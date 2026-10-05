-- Phase 7 report permissions, integrity and storage assertions.
--
-- Run only against a local/test Supabase database after `supabase db reset`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase7_reports_rls.sql
--
-- Every scenario runs as a real database role with real JWT claims, so the
-- policies under test are exactly the policies PostgREST applies. Nothing relies
-- on application checks, hidden UI or client-side filtering, and every change is
-- rolled back.
--
-- The matrix under test:
--   viewer  reads and downloads reports; never creates or regenerates one
--   analyst creates reports and moves them through generation
--   admin   the same as analyst
--   owner   the same as analyst
--   nobody  rewrites the analytical payload of a report, re-parents it, or
--           replaces a storage path with another tenant's path
BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight: catalog truth, not migration text
-- ---------------------------------------------------------------------------
DO $phase7_rls_preflight$
DECLARE
  missing_policy text;
  blanket_policy text;
  missing_constraint text;
  missing_trigger text;
  missing_storage_policy text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'analysis_reports'
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'Row level security is not enabled on public.analysis_reports';
  END IF;

  SELECT pg_catalog.string_agg(expected.policy, ', ')
    INTO missing_policy
    FROM (VALUES
      ('analysis_reports_select_member'),
      ('analysis_reports_insert_run'),
      ('analysis_reports_update_run')
    ) AS expected(policy)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_policies AS policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = 'analysis_reports'
        AND policy.policyname = expected.policy
   );

  IF missing_policy IS NOT NULL THEN
    RAISE EXCEPTION 'Expected report policies are missing: %', missing_policy;
  END IF;

  -- No report policy may be a blanket allow, and none may be reachable by anon.
  SELECT pg_catalog.string_agg(policy.policyname, ', ')
    INTO blanket_policy
    FROM pg_catalog.pg_policies AS policy
   WHERE policy.schemaname = 'public'
     AND policy.tablename = 'analysis_reports'
     AND (
       'anon' = ANY (policy.roles)
       OR (
         (COALESCE(policy.qual, '') <> ''
           AND COALESCE(policy.qual, '') NOT LIKE '%is_workspace_member%'
           AND COALESCE(policy.qual, '') NOT LIKE '%has_workspace_role%')
         OR (COALESCE(policy.with_check, '') <> ''
           AND COALESCE(policy.with_check, '') NOT LIKE '%is_workspace_member%'
           AND COALESCE(policy.with_check, '') NOT LIKE '%has_workspace_role%')
       )
     );

  IF blanket_policy IS NOT NULL THEN
    RAISE EXCEPTION 'A report policy is a blanket or anon-reachable policy: %', blanket_policy;
  END IF;

  -- Grants: members may read, run roles may insert/update, nobody may delete,
  -- anon holds nothing.
  IF NOT (
    pg_catalog.has_table_privilege('authenticated', 'public.analysis_reports', 'SELECT')
    AND pg_catalog.has_table_privilege('authenticated', 'public.analysis_reports', 'INSERT')
    AND pg_catalog.has_table_privilege('authenticated', 'public.analysis_reports', 'UPDATE')
    AND NOT pg_catalog.has_table_privilege('authenticated', 'public.analysis_reports', 'DELETE')
    AND NOT pg_catalog.has_table_privilege('anon', 'public.analysis_reports', 'SELECT')
    AND NOT pg_catalog.has_table_privilege('anon', 'public.analysis_reports', 'INSERT')
    AND NOT pg_catalog.has_table_privilege('anon', 'public.analysis_reports', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'The analysis_reports grant matrix is not the documented one';
  END IF;

  SELECT pg_catalog.string_agg(expected.constraint_name, ', ')
    INTO missing_constraint
    FROM (VALUES
      ('analysis_reports_analysis_fk'),
      ('analysis_reports_project_fk'),
      ('analysis_reports_snapshot_hash_format'),
      ('analysis_reports_storage_path_scope'),
      ('analysis_reports_map_path_scope'),
      ('analysis_reports_logo_path_scope'),
      ('analysis_reports_ready_has_artifact'),
      ('location_analyses_project_identity_unique')
    ) AS expected(constraint_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conname = expected.constraint_name
   );

  IF missing_constraint IS NOT NULL THEN
    RAISE EXCEPTION 'Expected report constraints are missing: %', missing_constraint;
  END IF;

  SELECT pg_catalog.string_agg(expected.trigger_name, ', ')
    INTO missing_trigger
    FROM (VALUES
      ('analysis_reports_validate_source'),
      ('analysis_reports_protect_snapshot'),
      ('analysis_reports_validate_status_transition'),
      ('analysis_reports_prevent_move')
    ) AS expected(trigger_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgname = expected.trigger_name
        AND NOT trigger_row.tgisinternal
   );

  IF missing_trigger IS NOT NULL THEN
    RAISE EXCEPTION 'Expected report triggers are missing: %', missing_trigger;
  END IF;

  -- The path helper must be invoker-rights and unreachable by anon.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS proc
     WHERE proc.oid = 'public.report_object_workspace_id(text)'::pg_catalog.regprocedure
       AND proc.prosecdef
  ) THEN
    RAISE EXCEPTION 'report_object_workspace_id must be SECURITY INVOKER';
  END IF;

  IF pg_catalog.has_function_privilege('anon', 'public.report_object_workspace_id(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'report_object_workspace_id must not be executable by anon';
  END IF;

  -- The private bucket and its three policies.
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets AS bucket
     WHERE bucket.id = 'analysis-reports' AND bucket.public IS FALSE
  ) THEN
    RAISE EXCEPTION 'The analysis-reports bucket must exist and stay private';
  END IF;

  SELECT pg_catalog.string_agg(expected.policy, ', ')
    INTO missing_storage_policy
    FROM (VALUES
      ('analysis_reports_storage_select_member'),
      ('analysis_reports_storage_insert_run'),
      ('analysis_reports_storage_update_run')
    ) AS expected(policy)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_policies AS policy
      WHERE policy.schemaname = 'storage'
        AND policy.tablename = 'objects'
        AND policy.policyname = expected.policy
   );

  IF missing_storage_policy IS NOT NULL THEN
    RAISE EXCEPTION 'Expected report storage policies are missing: %', missing_storage_policy;
  END IF;

  RAISE NOTICE 'Preflight: RLS, policies, grants, constraints, triggers, bucket and path helper are in place';
END;
$phase7_rls_preflight$;

-- ---------------------------------------------------------------------------
-- Assertion helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.p7rls_expect_count(p_description text, p_sql text, p_expected bigint)
RETURNS void
LANGUAGE plpgsql
AS $p7rls_count$
DECLARE
  actual bigint;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'COUNT CASE FAILED (got %, expected %): %', actual, p_expected, p_description;
  END IF;
  RAISE NOTICE 'count as expected (%): %', actual, p_description;
END;
$p7rls_count$;

CREATE FUNCTION pg_temp.p7rls_expect_error(p_description text, p_sql text, p_expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $p7rls_error$
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
$p7rls_error$;

CREATE FUNCTION pg_temp.p7rls_expect_true(p_description text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $p7rls_true$
DECLARE
  actual boolean;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BOOLEAN CASE FAILED (got %): %', actual, p_description;
  END IF;
  RAISE NOTICE 'true as expected: %', p_description;
END;
$p7rls_true$;

GRANT EXECUTE ON FUNCTION pg_temp.p7rls_expect_count(text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.p7rls_expect_error(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.p7rls_expect_true(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Fixtures: one analysis per mode in the demo workspace, and a second project
-- with an analysis of its own in the isolation workspace, so project/workspace
-- mismatches can be attempted for real.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE p7rls_probe (
  label text PRIMARY KEY,
  analysis_id uuid,
  report_path text
);
GRANT ALL ON p7rls_probe TO authenticated;

CREATE TEMP TABLE p7rls_ids (
  label text PRIMARY KEY,
  value uuid
);
GRANT ALL ON p7rls_ids TO authenticated;

INSERT INTO p7rls_ids (label, value)
VALUES
  ('report_comparison', '00000000-0000-4000-8000-0000000000a1'),
  ('report_single', '00000000-0000-4000-8000-0000000000a2'),
  ('report_isolation', '00000000-0000-4000-8000-0000000000a3');

SELECT pg_temp.p7rls_expect_true(
  'the path helper reads the workspace from a well-formed report object name',
  $sql$SELECT public.report_object_workspace_id(
    '00000000-0000-4000-8000-000000000010/00000000-0000-4000-8000-000000000020/'
      || '00000000-0000-4000-8000-0000000000a1/report.pdf'
  ) = '00000000-0000-4000-8000-000000000010'::uuid$sql$
);

SELECT pg_temp.p7rls_expect_true(
  'a malformed or shallow object name grants nothing',
  $sql$SELECT public.report_object_workspace_id('not-a-report/object.pdf') IS NULL
        AND public.report_object_workspace_id(
          '00000000-0000-4000-8000-000000000010/report.pdf'
        ) IS NULL$sql$
);

-- The isolation workspace needs a second project with its own candidate and
-- analysis; created as the database owner, before any role switch.
INSERT INTO public.projects (id, workspace_id, name, description)
VALUES (
  '00000000-0000-4000-8000-000000000022',
  '00000000-0000-4000-8000-000000000011',
  'Phase 7 second project',
  'Project-scope fixture for the reporting suite.'
);


-- ---------------------------------------------------------------------------
-- Analyst: runs analyses, creates reports, moves them through generation
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';

INSERT INTO p7rls_probe (label, analysis_id, report_path)
SELECT
  'comparison',
  (public.run_location_analysis(
     '00000000-0000-4000-8000-000000000010',
     '00000000-0000-4000-8000-000000000020',
     ARRAY[
       '00000000-0000-4000-8000-000000000050'::uuid,
       '00000000-0000-4000-8000-000000000051'::uuid
     ],
     1000,
     '00000000-0000-4000-8000-000000000040',
     'comparison'
  ) -> 'analysis' ->> 'id')::uuid,
  NULL;

INSERT INTO p7rls_probe (label, analysis_id, report_path)
SELECT
  'single',
  (public.run_location_analysis(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020',
    ARRAY['00000000-0000-4000-8000-000000000052'::uuid],
    1000,
    '00000000-0000-4000-8000-000000000040',
    'analysis'
  ) -> 'analysis' ->> 'id')::uuid,
  NULL;

UPDATE p7rls_probe
   SET report_path = pg_catalog.format(
     '00000000-0000-4000-8000-000000000010/00000000-0000-4000-8000-000000000020/%s/report.pdf',
     (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')
   )
 WHERE label = 'comparison';

INSERT INTO public.analysis_reports (
  id, workspace_id, project_id, analysis_id, report_type, title,
  snapshot, snapshot_hash, created_by
)
SELECT
  (SELECT value FROM p7rls_ids WHERE label = 'report_comparison'),
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020',
  probe.analysis_id,
  'comparison',
  'Reporting smoke report',
  pg_catalog.jsonb_build_object(
    'analysis', pg_catalog.jsonb_build_object('id', probe.analysis_id, 'mode', 'comparison'),
    'project', pg_catalog.jsonb_build_object('id', '00000000-0000-4000-8000-000000000020')
  ),
  pg_catalog.repeat('a', 64),
  'a1000000-0000-4000-8000-000000000003'
FROM p7rls_probe AS probe
WHERE probe.label = 'comparison';

SELECT pg_temp.p7rls_expect_count(
  'an analyst can create a report for a stored analysis of their own project',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  1
);

SELECT pg_temp.p7rls_expect_count(
  'the analyst sees the report they just created',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'the analytical snapshot of a report can never be rewritten',
  $sql$UPDATE public.analysis_reports
          SET snapshot = '{"tampered": true}'::jsonb
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '42501'
);

SELECT pg_temp.p7rls_expect_error(
  'the snapshot hash can never be rewritten',
  $sql$UPDATE public.analysis_reports
          SET snapshot_hash = pg_catalog.repeat('b', 64)
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '42501'
);

SELECT pg_temp.p7rls_expect_error(
  'a report can never be re-pointed at another project',
  $sql$UPDATE public.analysis_reports
          SET project_id = '00000000-0000-4000-8000-000000000022'
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '42501'
);

SELECT pg_temp.p7rls_expect_error(
  'a report can never be re-pointed at another analysis',
  $sql$UPDATE public.analysis_reports
          SET analysis_id = (SELECT analysis_id FROM p7rls_probe WHERE label = 'single')
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '42501'
);

SELECT pg_temp.p7rls_expect_error(
  'a report cannot jump straight from draft to ready',
  $sql$UPDATE public.analysis_reports
          SET status = 'ready',
              storage_path = (SELECT report_path FROM p7rls_probe WHERE label = 'comparison'),
              generated_at = pg_catalog.now()
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '23514'
);

SELECT pg_temp.p7rls_expect_error(
  'a ready report must carry its artifact path and generated_at',
  $sql$UPDATE public.analysis_reports
          SET status = 'ready', generated_at = pg_catalog.now()
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '23514'
);

-- The documented lifecycle: draft -> generating -> ready. A failing step
-- raises and aborts the suite, so these direct statements are the assertion.
UPDATE public.analysis_reports
   SET status = 'generating'
 WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison');

SELECT pg_temp.p7rls_expect_count(
  'the documented generation lifecycle draft -> generating is allowed',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')
          AND status = 'generating'$sql$,
  1
);

UPDATE public.analysis_reports
   SET status = 'ready',
       storage_path = (SELECT report_path FROM p7rls_probe WHERE label = 'comparison'),
       generated_at = pg_catalog.now()
 WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison');

SELECT pg_temp.p7rls_expect_count(
  'generating -> ready stores the artifact path and the generated timestamp',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')
          AND status = 'ready'
          AND storage_path IS NOT NULL
          AND generated_at IS NOT NULL$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'a ready report cannot skip back to draft',
  $sql$UPDATE public.analysis_reports
          SET status = 'draft'
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '23514'
);

UPDATE public.analysis_reports
   SET status = 'generating'
 WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison');

SELECT pg_temp.p7rls_expect_count(
  'a ready report can be regenerated from its unchanged snapshot (ready -> generating)',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')
          AND status = 'generating'$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'a storage path outside the report own workspace/project/report scope is refused',
  $sql$UPDATE public.analysis_reports
          SET storage_path =
            '00000000-0000-4000-8000-000000000099/00000000-0000-4000-8000-000000000099/'
            || '00000000-0000-4000-8000-000000000099/report.pdf'
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '23514'
);

SELECT pg_temp.p7rls_expect_error(
  'a report cannot be deleted: reports are an audit trail',
  $sql$DELETE FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')$sql$,
  '42501'
);

-- ---------------------------------------------------------------------------
-- Source-analysis integrity: type, mode, workspace and project must agree
-- ---------------------------------------------------------------------------
SELECT pg_temp.p7rls_expect_error(
  'a single-location report cannot cite a comparison analysis',
  $sql$INSERT INTO public.analysis_reports (
          workspace_id, project_id, analysis_id, report_type, title,
          snapshot, snapshot_hash, created_by
        )
        SELECT
          '00000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000020',
          probe.analysis_id,
          'single_location',
          'Wrong type',
          pg_catalog.jsonb_build_object('analysis', pg_catalog.jsonb_build_object('id', probe.analysis_id)),
          pg_catalog.repeat('c', 64),
          'a1000000-0000-4000-8000-000000000003'
        FROM p7rls_probe AS probe
        WHERE probe.label = 'comparison'$sql$,
  '23514'
);

SELECT pg_temp.p7rls_expect_error(
  'a report without an immutable snapshot and hash is refused',
  $sql$INSERT INTO public.analysis_reports (
          workspace_id, project_id, analysis_id, report_type, title, created_by
        )
        SELECT
          '00000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000020',
          probe.analysis_id,
          'comparison',
          'No snapshot',
          'a1000000-0000-4000-8000-000000000003'
        FROM p7rls_probe AS probe
        WHERE probe.label = 'comparison'$sql$,
  '23514'
);

SELECT pg_temp.p7rls_expect_error(
  'a snapshot that describes a different analysis is refused',
  $sql$INSERT INTO public.analysis_reports (
          workspace_id, project_id, analysis_id, report_type, title,
          snapshot, snapshot_hash, created_by
        )
        SELECT
          '00000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000020',
          probe.analysis_id,
          'comparison',
          'Mismatched snapshot',
          pg_catalog.jsonb_build_object(
            'analysis', pg_catalog.jsonb_build_object('id', '00000000-0000-4000-8000-0000000000ff')
          ),
          pg_catalog.repeat('d', 64),
          'a1000000-0000-4000-8000-000000000003'
        FROM p7rls_probe AS probe
        WHERE probe.label = 'comparison'$sql$,
  '23514'
);

SELECT pg_temp.p7rls_expect_error(
  'a report cannot cite an analysis of another workspace',
  $sql$INSERT INTO public.analysis_reports (
          workspace_id, project_id, analysis_id, report_type, title,
          snapshot, snapshot_hash, created_by
        )
        VALUES (
          '00000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000020',
          '00000000-0000-4000-8000-0000000000fe',
          'comparison',
          'Foreign analysis',
          '{"analysis": {"id": "00000000-0000-4000-8000-0000000000fe"}}'::jsonb,
          pg_catalog.repeat('e', 64),
          'a1000000-0000-4000-8000-000000000003'
        )$sql$,
  '23503'
);

-- ---------------------------------------------------------------------------
-- Viewer: may read and download, may not create or regenerate
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';

SELECT pg_temp.p7rls_expect_count(
  'a viewer reads reports of their own workspace',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE workspace_id = '00000000-0000-4000-8000-000000000010'$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'a viewer cannot create a report',
  $sql$INSERT INTO public.analysis_reports (
          workspace_id, project_id, analysis_id, report_type, title,
          snapshot, snapshot_hash, created_by
        )
        SELECT
          '00000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000020',
          probe.analysis_id,
          'comparison',
          'Viewer report',
          pg_catalog.jsonb_build_object('analysis', pg_catalog.jsonb_build_object('id', probe.analysis_id)),
          pg_catalog.repeat('f', 64),
          'a1000000-0000-4000-8000-000000000004'
        FROM p7rls_probe AS probe
        WHERE probe.label = 'comparison'$sql$,
  '42501'
);

-- Row-level security filters an UPDATE the viewer may not perform: the
-- statement succeeds and changes nothing. The assertion is therefore "no row
-- changed", not "an error was raised".
UPDATE public.analysis_reports
   SET title = 'Viewer edit', status = 'generating'
 WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison');

SELECT pg_temp.p7rls_expect_count(
  'a viewer cannot move a report through generation',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_comparison')
          AND title = 'Viewer edit'$sql$,
  0
);

-- ---------------------------------------------------------------------------
-- Isolation: the isolation workspace gets its own analysis and report
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The isolation workspace starts with no model and no candidates of its own
-- (the seed is demo-workspace only), so its owner builds them here exactly the
-- way a real user would: an explicit model and two explicit saved candidates.
INSERT INTO p7rls_ids (label, value)
SELECT
  'model_isolation',
  public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Isolation report model',
    'Created by the isolation workspace owner for the reporting suite.',
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  );

INSERT INTO p7rls_ids (label, value)
SELECT 'candidate_b1', saved.id
  FROM public.save_analysis_location(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Isolation site A', 69.2797, 41.3111
  ) AS saved;

INSERT INTO p7rls_ids (label, value)
SELECT 'candidate_b2', saved.id
  FROM public.save_analysis_location(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Isolation site B', 69.2600, 41.2950
  ) AS saved;

INSERT INTO p7rls_probe (label, analysis_id, report_path)
SELECT
  'isolation',
  (public.run_location_analysis(
     '00000000-0000-4000-8000-000000000011',
     '00000000-0000-4000-8000-000000000021',
     ARRAY[
       (SELECT value FROM p7rls_ids WHERE label = 'candidate_b1'),
       (SELECT value FROM p7rls_ids WHERE label = 'candidate_b2')
     ],
     1000,
     (SELECT value FROM p7rls_ids WHERE label = 'model_isolation'),
     'comparison'
  ) -> 'analysis' ->> 'id')::uuid,
  NULL;

INSERT INTO public.analysis_reports (
  id, workspace_id, project_id, analysis_id, report_type, title,
  snapshot, snapshot_hash, created_by
)
SELECT
  (SELECT value FROM p7rls_ids WHERE label = 'report_isolation'),
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  probe.analysis_id,
  'comparison',
  'Isolation report',
  pg_catalog.jsonb_build_object('analysis', pg_catalog.jsonb_build_object('id', probe.analysis_id)),
  pg_catalog.repeat('1', 64),
  'b1000000-0000-4000-8000-000000000001'
FROM p7rls_probe AS probe
WHERE probe.label = 'isolation';

SELECT pg_temp.p7rls_expect_count(
  'the isolation owner can create a report in their own workspace',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports
        WHERE id = (SELECT value FROM p7rls_ids WHERE label = 'report_isolation')$sql$,
  1
);

SELECT pg_temp.p7rls_expect_count(
  'the isolation owner sees only their own report',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'a report cannot cite an analysis of another project inside the same workspace',
  $sql$INSERT INTO public.analysis_reports (
          workspace_id, project_id, analysis_id, report_type, title,
          snapshot, snapshot_hash, created_by
        )
        SELECT
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000022',
          probe.analysis_id,
          'comparison',
          'Wrong project',
          pg_catalog.jsonb_build_object('analysis', pg_catalog.jsonb_build_object('id', probe.analysis_id)),
          pg_catalog.repeat('2', 64),
          'b1000000-0000-4000-8000-000000000001'
        FROM p7rls_probe AS probe
        WHERE probe.label = 'isolation'$sql$,
  '23503'
);

-- ---------------------------------------------------------------------------
-- Storage: artifacts are member-readable, run-role-writable, never anon
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';

INSERT INTO storage.objects (bucket_id, name, owner, metadata)
VALUES (
  'analysis-reports',
  (SELECT report_path FROM p7rls_probe WHERE label = 'comparison'),
  'a1000000-0000-4000-8000-000000000003',
  '{"mimetype":"application/pdf","size":20480}'::jsonb
);

SELECT pg_temp.p7rls_expect_count(
  'an analyst stores the PDF artifact of their own report',
  $sql$SELECT pg_catalog.count(*) FROM storage.objects
        WHERE bucket_id = 'analysis-reports'
          AND name = (SELECT report_path FROM p7rls_probe WHERE label = 'comparison')$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'an artifact path of another workspace cannot be written',
  $sql$INSERT INTO storage.objects (bucket_id, name, owner)
        VALUES (
          'analysis-reports',
          '00000000-0000-4000-8000-000000000011/00000000-0000-4000-8000-000000000021/'
            || '00000000-0000-4000-8000-0000000000a3/report.pdf',
          'a1000000-0000-4000-8000-000000000003'
        )$sql$,
  '42501'
);

SELECT pg_temp.p7rls_expect_error(
  'a malformed artifact path is refused outright',
  $sql$INSERT INTO storage.objects (bucket_id, name, owner)
        VALUES ('analysis-reports', 'not-a-report/report.pdf', 'a1000000-0000-4000-8000-000000000003')$sql$,
  '42501'
);

SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';

SELECT pg_temp.p7rls_expect_count(
  'a viewer can read the PDF artifact of their own workspace (authorized download)',
  $sql$SELECT pg_catalog.count(*) FROM storage.objects
        WHERE bucket_id = 'analysis-reports'
          AND name = (SELECT report_path FROM p7rls_probe WHERE label = 'comparison')$sql$,
  1
);

SELECT pg_temp.p7rls_expect_error(
  'a viewer cannot replace a stored PDF artifact',
  $sql$INSERT INTO storage.objects (bucket_id, name, owner)
        VALUES (
          'analysis-reports',
          (SELECT report_path FROM p7rls_probe WHERE label = 'comparison'),
          'a1000000-0000-4000-8000-000000000004'
        )$sql$,
  '42501'
);

-- ---------------------------------------------------------------------------
-- Anonymous: nothing at all
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","role":"anon"}';

SELECT pg_temp.p7rls_expect_error(
  'an anonymous caller cannot read reports',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_reports$sql$,
  '42501'
);

SELECT pg_temp.p7rls_expect_error(
  'an anonymous caller cannot download a report artifact',
  $sql$SELECT pg_catalog.count(*) FROM storage.objects WHERE bucket_id = 'analysis-reports'$sql$,
  '42501'
);

ROLLBACK;
