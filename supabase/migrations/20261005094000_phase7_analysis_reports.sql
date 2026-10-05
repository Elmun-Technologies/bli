-- Phase 7, migration 1 of 2: executive decision reports bound to stored analyses.
--
-- A report is not a second analysis. It is an immutable, hash-verified projection
-- of one already-stored Phase 6 analysis: the analysis header, the model snapshot
-- that scored it, every stored raw/normalized metric and every stored factor
-- contribution. Nothing here reruns ST_DWithin, normalization, ranking or
-- scoring, so a report generated a year later reproduces the historical numbers
-- even after the business data or the model has moved on.
--
-- Three guarantees are enforced in the database, not only in the route:
--
--   * OWNERSHIP  - composite foreign keys make
--                  (workspace A, project B, analysis C) combinations that do not
--                  belong together impossible. A report can never cite an
--                  analysis of another workspace, and its project must be the
--                  project the analysis was run in.
--   * SHAPE      - a `single_location` report can only cite an `analysis`, and a
--                  `comparison` report only a `comparison` with 2-5 candidates.
--                  The check runs in a trigger because it has to read the
--                  analysis row.
--   * IMMUTABILITY - the analytical payload (snapshot, snapshot_hash,
--                  report_type, analysis_id, workspace/project, creator) can
--                  never be rewritten once inserted. Presentation fields (title,
--                  subtitle, company name) and lifecycle fields (status,
--                  storage_path, generated_at) stay editable, and the status
--                  machine only moves forward.
--
-- The report snapshot itself is produced server-side by the reporting service
-- from the caller's own RLS-filtered reads, and its SHA-256 is computed over a
-- canonical (recursively key-sorted) serialization. The hash is stored here so a
-- later regeneration can prove it renders the same snapshot; it is an integrity
-- check, not a signature.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- The two supported report types, matching the two stored analysis modes.
CREATE TYPE public.analysis_report_type AS ENUM ('single_location', 'comparison');

-- Deliberately small lifecycle. Phase 7 has no job engine: generation runs
-- synchronously inside one request, so `generating` is only ever visible for the
-- duration of that request (or while a failed one is being retried).
CREATE TYPE public.analysis_report_status AS ENUM ('draft', 'generating', 'ready', 'failed');

-- ---------------------------------------------------------------------------
-- location_analyses: composite identity for report ownership
-- ---------------------------------------------------------------------------

-- Additive only, like the Phase 6 addition on analysis_locations: this makes
-- (id, project_id, workspace_id) referenceable so a report can prove in the
-- database that its analysis belongs to the report's own project.
ALTER TABLE public.location_analyses
  ADD CONSTRAINT location_analyses_project_identity_unique
  UNIQUE (id, project_id, workspace_id);

COMMENT ON CONSTRAINT location_analyses_project_identity_unique ON public.location_analyses IS
  'Supports the analysis_reports composite foreign key that keeps a report, its project and its analysis in one ownership scope.';

-- ---------------------------------------------------------------------------
-- analysis_reports
-- ---------------------------------------------------------------------------

CREATE TABLE public.analysis_reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  analysis_id uuid NOT NULL,
  report_type public.analysis_report_type NOT NULL,
  title text NOT NULL,
  subtitle text,
  company_name text,
  status public.analysis_report_status NOT NULL DEFAULT 'draft',
  -- Server-owned generation options (map on/off, provider name). Never branding.
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Immutable analytical payload: the complete executive report content, built
  -- from the stored analysis. Nullable only because a table column must have a
  -- default; the insert trigger below refuses a report without it.
  snapshot jsonb,
  snapshot_hash text,
  -- Private object paths, always <workspace>/<project>/<report>/<file>; the
  -- check constraints below re-derive the first three segments from the row's own
  -- ids, so a path can never be re-pointed at another tenant's object.
  storage_path text,
  map_storage_path text,
  logo_storage_path text,
  logo_mime_type text,
  logo_size_bytes integer,
  failure_code text,
  generated_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT analysis_reports_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  CONSTRAINT analysis_reports_project_fk
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects (id, workspace_id)
    ON DELETE RESTRICT,
  -- The report's analysis must belong to the report's own workspace AND project.
  CONSTRAINT analysis_reports_analysis_fk
    FOREIGN KEY (analysis_id, project_id, workspace_id)
    REFERENCES public.location_analyses (id, project_id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT analysis_reports_created_by_fk
    FOREIGN KEY (created_by)
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  CONSTRAINT analysis_reports_title_nonempty CHECK (
    pg_catalog.char_length(pg_catalog.btrim(title)) > 0
  ),
  CONSTRAINT analysis_reports_title_length CHECK (pg_catalog.char_length(title) <= 160),
  CONSTRAINT analysis_reports_subtitle_length CHECK (
    subtitle IS NULL OR pg_catalog.char_length(subtitle) <= 200
  ),
  CONSTRAINT analysis_reports_company_length CHECK (
    company_name IS NULL OR pg_catalog.char_length(pg_catalog.btrim(company_name)) <= 160
  ),
  CONSTRAINT analysis_reports_configuration_object CHECK (
    pg_catalog.jsonb_typeof(configuration) = 'object'
  ),
  CONSTRAINT analysis_reports_snapshot_object CHECK (
    snapshot IS NULL OR pg_catalog.jsonb_typeof(snapshot) = 'object'
  ),
  CONSTRAINT analysis_reports_snapshot_hash_format CHECK (
    snapshot_hash IS NULL OR snapshot_hash ~ '^[0-9a-f]{64}$'
  ),
  -- Generated artifacts exist only for a ready report, and a ready report that
  -- generated a PDF must say where it is.
  CONSTRAINT analysis_reports_storage_path_scope CHECK (
    storage_path IS NULL
    OR storage_path LIKE workspace_id::text || '/' || project_id::text || '/' || id::text || '/%'
  ),
  CONSTRAINT analysis_reports_map_path_scope CHECK (
    map_storage_path IS NULL
    OR map_storage_path LIKE workspace_id::text || '/' || project_id::text || '/' || id::text || '/%'
  ),
  CONSTRAINT analysis_reports_logo_path_scope CHECK (
    logo_storage_path IS NULL
    OR logo_storage_path LIKE workspace_id::text || '/' || project_id::text || '/' || id::text || '/%'
  ),
  CONSTRAINT analysis_reports_logo_mime_valid CHECK (
    logo_storage_path IS NULL
    OR logo_mime_type IN ('image/png', 'image/jpeg')
  ),
  CONSTRAINT analysis_reports_logo_size_range CHECK (
    logo_size_bytes IS NULL OR logo_size_bytes BETWEEN 1 AND 2097152
  ),
  CONSTRAINT analysis_reports_failure_code_safe CHECK (
    failure_code IS NULL
    OR failure_code IN ('map_provider_unavailable', 'pdf_render_failed', 'storage_unavailable')
  ),
  CONSTRAINT analysis_reports_ready_has_artifact CHECK (
    status <> 'ready' OR (storage_path IS NOT NULL AND generated_at IS NOT NULL)
  ),
  CONSTRAINT analysis_reports_workspace_identity_unique UNIQUE (id, workspace_id)
);

CREATE INDEX analysis_reports_workspace_project_created_idx
  ON public.analysis_reports (workspace_id, project_id, created_at DESC, id DESC);

CREATE INDEX analysis_reports_analysis_idx
  ON public.analysis_reports (analysis_id, created_at DESC);

COMMENT ON TABLE public.analysis_reports IS
  'Executive decision reports generated from immutable stored Phase 6 analyses. Analytical content lives in the hash-verified snapshot and is never rewritten; presentation fields (title/subtitle/company) and lifecycle fields stay editable.';
COMMENT ON COLUMN public.analysis_reports.snapshot IS
  'Immutable report snapshot built from the stored analysis payload: stored scores, ranks, raw/normalized metrics, factor contributions and the model snapshot. No customer-level rows.';
COMMENT ON COLUMN public.analysis_reports.snapshot_hash IS
  'SHA-256 over the canonical (recursively key-sorted) snapshot serialization. Integrity check for regeneration, not a digital signature.';
COMMENT ON COLUMN public.analysis_reports.configuration IS
  'Server-owned generation options (include_map, map_provider). Branding lives in company_name/logo_* columns, never here.';

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER analysis_reports_set_updated_at
  BEFORE UPDATE ON public.analysis_reports
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A report may never move between workspaces/projects, exactly like every other
-- tenant record (Phase 4 helper).
CREATE TRIGGER analysis_reports_prevent_move
  BEFORE UPDATE ON public.analysis_reports
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

-- Validates the analysis a report cites: same workspace and project (the FK
-- already covers that, but the trigger gives a precise message), the report type
-- matching the analysis mode, the candidate count of that mode, and a snapshot
-- whose own analysis id is the cited one. SECURITY INVOKER: the caller can only
-- reach this path when they can see the analysis anyway.
CREATE OR REPLACE FUNCTION public.analysis_reports_validate_source()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  source record;
BEGIN
  SELECT analysis.mode, analysis.candidate_count
    INTO source
    FROM public.location_analyses AS analysis
   WHERE analysis.id = NEW.analysis_id
     AND analysis.workspace_id = NEW.workspace_id
     AND analysis.project_id = NEW.project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'The analysis does not belong to this workspace and project';
  END IF;

  IF (NEW.report_type = 'single_location' AND source.mode <> 'analysis')
     OR (NEW.report_type = 'comparison' AND source.mode <> 'comparison') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The report type does not match the stored analysis mode';
  END IF;

  IF NEW.report_type = 'single_location' AND source.candidate_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A single-location report needs an analysis of exactly one candidate';
  END IF;

  IF NEW.report_type = 'comparison' AND source.candidate_count NOT BETWEEN 2 AND 5 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A comparison report needs an analysis of two to five candidates';
  END IF;

  IF NEW.snapshot IS NULL OR NEW.snapshot_hash IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A report needs an immutable snapshot and its hash';
  END IF;

  IF (NEW.snapshot -> 'analysis' ->> 'id')::uuid IS DISTINCT FROM NEW.analysis_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The report snapshot does not describe the cited analysis';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.analysis_reports_validate_source() IS
  'Rejects a report whose cited analysis is not in the report workspace/project, whose type does not match the stored analysis mode and candidate count, or whose snapshot describes a different analysis. Trigger only.';

CREATE TRIGGER analysis_reports_validate_source
  BEFORE INSERT OR UPDATE OF analysis_id, report_type, workspace_id, project_id, snapshot, snapshot_hash
  ON public.analysis_reports
  FOR EACH ROW EXECUTE FUNCTION public.analysis_reports_validate_source();

-- Immutability of the analytical payload. Everything the report asserts about
-- the analysis is frozen at insert; only presentation and lifecycle columns may
-- change afterwards.
CREATE OR REPLACE FUNCTION public.analysis_reports_protect_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
     OR NEW.analysis_id IS DISTINCT FROM OLD.analysis_id
     OR NEW.report_type IS DISTINCT FROM OLD.report_type
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'The analytical content of a report is immutable';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.analysis_reports_protect_snapshot() IS
  'Freezes the analytical payload of a report (snapshot, hash, source analysis, type, ownership, creator) after insert. Trigger only.';

CREATE TRIGGER analysis_reports_protect_snapshot
  BEFORE UPDATE ON public.analysis_reports
  FOR EACH ROW EXECUTE FUNCTION public.analysis_reports_protect_snapshot();

-- Forward-only lifecycle: draft -> generating -> ready|failed, failed ->
-- generating (retry), ready -> generating (regenerate the same snapshot).
CREATE OR REPLACE FUNCTION public.analysis_reports_validate_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'generating')
    OR (OLD.status = 'generating' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status = 'generating')
    OR (OLD.status = 'ready' AND NEW.status = 'generating')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The report status cannot move from ' || OLD.status || ' to ' || NEW.status;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.analysis_reports_validate_status_transition() IS
  'Keeps the report lifecycle forward-only: draft -> generating -> ready/failed, failed -> generating, ready -> generating. Trigger only.';

CREATE TRIGGER analysis_reports_validate_status_transition
  BEFORE UPDATE OF status ON public.analysis_reports
  FOR EACH ROW EXECUTE FUNCTION public.analysis_reports_validate_status_transition();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

ALTER TABLE public.analysis_reports ENABLE ROW LEVEL SECURITY;

-- Any member of the workspace reads the reports of a project they can see. The
-- API additionally demands an explicit project context; RLS is the independent
-- second layer and never trusts the route.
CREATE POLICY analysis_reports_select_member
  ON public.analysis_reports
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- Only owner/admin/analyst may create a report or move it through generation.
-- A viewer can read and download, never generate or mutate.
CREATE POLICY analysis_reports_insert_run
  ON public.analysis_reports
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(
    workspace_id,
    ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
  ));

CREATE POLICY analysis_reports_update_run
  ON public.analysis_reports
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(
    workspace_id,
    ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
  ))
  WITH CHECK (public.has_workspace_role(
    workspace_id,
    ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
  ));

-- No DELETE policy and no DELETE privilege: reports are an audit trail. A later
-- retention phase can add a deliberate deletion path.

REVOKE ALL PRIVILEGES ON TABLE public.analysis_reports FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_reports TO authenticated;

COMMENT ON POLICY analysis_reports_select_member ON public.analysis_reports IS
  'Any workspace member reads reports; project context is enforced by the API and by the composite keys, RLS by membership.';
COMMENT ON POLICY analysis_reports_insert_run ON public.analysis_reports IS
  'Owner/admin/analyst create reports; viewers are read-only.';
COMMENT ON POLICY analysis_reports_update_run ON public.analysis_reports IS
  'Owner/admin/analyst move a report through generation. The snapshot itself is frozen by trigger.';
