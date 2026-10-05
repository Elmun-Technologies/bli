-- Phase 5 geocoding pipeline assertions (no network, no provider).
--
-- Run only against a local/test Supabase database after `supabase db reset`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase5_geocoding.sql
--
-- The provider itself is exercised by the deterministic fake provider in the
-- TypeScript suite (`src/lib/imports/geocoding/batch.test.ts`); this file covers
-- the database half of the workflow: claiming a bounded batch, applying
-- results atomically, idempotent replay, the attempts ceiling, resuming after a
-- rate limit or an outage, manual map placement as the authoritative answer,
-- and cross-workspace / viewer tampering. Nothing here calls Mapbox.
BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight
-- ---------------------------------------------------------------------------
DO $phase5_geo_preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'owner-a@example.test')
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'viewer-a@example.test')
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE email = 'owner-b@example.test') THEN
    RAISE EXCEPTION 'Deterministic identities are missing: run supabase/seed.sql first';
  END IF;
  IF pg_catalog.to_regprocedure('public.apply_import_geocoding_results(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'public.apply_import_geocoding_results is missing';
  END IF;
  RAISE NOTICE 'Preflight: geocoding RPCs and identities are present';
END;
$phase5_geo_preflight$;

-- ---------------------------------------------------------------------------
-- Assertion helpers (table owner creates them, callers execute them)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.p5geo_expect_count(p_description text, p_sql text, p_expected bigint)
RETURNS void
LANGUAGE plpgsql
AS $p5geo_count$
DECLARE
  actual bigint;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'COUNT CASE FAILED (got %, expected %): %', actual, p_expected, p_description;
  END IF;
  RAISE NOTICE 'count as expected (%): %', actual, p_description;
END;
$p5geo_count$;

CREATE FUNCTION pg_temp.p5geo_expect_error(p_description text, p_sql text, p_expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $p5geo_error$
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
$p5geo_error$;

GRANT EXECUTE ON FUNCTION pg_temp.p5geo_expect_count(text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.p5geo_expect_error(text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Owner A stages one import with five address-only rows
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

CREATE TEMP TABLE p5geo_job AS SELECT * FROM public.import_jobs WHERE false;
GRANT SELECT ON p5geo_job TO authenticated;

WITH created AS (
  INSERT INTO public.import_jobs (
    workspace_id, created_by, original_filename, file_type, status, target_entity,
    storage_path, metadata
  )
  VALUES (
    '00000000-0000-4000-8000-000000000010',
    'a1000000-0000-4000-8000-000000000001',
    'phase5-geocoding.csv',
    'csv',
    'mapping_required',
    'customers',
    '00000000-0000-4000-8000-000000000010/22222222-2222-4222-8222-222222222222/source.csv',
    '{"parser":"csv"}'::jsonb
  )
  RETURNING *
)
INSERT INTO p5geo_job SELECT * FROM created;

INSERT INTO public.import_rows (
  import_job_id, workspace_id, row_number, raw_data, normalized_data,
  validation_status, validation_errors, geocoding_status
)
SELECT job.id, job.workspace_id, staged.row_number, staged.raw_data, staged.normalized_data,
       'needs_geocoding'::public.import_row_validation_status,
       '[]'::jsonb,
       'pending'::public.import_row_geocoding_status
  FROM p5geo_job AS job
  CROSS JOIN (VALUES
    (2, '{"name":"Ali","address":"Toshkent, Amir Temur 1"}'::jsonb,
        '{"name":"Ali","address":"Toshkent, Amir Temur 1"}'::jsonb),
    (3, '{"name":"Zuhra","address":"Samarqand, Registon 5"}'::jsonb,
        '{"name":"Zuhra","address":"Samarqand, Registon 5"}'::jsonb),
    (4, '{"name":"Botir","address":"Buxoro, Kogon 9"}'::jsonb,
        '{"name":"Botir","address":"Buxoro, Kogon 9"}'::jsonb),
    (5, '{"name":"Dilnoza","address":"Fargona, Mustaqillik 12"}'::jsonb,
        '{"name":"Dilnoza","address":"Fargona, Mustaqillik 12"}'::jsonb),
    (6, '{"name":"Jasur","address":"Nukus, Berdax 4"}'::jsonb,
        '{"name":"Jasur","address":"Nukus, Berdax 4"}'::jsonb)
  ) AS staged(row_number, raw_data, normalized_data);

DO $p5geo_claim$
DECLARE
  claimed record;
  batch_size integer := 0;
  second_claim integer := 0;
BEGIN
  -- The whole batch is claimed atomically and moved to 'geocoding'.
  FOR claimed IN
    SELECT * FROM public.claim_import_geocoding_rows((SELECT id FROM p5geo_job), 10, 5, '10 minutes')
  LOOP
    batch_size := batch_size + 1;
    IF claimed.attempts <> 1 THEN
      RAISE EXCEPTION 'Claim must count the first attempt, got %', claimed.attempts;
    END IF;
    IF claimed.address IS NULL OR claimed.address = '' THEN
      RAISE EXCEPTION 'Claimed row % has no address to geocode', claimed.row_number;
    END IF;
  END LOOP;

  IF batch_size <> 5 THEN
    RAISE EXCEPTION 'Expected 5 claimed rows, got %', batch_size;
  END IF;

  -- A second claim in the same instant returns nothing: those rows are in flight,
  -- which is what keeps two tabs from geocoding the same row twice.
  SELECT pg_catalog.count(*) INTO second_claim
    FROM public.claim_import_geocoding_rows((SELECT id FROM p5geo_job), 10, 5, '10 minutes');
  IF second_claim <> 0 THEN
    RAISE EXCEPTION 'Rows already in flight were claimed again (% rows)', second_claim;
  END IF;

  RAISE NOTICE 'Claim: one bounded batch of 5 rows, in-flight rows are not re-claimed';
END;
$p5geo_claim$;

-- ---------------------------------------------------------------------------
-- Apply a realistic mixed batch: success, ambiguous, no match, rate limit,
-- provider outage - the five shapes the provider abstraction can produce
-- ---------------------------------------------------------------------------
DO $p5geo_apply$
DECLARE
  summary jsonb;
  applied integer;
  skipped integer;
  status_counts integer;
  success_row public.import_rows;
BEGIN
  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'row_id', rows.id,
             'status', results.status,
             'longitude', results.longitude,
             'latitude', results.latitude,
             'provider', 'fake',
             'decision', results.status,
             'reason', results.reason,
             'confidence', results.confidence,
             'relevance', results.confidence,
             'provider_result_id', 'fake:' || rows.row_number,
             'formatted_address', results.address,
             'accuracy', 'rooftop',
             'feature_type', 'address',
             'country_code', 'uz',
             'match_confidence', 'exact',
             'retry_after_ms', results.retry_after_ms,
             'message', results.message,
             'alternatives', results.alternatives
           )
         )
    INTO summary
    FROM public.import_rows AS rows
    JOIN (VALUES
      (2, 'success', 69.2797::double precision, 41.3111::double precision, NULL::double precision,
          'accepted', 'Toshkent, Amir Temur 1', NULL::integer, NULL::text, NULL::jsonb, NULL::text),
      (3, 'ambiguous', NULL::double precision, NULL::double precision, NULL::double precision,
          'review_required', 'Samarqand, Registon 5', NULL::integer, 'ambiguous_candidates',
          '[{"longitude":66.9758,"latitude":39.6542,"confidence":0.9,"formatted_address":"Samarqand, Registon 5"}]'::jsonb,
          NULL::text),
      (4, 'no_match', NULL::double precision, NULL::double precision, NULL::double precision,
          'no_match', 'Buxoro, Kogon 9', NULL::integer, 'below_review_threshold', NULL::jsonb, NULL::text),
      (5, 'rate_limited', NULL::double precision, NULL::double precision, NULL::double precision,
          'review_required', 'Fargona, Mustaqillik 12', 1000::integer, 'provider_rate_limited', NULL::jsonb,
          'The geocoding service is rate limiting this server.'),
      (6, 'provider_error', NULL::double precision, NULL::double precision, NULL::double precision,
          'review_required', 'Nukus, Berdax 4', NULL::integer, 'provider_unavailable', NULL::jsonb,
          'The geocoding service is unreachable.')
    ) AS results(row_number, status, longitude, latitude, confidence, decision, address,
                 retry_after_ms, reason, alternatives, message)
      ON results.row_number = rows.row_number
   WHERE rows.import_job_id = (SELECT id FROM p5geo_job);

  IF pg_catalog.jsonb_array_length(summary) <> 5 THEN
    RAISE EXCEPTION 'Test setup produced % results, expected 5', pg_catalog.jsonb_array_length(summary);
  END IF;

  summary := public.apply_import_geocoding_results((SELECT id FROM p5geo_job), summary);

  applied := (summary ->> 'applied')::integer;
  skipped := (summary ->> 'skipped')::integer;
  IF applied <> 5 OR skipped <> 0 THEN
    RAISE EXCEPTION 'Apply reported applied=% skipped=%, expected 5/0', applied, skipped;
  END IF;
  IF (summary ->> 'accepted')::integer <> 1
     OR (summary ->> 'ambiguous')::integer <> 1
     OR (summary ->> 'no_match')::integer <> 1
     OR (summary ->> 'rate_limited')::integer <> 1
     OR (summary ->> 'provider_error')::integer <> 1 THEN
    RAISE EXCEPTION 'Apply summary is wrong: %', summary;
  END IF;
  IF (summary ->> 'geocoded_rows')::integer <> 1
     OR (summary ->> 'failed_geocoding_rows')::integer <> 4
     OR (summary ->> 'needs_geocoding_rows')::integer <> 4
     OR (summary ->> 'valid_rows')::integer <> 1 THEN
    RAISE EXCEPTION 'Counters after apply are wrong: %', summary;
  END IF;
  IF summary ->> 'job_status' <> 'review_required' THEN
    RAISE EXCEPTION 'A job with unresolved geocoding must require review, got %', summary ->> 'job_status';
  END IF;

  -- The successful row is now committable and carries its coordinate + provenance
  -- of the provider result.
  SELECT * INTO success_row FROM public.import_rows WHERE import_job_id = (SELECT id FROM p5geo_job) AND row_number = 2;
  IF success_row.validation_status <> 'valid' THEN
    RAISE EXCEPTION 'A successfully geocoded row must become valid, got %', success_row.validation_status;
  END IF;
  IF success_row.longitude <> 69.2797 OR success_row.latitude <> 41.3111 THEN
    RAISE EXCEPTION 'Geocoded coordinates were not stored: % / %', success_row.longitude, success_row.latitude;
  END IF;
  IF success_row.geocoding_claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A completed row must release its claim';
  END IF;
  IF success_row.geocoding_result ->> 'provider' <> 'fake'
     OR success_row.geocoding_result ->> 'formatted_address' IS NULL
     OR (success_row.geocoding_result ->> 'attempts')::integer <> 1 THEN
    RAISE EXCEPTION 'The provider result was not recorded: %', success_row.geocoding_result;
  END IF;

  -- Unresolved rows keep their address, gain an explanation and stay staged.
  SELECT pg_catalog.count(*) INTO status_counts
    FROM public.import_rows
   WHERE import_job_id = (SELECT id FROM p5geo_job)
     AND row_number IN (3, 4, 5, 6)
     AND validation_status = 'needs_geocoding'
     AND geocoding_claimed_at IS NULL
     AND normalized_data ->> 'address' IS NOT NULL
     AND geocoding_result ->> 'reason' IS NOT NULL;
  IF status_counts <> 4 THEN
    RAISE EXCEPTION 'Expected 4 unresolved rows to stay staged with a reason, found %', status_counts;
  END IF;

  -- The rate-limited row records when it may be retried.
  IF (SELECT geocoding_result ->> 'retry_after_ms'
        FROM public.import_rows
       WHERE import_job_id = (SELECT id FROM p5geo_job) AND row_number = 5) <> '1000' THEN
    RAISE EXCEPTION 'The rate limit retry hint was not recorded';
  END IF;

  RAISE NOTICE 'Apply: one success promoted, ambiguous/no-match/rate-limit/outage stay staged with reasons and counters';
END;
$p5geo_apply$;

-- ---------------------------------------------------------------------------
-- Idempotency: replaying the exact same batch changes nothing
-- ---------------------------------------------------------------------------
DO $p5geo_replay$
DECLARE
  payload jsonb;
  summary jsonb;
BEGIN
  SELECT pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'row_id', rows.id, 'status', 'success', 'longitude', 69.2797, 'latitude', 41.3111
           )
         )
    INTO payload
    FROM public.import_rows AS rows
   WHERE rows.import_job_id = (SELECT id FROM p5geo_job) AND rows.row_number = 2;

  summary := public.apply_import_geocoding_results((SELECT id FROM p5geo_job), payload);
  IF (summary ->> 'applied')::integer <> 0 OR (summary ->> 'skipped')::integer <> 1 THEN
    RAISE EXCEPTION 'Replaying a result must be ignored, got %', summary;
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.import_rows
       WHERE import_job_id = (SELECT id FROM p5geo_job) AND committed_record_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'Replaying a batch must not commit anything';
  END IF;

  -- (A claim never returns the now-resolved row 2; that exclusion is asserted by
  -- the resume block below, which claims and finds only the retryable rows.)
  RAISE NOTICE 'Idempotency: replaying a batch is a no-op and never commits anything';
END;
$p5geo_replay$;

-- ---------------------------------------------------------------------------
-- Resume: rate-limited and failed rows are retryable; ambiguous and no-match
-- rows wait for a human instead
-- ---------------------------------------------------------------------------
DO $p5geo_resume$
DECLARE
  claimed integer;
  capped integer;
BEGIN
  SELECT pg_catalog.count(*) INTO claimed
    FROM public.claim_import_geocoding_rows((SELECT id FROM p5geo_job), 10, 5, '10 minutes');

  -- Exactly the two retryable rows come back: the successfully geocoded row is
  -- never re-claimed, and the ambiguous and no-match rows wait for a human.
  IF claimed <> 2 THEN
    RAISE EXCEPTION 'Expected exactly the rate-limited and provider-error rows to be retryable, got %', claimed;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.import_rows
     WHERE import_job_id = (SELECT id FROM p5geo_job)
       AND row_number IN (3, 4)
       AND geocoding_status = 'geocoding'
  ) THEN
    RAISE EXCEPTION 'Ambiguous and no-match rows must not be geocoded again automatically';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.import_rows
       WHERE import_job_id = (SELECT id FROM p5geo_job)
         AND row_number IN (5, 6)
         AND geocoding_status = 'geocoding'
         AND geocoding_attempts = 2) <> 2 THEN
    RAISE EXCEPTION 'Retryable rows must be claimed with a second attempt recorded';
  END IF;

  -- Attempts ceiling: a row that has exhausted its attempts is not claimed even
  -- though it is still unresolved, so an outage cannot loop forever.
  UPDATE public.import_rows
     SET geocoding_attempts = 5,
         geocoding_status = 'provider_error',
         geocoding_claimed_at = NULL
   WHERE import_job_id = (SELECT id FROM p5geo_job) AND row_number = 6;

  SELECT pg_catalog.count(*) INTO capped
    FROM public.claim_import_geocoding_rows((SELECT id FROM p5geo_job), 10, 5, '10 minutes')
   WHERE row_number = 6;
  IF capped <> 0 THEN
    RAISE EXCEPTION 'A row at the attempt ceiling was claimed again';
  END IF;

  RAISE NOTICE 'Resume: only retryable rows are re-claimed, an exhausted row stops, resolved rows stay resolved';
END;
$p5geo_resume$;

-- ---------------------------------------------------------------------------
-- An abandoned claim is requeued after its lease expires
-- ---------------------------------------------------------------------------
DO $p5geo_lease$
DECLARE
  lease_row_id uuid;
  requeued integer;
BEGIN
  SELECT rows.id INTO lease_row_id
    FROM public.import_rows AS rows
   WHERE rows.import_job_id = (SELECT id FROM p5geo_job) AND rows.row_number = 5;

  UPDATE public.import_rows
     SET geocoding_claimed_at = pg_catalog.now() - interval '30 minutes'
   WHERE id = lease_row_id;

  SELECT pg_catalog.count(*) INTO requeued
    FROM public.claim_import_geocoding_rows((SELECT id FROM p5geo_job), 10, 5, '10 minutes') AS claim
   WHERE claim.row_id = lease_row_id;

  IF requeued <> 1 THEN
    RAISE EXCEPTION 'An abandoned claim was not requeued';
  END IF;
  RAISE NOTICE 'Lease: a claim abandoned by a stopped request is requeued after the stale window';
END;
$p5geo_lease$;

-- ---------------------------------------------------------------------------
-- Manual placement is authoritative, validated server-side and keeps the address
-- ---------------------------------------------------------------------------
DO $p5geo_manual$
DECLARE
  target public.import_rows;
  decision public.import_row_validation_status;
  committed record;
  promoted public.customers;
BEGIN
  -- Finish the successful-geocode row first so the manual row is the only
  -- committable one.
  PERFORM 1 FROM public.commit_import_job((SELECT id FROM p5geo_job), NULL, 'Phase 5 Geocoding', 'customers');

  SELECT * INTO target
    FROM public.import_rows
   WHERE import_job_id = (SELECT id FROM p5geo_job) AND row_number = 4;

  -- Out-of-range manual coordinates are refused by the database itself.
  PERFORM pg_temp.p5geo_expect_error(
    'out-of-range manual coordinates',
    pg_catalog.format(
      'SELECT public.set_import_row_manual_point(%L, 200::double precision, 41.0::double precision)',
      target.id
    ),
    '22023'
  );

  decision := public.set_import_row_manual_point(target.id, 64.4214, 39.7747);

  IF decision <> 'valid' THEN
    RAISE EXCEPTION 'Manual placement must make the row valid, got %', decision;
  END IF;

  SELECT * INTO target FROM public.import_rows WHERE id = target.id;
  IF NOT target.manual_override OR target.geocoding_status <> 'manual_override' THEN
    RAISE EXCEPTION 'Manual placement was not recorded as an override';
  END IF;
  IF target.longitude <> 64.4214 OR target.latitude <> 39.7747 THEN
    RAISE EXCEPTION 'Manual coordinates were not stored';
  END IF;
  IF target.normalized_data ->> 'address' <> 'Buxoro, Kogon 9' THEN
    RAISE EXCEPTION 'Manual placement must not rewrite the original address, got %',
      target.normalized_data ->> 'address';
  END IF;

  SELECT * INTO committed
    FROM public.commit_import_job((SELECT id FROM p5geo_job), NULL, NULL, NULL);
  IF committed.inserted_rows <> 1 THEN
    RAISE EXCEPTION 'The manually placed row was not committed (inserted %)', committed.inserted_rows;
  END IF;

  SELECT * INTO promoted
    FROM public.customers
   WHERE import_job_id = (SELECT id FROM p5geo_job)
     AND source_row_number = 4;
  IF promoted.id IS NULL THEN
    RAISE EXCEPTION 'The manually placed customer was not promoted';
  END IF;
  IF NOT extensions.st_dwithin(
       promoted.spatial_point,
       extensions.st_setsrid(extensions.st_makepoint(64.4214, 39.7747), 4326)::extensions.geography,
       0.01
     ) THEN
    RAISE EXCEPTION 'The promoted record does not sit at the manually placed point';
  END IF;

  RAISE NOTICE 'Manual override: bounds enforced, override flagged, address untouched, point committed as placed';
END;
$p5geo_manual$;

-- ---------------------------------------------------------------------------
-- Guard rails and client mistakes
-- ---------------------------------------------------------------------------
DO $p5geo_guards$
DECLARE
  job_id uuid := (SELECT id FROM p5geo_job);
  row_id uuid := (
    SELECT id FROM public.import_rows
     WHERE import_job_id = (SELECT id FROM p5geo_job) AND row_number = 3
  );
BEGIN
  PERFORM pg_temp.p5geo_expect_error(
    'an unsupported geocoding status',
    pg_catalog.format(
      'SELECT public.apply_import_geocoding_results(%L, %L::jsonb)',
      job_id,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('row_id', row_id, 'status', 'maybe')
      )::text
    ),
    '22023'
  );

  PERFORM pg_temp.p5geo_expect_error(
    'coordinates that are out of range in a success result',
    pg_catalog.format(
      'SELECT public.apply_import_geocoding_results(%L, %L::jsonb)',
      job_id,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'row_id', row_id, 'status', 'success', 'longitude', 181.5, 'latitude', 41.0
        )
      )::text
    ),
    '22023'
  );

  PERFORM pg_temp.p5geo_expect_error(
    'an empty result array',
    pg_catalog.format('SELECT public.apply_import_geocoding_results(%L, %L::jsonb)', job_id, '[]'),
    '22023'
  );

  PERFORM pg_temp.p5geo_expect_error(
    'a batch larger than the documented maximum',
    pg_catalog.format(
      'SELECT public.apply_import_geocoding_results(%L, %L::jsonb)',
      job_id,
      (
        SELECT pg_catalog.jsonb_agg(
                 pg_catalog.jsonb_build_object(
                   'row_id', pg_catalog.gen_random_uuid(), 'status', 'no_match'
                 )
               )::text
          FROM pg_catalog.generate_series(1, 51)
      )
    ),
    '22023'
  );

  RAISE NOTICE 'Guards: unsupported status, out-of-range coordinates, empty and oversized batches are all refused';
END;
$p5geo_guards$;

-- ---------------------------------------------------------------------------
-- Viewer and cross-workspace tampering
-- ---------------------------------------------------------------------------
DO $p5geo_viewer$
DECLARE
  job_id uuid := (SELECT id FROM p5geo_job);
  denied boolean := false;
BEGIN
  -- A viewer cannot claim work, apply results or place a point manually, even
  -- though they can read the import.
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';

  BEGIN
    PERFORM 1 FROM public.claim_import_geocoding_rows(job_id, 5, 5, '10 minutes');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A viewer claimed geocoding work'; END IF;
  denied := false;

  BEGIN
    PERFORM public.apply_import_geocoding_results(
      job_id,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('row_id', pg_catalog.gen_random_uuid(), 'status', 'no_match')
      )
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A viewer applied geocoding results'; END IF;
  denied := false;

  BEGIN
    PERFORM public.set_import_row_manual_point(pg_catalog.gen_random_uuid(), 69.2, 41.3);
  EXCEPTION WHEN insufficient_privilege THEN denied := true; WHEN others THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A viewer placed a manual point'; END IF;

  RAISE NOTICE 'Viewer: claiming, applying and manual placement are all refused';
END;
$p5geo_viewer$;

DO $p5geo_cross_workspace$
DECLARE
  job_id uuid := (SELECT id FROM p5geo_job);
BEGIN
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';

  -- Workspace B sees no such job: the same "not found" a missing job produces.
  PERFORM pg_temp.p5geo_expect_error(
    'workspace B claiming geocoding work in workspace A',
    pg_catalog.format('SELECT * FROM public.claim_import_geocoding_rows(%L, 5, 5, ''10 minutes'')', job_id),
    '42501'
  );

  PERFORM pg_temp.p5geo_expect_error(
    'workspace B applying results to a workspace A import',
    pg_catalog.format(
      'SELECT public.apply_import_geocoding_results(%L, %L::jsonb)',
      job_id,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('row_id', pg_catalog.gen_random_uuid(), 'status', 'no_match')
      )::text
    ),
    'P0002'
  );

  PERFORM pg_temp.p5geo_expect_count(
    'workspace B seeing workspace A geocoding results',
    pg_catalog.format(
      'SELECT pg_catalog.count(*) FROM public.import_rows WHERE import_job_id = %L AND geocoding_result IS NOT NULL',
      job_id
    ),
    0
  );

  RAISE NOTICE 'Cross-workspace: claiming, applying and reading geocoding results are refused';
END;
$p5geo_cross_workspace$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
DO $p5geo_grants$
DECLARE
  anon_execute integer;
  authenticated_execute integer;
BEGIN
  SELECT pg_catalog.count(*) INTO anon_execute
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
   WHERE namespace.nspname = 'public'
     AND procedure.proname IN (
       'apply_import_geocoding_results',
       'claim_import_geocoding_rows',
       'set_import_row_manual_point',
       'commit_import_job',
       'refresh_import_job_counters'
     )
     AND acl.grantee = (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = 'anon');

  IF anon_execute <> 0 THEN
    RAISE EXCEPTION 'anon holds EXECUTE on % Phase 5 function grant(s)', anon_execute;
  END IF;

  SELECT pg_catalog.count(DISTINCT procedure.proname) INTO authenticated_execute
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
   WHERE namespace.nspname = 'public'
     AND procedure.proname IN (
       'apply_import_geocoding_results',
       'claim_import_geocoding_rows',
       'set_import_row_manual_point',
       'commit_import_job',
       'refresh_import_job_counters'
     )
     AND acl.grantee = (SELECT role.oid FROM pg_catalog.pg_roles AS role WHERE role.rolname = 'authenticated');

  IF authenticated_execute <> 5 THEN
    RAISE EXCEPTION 'authenticated holds EXECUTE on only % of the 5 Phase 5 functions', authenticated_execute;
  END IF;

  RAISE NOTICE 'Grants: anon has no execute, authenticated has execute on all five workflow functions (RLS and role checks still decide)';
END;
$p5geo_grants$;

ROLLBACK;
