-- Phase 6 location scoring: saved candidates and stored analysis history.
--
-- The engine migration already stores every number an analysis produced. What
-- the interface still needs are two views the raw tables cannot serve safely:
--
--   * the saved candidate locations of a project, as readable coordinate pairs
--     (a geography column is not a client-side value)
--   * recent stored analyses with their full results, so the analysis list, the
--     comparison table, the factor breakdown and the CSV export all render from
--     what was snapshotted, never from a re-run
--
-- Both are SECURITY INVOKER functions: the caller's own session decides, RLS
-- filters every row, and each function asserts membership or role explicitly so
-- the API can return a precise, safe message. Saving a candidate goes through
-- one function too, because it must be impossible to attach a candidate to a
-- project of another workspace (the composite foreign key backs that up).
--
-- No metrics are cached anywhere: the stored `raw_metrics`, `normalized_metrics`
-- and `factor_contributions` of each result are the single source for every
-- column the interface shows.

-- ---------------------------------------------------------------------------
-- Saved candidate locations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_analysis_locations(
  p_workspace_id uuid,
  p_project_id uuid
)
RETURNS TABLE (
  id uuid,
  name text,
  longitude double precision,
  latitude double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id and project id are required';
  END IF;

  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Saved candidate locations require workspace membership';
  END IF;

  RETURN QUERY
  SELECT
    candidate.id,
    candidate.name,
    extensions.st_x(candidate.spatial_point::extensions.geometry),
    extensions.st_y(candidate.spatial_point::extensions.geometry),
    candidate.created_at
  FROM public.analysis_locations AS candidate
  WHERE candidate.workspace_id = p_workspace_id
    AND candidate.project_id = p_project_id
  ORDER BY pg_catalog.lower(candidate.name), candidate.created_at, candidate.id;
END;
$function$;

COMMENT ON FUNCTION public.list_analysis_locations(uuid, uuid) IS
  'Saved candidate locations of one project as name plus readable coordinates. SECURITY INVOKER: membership is asserted and RLS filters the rows.';

CREATE OR REPLACE FUNCTION public.save_analysis_location(
  p_workspace_id uuid,
  p_project_id uuid,
  p_name text,
  p_longitude double precision,
  p_latitude double precision
)
RETURNS TABLE (
  id uuid,
  name text,
  longitude double precision,
  latitude double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  saved_id uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id and project id are required';
  END IF;

  -- A precise, safe message for the role matrix; the insert policy and the
  -- composite project key enforce the same rule independently.
  IF public.has_workspace_role(
    p_workspace_id,
    ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Saving a candidate location requires owner, admin or analyst membership';
  END IF;

  IF COALESCE(pg_catalog.btrim(p_name), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A candidate location needs a name';
  END IF;
  IF pg_catalog.btrim(p_name) <> p_name THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The candidate name cannot start or end with spaces';
  END IF;
  IF p_longitude IS NULL OR p_latitude IS NULL
     OR p_longitude < -180 OR p_longitude > 180
     OR p_latitude < -90 OR p_latitude > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A longitude between -180 and 180 and a latitude between -90 and 90 are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.projects AS project
     WHERE project.id = p_project_id
       AND project.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Project not found';
  END IF;

  INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
  VALUES (
    p_workspace_id,
    p_project_id,
    p_name,
    extensions.st_setsrid(extensions.st_makepoint(p_longitude, p_latitude), 4326)::extensions.geography
  )
  RETURNING analysis_locations.id INTO saved_id;

  RETURN QUERY
  SELECT
    candidate.id,
    candidate.name,
    extensions.st_x(candidate.spatial_point::extensions.geometry),
    extensions.st_y(candidate.spatial_point::extensions.geometry),
    candidate.created_at
  FROM public.analysis_locations AS candidate
  WHERE candidate.id = saved_id;
END;
$function$;

COMMENT ON FUNCTION public.save_analysis_location(uuid, uuid, text, double precision, double precision) IS
  'Saves one candidate location for a project after an explicit role check. SECURITY INVOKER so the insert policy is a second, independent gate.';

-- ---------------------------------------------------------------------------
-- Stored analysis history
-- ---------------------------------------------------------------------------
-- One row per stored analysis, each carrying the same payload shape
-- get_location_analysis returns, so a stored comparison can be re-read exactly
-- as it was written and rendered without any extra query.
CREATE OR REPLACE FUNCTION public.list_location_analyses(
  p_workspace_id uuid,
  p_project_id uuid,
  p_mode text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (analysis jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  row_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  mode_filter text := NULLIF(pg_catalog.btrim(COALESCE(p_mode, '')), '');
BEGIN
  IF p_workspace_id IS NULL OR p_project_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id and project id are required';
  END IF;
  IF mode_filter IS NOT NULL AND mode_filter NOT IN ('analysis', 'comparison') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The mode filter must be analysis or comparison';
  END IF;

  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Stored analyses require workspace membership';
  END IF;

  RETURN QUERY
  SELECT public.location_analysis_payload(recent.id)
  FROM (
    SELECT stored.id
    FROM public.location_analyses AS stored
    WHERE stored.workspace_id = p_workspace_id
      AND stored.project_id = p_project_id
      AND (mode_filter IS NULL OR stored.mode = mode_filter)
    ORDER BY stored.created_at DESC, stored.id DESC
    LIMIT row_limit
  ) AS recent;
END;
$function$;

COMMENT ON FUNCTION public.list_location_analyses(uuid, uuid, text, integer) IS
  'Recent stored analyses of one project, newest first, each returned in the same shape as get_location_analysis. SECURITY INVOKER: membership is asserted and RLS filters the rows.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.list_analysis_locations(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_analysis_locations(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.save_analysis_location(uuid, uuid, text, double precision, double precision)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_analysis_location(uuid, uuid, text, double precision, double precision)
  TO authenticated;

REVOKE ALL ON FUNCTION public.list_location_analyses(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_location_analyses(uuid, uuid, text, integer) TO authenticated;

-- anon holds no EXECUTE on the saved-candidate or history surface.
