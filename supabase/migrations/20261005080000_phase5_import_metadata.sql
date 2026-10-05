-- Phase 5 (part 4 of 4): whitelisted import metadata updates.
--
-- The API records parse results (headers, sheets, warnings, the chosen mapping)
-- in `import_jobs.metadata`. Writing that from the API as a read-modify-write
-- would race with a second tab and would let a client write arbitrary keys into
-- a column some future code might trust. So the merge happens here, with a
-- whitelist: an unknown key is refused rather than stored.
--
-- Everything else about the job (workspace, creator, dataset, counters, status)
-- stays out of reach: counters and status are derived by
-- refresh_import_job_counters, and the immutability guard already refuses a
-- changed workspace or creator.

CREATE OR REPLACE FUNCTION public.update_import_job_metadata(
  p_import_job_id uuid,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  job public.import_jobs;
  allowed_keys constant text[] := ARRAY[
    'headers', 'sheets', 'warnings', 'parser', 'rowCount',
    'selectedSheet', 'suggestions', 'mapping', 'validatedAt'
  ];
  unknown_keys text;
  updated jsonb;
BEGIN
  IF p_import_job_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import job id is required';
  END IF;
  IF p_patch IS NULL OR pg_catalog.jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A metadata patch object is required';
  END IF;

  SELECT pg_catalog.string_agg(key, ', ')
    INTO unknown_keys
    FROM pg_catalog.jsonb_object_keys(p_patch) AS key
   WHERE key <> ALL (allowed_keys);
  IF unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = pg_catalog.format('Unsupported import metadata key(s): %s', unknown_keys);
  END IF;

  SELECT * INTO job
    FROM public.import_jobs AS target
   WHERE target.id = p_import_job_id;
  IF job.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Import job not found';
  END IF;
  IF NOT public.has_workspace_role(
       job.workspace_id,
       ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Updating an import requires owner, admin or analyst membership';
  END IF;

  UPDATE public.import_jobs AS target
     SET metadata = target.metadata || p_patch
   WHERE target.id = p_import_job_id
  RETURNING target.metadata INTO updated;

  RETURN updated;
END;
$function$;

COMMENT ON FUNCTION public.update_import_job_metadata(uuid, jsonb) IS
  'Merges whitelisted parse/mapping metadata into import_jobs.metadata (unknown keys are refused). SECURITY INVOKER with an explicit owner/admin/analyst assertion.';

REVOKE ALL ON FUNCTION public.update_import_job_metadata(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_import_job_metadata(uuid, jsonb)
  TO authenticated;
