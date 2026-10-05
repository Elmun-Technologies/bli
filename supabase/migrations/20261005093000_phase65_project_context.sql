-- Phase 6.5: explicit project context for the scoring workspace.
--
-- Phase 6 shipped one genuine product gap: saved candidates and analysis history
-- were addressed by (workspace, project), but the two read functions never
-- verified that the named project actually belongs to the named workspace. A
-- wrong or foreign project id therefore answered with an empty list, which is an
-- implicitly "successful" answer to an unauthorized question.
--
-- This migration closes that gap without changing any signature, any table, any
-- policy or any grant:
--
--   * `list_analysis_locations` and `list_location_analyses` now verify the
--     project inside the workspace first and raise P0002 otherwise, so a foreign
--     project id fails exactly like a project that does not exist. A caller who
--     is not a member still gets 42501 before any project lookup, so the refusal
--     never depends on the workspace's contents.
--   * `run_location_analysis` already required every candidate to belong to
--     `p_project_id` (`AND candidate.project_id = p_project_id`), which is what
--     makes a mixed-project comparison impossible; no change is needed there and
--     the suites assert it directly.
--
-- Nothing here infers a project. Every function still takes an explicit project
-- id, and the API layer rejects a missing one with a safe 400 instead of
-- choosing a project for the caller.

-- ---------------------------------------------------------------------------
-- Saved candidate locations: the project must belong to the workspace
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

  -- Authorization first: an outsider learns nothing about projects or rows.
  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Saved candidate locations require workspace membership';
  END IF;

  -- The project is part of the query, not a filter the caller can widen: a
  -- project of another workspace answers exactly like a project that does not
  -- exist, and never as an empty list.
  IF NOT EXISTS (
    SELECT 1
      FROM public.projects AS project
     WHERE project.id = p_project_id
       AND project.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Project not found';
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
  'Saved candidate locations of one project of one workspace, as name plus readable coordinates. SECURITY INVOKER: membership is asserted, the project is verified to belong to the workspace, and RLS filters the rows. Never returns another project''s candidates.';

-- ---------------------------------------------------------------------------
-- Stored analysis history: scoped to one verified project
-- ---------------------------------------------------------------------------
-- One row per stored analysis, each carrying the same payload shape
-- get_location_analysis returns, so a stored comparison can be re-read exactly
-- as it was written and rendered without any extra query. There is deliberately
-- no "all projects" mode: history is project context or it is not returned.
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

  IF NOT EXISTS (
    SELECT 1
      FROM public.projects AS project
     WHERE project.id = p_project_id
       AND project.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Project not found';
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
  'Recent stored analyses of one verified project, newest first, each returned in the same shape as get_location_analysis. SECURITY INVOKER: membership is asserted, the project must belong to the workspace, and RLS filters the rows. Never mixes projects.';

-- ---------------------------------------------------------------------------
-- Grants: unchanged signatures, unchanged posture
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps the existing ACL, but the matrix is restated so this
-- file remains the single readable statement of who may call what: authenticated
-- only, never anon and never PUBLIC.
REVOKE ALL ON FUNCTION public.list_analysis_locations(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_analysis_locations(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.list_location_analyses(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_location_analyses(uuid, uuid, text, integer) TO authenticated;
