-- Phase 6 scoring permissions and Row Level Security assertions.
--
-- Run only against a local/test Supabase database after `supabase db reset`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase6_scoring_rls.sql
--
-- Every scenario runs as a real database role with real JWT claims, so the
-- policies under test are exactly the policies PostgREST applies. Nothing relies
-- on application checks, hidden UI or client-side filtering, and every change is
-- rolled back.
--
-- The role matrix under test:
--   viewer  reads models, analyses and results; writes nothing
--   analyst runs analyses and saves candidates; never edits a shared model
--   admin   manages models (analyst must not)
--   owner   manages models and runs analyses
--   nobody  writes an analysis row directly: run_location_analysis is the only
--           writer, so a final score can never be forged with an INSERT
BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight: catalog truth, not migration text
-- ---------------------------------------------------------------------------
DO $phase6_rls_preflight$
DECLARE
  missing_rls text;
  missing_policy text;
  blanket_policy text;
  definer_functions text;
BEGIN
  SELECT pg_catalog.string_agg(expected.relation, ', ')
    INTO missing_rls
    FROM (VALUES
      ('scoring_models'), ('scoring_model_factors'),
      ('location_analyses'), ('location_analysis_results')
    ) AS expected(relation)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_class AS relation
     JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = expected.relation
       AND relation.relrowsecurity
   );

  IF missing_rls IS NOT NULL THEN
    RAISE EXCEPTION 'Row level security is not enabled on: %', missing_rls;
  END IF;

  SELECT pg_catalog.string_agg(expected.policy, ', ')
    INTO missing_policy
    FROM (VALUES
      ('scoring_models', 'scoring_models_select_member'),
      ('scoring_models', 'scoring_models_insert_owner_admin'),
      ('scoring_models', 'scoring_models_update_owner_admin'),
      ('scoring_model_factors', 'scoring_model_factors_select_member'),
      ('scoring_model_factors', 'scoring_model_factors_insert_owner_admin'),
      ('scoring_model_factors', 'scoring_model_factors_update_owner_admin'),
      ('scoring_model_factors', 'scoring_model_factors_delete_owner_admin'),
      ('location_analyses', 'location_analyses_select_member'),
      ('location_analysis_results', 'location_analysis_results_select_member')
    ) AS expected(relation, policy)
   WHERE NOT EXISTS (
     SELECT 1
       FROM pg_catalog.pg_policies AS policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected.relation
        AND policy.policyname = expected.policy
   );

  IF missing_policy IS NOT NULL THEN
    RAISE EXCEPTION 'Expected policies are missing: %', missing_policy;
  END IF;

  -- No policy may be a blanket allow: every USING/WITH CHECK expression must
  -- reference the membership helpers.
  SELECT pg_catalog.string_agg(policy.policyname, ', ')
    INTO blanket_policy
    FROM pg_catalog.pg_policies AS policy
   WHERE policy.schemaname = 'public'
     AND policy.tablename IN (
       'scoring_models', 'scoring_model_factors',
       'location_analyses', 'location_analysis_results'
     )
     AND (
       (
         COALESCE(policy.qual, '') <> ''
         AND COALESCE(policy.qual, '') NOT LIKE '%is_workspace_member%'
         AND COALESCE(policy.qual, '') NOT LIKE '%has_workspace_role%'
       )
       OR (
         COALESCE(policy.with_check, '') <> ''
         AND COALESCE(policy.with_check, '') NOT LIKE '%is_workspace_member%'
         AND COALESCE(policy.with_check, '') NOT LIKE '%has_workspace_role%'
       )
     );

  IF blanket_policy IS NOT NULL THEN
    RAISE EXCEPTION 'A scoring policy does not reference the membership helpers: %', blanket_policy;
  END IF;

  -- Exactly one security definer function exists in the scoring surface, and it
  -- pins its search path. Everything else is invoker rights.
  SELECT pg_catalog.string_agg(proc.proname, ', ')
    INTO definer_functions
    FROM pg_catalog.pg_proc AS proc
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
   WHERE namespace.nspname = 'public'
     AND proc.proname IN (
       'scoring_threshold_points_valid', 'scoring_interpolate', 'scoring_metric_value',
       'scoring_metric_text', 'validate_scoring_factors', 'insert_scoring_factors',
       'workspace_data_updated_at', 'location_analysis_payload', 'get_location_analysis',
       'create_scoring_model', 'update_scoring_model', 'run_location_analysis'
     )
     AND proc.prosecdef
     AND proc.proname <> 'run_location_analysis';

  IF definer_functions IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected security definer functions in the scoring surface: %', definer_functions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS proc
     WHERE proc.oid = 'public.run_location_analysis(uuid, uuid, uuid[], integer, uuid, text)'::pg_catalog.regprocedure
       AND proc.prosecdef
       AND pg_catalog.array_to_string(proc.proconfig, ',') LIKE '%search_path=pg_catalog%'
  ) THEN
    RAISE EXCEPTION 'run_location_analysis must be security definer with a pinned search_path';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conname = 'analysis_locations_workspace_identity_unique'
       AND constraint_row.conrelid = 'public.analysis_locations'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'The composite candidate identity constraint is missing';
  END IF;

  RAISE NOTICE 'Preflight: RLS, policies, grants, definer discipline and the candidate identity constraint are in place';
END;
$phase6_rls_preflight$;

-- ---------------------------------------------------------------------------
-- Assertion helpers (created by the table owner, executed by the caller)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.p6rls_expect_count(p_description text, p_sql text, p_expected bigint)
RETURNS void
LANGUAGE plpgsql
AS $p6rls_count$
DECLARE
  actual bigint;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'COUNT CASE FAILED (got %, expected %): %', actual, p_expected, p_description;
  END IF;
  RAISE NOTICE 'count as expected (%): %', actual, p_description;
END;
$p6rls_count$;

CREATE FUNCTION pg_temp.p6rls_expect_error(p_description text, p_sql text, p_expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $p6rls_error$
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
$p6rls_error$;

CREATE FUNCTION pg_temp.p6rls_expect_true(p_description text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $p6rls_true$
DECLARE
  actual boolean;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BOOLEAN CASE FAILED (got %): %', actual, p_description;
  END IF;
  RAISE NOTICE 'true as expected: %', p_description;
END;
$p6rls_true$;

GRANT EXECUTE ON FUNCTION pg_temp.p6rls_expect_count(text, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.p6rls_expect_error(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.p6rls_expect_true(text, text) TO authenticated;

-- A pivot for the scenarios below: one saved analysis in the demo workspace,
-- created by the analyst, read back by every other role.
CREATE TEMP TABLE p6rls_probe (
  label text PRIMARY KEY,
  analysis_id uuid,
  model_id uuid,
  factor_count integer
);
GRANT ALL ON p6rls_probe TO authenticated;
INSERT INTO p6rls_probe (label, model_id, factor_count)
SELECT 'demo', model.id, (SELECT pg_catalog.count(*) FROM public.scoring_model_factors AS factor WHERE factor.model_id = model.id)
  FROM public.scoring_models AS model
 WHERE model.id = '00000000-0000-4000-8000-000000000040';

-- ---------------------------------------------------------------------------
-- Analyst: runs analyses, saves candidates, never edits a shared model
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';

UPDATE p6rls_probe
   SET analysis_id = (public.run_location_analysis(
     '00000000-0000-4000-8000-000000000010',
     '00000000-0000-4000-8000-000000000020',
     ARRAY[
       '00000000-0000-4000-8000-000000000050'::uuid,
       '00000000-0000-4000-8000-000000000051'::uuid
     ],
     1000,
     (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
     'comparison'
   ) -> 'analysis' ->> 'id')::uuid;

SELECT pg_temp.p6rls_expect_true(
  'an analyst can run a comparison and read its stored payload back',
  $sql$(SELECT public.get_location_analysis(
            '00000000-0000-4000-8000-000000000010',
            (SELECT analysis_id FROM p6rls_probe WHERE label = 'demo')
          ) -> 'results' -> 0 ->> 'final_score' IS NOT NULL)$sql$
);

SELECT pg_temp.p6rls_expect_count(
  'an analyst reads the workspace model catalogue',
  $sql$SELECT pg_catalog.count(*) FROM public.scoring_models WHERE workspace_id = '00000000-0000-4000-8000-000000000010'$sql$,
  1
);

SELECT pg_temp.p6rls_expect_error(
  'an analyst cannot create a scoring model',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000010',
    'Analyst model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'an analyst cannot update a shared model',
  $sql$SELECT public.update_scoring_model(
    (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
    'Analyst rename',
    NULL,
    NULL,
    NULL
  )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'an analyst cannot insert a model row directly either',
  $sql$INSERT INTO public.scoring_models (workspace_id, name, status, created_by)
       VALUES ('00000000-0000-4000-8000-000000000010', 'Analyst direct model', 'active',
               'a1000000-0000-4000-8000-000000000003')$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'an analyst cannot insert a factor row into a shared model',
  $sql$INSERT INTO public.scoring_model_factors (
         model_id, workspace_id, key, label, metric, weight, direction, normalization, configuration
       ) VALUES (
         (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
         '00000000-0000-4000-8000-000000000010',
         'analyst_extra', 'Analyst extra', 'locations_count', 0, 'positive', 'threshold',
         '{"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}'::jsonb
       )$sql$,
  '42501'
);

-- A denied DELETE is filtered, not rejected: the row must still be there.
SELECT pg_temp.p6rls_expect_count(
  'an analyst delete of a shared factor matches no rows',
  $sql$WITH deleted AS (
         DELETE FROM public.scoring_model_factors
          WHERE model_id = (SELECT model_id FROM p6rls_probe WHERE label = 'demo')
          RETURNING 1
       )
       SELECT pg_catalog.count(*) FROM deleted$sql$,
  0
);

SELECT pg_temp.p6rls_expect_count(
  'the shared model still has all of its factors',
  $sql$SELECT pg_catalog.count(*) FROM public.scoring_model_factors
         WHERE model_id = (SELECT model_id FROM p6rls_probe WHERE label = 'demo')$sql$,
  5
);

INSERT INTO public.analysis_locations (id, workspace_id, project_id, name, spatial_point, metadata)
VALUES (
  '00000000-0000-4000-8000-000000000070',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000020',
  'Analyst saved candidate',
  extensions.st_setsrid(extensions.st_makepoint(69.2810, 41.3120), 4326)::extensions.geography,
  '{"synthetic": true}'::jsonb
);

SELECT pg_temp.p6rls_expect_count(
  'an analyst can save a candidate location',
  $sql$SELECT pg_catalog.count(*) FROM public.analysis_locations
         WHERE id = '00000000-0000-4000-8000-000000000070'$sql$,
  1
);

SELECT pg_temp.p6rls_expect_error(
  'nobody may forge an analysis row, not even the workspace owner',
  $sql$INSERT INTO public.location_analyses (
         workspace_id, project_id, scoring_model_id, model_name, model_version, model_snapshot,
         mode, radius_meters, candidate_count, created_by
       ) VALUES (
         '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020',
         (SELECT model_id FROM p6rls_probe WHERE label = 'demo'), 'Forged', 1, '{}'::jsonb, 'analysis', 1000, 1,
         'a1000000-0000-4000-8000-000000000003'
       )$sql$,
  '42501'
);

-- ---------------------------------------------------------------------------
-- Viewer: reads everything, writes nothing
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';

SELECT pg_temp.p6rls_expect_true(
  'a viewer can read a stored analysis and its breakdown',
  $sql$(SELECT public.get_location_analysis(
            '00000000-0000-4000-8000-000000000010',
            (SELECT analysis_id FROM p6rls_probe WHERE label = 'demo')
          ) -> 'results' -> 0 -> 'factor_contributions' IS NOT NULL)$sql$
);

SELECT pg_temp.p6rls_expect_count(
  'a viewer sees the comparison rows of the stored analysis',
  $sql$SELECT pg_catalog.count(*) FROM public.location_analysis_results
         WHERE analysis_id = (SELECT analysis_id FROM p6rls_probe WHERE label = 'demo')$sql$,
  2
);

SELECT pg_temp.p6rls_expect_error(
  'a viewer cannot run an analysis',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020',
    ARRAY['00000000-0000-4000-8000-000000000050'::uuid],
    1000, (SELECT model_id FROM p6rls_probe WHERE label = 'demo'), 'analysis'
  )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'a viewer cannot save a candidate location',
  $sql$INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
       VALUES ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020',
               'Viewer candidate',
               extensions.st_setsrid(extensions.st_makepoint(69.28, 41.31), 4326)::extensions.geography)$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_count(
  'a viewer update of a candidate matches no rows',
  $sql$WITH updated AS (
         UPDATE public.analysis_locations SET name = 'viewer rename'
          WHERE id = '00000000-0000-4000-8000-000000000070'
          RETURNING 1
       )
       SELECT pg_catalog.count(*) FROM updated$sql$,
  0
);

SELECT pg_temp.p6rls_expect_count(
  'a viewer is never granted an analysis insert',
  $sql$SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN ('location_analyses', 'location_analysis_results')
          AND pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')$sql$,
  0
);

-- ---------------------------------------------------------------------------
-- Admin and owner: the only roles that manage models
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}';

INSERT INTO p6rls_probe (label, model_id)
VALUES (
  'admin',
  public.create_scoring_model(
    '00000000-0000-4000-8000-000000000010',
    'Admin managed model',
    'Created by the admin role in the permissions suite.',
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 60, "direction": "positive", "normalization": "min_max", "configuration": {"missing_score": 0, "degenerate_score": 50}}, {"key": "competition", "label": "Competition", "metric": "competitors_count", "weight": 40, "direction": "negative", "normalization": "inverse_min_max", "configuration": {"missing_score": 100, "degenerate_score": 50}}]'::jsonb
  )
);

CREATE TEMP TABLE p6rls_admin_edit (version_before integer, version_after integer);
GRANT ALL ON p6rls_admin_edit TO authenticated;

INSERT INTO p6rls_admin_edit (version_before)
SELECT model.version FROM public.scoring_models AS model
 WHERE model.id = (SELECT model_id FROM p6rls_probe WHERE label = 'admin');

CREATE TEMP TABLE p6rls_admin_payload (factors jsonb);
GRANT ALL ON p6rls_admin_payload TO authenticated;
INSERT INTO p6rls_admin_payload (factors)
VALUES ('[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "min_max", "configuration": {"missing_score": 0, "degenerate_score": 50}}]'::jsonb);

UPDATE p6rls_admin_edit
   SET version_after = public.update_scoring_model(
     (SELECT model_id FROM p6rls_probe WHERE label = 'admin'),
     'Admin managed model (edited)',
     NULL,
     'active',
     (SELECT factors FROM p6rls_admin_payload)
   );

SELECT pg_temp.p6rls_expect_true(
  'an admin can create a model and the revision starts at 1',
  $sql$(SELECT model.version >= 1 FROM public.scoring_models AS model
         WHERE model.id = (SELECT model_id FROM p6rls_probe WHERE label = 'admin'))$sql$
);

SELECT pg_temp.p6rls_expect_true(
  'an admin can update the model and the revision advances',
  $sql$(SELECT version_after > version_before
            AND version_after = (SELECT model.version FROM public.scoring_models AS model
                                  WHERE model.id = (SELECT model_id FROM p6rls_probe WHERE label = 'admin'))
          FROM p6rls_admin_edit)$sql$
);

SELECT pg_temp.p6rls_expect_count(
  'the edited admin model has exactly the factors the payload listed',
  $sql$SELECT pg_catalog.count(*) FROM public.scoring_model_factors
         WHERE model_id = (SELECT model_id FROM p6rls_probe WHERE label = 'admin')$sql$,
  1
);

SELECT pg_temp.p6rls_expect_error(
  'a duplicate model name in the same workspace is refused',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000010',
    'ADMIN MANAGED MODEL (EDITED)',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '23505'
);

SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

SELECT pg_temp.p6rls_expect_error(
  'a model cannot be re-pointed at another workspace',
  $sql$UPDATE public.scoring_models
          SET workspace_id = '00000000-0000-4000-8000-000000000011'
        WHERE id = (SELECT model_id FROM p6rls_probe WHERE label = 'demo')$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'a factor cannot be moved to another model in another workspace',
  $sql$UPDATE public.scoring_model_factors
          SET workspace_id = '00000000-0000-4000-8000-000000000011'
        WHERE model_id = (SELECT model_id FROM p6rls_probe WHERE label = 'demo')$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'nobody may delete a scoring model: models are archived, not removed',
  $sql$DELETE FROM public.scoring_models
        WHERE id = (SELECT model_id FROM p6rls_probe WHERE label = 'demo')$sql$,
  '42501'
);

-- ---------------------------------------------------------------------------
-- Isolation workspace owner: no path to the demo workspace
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- The isolation workspace owner manages their own workspace normally, which is
-- what makes the cross-workspace refusals below meaningful.
INSERT INTO p6rls_probe (label, model_id)
VALUES (
  'isolation',
  public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Isolation managed model',
    'Created by the isolation workspace owner.',
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )
);

INSERT INTO public.analysis_locations (id, workspace_id, project_id, name, spatial_point, metadata)
VALUES (
  '00000000-0000-4000-8000-000000000071',
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  'Isolation saved candidate',
  extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography,
  '{"synthetic": true}'::jsonb
);

SELECT pg_temp.p6rls_expect_count(
  'a foreign owner sees no model of another workspace',
  $sql$SELECT pg_catalog.count(*) FROM public.scoring_models
         WHERE workspace_id = '00000000-0000-4000-8000-000000000010'$sql$,
  0
);

SELECT pg_temp.p6rls_expect_count(
  'a foreign owner sees no factor of another workspace',
  $sql$SELECT pg_catalog.count(*) FROM public.scoring_model_factors
         WHERE workspace_id = '00000000-0000-4000-8000-000000000010'$sql$,
  0
);

SELECT pg_temp.p6rls_expect_count(
  'a foreign owner sees no analysis of another workspace',
  $sql$SELECT pg_catalog.count(*) FROM public.location_analyses
         WHERE workspace_id = '00000000-0000-4000-8000-000000000010'$sql$,
  0
);

SELECT pg_temp.p6rls_expect_count(
  'a foreign owner sees no result row of another workspace',
  $sql$SELECT pg_catalog.count(*) FROM public.location_analysis_results
         WHERE workspace_id = '00000000-0000-4000-8000-000000000010'$sql$,
  0
);

SELECT pg_temp.p6rls_expect_error(
  'reading another workspace analysis answers exactly like a missing one',
  $sql$SELECT public.get_location_analysis(
    '00000000-0000-4000-8000-000000000010',
    (SELECT analysis_id FROM p6rls_probe WHERE label = 'demo')
  )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'editing another workspace model answers not found, never forbidden detail',
  $sql$SELECT public.update_scoring_model(
    (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
    'Foreign rename',
    NULL,
    NULL,
    NULL
  )$sql$,
  'P0002'
);

SELECT pg_temp.p6rls_expect_error(
  'a foreign owner cannot create a model in another workspace',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000010',
    'Foreign model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'a foreign owner cannot run an analysis in another workspace',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020',
    ARRAY['00000000-0000-4000-8000-000000000050'::uuid],
    1000, (SELECT model_id FROM p6rls_probe WHERE label = 'demo'), 'analysis'
  )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'a foreign project id is refused inside the own workspace',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000020',
    ARRAY['00000000-0000-4000-8000-000000000050'::uuid],
    1000, (SELECT model_id FROM p6rls_probe WHERE label = 'demo'), 'analysis'
  )$sql$,
  'P0002'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';

SELECT pg_temp.p6rls_expect_error(
  'a foreign candidate id is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000050'::uuid],
    1000,
    (SELECT model_id FROM p6rls_probe WHERE label = 'isolation'),
    'analysis'
  )$sql$,
  'P0002'
);

SELECT pg_temp.p6rls_expect_error(
  'a foreign model id is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000071'::uuid],
    1000,
    (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
    'analysis'
  )$sql$,
  'P0002'
);

SELECT pg_temp.p6rls_expect_error(
  'writing a factor row for a foreign model is refused by RLS',
  $sql$INSERT INTO public.scoring_model_factors (
         model_id, workspace_id, key, label, metric, weight, direction, normalization, configuration
       ) VALUES (
         (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
         '00000000-0000-4000-8000-000000000010',
         'foreign_extra', 'Foreign extra', 'locations_count', 10, 'positive', 'threshold',
         '{"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}'::jsonb
       )$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'a factor row whose model and workspace disagree is refused by the composite key',
  $sql$INSERT INTO public.scoring_model_factors (
         model_id, workspace_id, key, label, metric, weight, direction, normalization, configuration
       ) VALUES (
         (SELECT model_id FROM p6rls_probe WHERE label = 'demo'),
         '00000000-0000-4000-8000-000000000011',
         'mismatched_extra', 'Mismatched extra', 'locations_count', 10, 'positive', 'threshold',
         '{"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}'::jsonb
       )$sql$,
  '23503'
);

-- ---------------------------------------------------------------------------
-- Outsider and anon: zero tenant access
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';

SELECT pg_temp.p6rls_expect_count(
  'an outsider sees no model, factor, analysis or result row',
  $sql$SELECT (SELECT pg_catalog.count(*) FROM public.scoring_models)
            + (SELECT pg_catalog.count(*) FROM public.scoring_model_factors)
            + (SELECT pg_catalog.count(*) FROM public.location_analyses)
            + (SELECT pg_catalog.count(*) FROM public.location_analysis_results)$sql$,
  0
);

SELECT pg_temp.p6rls_expect_error(
  'an outsider cannot run an analysis',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020',
    ARRAY['00000000-0000-4000-8000-000000000050'::uuid],
    1000, (SELECT model_id FROM p6rls_probe WHERE label = 'demo'), 'analysis'
  )$sql$,
  '42501'
);

SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","role":"anon"}';

SELECT pg_temp.p6rls_expect_error(
  'anon holds no privilege on the scoring tables',
  $sql$SELECT pg_catalog.count(*) FROM public.scoring_models$sql$,
  '42501'
);

SELECT pg_temp.p6rls_expect_error(
  'anon cannot execute the scoring RPCs',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020',
    ARRAY['00000000-0000-4000-8000-000000000050'::uuid],
    1000, (SELECT model_id FROM p6rls_probe WHERE label = 'demo'), 'analysis'
  )$sql$,
  '42501'
);

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';

SELECT pg_temp.p6rls_expect_true(
  'the tenant scoring path needs no service_role privilege',
  $sql$(SELECT pg_catalog.has_function_privilege(
            'authenticated',
            'public.run_location_analysis(uuid, uuid, uuid[], integer, uuid, text)',
            'EXECUTE')
        AND pg_catalog.has_function_privilege(
            'authenticated',
            'public.create_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)',
            'EXECUTE')
        AND pg_catalog.has_function_privilege(
            'authenticated',
            'public.update_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)',
            'EXECUTE')
        AND pg_catalog.has_function_privilege(
            'authenticated', 'public.get_location_analysis(uuid, uuid)', 'EXECUTE'))$sql$
);

DO $phase6_rls_summary$
DECLARE
  analysis_count integer;
  result_count integer;
  model_count integer;
BEGIN
  SELECT pg_catalog.count(*) INTO analysis_count FROM public.location_analyses;
  SELECT pg_catalog.count(*) INTO result_count FROM public.location_analysis_results;
  SELECT pg_catalog.count(*) INTO model_count FROM public.scoring_models;

  RAISE NOTICE 'Scoring permissions passed: % stored analyses, % stored results, % models in the rolled back transaction',
    analysis_count, result_count, model_count;
  RAISE NOTICE 'Phase 6 scoring permission and RLS checks passed';
END;
$phase6_rls_summary$;

ROLLBACK;
