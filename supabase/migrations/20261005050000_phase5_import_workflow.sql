-- Phase 5, migration 1 of 2: import workflow schema.
--
-- Design principles:
--   * Uploaded data lands in staging (import_jobs + import_rows) and is only
--     promoted into customers/locations by an explicit, idempotent commit.
--   * Every import belongs to exactly one workspace, enforced by a composite
--     foreign key (id, workspace_id) plus the shared prevent_tenant_record_move
--     trigger, so neither a job nor a staged row can be re-parented.
--   * Staged rows are never inserted into production tables before validation.
--   * Validation, mapping and batching live in the application layer; the
--     database owns ownership, idempotency, counters and the commit transaction.

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

-- Workflow stages actually used by the implementation. Deliberately small:
-- uploaded -> mapping_required -> ready -> (review_required) -> completed.
CREATE TYPE public.import_job_status AS ENUM (
  'uploaded',
  'mapping_required',
  'ready',
  'review_required',
  'completed',
  'failed'
);

-- Phase 5 targets. A later phase adds competitors/branches with
-- ALTER TYPE ... ADD VALUE plus a commit branch, not a second engine.
CREATE TYPE public.import_target_entity AS ENUM ('customers', 'locations');

CREATE TYPE public.import_file_type AS ENUM ('csv', 'xlsx');

-- pending           - staging row, no validation has run yet
-- valid             - has every required value and a usable coordinate
-- needs_geocoding   - address-only row: valid apart from its coordinate
-- invalid           - at least one blocking error (never silently dropped)
CREATE TYPE public.import_row_validation_status AS ENUM (
  'pending',
  'valid',
  'needs_geocoding',
  'invalid'
);

-- not_required      - the row already had coordinates
-- pending           - awaiting a provider call
-- geocoding         - claimed by an in-flight batch (stale claims are requeued)
-- success           - provider returned a result accepted by the policy
-- ambiguous         - provider returned a weak/low-confidence result: review
-- no_match          - provider returned nothing for this address
-- provider_error    - transient/transport failure, retryable
-- rate_limited      - provider throttled us, retryable
-- manual_override   - an authorized user placed the point by hand
CREATE TYPE public.import_row_geocoding_status AS ENUM (
  'not_required',
  'pending',
  'geocoding',
  'success',
  'ambiguous',
  'no_match',
  'provider_error',
  'rate_limited',
  'manual_override'
);

-- ---------------------------------------------------------------------------
-- import_jobs
-- ---------------------------------------------------------------------------

CREATE TABLE public.import_jobs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  dataset_id uuid,
  created_by uuid NOT NULL,
  original_filename text NOT NULL,
  storage_path text,
  file_type public.import_file_type,
  status public.import_job_status NOT NULL DEFAULT 'uploaded',
  target_entity public.import_target_entity,
  sheet_name text,
  column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  needs_geocoding_rows integer NOT NULL DEFAULT 0,
  geocoded_rows integer NOT NULL DEFAULT 0,
  failed_geocoding_rows integer NOT NULL DEFAULT 0,
  committed_rows integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT import_jobs_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  -- A job may only cite a dataset of its own workspace. Composite FK, so a
  -- client cannot point an import at another tenant's dataset.
  CONSTRAINT import_jobs_dataset_workspace_fk
    FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES public.datasets (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT import_jobs_created_by_fk
    FOREIGN KEY (created_by)
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  -- Required target for import_rows' composite workspace FK.
  CONSTRAINT import_jobs_workspace_identity_unique UNIQUE (id, workspace_id),
  CONSTRAINT import_jobs_filename_nonempty CHECK (
    pg_catalog.char_length(pg_catalog.btrim(original_filename)) > 0
  ),
  CONSTRAINT import_jobs_storage_path_nonempty CHECK (
    storage_path IS NULL OR pg_catalog.char_length(pg_catalog.btrim(storage_path)) > 0
  ),
  CONSTRAINT import_jobs_sheet_name_nonempty CHECK (
    sheet_name IS NULL OR pg_catalog.char_length(pg_catalog.btrim(sheet_name)) > 0
  ),
  CONSTRAINT import_jobs_counts_nonnegative CHECK (
    total_rows >= 0 AND valid_rows >= 0 AND invalid_rows >= 0
    AND needs_geocoding_rows >= 0 AND geocoded_rows >= 0
    AND failed_geocoding_rows >= 0 AND committed_rows >= 0
  ),
  CONSTRAINT import_jobs_column_mapping_object CHECK (
    pg_catalog.jsonb_typeof(column_mapping) = 'object'
  ),
  CONSTRAINT import_jobs_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object'),
  CONSTRAINT import_jobs_committed_at_consistent CHECK (
    (status = 'completed') = (committed_at IS NOT NULL)
  )
);

CREATE INDEX import_jobs_workspace_created_idx
  ON public.import_jobs (workspace_id, created_at DESC);
CREATE INDEX import_jobs_created_by_idx ON public.import_jobs (created_by);
CREATE INDEX import_jobs_dataset_idx ON public.import_jobs (dataset_id)
  WHERE dataset_id IS NOT NULL;

CREATE TRIGGER import_jobs_set_updated_at
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A job can never be re-parented to another workspace or re-attributed.
CREATE OR REPLACE FUNCTION public.prevent_import_job_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'An import job cannot be re-pointed at another workspace or user';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.prevent_import_job_reassignment() IS
  'BEFORE UPDATE trigger on import_jobs: workspace_id and created_by are immutable, so an authorized member of two workspaces cannot relocate an import (or its staged rows) across the authorization boundary. SECURITY INVOKER.';

CREATE TRIGGER import_jobs_prevent_reassignment
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_import_job_reassignment();

-- The completion transition belongs to public.commit_import_job alone. RLS
-- cannot express "only through that function", because the function runs with
-- the caller's own privileges (SECURITY INVOKER) - so the commit function marks
-- the transaction with a transaction-local setting that a PostgREST client has
-- no way to set (set_config lives in pg_catalog and is not exposed over /rpc),
-- and this trigger rejects every other write of the completion fields.
CREATE OR REPLACE FUNCTION public.prevent_direct_import_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  -- Ordinary workflow transitions (mapping_required -> ready -> review_required)
  -- are derived by public.refresh_import_job_counters and stay allowed. Only the
  -- completion fields are reserved for the commit function.
  IF (NEW.committed_at IS DISTINCT FROM OLD.committed_at
      OR (NEW.status IS DISTINCT FROM OLD.status
          AND (NEW.status = 'completed' OR OLD.status = 'completed')))
     AND pg_catalog.current_setting('bli.import_commit_job', true)
         IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Import completion is written by public.commit_import_job only';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.prevent_direct_import_completion() IS
  'BEFORE UPDATE trigger on import_jobs: status/committed_at may only change inside public.commit_import_job (transaction-local marker). SECURITY INVOKER.';

CREATE TRIGGER import_jobs_prevent_direct_completion
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_import_completion();

-- ---------------------------------------------------------------------------
-- import_rows (staging)
-- ---------------------------------------------------------------------------

CREATE TABLE public.import_rows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  import_job_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  row_number integer NOT NULL,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  normalized_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_status public.import_row_validation_status NOT NULL DEFAULT 'pending',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  geocoding_status public.import_row_geocoding_status NOT NULL DEFAULT 'not_required',
  geocoding_result jsonb,
  geocoding_attempts integer NOT NULL DEFAULT 0,
  geocoding_claimed_at timestamptz,
  manual_override boolean NOT NULL DEFAULT false,
  longitude double precision,
  latitude double precision,
  committed_record_id uuid,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT import_rows_job_workspace_fk
    FOREIGN KEY (import_job_id, workspace_id)
    REFERENCES public.import_jobs (id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT import_rows_row_number_unique UNIQUE (import_job_id, row_number),
  CONSTRAINT import_rows_row_number_positive CHECK (row_number >= 1),
  CONSTRAINT import_rows_raw_data_object CHECK (pg_catalog.jsonb_typeof(raw_data) = 'object'),
  CONSTRAINT import_rows_normalized_data_object CHECK (
    pg_catalog.jsonb_typeof(normalized_data) = 'object'
  ),
  CONSTRAINT import_rows_validation_errors_array CHECK (
    pg_catalog.jsonb_typeof(validation_errors) = 'array'
  ),
  CONSTRAINT import_rows_geocoding_result_object CHECK (
    geocoding_result IS NULL OR pg_catalog.jsonb_typeof(geocoding_result) = 'object'
  ),
  CONSTRAINT import_rows_geocoding_attempts_nonnegative CHECK (geocoding_attempts >= 0),
  CONSTRAINT import_rows_claim_requires_geocoding CHECK (
    geocoding_claimed_at IS NULL OR geocoding_status <> 'not_required'
  ),
  -- Coordinates are all-or-nothing and must be finite and in range. The same
  -- bounds Phase 2 uses for stored points apply before anything is staged.
  CONSTRAINT import_rows_coordinates_valid CHECK (
    (longitude IS NULL AND latitude IS NULL)
    OR (
      longitude IS NOT NULL AND latitude IS NOT NULL
      AND longitude = longitude AND latitude = latitude
      AND longitude BETWEEN -180 AND 180
      AND latitude BETWEEN -90 AND 90
    )
  ),
  CONSTRAINT import_rows_geocoding_status_consistent CHECK (
    (geocoding_status = 'not_required' AND validation_status <> 'needs_geocoding')
    OR geocoding_status <> 'not_required'
  ),
  CONSTRAINT import_rows_committed_consistency CHECK (
    (committed_record_id IS NULL) = (committed_at IS NULL)
  ),
  CONSTRAINT import_rows_manual_override_requires_point CHECK (
    (NOT manual_override) OR (longitude IS NOT NULL AND latitude IS NOT NULL)
  )
);

CREATE INDEX import_rows_job_status_idx
  ON public.import_rows (import_job_id, validation_status);
CREATE INDEX import_rows_job_geocoding_idx
  ON public.import_rows (import_job_id, geocoding_status)
  WHERE geocoding_status <> 'not_required';
CREATE INDEX import_rows_workspace_idx ON public.import_rows (workspace_id);
CREATE INDEX import_rows_committed_idx ON public.import_rows (committed_record_id)
  WHERE committed_record_id IS NOT NULL;

CREATE TRIGGER import_rows_set_updated_at
  BEFORE UPDATE ON public.import_rows
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Staged rows may not be re-parented either (the composite FK already requires
-- the job and workspace to match; this rejects the change in plain words).
CREATE TRIGGER import_rows_prevent_move
  BEFORE UPDATE ON public.import_rows
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

-- ---------------------------------------------------------------------------
-- Provenance on imported production records
-- ---------------------------------------------------------------------------

-- Provenance lives in relational columns, not only in an opaque JSON blob, so
-- "which import created this customer?" is a join. The composite FK keeps the
-- provenance honest: a record can only cite an import job of its own workspace.
ALTER TABLE public.customers
  ADD COLUMN import_job_id uuid,
  ADD COLUMN source_row_number integer;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_import_job_workspace_fk
    FOREIGN KEY (import_job_id, workspace_id)
    REFERENCES public.import_jobs (id, workspace_id),
  ADD CONSTRAINT customers_source_row_number_positive CHECK (
    source_row_number IS NULL OR source_row_number >= 1
  );

ALTER TABLE public.locations
  ADD COLUMN import_job_id uuid,
  ADD COLUMN source_row_number integer;
ALTER TABLE public.locations
  ADD CONSTRAINT locations_import_job_workspace_fk
    FOREIGN KEY (import_job_id, workspace_id)
    REFERENCES public.import_jobs (id, workspace_id),
  ADD CONSTRAINT locations_source_row_number_positive CHECK (
    source_row_number IS NULL OR source_row_number >= 1
  );

-- The same provenance columns exist on competitors/branches so a later phase
-- can enable those targets without another schema change. Nothing writes them
-- in Phase 5.
ALTER TABLE public.competitors
  ADD COLUMN import_job_id uuid,
  ADD COLUMN source_row_number integer;
ALTER TABLE public.competitors
  ADD CONSTRAINT competitors_import_job_workspace_fk
    FOREIGN KEY (import_job_id, workspace_id)
    REFERENCES public.import_jobs (id, workspace_id),
  ADD CONSTRAINT competitors_source_row_number_positive CHECK (
    source_row_number IS NULL OR source_row_number >= 1
  );

ALTER TABLE public.branches
  ADD COLUMN import_job_id uuid,
  ADD COLUMN source_row_number integer;
ALTER TABLE public.branches
  ADD CONSTRAINT branches_import_job_workspace_fk
    FOREIGN KEY (import_job_id, workspace_id)
    REFERENCES public.import_jobs (id, workspace_id),
  ADD CONSTRAINT branches_source_row_number_positive CHECK (
    source_row_number IS NULL OR source_row_number >= 1
  );

CREATE INDEX customers_import_job_idx ON public.customers (import_job_id)
  WHERE import_job_id IS NOT NULL;
CREATE INDEX locations_import_job_idx ON public.locations (import_job_id)
  WHERE import_job_id IS NOT NULL;
CREATE INDEX competitors_import_job_idx ON public.competitors (import_job_id)
  WHERE import_job_id IS NOT NULL;
CREATE INDEX branches_import_job_idx ON public.branches (import_job_id)
  WHERE import_job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_rows ENABLE ROW LEVEL SECURITY;

-- Every member (including a viewer) may read imports of a workspace they
-- belong to: viewing an import is read-only and viewer-safe.
CREATE POLICY import_jobs_select_member
  ON public.import_jobs
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- Uploading, mapping, validating, geocoding and committing are analytical
-- writes restricted to owner/admin/analyst. A viewer has no write policy, so
-- the database refuses every one of those operations regardless of the UI.
CREATE POLICY import_jobs_insert_analyst
  ON public.import_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
    AND created_by = auth.uid()
  );

CREATE POLICY import_jobs_update_analyst
  ON public.import_jobs
  FOR UPDATE
  TO authenticated
  USING (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  )
  WITH CHECK (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

-- No DELETE policy on import_jobs: an import is an audit record and its staged
-- rows and provenance must stay answerable. Retention automation is future work.

CREATE POLICY import_rows_select_member
  ON public.import_rows
  FOR SELECT
  TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY import_rows_insert_analyst
  ON public.import_rows
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

CREATE POLICY import_rows_update_analyst
  ON public.import_rows
  FOR UPDATE
  TO authenticated
  USING (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  )
  WITH CHECK (
    public.has_workspace_role(
      workspace_id,
      ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
    )
  );

-- No DELETE policy on import_rows: staged rows are the evidence behind the
-- import summary and the failed-row export.

-- ---------------------------------------------------------------------------
-- Grants (revoke the Supabase default privileges first, then grant exactly the
-- set the policies above allow)
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE public.import_jobs, public.import_rows
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.import_jobs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.import_rows TO authenticated;

-- anon keeps zero privileges: the import workflow is authenticated-only.
-- service_role keeps the platform default; Phase 5 never uses it for imports.

-- ---------------------------------------------------------------------------
-- Counter refresh
-- ---------------------------------------------------------------------------

-- Recomputes every counter from import_rows and derives the workflow status.
-- Called after validation, after each geocoding batch and inside commit, so the
-- summary a user sees is always derived from the staging rows themselves rather
-- than from application bookkeeping.
CREATE OR REPLACE FUNCTION public.refresh_import_job_counters(p_import_job_id uuid)
RETURNS TABLE (
  total_rows integer,
  valid_rows integer,
  invalid_rows integer,
  needs_geocoding_rows integer,
  geocoded_rows integer,
  failed_geocoding_rows integer,
  committed_rows integer,
  job_status public.import_job_status
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  counters record;
BEGIN
  IF p_import_job_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import job id is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.import_jobs AS job
     WHERE job.id = p_import_job_id
       AND public.has_workspace_role(
             job.workspace_id,
             ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
           )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Import counters require owner, admin or analyst membership';
  END IF;

  SELECT
    pg_catalog.count(*)::integer AS total,
    pg_catalog.count(*) FILTER (WHERE rows.validation_status = 'valid')::integer AS valid,
    pg_catalog.count(*) FILTER (WHERE rows.validation_status = 'invalid')::integer AS invalid,
    pg_catalog.count(*) FILTER (WHERE rows.validation_status = 'needs_geocoding')::integer AS needing,
    pg_catalog.count(*) FILTER (
      WHERE rows.geocoding_status IN ('success', 'manual_override')
    )::integer AS geocoded,
    pg_catalog.count(*) FILTER (
      WHERE rows.geocoding_status IN (
        'ambiguous', 'no_match', 'provider_error', 'rate_limited'
      )
    )::integer AS failed_geocoding,
    pg_catalog.count(*) FILTER (WHERE rows.committed_record_id IS NOT NULL)::integer AS committed,
    pg_catalog.count(*) FILTER (
      WHERE rows.validation_status = 'valid' AND rows.committed_record_id IS NULL
    )::integer AS valid_uncommitted,
    pg_catalog.count(*) FILTER (WHERE rows.validation_status = 'pending')::integer AS pending
  INTO counters
  FROM public.import_rows AS rows
  WHERE rows.import_job_id = p_import_job_id;

  UPDATE public.import_jobs AS job
     SET total_rows = counters.total,
         valid_rows = counters.valid,
         invalid_rows = counters.invalid,
         needs_geocoding_rows = counters.needing,
         geocoded_rows = counters.geocoded,
         failed_geocoding_rows = counters.failed_geocoding,
         committed_rows = counters.committed,
         status = CASE
           -- Nothing is staged yet: keep whatever stage the workflow is in.
           WHEN counters.total = 0 THEN job.status
           -- Validation has not produced a decision for every row yet.
           WHEN counters.pending > 0 THEN job.status
           -- Finished: at least one row was promoted, nothing is committable
           -- any more, and no row is still waiting for a coordinate. Invalid
           -- rows do not block completion - they stay staged and reviewable,
           -- and the summary reports them.
           WHEN counters.committed > 0
             AND counters.valid_uncommitted = 0
             AND counters.needing = 0 THEN 'completed'::public.import_job_status
           -- Work remains: unresolved addresses, conflicts or invalid rows.
           WHEN counters.needing > 0
             OR counters.invalid > 0
             OR counters.failed_geocoding > 0 THEN 'review_required'::public.import_job_status
           -- Validated and committable, nothing promoted yet.
           ELSE 'ready'::public.import_job_status
         END,
         committed_at = CASE
           WHEN job.committed_at IS NOT NULL THEN job.committed_at
           WHEN counters.committed > 0
             AND counters.valid_uncommitted = 0
             AND counters.needing = 0 THEN pg_catalog.now()
           ELSE NULL
         END
   WHERE job.id = p_import_job_id;

  RETURN QUERY
  SELECT job.total_rows,
         job.valid_rows,
         job.invalid_rows,
         job.needs_geocoding_rows,
         job.geocoded_rows,
         job.failed_geocoding_rows,
         job.committed_rows,
         job.status
    FROM public.import_jobs AS job
   WHERE job.id = p_import_job_id;
END;
$function$;

COMMENT ON FUNCTION public.refresh_import_job_counters(uuid) IS
  'Recomputes import_jobs counters from import_rows and derives the workflow status. SECURITY INVOKER (RLS applies) with an explicit owner/admin/analyst assertion.';

REVOKE ALL ON FUNCTION public.refresh_import_job_counters(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_import_job_counters(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Geocoding batch claim
-- ---------------------------------------------------------------------------

-- Atomically claims one bounded batch of rows for geocoding. This is what makes
-- batch processing resumable and safe against two tabs (or two requests)
-- processing the same row:
--   * rows are claimed FOR UPDATE SKIP LOCKED and moved to 'geocoding';
--   * attempts are incremented at claim time, so a provider outage cannot loop
--     forever (p_max_attempts);
--   * a claim abandoned by a crashed request is requeued after p_stale_after,
--     so already-completed rows stay completed and interrupted work resumes.
CREATE OR REPLACE FUNCTION public.claim_import_geocoding_rows(
  p_import_job_id uuid,
  p_limit integer DEFAULT 25,
  p_max_attempts integer DEFAULT 5,
  p_stale_after interval DEFAULT '10 minutes'::interval
)
RETURNS TABLE (
  row_id uuid,
  row_number integer,
  address text,
  attempts integer
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  workspace uuid;
BEGIN
  IF p_import_job_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import job id is required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Geocoding batch size must be between 1 and 50';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 20 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid geocoding attempt limit';
  END IF;

  SELECT job.workspace_id INTO workspace
    FROM public.import_jobs AS job
   WHERE job.id = p_import_job_id;

  IF workspace IS NULL OR NOT public.has_workspace_role(
       workspace,
       ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Geocoding requires owner, admin or analyst membership';
  END IF;

  -- Requeue claims abandoned by a request that stopped halfway. The lease is a
  -- dedicated column because updated_at is maintained by a trigger and cannot
  -- double as an in-flight marker.
  UPDATE public.import_rows AS stale
     SET geocoding_status = 'pending',
         geocoding_claimed_at = NULL
   WHERE stale.import_job_id = p_import_job_id
     AND stale.geocoding_status = 'geocoding'
     AND stale.geocoding_claimed_at < pg_catalog.now() - p_stale_after;

  RETURN QUERY
  WITH claimed AS (
    SELECT rows.id
      FROM public.import_rows AS rows
     WHERE rows.import_job_id = p_import_job_id
       AND rows.validation_status = 'needs_geocoding'
       AND rows.geocoding_status IN ('pending', 'rate_limited', 'provider_error')
       AND rows.geocoding_attempts < p_max_attempts
     ORDER BY rows.row_number
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.import_rows AS target
     SET geocoding_status = 'geocoding',
         geocoding_attempts = target.geocoding_attempts + 1,
         geocoding_claimed_at = pg_catalog.now()
    FROM claimed
   WHERE target.id = claimed.id
  RETURNING
    target.id,
    target.row_number,
    COALESCE(target.normalized_data ->> 'address', ''),
    target.geocoding_attempts;
END;
$function$;

COMMENT ON FUNCTION public.claim_import_geocoding_rows(uuid, integer, integer, interval) IS
  'Claims a bounded, resumable batch of address-only rows for geocoding (FOR UPDATE SKIP LOCKED, attempt counting, stale-claim requeue). SECURITY INVOKER with an explicit owner/admin/analyst assertion.';

REVOKE ALL ON FUNCTION public.claim_import_geocoding_rows(uuid, integer, integer, interval)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_import_geocoding_rows(uuid, integer, integer, interval)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Commit
-- ---------------------------------------------------------------------------

-- Promotes every valid staged row of one import into its target table inside a
-- single transaction, then reports exact counts.
--
-- Idempotency:
--   * the job row is locked FOR UPDATE, so concurrent commits serialize;
--   * a second commit of an already-completed job inserts nothing and returns
--     the same summary;
--   * only rows with committed_record_id IS NULL are inserted, so a retry after
--     a transport failure cannot duplicate records.
--
-- Row conflicts are reported, never silently dropped: a staged row whose
-- external_id already exists in the destination dataset is marked invalid with
-- a duplicate_external_id error and stays visible for review/export.
CREATE OR REPLACE FUNCTION public.commit_import_job(
  p_import_job_id uuid,
  p_dataset_id uuid DEFAULT NULL,
  p_new_dataset_name text DEFAULT NULL,
  p_new_dataset_type text DEFAULT 'imported'
)
RETURNS TABLE (
  job_id uuid,
  target_dataset_id uuid,
  dataset_created boolean,
  inserted_rows bigint,
  conflicting_rows bigint,
  previously_committed_rows bigint,
  job_status public.import_job_status
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  job public.import_jobs;
  destination_dataset uuid;
  created_dataset boolean := false;
  inserted bigint := 0;
  conflicts bigint := 0;
  already bigint := 0;
  is_admin boolean := false;
  stage public.import_target_entity;
BEGIN
  IF p_import_job_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import job id is required';
  END IF;

  -- Read the job with the ordinary member SELECT policy first. A job of another
  -- workspace is invisible here and reports exactly the same "not found" as a
  -- job that does not exist, so the RPC is not an existence oracle.
  SELECT * INTO job
    FROM public.import_jobs AS target
   WHERE target.id = p_import_job_id;

  IF job.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Import job not found';
  END IF;

  -- Role assertion before the row lock: a viewer cannot lock a row it has no
  -- UPDATE policy for, so locking first would report a misleading "not found"
  -- instead of the real reason.
  IF NOT public.has_workspace_role(
       job.workspace_id,
       ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Committing an import requires owner, admin or analyst membership';
  END IF;

  -- Lock the job row: this is the serialization point that makes a repeated
  -- commit idempotent instead of duplicating records.
  SELECT * INTO job
    FROM public.import_jobs AS target
   WHERE target.id = p_import_job_id
   FOR UPDATE;

  IF job.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Import job not found';
  END IF;

  is_admin := public.has_workspace_role(
    job.workspace_id,
    ARRAY['owner', 'admin']::public.workspace_member_role[]
  );

  stage := job.target_entity;
  IF stage IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import has no target entity yet';
  END IF;

  already := job.committed_rows;

  -- Authorization before state: creating a dataset is an owner/admin action
  -- (the Phase 4 datasets matrix), so an analyst always gets that reason rather
  -- than a state error about an already-committed import. The destination
  -- resolution below repeats the check defensively.
  IF p_dataset_id IS NULL
     AND p_new_dataset_name IS NOT NULL
     AND pg_catalog.char_length(pg_catalog.btrim(p_new_dataset_name)) > 0
     AND NOT is_admin THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only owners and admins can create a dataset';
  END IF;

  -- A committed import is never re-pointed at another destination. Replaying the
  -- same commit stays idempotent, but naming a *new* dataset after rows were
  -- already promoted would leave an unexplained empty dataset behind, so a
  -- different destination is refused instead.
  IF already > 0
     AND (
       (p_dataset_id IS NOT NULL AND p_dataset_id IS DISTINCT FROM job.dataset_id)
       OR (p_new_dataset_name IS NOT NULL
           AND pg_catalog.char_length(pg_catalog.btrim(p_new_dataset_name)) > 0)
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Import already committed; reuse its destination dataset';
  END IF;

  -- Resolve the destination dataset: an existing dataset of this workspace, or
  -- a new one (owner/admin only, matching the Phase 4 datasets policies).
  IF p_dataset_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.datasets AS dataset
       WHERE dataset.id = p_dataset_id
         AND dataset.workspace_id = job.workspace_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Destination dataset is not in this workspace';
    END IF;
    destination_dataset := p_dataset_id;
  ELSIF p_new_dataset_name IS NOT NULL
        AND pg_catalog.char_length(pg_catalog.btrim(p_new_dataset_name)) > 0 THEN
    IF NOT is_admin THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'Only owners and admins can create a dataset';
    END IF;
    INSERT INTO public.datasets (workspace_id, name, dataset_type, source, metadata)
    VALUES (
      job.workspace_id,
      pg_catalog.btrim(p_new_dataset_name),
      COALESCE(NULLIF(pg_catalog.btrim(p_new_dataset_type), ''), 'imported'),
      job.original_filename,
      pg_catalog.jsonb_build_object('import_job_id', job.id)
    )
    RETURNING datasets.id INTO destination_dataset;
    created_dataset := true;
  ELSIF job.dataset_id IS NOT NULL THEN
    destination_dataset := job.dataset_id;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Choose a destination dataset or name a new one';
  END IF;

  -- Deterministic duplicate handling: a staged row whose external_id already
  -- exists in the destination dataset cannot be inserted. It is marked invalid
  -- with a machine-readable error and stays reviewable and exportable - never
  -- silently dropped, and never merged into an existing customer.
  IF stage = 'customers' THEN
    UPDATE public.import_rows AS staged
       SET validation_status = 'invalid',
           validation_errors = staged.validation_errors || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'code', 'duplicate_external_id',
               'field', 'external_id',
               'message', 'A record with this external id already exists in the destination dataset.'
             )
           )
     WHERE staged.import_job_id = job.id
       AND staged.validation_status = 'valid'
       AND staged.committed_record_id IS NULL
       AND staged.normalized_data ->> 'external_id' IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.customers AS existing
          WHERE existing.dataset_id = destination_dataset
            AND existing.external_id = staged.normalized_data ->> 'external_id'
       );
    GET DIAGNOSTICS conflicts = ROW_COUNT;
  ELSIF stage = 'locations' THEN
    UPDATE public.import_rows AS staged
       SET validation_status = 'invalid',
           validation_errors = staged.validation_errors || pg_catalog.jsonb_build_array(
             pg_catalog.jsonb_build_object(
               'code', 'duplicate_external_id',
               'field', 'external_id',
               'message', 'A record with this external id already exists in the destination dataset.'
             )
           )
     WHERE staged.import_job_id = job.id
       AND staged.validation_status = 'valid'
       AND staged.committed_record_id IS NULL
       AND staged.normalized_data ->> 'external_id' IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.locations AS existing
          WHERE existing.dataset_id = destination_dataset
            AND existing.external_id = staged.normalized_data ->> 'external_id'
       );
    GET DIAGNOSTICS conflicts = ROW_COUNT;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'This target entity is not enabled in Phase 5';
  END IF;

  -- Marker read by public.prevent_direct_import_completion(): only this
  -- function may write the completion fields. Transaction-local, and a
  -- PostgREST client has no exposed function that could set it.
  PERFORM pg_catalog.set_config('bli.import_commit_job', job.id::text, true);

  IF stage = 'customers' THEN
    WITH candidates AS (
      SELECT staged.id AS staged_id,
             pg_catalog.gen_random_uuid() AS record_id,
             staged.row_number,
             staged.longitude,
             staged.latitude,
             staged.normalized_data AS data
        FROM public.import_rows AS staged
       WHERE staged.import_job_id = job.id
         AND staged.validation_status = 'valid'
         AND staged.committed_record_id IS NULL
         AND staged.longitude IS NOT NULL
         AND staged.latitude IS NOT NULL
       ORDER BY staged.row_number
    ), inserted_records AS (
      INSERT INTO public.customers (
        id, workspace_id, dataset_id, external_id, name, phone, company, address,
        spatial_point, revenue, order_count, last_order_date, segment, source,
        import_job_id, source_row_number
      )
      SELECT candidate.record_id,
             job.workspace_id,
             destination_dataset,
             NULLIF(candidate.data ->> 'external_id', ''),
             NULLIF(candidate.data ->> 'name', ''),
             NULLIF(candidate.data ->> 'phone', ''),
             NULLIF(candidate.data ->> 'company', ''),
             NULLIF(candidate.data ->> 'address', ''),
             extensions.st_setsrid(
               extensions.st_makepoint(candidate.longitude, candidate.latitude),
               4326
             )::extensions.geography,
             NULLIF(candidate.data ->> 'revenue', '')::numeric(18, 2),
             NULLIF(candidate.data ->> 'order_count', '')::integer,
             NULLIF(candidate.data ->> 'last_order_date', '')::date,
             NULLIF(candidate.data ->> 'segment', ''),
             COALESCE(NULLIF(candidate.data ->> 'source', ''), job.original_filename),
             job.id,
             candidate.row_number
        FROM candidates AS candidate
       RETURNING id
    )
    UPDATE public.import_rows AS staged
       SET committed_record_id = candidate.record_id,
           committed_at = pg_catalog.now()
      FROM candidates AS candidate
     WHERE staged.id = candidate.staged_id;
    GET DIAGNOSTICS inserted = ROW_COUNT;
  ELSIF stage = 'locations' THEN
    WITH candidates AS (
      SELECT staged.id AS staged_id,
             pg_catalog.gen_random_uuid() AS record_id,
             staged.row_number,
             staged.longitude,
             staged.latitude,
             staged.normalized_data AS data
        FROM public.import_rows AS staged
       WHERE staged.import_job_id = job.id
         AND staged.validation_status = 'valid'
         AND staged.committed_record_id IS NULL
         AND staged.longitude IS NOT NULL
         AND staged.latitude IS NOT NULL
       ORDER BY staged.row_number
    ), inserted_records AS (
      INSERT INTO public.locations (
        id, workspace_id, dataset_id, name, category, subcategory, address,
        spatial_point, source, external_id, import_job_id, source_row_number
      )
      SELECT candidate.record_id,
             job.workspace_id,
             destination_dataset,
             COALESCE(NULLIF(candidate.data ->> 'name', ''), 'Imported location'),
             COALESCE(NULLIF(candidate.data ->> 'category', ''), 'imported'),
             NULLIF(candidate.data ->> 'subcategory', ''),
             NULLIF(candidate.data ->> 'address', ''),
             extensions.st_setsrid(
               extensions.st_makepoint(candidate.longitude, candidate.latitude),
               4326
             )::extensions.geography,
             COALESCE(NULLIF(candidate.data ->> 'source', ''), job.original_filename),
             NULLIF(candidate.data ->> 'external_id', ''),
             job.id,
             candidate.row_number
        FROM candidates AS candidate
       RETURNING id
    )
    UPDATE public.import_rows AS staged
       SET committed_record_id = candidate.record_id,
           committed_at = pg_catalog.now()
      FROM candidates AS candidate
     WHERE staged.id = candidate.staged_id;
    GET DIAGNOSTICS inserted = ROW_COUNT;
  END IF;

  UPDATE public.import_jobs AS target
     SET dataset_id = destination_dataset
   WHERE target.id = job.id;

  -- Status and committed_at are derived from the staging rows, so the summary
  -- can never disagree with the data that was actually promoted.
  PERFORM public.refresh_import_job_counters(job.id);

  RETURN QUERY
  SELECT job.id,
         destination_dataset,
         created_dataset,
         inserted,
         conflicts,
         already,
         refreshed.status
    FROM public.import_jobs AS refreshed
   WHERE refreshed.id = job.id;
END;
$function$;

COMMENT ON FUNCTION public.commit_import_job(uuid, uuid, text, text) IS
  'Promotes validated staged rows into the target table in one transaction. Idempotent (job row lock + committed_record_id guard), reports exact counts, marks duplicate external ids invalid instead of dropping them. SECURITY INVOKER with an explicit owner/admin/analyst assertion.';

REVOKE ALL ON FUNCTION public.commit_import_job(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_import_job(uuid, uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Manual map placement
-- ---------------------------------------------------------------------------

-- Records a user-placed point for one staged row. The original address is not
-- modified; the manual coordinates and the override flag are.
CREATE OR REPLACE FUNCTION public.set_import_row_manual_point(
  p_import_row_id uuid,
  p_longitude double precision,
  p_latitude double precision
)
RETURNS public.import_row_validation_status
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  staged public.import_rows;
BEGIN
  IF p_import_row_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import row id is required';
  END IF;
  IF p_longitude IS NULL OR p_latitude IS NULL
     OR p_longitude <> p_longitude OR p_latitude <> p_latitude
     OR p_longitude < -180 OR p_longitude > 180
     OR p_latitude < -90 OR p_latitude > 90 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid manual coordinates';
  END IF;

  SELECT * INTO staged
    FROM public.import_rows AS target
   WHERE target.id = p_import_row_id;

  IF staged.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Import row not found';
  END IF;

  IF NOT public.has_workspace_role(
       staged.workspace_id,
       ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Manual placement requires owner, admin or analyst membership';
  END IF;

  UPDATE public.import_rows AS target
     SET longitude = p_longitude,
         latitude = p_latitude,
         manual_override = true,
         geocoding_status = 'manual_override',
         geocoding_claimed_at = NULL,
         validation_status = 'valid',
         validation_errors = '[]'::jsonb,
         geocoding_result = pg_catalog.jsonb_build_object(
           'manual_override', true,
           'decision', 'accepted',
           'recorded_at', pg_catalog.now()
         )
   WHERE target.id = p_import_row_id;

  RETURN 'valid'::public.import_row_validation_status;
END;
$function$;

COMMENT ON FUNCTION public.set_import_row_manual_point(uuid, double precision, double precision) IS
  'Records an authorized user''s manual map placement for one staged row (validates coordinates server-side, keeps the original address). SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.set_import_row_manual_point(uuid, double precision, double precision)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_import_row_manual_point(uuid, double precision, double precision)
  TO authenticated;
