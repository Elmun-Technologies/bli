-- Phase 5 import workflow, RLS, storage and commit assertions.
--
-- Run only against a local/test Supabase database after `supabase db reset`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase5_import_rls.sql
--
-- Every scenario runs as a real database role (`anon`, `authenticated`,
-- `service_role`) with real JWT claims in `request.jwt.claims`, so the policies
-- under test are exactly the policies PostgREST and the Storage API apply.
-- Nothing relies on application checks or hidden UI, and everything is rolled
-- back. Storage assertions run against storage.objects with the platform's own
-- privileges granted to the API roles, so row level security is the only thing
-- deciding the outcome - exactly as in production.
BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
DO $phase5_preflight$
DECLARE
  missing text;
BEGIN
  SELECT pg_catalog.string_agg(expected.email, ', ')
    INTO missing
    FROM (VALUES
      ('owner-a@example.test'),
      ('admin-a@example.test'),
      ('analyst-a@example.test'),
      ('viewer-a@example.test'),
      ('owner-b@example.test'),
      ('outsider@example.test')
    ) AS expected(email)
   WHERE NOT EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.email = expected.email);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Deterministic identities are missing: %', missing;
  END IF;

  IF pg_catalog.to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'storage.objects is missing: run this suite on Supabase (local or CI), not on a bare PostgreSQL database';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'workspace-imports' AND public = false) THEN
    RAISE EXCEPTION 'The workspace-imports bucket is missing or not private';
  END IF;

  RAISE NOTICE 'Preflight: identities, import tables and the private workspace-imports bucket are present';
END;
$phase5_preflight$;

-- ---------------------------------------------------------------------------
-- Assertion helpers (created by the table owner, executed as the caller)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.phase5_expect_denied(p_description text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $phase5_denied$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'DENIED CASE FAILED (statement was allowed): %', p_description;
  END IF;
  RAISE NOTICE 'denied as expected: %', p_description;
END;
$phase5_denied$;

CREATE FUNCTION pg_temp.phase5_expect_zero_rows(p_description text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $phase5_zero$
DECLARE
  touched bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS touched = ROW_COUNT;
  IF touched <> 0 THEN
    RAISE EXCEPTION 'SCOPED CASE FAILED (% rows changed, expected 0): %', touched, p_description;
  END IF;
  RAISE NOTICE 'scoped to zero rows as expected: %', p_description;
END;
$phase5_zero$;

CREATE FUNCTION pg_temp.phase5_expect_count(p_description text, p_sql text, p_expected bigint)
RETURNS void
LANGUAGE plpgsql
AS $phase5_count$
DECLARE
  actual bigint;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'COUNT CASE FAILED (got %, expected %): %', actual, p_expected, p_description;
  END IF;
  RAISE NOTICE 'count as expected (%): %', actual, p_description;
END;
$phase5_count$;

CREATE FUNCTION pg_temp.phase5_expect_error(p_description text, p_sql text, p_expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $phase5_error$
DECLARE
  actual_state text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    actual_state := SQLSTATE;
  END;
  IF actual_state IS NULL THEN
    RAISE EXCEPTION 'ERROR CASE FAILED (statement succeeded): %', p_description;
  END IF;
  IF actual_state <> p_expected_state THEN
    RAISE EXCEPTION 'ERROR CASE FAILED (got SQLSTATE %, expected %): %',
      actual_state, p_expected_state, p_description;
  END IF;
  RAISE NOTICE 'raised % as expected: %', actual_state, p_description;
END;
$phase5_error$;

-- A stored object is removed through the Storage API, never through SQL: the
-- platform protects storage.objects with a BEFORE DELETE trigger, and the
-- membership-scoped DELETE policy is what authorizes the API call. Whatever the
-- reason a direct attempt is refused, the file itself must survive.
CREATE FUNCTION pg_temp.phase5_expect_storage_preserved(
  p_description text,
  p_delete_sql text,
  p_check_sql text
)
RETURNS void
LANGUAGE plpgsql
AS $phase5_preserved$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    EXECUTE p_delete_sql;
  EXCEPTION WHEN others THEN
    refused := true;
  END;

  PERFORM pg_temp.phase5_expect_count(p_description, p_check_sql, 1);
  RAISE NOTICE 'storage preserved (direct delete refused: %): %', refused, p_description;
END;
$phase5_preserved$;

GRANT EXECUTE ON FUNCTION pg_temp.phase5_expect_denied(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase5_expect_storage_preserved(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase5_expect_zero_rows(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase5_expect_count(text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase5_expect_error(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Owner: the full happy path against a scratch import
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

CREATE TEMP TABLE phase5_job AS
SELECT * FROM public.import_jobs WHERE false;

WITH created AS (
  INSERT INTO public.import_jobs (
    workspace_id, created_by, original_filename, storage_path, file_type,
    status, target_entity, sheet_name, metadata
  )
  VALUES (
    '00000000-0000-4000-8000-000000000010',
    'a1000000-0000-4000-8000-000000000001',
    'phase5-customers.csv',
    '00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv',
    'csv',
    'mapping_required',
    'customers',
    NULL,
    '{"sheets":[],"parser":"csv"}'::jsonb
  )
  RETURNING *
)
INSERT INTO phase5_job SELECT * FROM created;

GRANT SELECT ON phase5_job TO authenticated;

INSERT INTO public.import_rows (
  import_job_id, workspace_id, row_number, raw_data, normalized_data,
  validation_status, validation_errors, geocoding_status, longitude, latitude
)
SELECT job.id, job.workspace_id, staged.row_number, staged.raw_data, staged.normalized_data,
       staged.validation_status::public.import_row_validation_status,
       staged.validation_errors::jsonb,
       staged.geocoding_status::public.import_row_geocoding_status,
       staged.longitude, staged.latitude
  FROM phase5_job AS job
  CROSS JOIN (VALUES
    (2, '{"name":"Ali","external_id":"phase5-a1","revenue":"1250000.50"}'::jsonb,
        '{"name":"Ali","external_id":"phase5-a1","revenue":"1250000.50","longitude":"69.2797","latitude":"41.3111"}'::jsonb,
        'valid', '[]', 'not_required', 69.2797::double precision, 41.3111::double precision),
    (3, '{"name":"Zuhra","revenue":"980000"}'::jsonb,
        '{"name":"Zuhra","revenue":"980000","longitude":"69.2850","latitude":"41.3200"}'::jsonb,
        'valid', '[]', 'not_required', 69.2850::double precision, 41.3200::double precision),
    (4, '{"name":"Botir","address":"Buxoro, Kogon 9"}'::jsonb,
        '{"name":"Botir","address":"Buxoro, Kogon 9"}'::jsonb,
        'needs_geocoding', '[]', 'pending', NULL, NULL),
    (5, '{"name":"Dilnoza","revenue":"not-money"}'::jsonb,
        '{"name":"Dilnoza"}'::jsonb,
        'invalid', '[{"code":"invalid_revenue","field":"revenue","message":"Revenue is not a valid amount."}]',
        'not_required', NULL, NULL)
  ) AS staged(row_number, raw_data, normalized_data, validation_status, validation_errors,
              geocoding_status, longitude, latitude);

DO $phase5_owner_happy$
DECLARE
  counters record;
  first_commit record;
  second_commit record;
  customer_count bigint;
  provenance_count bigint;
  staged_rows bigint;
BEGIN
  SELECT * INTO counters FROM public.refresh_import_job_counters((SELECT id FROM phase5_job));
  IF counters.total_rows <> 4 OR counters.valid_rows <> 2
     OR counters.needs_geocoding_rows <> 1 OR counters.invalid_rows <> 1 THEN
    RAISE EXCEPTION 'Counter refresh is wrong: %', pg_catalog.row_to_json(counters);
  END IF;
  IF counters.job_status <> 'review_required' THEN
    RAISE EXCEPTION 'A job with unresolved rows and invalid rows should require review, got %', counters.job_status;
  END IF;
  RAISE NOTICE 'Counters derive from staging rows: 4 total, 2 valid, 1 needs geocoding, 1 invalid';

  SELECT pg_catalog.count(*) INTO staged_rows FROM public.import_rows WHERE import_job_id = (SELECT id FROM phase5_job);

  SELECT * INTO first_commit
    FROM public.commit_import_job(
      (SELECT id FROM phase5_job),
      NULL,
      'Phase 5 Owner Import',
      'customers'
    );
  IF first_commit.inserted_rows <> 2 THEN
    RAISE EXCEPTION 'Commit inserted % rows, expected 2', first_commit.inserted_rows;
  END IF;
  IF first_commit.dataset_created IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Commit did not report the dataset it created';
  END IF;
  IF first_commit.job_status <> 'review_required' THEN
    RAISE EXCEPTION 'A partially committed job with unresolved rows must stay reviewable, got %', first_commit.job_status;
  END IF;

  SELECT pg_catalog.count(*) INTO customer_count
    FROM public.customers
   WHERE import_job_id = (SELECT id FROM phase5_job);
  IF customer_count <> 2 THEN
    RAISE EXCEPTION 'Expected 2 promoted customers, found %', customer_count;
  END IF;

  SELECT pg_catalog.count(*) INTO provenance_count
    FROM public.customers
   WHERE import_job_id = (SELECT id FROM phase5_job)
     AND source_row_number IN (2, 3);
  IF provenance_count <> 2 THEN
    RAISE EXCEPTION 'Provenance columns do not answer which import and source row created each record';
  END IF;

  -- Idempotency: the same commit again must not duplicate records, and must
  -- report the previous outcome.
  SELECT * INTO second_commit
    FROM public.commit_import_job((SELECT id FROM phase5_job), NULL, NULL, NULL);
  IF second_commit.inserted_rows <> 0 THEN
    RAISE EXCEPTION 'Repeated commit inserted % rows again', second_commit.inserted_rows;
  END IF;
  IF second_commit.previously_committed_rows <> 2 THEN
    RAISE EXCEPTION 'Repeated commit reported % previously committed rows, expected 2',
      second_commit.previously_committed_rows;
  END IF;

  SELECT pg_catalog.count(*) INTO customer_count
    FROM public.customers
   WHERE import_job_id = (SELECT id FROM phase5_job);
  IF customer_count <> 2 THEN
    RAISE EXCEPTION 'Repeated commit duplicated rows: % customers for one import', customer_count;
  END IF;

  -- Re-pointing a committed import at a different dataset is refused: the rows
  -- are already promoted, so a second destination could only be an empty one.
  BEGIN
    PERFORM public.commit_import_job(
      (SELECT id FROM phase5_job), NULL, 'Phase 5 Second Dataset', 'customers'
    );
    RAISE EXCEPTION 'A committed import must not be re-pointed at a new dataset';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF (SELECT pg_catalog.count(*) FROM public.datasets
       WHERE name = 'Phase 5 Second Dataset') <> 0 THEN
    RAISE EXCEPTION 'The refused re-commit still created a dataset';
  END IF;

  -- Invalid rows are never dropped: they stay staged, with their errors.
  IF (SELECT pg_catalog.count(*) FROM public.import_rows
       WHERE import_job_id = (SELECT id FROM phase5_job)) <> staged_rows THEN
    RAISE EXCEPTION 'Rows disappeared during commit';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.import_rows
       WHERE import_job_id = (SELECT id FROM phase5_job)
         AND validation_status = 'invalid'
         AND validation_errors -> 0 ->> 'code' = 'invalid_revenue') <> 1 THEN
    RAISE EXCEPTION 'The invalid row lost its machine-readable error';
  END IF;

  RAISE NOTICE 'Owner path: 4 staged rows, 2 promoted with provenance, repeated commit is idempotent, invalid row retained';
END;
$phase5_owner_happy$;

-- ---------------------------------------------------------------------------
-- Deterministic duplicates are reported, never silently merged
-- ---------------------------------------------------------------------------
DO $phase5_duplicates$
DECLARE
  job record;
  outcome record;
  duplicates bigint;
BEGIN
  INSERT INTO public.import_jobs (
    workspace_id, created_by, original_filename, file_type, status, target_entity,
    dataset_id, column_mapping
  )
  VALUES (
    '00000000-0000-4000-8000-000000000010',
    'a1000000-0000-4000-8000-000000000001',
    'phase5-duplicates.csv', 'csv', 'ready', 'customers',
    (SELECT dataset_id FROM public.import_jobs WHERE id = (SELECT id FROM phase5_job)),
    '{}'::jsonb
  )
  RETURNING * INTO job;

  INSERT INTO public.import_rows (
    import_job_id, workspace_id, row_number, raw_data, normalized_data,
    validation_status, geocoding_status, longitude, latitude
  ) VALUES (
    job.id, job.workspace_id, 2,
    '{"external_id":"phase5-a1"}'::jsonb,
    '{"external_id":"phase5-a1","name":"Ali duplicate"}'::jsonb,
    'valid', 'not_required', 69.2797, 41.3111
  );

  SELECT * INTO outcome FROM public.commit_import_job(job.id, NULL, NULL, NULL);
  IF outcome.inserted_rows <> 0 THEN
    RAISE EXCEPTION 'A conflicting external_id was inserted anyway';
  END IF;
  IF outcome.conflicting_rows <> 1 THEN
    RAISE EXCEPTION 'Expected 1 reported conflict, got %', outcome.conflicting_rows;
  END IF;

  SELECT pg_catalog.count(*) INTO duplicates
    FROM public.import_rows
   WHERE import_job_id = job.id
     AND validation_status = 'invalid'
     AND validation_errors -> 0 ->> 'code' = 'duplicate_external_id';
  IF duplicates <> 1 THEN
    RAISE EXCEPTION 'The conflicting row was not marked invalid with duplicate_external_id';
  END IF;

  RAISE NOTICE 'Deterministic duplicate: reported as conflicting_rows and marked invalid, never merged';
END;
$phase5_duplicates$;

-- ---------------------------------------------------------------------------
-- Completion guard: only the commit function may write completion fields
-- ---------------------------------------------------------------------------
DO $phase5_completion_guard$
BEGIN
  PERFORM pg_temp.phase5_expect_denied(
    'a direct UPDATE that claims completion',
    pg_catalog.format(
      'UPDATE public.import_jobs SET status = ''completed'', committed_at = pg_catalog.now() WHERE id = %L',
      (SELECT id FROM phase5_job)
    )
  );
  RAISE NOTICE 'Completion fields are writable by public.commit_import_job only';
END;
$phase5_completion_guard$;

-- ---------------------------------------------------------------------------
-- Geocoding claim: bounded, resumable, attempt-counted, viewer-denied
-- ---------------------------------------------------------------------------
DO $phase5_geocoding_claim$
DECLARE
  claimed record;
  second_claim bigint;
  requeued bigint;
BEGIN
  SELECT * INTO claimed FROM public.claim_import_geocoding_rows((SELECT id FROM phase5_job), 25);
  IF claimed.row_id IS NULL OR claimed.attempts <> 1 THEN
    RAISE EXCEPTION 'The claim did not return the address-only row with attempts = 1';
  END IF;
  IF claimed.address <> 'Buxoro, Kogon 9' THEN
    RAISE EXCEPTION 'The claim returned the wrong address: %', claimed.address;
  END IF;

  SELECT pg_catalog.count(*) INTO second_claim
    FROM public.claim_import_geocoding_rows((SELECT id FROM phase5_job), 25);
  IF second_claim <> 0 THEN
    RAISE EXCEPTION 'An in-flight row was claimed twice';
  END IF;

  -- Simulate a request that stopped halfway: the stale claim is requeued.
  UPDATE public.import_rows
     SET geocoding_status = 'success', longitude = 64.4211, latitude = 39.7747, updated_at = pg_catalog.now()
   WHERE id = claimed.row_id;

  UPDATE public.import_rows
     SET geocoding_status = 'geocoding',
         geocoding_claimed_at = pg_catalog.now() - interval '30 minutes'
   WHERE import_job_id = (SELECT id FROM phase5_job)
     AND validation_status = 'needs_geocoding';

  SELECT pg_catalog.count(*) INTO requeued
    FROM public.claim_import_geocoding_rows((SELECT id FROM phase5_job), 25);
  IF requeued <> 1 THEN
    RAISE EXCEPTION 'A stale claim was not requeued (got % rows)', requeued;
  END IF;

  RAISE NOTICE 'Geocoding claim: one bounded batch, no double claim, stale claim requeued after the stale window';
END;
$phase5_geocoding_claim$;

DO $phase5_geocoding_validation$
BEGIN
  PERFORM pg_temp.phase5_expect_error(
    'a batch larger than the documented maximum',
    'SELECT * FROM public.claim_import_geocoding_rows(' ||
      pg_catalog.quote_literal((SELECT id FROM phase5_job)) || ', 500)',
    '22023'
  );
END;
$phase5_geocoding_validation$;

-- ---------------------------------------------------------------------------
-- Manual map placement
-- ---------------------------------------------------------------------------
DO $phase5_manual_point$
DECLARE
  target uuid;
  resulting_status public.import_row_validation_status;
  stored record;
BEGIN
  SELECT id INTO target
    FROM public.import_rows
   WHERE import_job_id = (SELECT id FROM phase5_job)
     AND validation_status = 'needs_geocoding'
   ORDER BY row_number
   LIMIT 1;

  SELECT public.set_import_row_manual_point(target, 64.4150, 39.7700) INTO resulting_status;
  IF resulting_status <> 'valid' THEN
    RAISE EXCEPTION 'Manual placement did not make the row valid';
  END IF;

  SELECT geocoding_status, manual_override, longitude, latitude, normalized_data ->> 'address' AS address
    INTO stored
    FROM public.import_rows WHERE id = target;
  IF stored.geocoding_status <> 'manual_override' OR NOT stored.manual_override THEN
    RAISE EXCEPTION 'Manual placement was not recorded as an override';
  END IF;
  IF stored.longitude <> 64.4150 OR stored.latitude <> 39.7700 THEN
    RAISE EXCEPTION 'Manual coordinates were not stored as authoritative';
  END IF;
  IF stored.address <> 'Buxoro, Kogon 9' THEN
    RAISE EXCEPTION 'Manual placement silently modified the original address (%)', stored.address;
  END IF;

  PERFORM pg_temp.phase5_expect_error(
    'out-of-range manual coordinates',
    pg_catalog.format('SELECT public.set_import_row_manual_point(%L, 181, 41)', target),
    '22023'
  );

  RAISE NOTICE 'Manual placement: coordinates stored, override flagged, original address untouched, bounds enforced';
END;
$phase5_manual_point$;

-- ---------------------------------------------------------------------------
-- Storage: the owner uploads the import file for their own workspace
-- ---------------------------------------------------------------------------
DO $phase5_storage_upload$
DECLARE
  workspace_a_object text := '00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv';
BEGIN
  INSERT INTO storage.objects (bucket_id, name, owner, metadata)
  VALUES ('workspace-imports', workspace_a_object, 'a1000000-0000-4000-8000-000000000001',
          '{"mimetype":"text/csv","size":1024}'::jsonb);

  PERFORM pg_temp.phase5_expect_count(
    'an owner can read an import file of their workspace',
    pg_catalog.format('SELECT pg_catalog.count(*) FROM storage.objects WHERE name = %L', workspace_a_object),
    1
  );

  RAISE NOTICE 'Storage: the workspace import file exists and its own owner can read it';
END;
$phase5_storage_upload$;

-- ---------------------------------------------------------------------------
-- Viewer: read-only
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';

DO $phase5_viewer$
BEGIN
  PERFORM pg_temp.phase5_expect_count(
    'a viewer can read import jobs of their workspace',
    'SELECT pg_catalog.count(*) FROM public.import_jobs WHERE workspace_id = ''00000000-0000-4000-8000-000000000010''',
    2
  );
  PERFORM pg_temp.phase5_expect_count(
    'a viewer can read staged rows of their workspace',
    'SELECT pg_catalog.count(*) FROM public.import_rows WHERE workspace_id = ''00000000-0000-4000-8000-000000000010''',
    5
  );

  PERFORM pg_temp.phase5_expect_denied(
    'viewer creating an import job',
    'INSERT INTO public.import_jobs (workspace_id, created_by, original_filename, file_type, target_entity)
     VALUES (''00000000-0000-4000-8000-000000000010'', ''a1000000-0000-4000-8000-000000000004'', ''viewer.csv'', ''csv'', ''customers'')'
  );
  PERFORM pg_temp.phase5_expect_denied(
    'viewer inserting staged rows',
    pg_catalog.format(
      'INSERT INTO public.import_rows (import_job_id, workspace_id, row_number, raw_data)
       VALUES (%L, ''00000000-0000-4000-8000-000000000010'', 99, ''{}''::jsonb)',
      (SELECT id FROM phase5_job)
    )
  );
  PERFORM pg_temp.phase5_expect_zero_rows(
    'viewer updating a staged row',
    'UPDATE public.import_rows SET validation_status = ''valid'' WHERE workspace_id = ''00000000-0000-4000-8000-000000000010'''
  );
  PERFORM pg_temp.phase5_expect_zero_rows(
    'viewer updating an import job',
    'UPDATE public.import_jobs SET original_filename = ''hijacked.csv'' WHERE workspace_id = ''00000000-0000-4000-8000-000000000010'''
  );
  PERFORM pg_temp.phase5_expect_denied(
    'viewer claiming geocoding work',
    pg_catalog.format(
      'SELECT * FROM public.claim_import_geocoding_rows(%L, 25)',
      (SELECT id FROM phase5_job)
    )
  );
  PERFORM pg_temp.phase5_expect_denied(
    'viewer committing an import',
    pg_catalog.format('SELECT * FROM public.commit_import_job(%L, NULL, NULL, NULL)', (SELECT id FROM phase5_job))
  );
  PERFORM pg_temp.phase5_expect_denied(
    'viewer refreshing counters',
    pg_catalog.format('SELECT * FROM public.refresh_import_job_counters(%L)', (SELECT id FROM phase5_job))
  );
  PERFORM pg_temp.phase5_expect_count(
    'viewer sees no import file',
    'SELECT pg_catalog.count(*) FROM storage.objects
      WHERE bucket_id = ''workspace-imports''
        AND name = ''00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv''',
    0
  );
  RAISE NOTICE 'Viewer: can read import metadata, refused every write, the geocoding claim and the commit';
END;
$phase5_viewer$;

-- ---------------------------------------------------------------------------
-- Analyst: can import, cannot create datasets, cannot cross workspaces
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';

DO $phase5_analyst$
DECLARE
  job record;
  outcome record;
  denied boolean := false;
BEGIN
  INSERT INTO public.import_jobs (
    workspace_id, created_by, original_filename, file_type, status, target_entity, dataset_id
  )
  VALUES (
    '00000000-0000-4000-8000-000000000010',
    'a1000000-0000-4000-8000-000000000003',
    'phase5-analyst.csv', 'csv', 'ready', 'locations',
    '00000000-0000-4000-8000-000000000030'
  )
  RETURNING * INTO job;

  INSERT INTO public.import_rows (
    import_job_id, workspace_id, row_number, raw_data, normalized_data,
    validation_status, geocoding_status, longitude, latitude
  ) VALUES (
    job.id, job.workspace_id, 2, '{"name":"Analyst POI"}'::jsonb,
    '{"name":"Analyst POI","category":"retail"}'::jsonb,
    'valid', 'not_required', 69.2900, 41.3150
  );

  SELECT * INTO outcome FROM public.commit_import_job(job.id, NULL, NULL, NULL);
  IF outcome.inserted_rows <> 1 THEN
    RAISE EXCEPTION 'Analyst commit inserted % rows, expected 1', outcome.inserted_rows;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.locations
     WHERE import_job_id = job.id AND source_row_number = 2 AND workspace_id = job.workspace_id
  ) THEN
    RAISE EXCEPTION 'The analyst import did not reach public.locations with provenance';
  END IF;

  -- Analyst is not allowed to create datasets (Phase 4 matrix).
  BEGIN
    PERFORM public.commit_import_job(job.id, NULL, 'Analyst Created Dataset', 'customers');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'An analyst was allowed to create a dataset';
  END IF;

  RAISE NOTICE 'Analyst: can stage, validate and commit into an existing dataset; cannot create one';
END;
$phase5_analyst$;

-- ---------------------------------------------------------------------------
-- Cross-workspace: reads, writes, datasets, commit, provenance, storage
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';

DO $phase5_cross_workspace$
DECLARE
  job public.import_jobs;
BEGIN
  PERFORM pg_temp.phase5_expect_count(
    'workspace B cannot read workspace A import jobs',
    'SELECT pg_catalog.count(*) FROM public.import_jobs WHERE workspace_id = ''00000000-0000-4000-8000-000000000010''',
    0
  );
  PERFORM pg_temp.phase5_expect_count(
    'workspace B cannot read workspace A staged rows',
    'SELECT pg_catalog.count(*) FROM public.import_rows WHERE workspace_id = ''00000000-0000-4000-8000-000000000010''',
    0
  );
  PERFORM pg_temp.phase5_expect_denied(
    'workspace B creating an import inside workspace A',
    'INSERT INTO public.import_jobs (workspace_id, created_by, original_filename, file_type, target_entity)
     VALUES (''00000000-0000-4000-8000-000000000010'', ''b1000000-0000-4000-8000-000000000001'', ''intruder.csv'', ''csv'', ''customers'')'
  );
  PERFORM pg_temp.phase5_expect_denied(
    'workspace B staging rows inside workspace A',
    pg_catalog.format(
      'INSERT INTO public.import_rows (import_job_id, workspace_id, row_number, raw_data)
       VALUES (%L, ''00000000-0000-4000-8000-000000000010'', 1, ''{}''::jsonb)',
      (SELECT id FROM phase5_job)
    )
  );
  -- The composite foreign key (dataset_id, workspace_id) is what rejects this,
  -- one layer below RLS.
  PERFORM pg_temp.phase5_expect_error(
    'workspace B citing a workspace A dataset on its own job',
    'INSERT INTO public.import_jobs (workspace_id, created_by, original_filename, file_type, target_entity, dataset_id)
     VALUES (''00000000-0000-4000-8000-000000000011'', ''b1000000-0000-4000-8000-000000000001'', ''cross.csv'', ''csv'', ''customers'', ''00000000-0000-4000-8000-000000000033'')',
    '23503'
  );
  -- A foreign job is invisible, so the commit reports the same "not found" as a
  -- job that does not exist: no existence oracle for other tenants' imports.
  PERFORM pg_temp.phase5_expect_error(
    'workspace B committing a workspace A import',
    pg_catalog.format('SELECT * FROM public.commit_import_job(%L, NULL, ''B Dataset'', NULL)', (SELECT id FROM phase5_job)),
    'P0002'
  );

  -- Workspace B has its own import; pointing it at a workspace A dataset must
  -- fail both at the composite foreign key and at the explicit check.
  INSERT INTO public.import_jobs (
    workspace_id, created_by, original_filename, file_type, status, target_entity, dataset_id
  )
  VALUES (
    '00000000-0000-4000-8000-000000000011',
    'b1000000-0000-4000-8000-000000000001',
    'phase5-workspace-b.csv', 'csv', 'ready', 'customers',
    '00000000-0000-4000-8000-000000000037'
  );

  PERFORM pg_temp.phase5_expect_denied(
    'workspace B committing into a workspace A dataset',
    pg_catalog.format(
      'SELECT * FROM public.commit_import_job(%L, ''00000000-0000-4000-8000-000000000033'', NULL, NULL)',
      (SELECT id FROM public.import_jobs WHERE workspace_id = '00000000-0000-4000-8000-000000000011' ORDER BY created_at LIMIT 1)
    )
  );
  PERFORM pg_temp.phase5_expect_error(
    'workspace B citing a workspace A dataset',
    'INSERT INTO public.import_jobs (workspace_id, created_by, original_filename, file_type, target_entity, dataset_id)
     VALUES (''00000000-0000-4000-8000-000000000011'', ''b1000000-0000-4000-8000-000000000001'', ''phase5-cross.csv'', ''csv'', ''customers'', ''00000000-0000-4000-8000-000000000033'')',
    '23503'
  );
  PERFORM pg_temp.phase5_expect_error(
    'workspace B writing provenance that cites a workspace A import',
    pg_catalog.format(
      'INSERT INTO public.customers (workspace_id, dataset_id, external_id, spatial_point, import_job_id, source_row_number)
       VALUES (''00000000-0000-4000-8000-000000000011'', ''00000000-0000-4000-8000-000000000037'', ''phase5-b-provenance'',
               extensions.st_setsrid(extensions.st_makepoint(69.28, 41.31), 4326)::extensions.geography,
               %L, 2)',
      (SELECT id FROM phase5_job)
    ),
    '23503'
  );
  -- Owner B uploads a file for their own workspace, then proves they can neither
  -- see nor remove the file of workspace A.
  INSERT INTO storage.objects (bucket_id, name, owner)
  VALUES ('workspace-imports',
          '00000000-0000-4000-8000-000000000011/22222222-2222-4222-8222-222222222222/source.xlsx',
          'b1000000-0000-4000-8000-000000000001');
  PERFORM pg_temp.phase5_expect_count(
    'workspace B can read its own import file',
    'SELECT pg_catalog.count(*) FROM storage.objects
      WHERE bucket_id = ''workspace-imports''
        AND name = ''00000000-0000-4000-8000-000000000011/22222222-2222-4222-8222-222222222222/source.xlsx''',
    1
  );
  PERFORM pg_temp.phase5_expect_count(
    'workspace B cannot read workspace A import files',
    'SELECT pg_catalog.count(*) FROM storage.objects
      WHERE bucket_id = ''workspace-imports''
        AND name = ''00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv''',
    0
  );
  PERFORM pg_temp.phase5_expect_zero_rows(
    'deleting a workspace A import file from workspace B',
    'DELETE FROM storage.objects
      WHERE bucket_id = ''workspace-imports''
        AND name = ''00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv'''
  );

  RAISE NOTICE 'Cross-workspace: jobs, rows, datasets, commit, provenance and storage are all refused';
END;
$phase5_cross_workspace$;

-- ---------------------------------------------------------------------------
-- Re-parenting and immutability
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- RLS alone already blocks a caller who is not a member of workspace B. To reach
-- the immutability trigger as well, grant this user a genuine membership in both
-- workspaces first (as the operator/superuser, outside RLS - an authenticated
-- owner cannot add themselves to another tenant, which is the correct Phase 4
-- behavior). Then try to relocate the row: the trigger is the deciding layer.
RESET ROLE;
INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES ('00000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000001', 'admin');
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

DO $phase5_row_reparenting$
DECLARE
  denied boolean := false;
  moved boolean := false;
  job_id uuid := (SELECT id FROM phase5_job);
BEGIN
  BEGIN
    UPDATE public.import_jobs SET workspace_id = '00000000-0000-4000-8000-000000000011' WHERE id = job_id;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;

  SELECT EXISTS (
    SELECT 1 FROM public.import_jobs
     WHERE id = job_id AND workspace_id = '00000000-0000-4000-8000-000000000011'
  ) INTO moved;

  IF moved THEN
    RAISE EXCEPTION 'An import job was re-parented to another workspace';
  END IF;
  IF NOT denied THEN
    RAISE EXCEPTION 'Moving an import job across workspaces did not raise';
  END IF;

  -- The same immutability applies to staged rows.
  denied := false;
  BEGIN
    UPDATE public.import_rows SET workspace_id = '00000000-0000-4000-8000-000000000011'
     WHERE import_job_id = job_id;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'Staged rows were re-parented to another workspace';
  END IF;

  RAISE NOTICE 'Re-parenting: a user who belongs to both workspaces still cannot move an import job or its staged rows';
END;
$phase5_row_reparenting$;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, membership-scoped object access
-- ---------------------------------------------------------------------------
DO $phase5_storage$
DECLARE
  workspace_a_object text := '00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv';
  workspace_b_object text := '00000000-0000-4000-8000-000000000011/22222222-2222-4222-8222-222222222222/source.xlsx';
  malformed_object text := 'not-a-workspace/22222222-2222-4222-8222-222222222222/source.csv';
BEGIN
  PERFORM pg_temp.phase5_expect_count(
    'a member of both workspaces can read the workspace B import file',
    pg_catalog.format('SELECT pg_catalog.count(*) FROM storage.objects WHERE name = %L', workspace_b_object),
    1
  );

  -- A malformed path resolves to no workspace, so it grants nothing even though
  -- the caller is a legitimate member of a workspace.
  PERFORM pg_temp.phase5_expect_denied(
    'an upload with a path that does not start with a workspace UUID',
    pg_catalog.format(
      'INSERT INTO storage.objects (bucket_id, name, owner) VALUES (''workspace-imports'', %L, ''a1000000-0000-4000-8000-000000000001'')',
      malformed_object
    )
  );
  PERFORM pg_temp.phase5_expect_count(
    'the same caller cannot read the malformed-path object',
    pg_catalog.format('SELECT pg_catalog.count(*) FROM storage.objects WHERE name = %L', malformed_object),
    0
  );

  -- A direct DELETE is never how a stored file disappears: the platform refuses
  -- it (use the Storage API), and the membership-scoped DELETE policy is what
  -- authorizes that API call. Either way the file survives the attempt.
  PERFORM pg_temp.phase5_expect_storage_preserved(
    'a direct delete of the workspace A import file',
    pg_catalog.format('DELETE FROM storage.objects WHERE name = %L', workspace_a_object),
    pg_catalog.format('SELECT pg_catalog.count(*) FROM storage.objects WHERE name = %L', workspace_a_object)
  );
  PERFORM pg_temp.phase5_expect_storage_preserved(
    'a direct delete of the workspace B import file',
    pg_catalog.format('DELETE FROM storage.objects WHERE name = %L', workspace_b_object),
    pg_catalog.format('SELECT pg_catalog.count(*) FROM storage.objects WHERE name = %L', workspace_b_object)
  );

  RAISE NOTICE 'Storage: private bucket, membership-scoped access, malformed paths grant nothing, direct deletes never destroy a file';
END;
$phase5_storage$;

-- Viewer and anon against Storage
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';
DO $phase5_storage_viewer$
DECLARE
  workspace_a_object text := '00000000-0000-4000-8000-000000000010/11111111-1111-4111-8111-111111111111/source.csv';
BEGIN
  PERFORM pg_temp.phase5_expect_count(
    'a viewer sees no import file',
    pg_catalog.format('SELECT pg_catalog.count(*) FROM storage.objects WHERE name = %L', workspace_a_object),
    0
  );
  PERFORM pg_temp.phase5_expect_denied(
    'a viewer upload to the imports bucket',
    pg_catalog.format(
      'INSERT INTO storage.objects (bucket_id, name, owner) VALUES (''workspace-imports'', %L, ''a1000000-0000-4000-8000-000000000004'')',
      workspace_a_object
    )
  );
END;
$phase5_storage_viewer$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $phase5_anon$
DECLARE
  denied boolean := false;
  visible bigint := -1;
BEGIN
  -- Import tables: anon has no table privilege at all, so the statement is
  -- refused outright rather than filtered.
  BEGIN
    PERFORM pg_catalog.count(*) FROM public.import_jobs;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon read public.import_jobs'; END IF;

  denied := false;
  BEGIN
    PERFORM pg_catalog.count(*) FROM public.import_rows;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon read public.import_rows'; END IF;

  -- Storage: either the privilege is refused or RLS filters everything out.
  -- Both outcomes are "anon sees nothing"; the assertion accepts either but not
  -- a visible import object.
  denied := false;
  visible := -1;
  BEGIN
    SELECT pg_catalog.count(*) INTO visible FROM storage.objects;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied AND visible <> 0 THEN
    RAISE EXCEPTION 'anon saw % storage objects', visible;
  END IF;

  denied := false;
  visible := -1;
  BEGIN
    SELECT pg_catalog.count(*) INTO visible
      FROM storage.buckets
     WHERE id = 'workspace-imports';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied AND visible <> 0 THEN
    RAISE EXCEPTION 'anon saw the private imports bucket';
  END IF;

  RAISE NOTICE 'anon: no import table privileges and no visibility of import files or the private bucket';
END;
$phase5_anon$;

-- ---------------------------------------------------------------------------
-- Grant matrix
-- ---------------------------------------------------------------------------
RESET ROLE;
DO $phase5_grants$
DECLARE
  offending text;
BEGIN
  SELECT pg_catalog.string_agg(table_name || ':' || privilege_type, ', ')
    INTO offending
    FROM information_schema.role_table_grants
   WHERE grantee = 'anon'
     AND table_schema = 'public'
     AND table_name IN ('import_jobs', 'import_rows');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'anon holds import privileges: %', offending;
  END IF;

  SELECT pg_catalog.string_agg(table_name || ':' || privilege_type, ', ')
    INTO offending
    FROM information_schema.role_table_grants
   WHERE grantee = 'authenticated'
     AND table_schema = 'public'
     AND table_name IN ('import_jobs', 'import_rows')
     AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated holds a destructive import privilege: %', offending;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'workspace_imports_select_analyst'
  ) THEN
    RAISE EXCEPTION 'The storage select policy is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname LIKE 'workspace_imports_%'
       AND (qual = 'true' OR with_check = 'true')
  ) THEN
    RAISE EXCEPTION 'A blanket import storage policy exists';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname LIKE 'workspace_imports_%') <> 4 THEN
    RAISE EXCEPTION 'Expected exactly four workspace_imports storage policies';
  END IF;

  RAISE NOTICE 'Grant matrix: anon has no import privileges, authenticated has no destructive privilege, storage policies are member-scoped';
END;
$phase5_grants$;

DO $phase5_no_blanket_policies$
DECLARE
  offending text;
BEGIN
  SELECT pg_catalog.string_agg(policyname, ', ')
    INTO offending
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('import_jobs', 'import_rows')
     AND (qual = 'true' OR with_check = 'true');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Blanket import policies exist: %', offending;
  END IF;
  RAISE NOTICE 'No import policy is a blanket USING (true) rule';
END;
$phase5_no_blanket_policies$;

ROLLBACK;
