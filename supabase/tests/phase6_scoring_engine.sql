-- Phase 6 scoring engine assertions: raw metrics, normalization, weights,
-- contributions, deterministic rounding, snapshots and freshness.
--
-- Run only against a local/test Supabase database after `supabase db reset`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase6_scoring_engine.sql
--
-- Everything runs as the real `authenticated` role with real JWT claims, inside
-- one transaction that is rolled back, so the suite can create models, save
-- candidates and run analyses without touching the seeded database.
--
-- The scenarios use the isolation workspace, whose synthetic seed contains
-- exactly one customer, one competitor, one location and one branch, all at
-- (69.2797, 41.3111). Adding a few rows at known offsets therefore produces
-- metrics that are known by construction, and every expected score below is
-- derived by hand from those numbers rather than from the engine's own output.
-- The engine is never used to compute its own expectation.
BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight: the objects this suite scores against exist in the live catalog
-- ---------------------------------------------------------------------------
DO $phase6_engine_preflight$
DECLARE
  missing text;
BEGIN
  SELECT pg_catalog.string_agg(expected.signature, ', ')
    INTO missing
    FROM (
      VALUES
        ('public.create_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)'),
        ('public.update_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)'),
        ('public.run_location_analysis(uuid, uuid, uuid[], integer, uuid, text)'),
        ('public.get_location_analysis(uuid, uuid)'),
        ('public.location_analysis_payload(uuid)'),
        ('public.scoring_interpolate(jsonb, numeric)'),
        ('public.scoring_threshold_points_valid(jsonb, public.scoring_factor_direction)'),
        ('public.scoring_metric_value(jsonb, text)')
    ) AS expected(signature)
   WHERE pg_catalog.to_regprocedure(expected.signature) IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 6 functions are missing from the live catalog: %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.scoring_models
     WHERE id = '00000000-0000-4000-8000-000000000040'
       AND workspace_id = '00000000-0000-4000-8000-000000000010'
  ) THEN
    RAISE EXCEPTION 'The seeded generic scoring model is missing';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.scoring_model_factors
       WHERE model_id = '00000000-0000-4000-8000-000000000040') <> 5 THEN
    RAISE EXCEPTION 'The seeded scoring model does not have its five factors';
  END IF;

  IF (SELECT pg_catalog.sum(factor.weight) FROM public.scoring_model_factors AS factor
       WHERE factor.model_id = '00000000-0000-4000-8000-000000000040' AND factor.enabled) <> 100 THEN
    RAISE EXCEPTION 'The seeded scoring model weights do not total 100';
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.analysis_locations
       WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
         AND project_id = '00000000-0000-4000-8000-000000000020') < 3 THEN
    RAISE EXCEPTION 'The seeded saved candidate locations are missing';
  END IF;

  RAISE NOTICE 'Preflight: scoring functions, the seeded model and the saved candidates are present';
END;
$phase6_engine_preflight$;

-- ---------------------------------------------------------------------------
-- Assertion helpers (created by the table owner, executed by the caller)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.phase6_expect_numeric(p_description text, p_sql text, p_expected numeric)
RETURNS void
LANGUAGE plpgsql
AS $phase6_numeric$
DECLARE
  actual numeric;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'NUMERIC CASE FAILED (got %, expected %): %', actual, p_expected, p_description;
  END IF;
  RAISE NOTICE 'numeric as expected (%): %', actual, p_description;
END;
$phase6_numeric$;

CREATE FUNCTION pg_temp.phase6_expect_text(p_description text, p_sql text, p_expected text)
RETURNS void
LANGUAGE plpgsql
AS $phase6_text$
DECLARE
  actual text;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'TEXT CASE FAILED (got %, expected %): %', actual, p_expected, p_description;
  END IF;
  RAISE NOTICE 'text as expected (%): %', actual, p_description;
END;
$phase6_text$;

CREATE FUNCTION pg_temp.phase6_expect_true(p_description text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $phase6_true$
DECLARE
  actual boolean;
BEGIN
  EXECUTE p_sql INTO actual;
  IF actual IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BOOLEAN CASE FAILED (got %): %', actual, p_description;
  END IF;
  RAISE NOTICE 'true as expected: %', p_description;
END;
$phase6_true$;

CREATE FUNCTION pg_temp.phase6_expect_error(p_description text, p_sql text, p_expected_state text)
RETURNS void
LANGUAGE plpgsql
AS $phase6_error$
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
$phase6_error$;

GRANT EXECUTE ON FUNCTION pg_temp.phase6_expect_numeric(text, text, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase6_expect_text(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase6_expect_true(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.phase6_expect_error(text, text, text) TO authenticated;

-- Scenario bookkeeping: model definitions the suite writes, and the payloads it
-- stores so a later assertion can prove a stored analysis did not move.
CREATE TEMP TABLE phase6_factor_specs (
  model_label text NOT NULL,
  factor_key text NOT NULL,
  factor_label text NOT NULL,
  metric text NOT NULL,
  weight numeric NOT NULL,
  direction public.scoring_factor_direction NOT NULL,
  normalization public.scoring_normalization NOT NULL,
  configuration jsonb NOT NULL,
  enabled boolean NOT NULL,
  sort_order integer NOT NULL,
  PRIMARY KEY (model_label, factor_key)
);

CREATE TEMP TABLE phase6_runs (
  label text PRIMARY KEY,
  payload jsonb NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

GRANT ALL ON phase6_factor_specs TO authenticated;
GRANT ALL ON phase6_runs TO authenticated;

-- Builds the factor array a model RPC receives from the readable spec table, so
-- the model definition in the test is the same one a client would send.
CREATE FUNCTION pg_temp.phase6_factor_payload(p_model_label text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $phase6_payload$
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'key', spec.factor_key,
      'label', spec.factor_label,
      'metric', spec.metric,
      'weight', spec.weight,
      'direction', spec.direction,
      'normalization', spec.normalization,
      'configuration', spec.configuration,
      'enabled', spec.enabled,
      'sort_order', spec.sort_order
    )
    ORDER BY spec.sort_order
  )
  FROM phase6_factor_specs AS spec
  WHERE spec.model_label = p_model_label;
$phase6_payload$;

GRANT EXECUTE ON FUNCTION pg_temp.phase6_factor_payload(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Owner B: a controlled dataset and four saved candidates
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Three customers at known offsets from the seeded isolation customer, whose
-- revenue is 999.99 and whose position is the workspace center.
INSERT INTO public.customers (
  id, workspace_id, dataset_id, external_id, spatial_point, revenue, order_count, segment, source
)
VALUES
  (
    '00000000-0000-4000-8000-000000000060',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000037',
    'phase6-customer-near',
    extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3116), 4326)::extensions.geography,
    100.01, 1, 'phase6-synthetic', 'synthetic-seed'
  ),
  (
    '00000000-0000-4000-8000-000000000061',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000037',
    'phase6-customer-mid',
    extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3141), 4326)::extensions.geography,
    200.02, 2, 'phase6-synthetic', 'synthetic-seed'
  ),
  (
    '00000000-0000-4000-8000-000000000062',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000037',
    'phase6-customer-far',
    extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3291), 4326)::extensions.geography,
    987654321098.76, 3, 'phase6-synthetic', 'synthetic-seed'
  );

INSERT INTO public.analysis_locations (id, workspace_id, project_id, name, address, spatial_point, metadata)
VALUES
  (
    '00000000-0000-4000-8000-000000000063',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Candidate A Center',
    'Synthetic candidate at the workspace center',
    extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography,
    '{"synthetic": true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000064',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Candidate B North',
    'Synthetic candidate far from the seeded cluster',
    extensions.st_setsrid(extensions.st_makepoint(69.3100, 41.3400), 4326)::extensions.geography,
    '{"synthetic": true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000065',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Candidate C Near Center',
    'Synthetic candidate next to the seeded customer',
    extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3116), 4326)::extensions.geography,
    '{"synthetic": true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000066',
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Candidate D South',
    'Synthetic candidate with no data anywhere near it',
    extensions.st_setsrid(extensions.st_makepoint(69.2400, 41.2600), 4326)::extensions.geography,
    '{"synthetic": true}'::jsonb
  );

-- ---------------------------------------------------------------------------
-- Owner B: four model definitions
-- ---------------------------------------------------------------------------
INSERT INTO phase6_factor_specs VALUES
  -- Threshold model: customers 50, competition 50.
  (
    'threshold', 'customers', 'Customer density', 'customers_count', 50,
    'positive', 'threshold',
    '{"points": [{"value": 0, "score": 0}, {"value": 2, "score": 50}, {"value": 4, "score": 100}], "missing_score": 0, "degenerate_score": 50}'::jsonb,
    true, 1
  ),
  (
    'threshold', 'competition', 'Competition', 'competitors_count', 50,
    'negative', 'threshold',
    '{"points": [{"value": 0, "score": 100}, {"value": 2, "score": 0}], "missing_score": 100}'::jsonb,
    true, 2
  ),
  -- Comparison model: customers 60 by min_max, competition 40 by inverse_min_max.
  (
    'comparison', 'customers', 'Customer potential', 'customers_count', 60,
    'positive', 'min_max',
    '{"missing_score": 0, "degenerate_score": 25}'::jsonb,
    true, 1
  ),
  (
    'comparison', 'competition', 'Competition pressure', 'competitors_count', 40,
    'negative', 'inverse_min_max',
    '{"missing_score": 100, "degenerate_score": 25}'::jsonb,
    true, 2
  ),
  -- Rounding model: a single factor whose threshold curve produces a repeating
  -- decimal.
  (
    'rounding', 'customers', 'Customer curve', 'customers_count', 100,
    'positive', 'threshold',
    '{"points": [{"value": 0, "score": 0}, {"value": 3, "score": 100}], "missing_score": 0, "degenerate_score": 0}'::jsonb,
    true, 1
  ),
  -- Decimal-safety model for a very large revenue value.
  (
    'revenue', 'revenue', 'Revenue curve', 'customers_revenue_total', 100,
    'positive', 'threshold',
    '{"points": [{"value": 0, "score": 0}, {"value": 1000000000000, "score": 100}], "missing_score": 0, "degenerate_score": 0}'::jsonb,
    true, 1
  ),
  -- Disabled factor: it must not contribute and must not be counted by the
  -- weight rule.
  (
    'disabled', 'customers', 'Customer density', 'customers_count', 50,
    'positive', 'threshold',
    '{"points": [{"value": 0, "score": 0}, {"value": 4, "score": 100}], "missing_score": 0}'::jsonb,
    true, 1
  ),
  (
    'disabled', 'branches', 'Branch coverage', 'branch_distance_score', 50,
    'positive', 'threshold',
    '{"points": [{"value": 0, "score": 0}, {"value": 100, "score": 100}], "missing_score": 0}'::jsonb,
    true, 2
  ),
  (
    'disabled', 'retired', 'Retired dimension', 'locations_count', 25,
    'positive', 'threshold',
    '{"points": [{"value": 0, "score": 0}, {"value": 100, "score": 100}], "missing_score": 0}'::jsonb,
    false, 3
  );

CREATE TEMP TABLE phase6_models (label text PRIMARY KEY, model_id uuid NOT NULL);
GRANT ALL ON phase6_models TO authenticated;

-- Every model is created through the public RPC, the same path the API uses, so
-- the suite exercises the real write path and the 100 percent weight rule.
INSERT INTO phase6_models (label, model_id)
SELECT spec.label, public.create_scoring_model(
  '00000000-0000-4000-8000-000000000011',
  spec.name,
  spec.description,
  'active',
  pg_temp.phase6_factor_payload(spec.label)
)
FROM (
  VALUES
    ('threshold', 'Phase 6 Threshold Model', 'Absolute threshold curves, usable for a single candidate.'),
    ('comparison', 'Phase 6 Comparison Model', 'Comparison-set min_max and inverse_min_max scaling.'),
    ('rounding', 'Phase 6 Rounding Model', 'One factor with a repeating decimal.'),
    ('revenue', 'Phase 6 Revenue Model', 'Single revenue factor for very large decimal values.'),
    ('disabled', 'Phase 6 Disabled Factor Model', 'Two enabled factors and one disabled factor.')
) AS spec(label, name, description);

-- A draft model exists only to prove the create path and to prove that an
-- inactive model cannot be scored with.
INSERT INTO phase6_models (label, model_id)
SELECT 'draft', public.create_scoring_model(
  '00000000-0000-4000-8000-000000000011',
  'Phase 6 Draft Model',
  'Created through the public RPC to prove the create path and the weight rule.',
  'draft',
  pg_temp.phase6_factor_payload('rounding')
);

DO $phase6_models_created$
DECLARE
  observation text;
  model_count integer;
BEGIN
  SELECT pg_catalog.count(*), pg_catalog.string_agg(
           pg_catalog.format('%s revision %s', model.name, model.version),
           '; ' ORDER BY model.name)
    INTO model_count, observation
    FROM public.scoring_models AS model
    JOIN phase6_models AS probe ON probe.model_id = model.id;

  IF model_count <> 6 THEN
    RAISE EXCEPTION 'The suite created % models instead of 6', model_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.scoring_models AS model
    JOIN phase6_models AS probe ON probe.model_id = model.id
    WHERE model.version < 1
  ) THEN
    RAISE EXCEPTION 'A created model did not start at revision 1 or higher';
  END IF;

  RAISE NOTICE 'Six models created through the public RPC, each at revision 1: %', observation;
END;
$phase6_models_created$;

-- ---------------------------------------------------------------------------
-- Saved candidate locations and analysis history
-- ---------------------------------------------------------------------------
SELECT pg_temp.phase6_expect_numeric(
  'the four saved candidates of the project are listed with coordinates',
  $sql$SELECT pg_catalog.count(*) FROM public.list_analysis_locations(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021'
        ) WHERE longitude IS NOT NULL AND latitude IS NOT NULL$sql$,
  4
);

SELECT pg_temp.phase6_expect_numeric(
  'a saved candidate is listed with its readable longitude',
  $sql$SELECT longitude FROM public.list_analysis_locations(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021'
        ) WHERE name = 'Candidate A Center'$sql$,
  69.2797
);

SELECT pg_temp.phase6_expect_numeric(
  'saving a candidate returns the stored coordinate pair',
  $sql$SELECT latitude FROM public.save_analysis_location(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021',
          'Candidate E Saved',
          69.2500,
          41.3010
        )$sql$,
  41.301
);

SELECT pg_temp.phase6_expect_numeric(
  'the saved candidate is then part of the project list',
  $sql$SELECT pg_catalog.count(*) FROM public.list_analysis_locations(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021'
        )$sql$,
  5
);

SELECT pg_temp.phase6_expect_error(
  'a candidate name is required',
  $sql$SELECT public.save_analysis_location(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    '   ',
    69.25,
    41.30
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'impossible coordinates are refused',
  $sql$SELECT public.save_analysis_location(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'Nowhere',
    200,
    41.30
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a candidate cannot be saved into a foreign project',
  $sql$SELECT public.save_analysis_location(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000020',
    'Foreign project candidate',
    69.28,
    41.31
  )$sql$,
  'P0002'
);

SELECT pg_temp.phase6_expect_error(
  'candidates of a foreign workspace are refused',
  $sql$SELECT pg_catalog.count(*) FROM public.list_analysis_locations(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020'
  )$sql$,
  '42501'
);

-- ---------------------------------------------------------------------------
-- Threshold normalization, weights, contributions and ordering
-- ---------------------------------------------------------------------------
INSERT INTO phase6_runs (label, payload)
SELECT 'threshold-500', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY[
    '00000000-0000-4000-8000-000000000063'::uuid,
    '00000000-0000-4000-8000-000000000064'::uuid
  ],
  500,
  (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
  'analysis'
);

SELECT pg_temp.phase6_expect_true(
  'the analysis header and the model snapshot agree on the revision used',
  $sql$(SELECT (phase6_runs.payload -> 'analysis' ->> 'model_version')::integer >= 1
            AND (phase6_runs.payload -> 'analysis' ->> 'model_version')
                = (phase6_runs.payload -> 'model' -> 'model' ->> 'version')
          FROM phase6_runs WHERE label = 'threshold-500')$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'candidate A: customers 3 interpolates to 75 on the authored curve',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'normalized_metrics' ->> 'customers')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  75
);

SELECT pg_temp.phase6_expect_numeric(
  'candidate A: competition 1 scores 50 (more competitors is worse)',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'normalized_metrics' ->> 'competition')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  50
);

SELECT pg_temp.phase6_expect_numeric(
  'candidate A: contributions are 37.50 and 25.00 for 50 percent weights',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'factor_contributions' -> 0 ->> 'contribution')::numeric
          + (phase6_runs.payload -> 'results' -> 0 -> 'factor_contributions' -> 1 ->> 'contribution')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  62.5
);

SELECT pg_temp.phase6_expect_numeric(
  'candidate A final score is the sum of the weighted contributions',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  62.5
);

SELECT pg_temp.phase6_expect_numeric(
  'candidate B has no data inside 500 m, so the missing score applies',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 1 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  50
);

SELECT pg_temp.phase6_expect_numeric(
  'the better candidate ranks first',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'rank')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  1
);

SELECT pg_temp.phase6_expect_numeric(
  'raw counts come from PostGIS: three customers inside 500 m of the center',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'customers_count')::numeric
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  3
);

SELECT pg_temp.phase6_expect_text(
  'revenue stays exact decimal text: 999.99 + 100.01 + 200.02',
  $sql$(SELECT phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'customers_revenue_total'
          FROM phase6_runs WHERE label = 'threshold-500')$sql$,
  '1300.02'
);

SELECT pg_temp.phase6_expect_true(
  'a fresh analysis is not flagged as outdated',
  $sql$(SELECT (phase6_runs.payload -> 'analysis' ->> 'may_be_outdated')::boolean IS FALSE
          FROM phase6_runs WHERE label = 'threshold-500')$sql$
);

SELECT pg_temp.phase6_expect_true(
  'the payload carries aggregates only: no phone, address or per-customer revenue fields',
  $sql$(SELECT (phase6_runs.payload::text NOT LIKE '%"phone"%'
            AND phase6_runs.payload::text NOT LIKE '%"address"%'
            AND phase6_runs.payload::text NOT LIKE '%"external_id"%')
          FROM phase6_runs WHERE label = 'threshold-500')$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'every stored contribution adds up to the stored final score',
  $sql$(SELECT pg_catalog.round(pg_catalog.sum((entry.value ->> 'contribution')::numeric), 2)
          FROM phase6_runs AS run,
               LATERAL pg_catalog.jsonb_array_elements(run.payload -> 'results' -> 0 -> 'factor_contributions') AS entry(value)
          WHERE run.label = 'threshold-500')$sql$,
  62.5
);

-- The same inputs must always produce the same output: no randomness, no clock
-- dependence beyond the snapshot timestamp.
INSERT INTO phase6_runs (label, payload)
SELECT 'threshold-500-repeat', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY[
    '00000000-0000-4000-8000-000000000063'::uuid,
    '00000000-0000-4000-8000-000000000064'::uuid
  ],
  500,
  (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
  'analysis'
);

SELECT pg_temp.phase6_expect_true(
  'repeating an analysis with the same inputs produces identical results',
  $sql$(SELECT (SELECT payload -> 'results' FROM phase6_runs WHERE label = 'threshold-500')
                 = (SELECT payload -> 'results' FROM phase6_runs WHERE label = 'threshold-500-repeat'))$sql$
);

-- ---------------------------------------------------------------------------
-- Comparison-set normalization: min_max, inverse_min_max, degenerate sets
-- ---------------------------------------------------------------------------
INSERT INTO phase6_runs (label, payload)
SELECT 'comparison-1000', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY[
    '00000000-0000-4000-8000-000000000063'::uuid,
    '00000000-0000-4000-8000-000000000064'::uuid,
    '00000000-0000-4000-8000-000000000065'::uuid
  ],
  1000,
  (SELECT model_id FROM phase6_models WHERE label = 'comparison'),
  'comparison'
);

SELECT pg_temp.phase6_expect_numeric(
  'min_max scales the largest customer count to 100 and the smallest to 0',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'normalized_metrics' ->> 'customers')::numeric
          FROM phase6_runs WHERE label = 'comparison-1000')$sql$,
  100
);

SELECT pg_temp.phase6_expect_numeric(
  'inverse_min_max gives the candidate with no competitors the full 100',
  $sql$(SELECT (entry.value -> 'normalized_metrics' ->> 'competition')::numeric
          FROM phase6_runs AS run,
               LATERAL pg_catalog.jsonb_array_elements(run.payload -> 'results') AS entry(value)
          WHERE run.label = 'comparison-1000'
            AND entry.value ->> 'candidate_name' = 'Candidate B North')$sql$,
  100
);

SELECT pg_temp.phase6_expect_numeric(
  'weighted contributions are 60 for candidate A and 40 for candidate B',
  $sql$(SELECT (entry.value ->> 'final_score')::numeric
          FROM phase6_runs AS run,
               LATERAL pg_catalog.jsonb_array_elements(run.payload -> 'results') AS entry(value)
          WHERE run.label = 'comparison-1000'
            AND entry.value ->> 'candidate_name' = 'Candidate B North')$sql$,
  40
);

SELECT pg_temp.phase6_expect_numeric(
  'the comparison results are ordered by score, so the first row is the best',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'comparison-1000')$sql$,
  60
);

SELECT pg_temp.phase6_expect_true(
  'equal totals are ranked deterministically: Candidate C Near Center takes rank 2',
  $sql$(SELECT (entry.value ->> 'rank')::integer = 2
          FROM phase6_runs AS run,
               LATERAL pg_catalog.jsonb_array_elements(run.payload -> 'results') AS entry(value)
          WHERE run.label = 'comparison-1000'
            AND entry.value ->> 'candidate_name' = 'Candidate C Near Center')$sql$
);

SELECT pg_temp.phase6_expect_text(
  'the tie break puts Candidate A Center ahead of Candidate C Near Center',
  $sql$(SELECT phase6_runs.payload -> 'results' -> 0 ->> 'candidate_name'
          FROM phase6_runs WHERE label = 'comparison-1000')$sql$,
  'Candidate A Center'
);

INSERT INTO phase6_runs (label, payload)
SELECT 'comparison-degenerate', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY[
    '00000000-0000-4000-8000-000000000063'::uuid,
    '00000000-0000-4000-8000-000000000065'::uuid
  ],
  1000,
  (SELECT model_id FROM phase6_models WHERE label = 'comparison'),
  'comparison'
);

SELECT pg_temp.phase6_expect_numeric(
  'a comparison set with identical values scores the documented degenerate value',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'comparison-degenerate')$sql$,
  25
);

SELECT pg_temp.phase6_expect_numeric(
  'both tied candidates score the same degenerate value',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 1 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'comparison-degenerate')$sql$,
  25
);

-- ---------------------------------------------------------------------------
-- Deterministic rounding, very large decimals, zero-data candidates
-- ---------------------------------------------------------------------------
INSERT INTO phase6_runs (label, payload)
SELECT 'rounding-100', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
  100,
  (SELECT model_id FROM phase6_models WHERE label = 'rounding'),
  'analysis'
);

SELECT pg_temp.phase6_expect_numeric(
  'two customers on a 0..3 curve round half away from zero to 66.67',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'rounding-100')$sql$,
  66.67
);

SELECT pg_temp.phase6_expect_numeric(
  'the stored normalized value is rounded to two decimals, not truncated',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'normalized_metrics' ->> 'customers')::numeric
          FROM phase6_runs WHERE label = 'rounding-100')$sql$,
  66.67
);

INSERT INTO phase6_runs (label, payload)
SELECT 'revenue-3000', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000064'::uuid],
  3000,
  (SELECT model_id FROM phase6_models WHERE label = 'revenue'),
  'analysis'
);

SELECT pg_temp.phase6_expect_text(
  'a 987654321098.76 revenue survives as exact decimal text',
  $sql$(SELECT phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'customers_revenue_total'
          FROM phase6_runs WHERE label = 'revenue-3000')$sql$,
  '987654321098.76'
);

SELECT pg_temp.phase6_expect_text(
  'the revenue contribution repeats the exact decimal it scored',
  $sql$(SELECT (entry.value ->> 'raw_text')
          FROM phase6_runs AS run,
               LATERAL pg_catalog.jsonb_array_elements(run.payload -> 'results' -> 0 -> 'factor_contributions') AS entry(value)
          WHERE run.label = 'revenue-3000'
          LIMIT 1)$sql$,
  '987654321098.76'
);

SELECT pg_temp.phase6_expect_numeric(
  'a very large metric interpolates without float drift',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'revenue-3000')$sql$,
  98.77
);

INSERT INTO phase6_runs (label, payload)
SELECT 'zeros-1000', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000066'::uuid],
  1000,
  (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
  'analysis'
);

SELECT pg_temp.phase6_expect_text(
  'a candidate with no customers stores an explicit zero revenue, never null',
  $sql$(SELECT phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'customers_revenue_total'
          FROM phase6_runs WHERE label = 'zeros-1000')$sql$,
  '0'
);

SELECT pg_temp.phase6_expect_numeric(
  'a candidate with no data still produces a valid score',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'zeros-1000')$sql$,
  50
);

SELECT pg_temp.phase6_expect_true(
  'a branch beyond the radius scores zero coverage, never a negative one',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'nearest_branch_distance_meters')::numeric > 1000
            AND (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'branch_distance_score')::numeric = 0
          FROM phase6_runs WHERE label = 'zeros-1000')$sql$
);

SELECT pg_temp.phase6_expect_true(
  'zero-data metrics stay finite: no NaN or infinity anywhere in the payload',
  $sql$(SELECT phase6_runs.payload::text NOT LIKE '%NaN%'
            AND phase6_runs.payload::text NOT LIKE '%Infinity%'
          FROM phase6_runs WHERE label = 'zeros-1000')$sql$
);

SELECT pg_temp.phase6_expect_true(
  'every score in every scenario stays within 0 and 100',
  $sql$(SELECT pg_catalog.bool_and((entry.value ->> 'final_score')::numeric BETWEEN 0 AND 100)
          FROM phase6_runs AS run,
               LATERAL pg_catalog.jsonb_array_elements(run.payload -> 'results') AS entry(value))$sql$
);

-- ---------------------------------------------------------------------------
-- Disabled factors
-- ---------------------------------------------------------------------------
INSERT INTO phase6_runs (label, payload)
SELECT 'disabled-500', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
  500,
  (SELECT model_id FROM phase6_models WHERE label = 'disabled'),
  'analysis'
);

SELECT pg_temp.phase6_expect_numeric(
  'only the two enabled factors contribute',
  $sql$(SELECT pg_catalog.jsonb_array_length(phase6_runs.payload -> 'results' -> 0 -> 'factor_contributions')::numeric
          FROM phase6_runs WHERE label = 'disabled-500')$sql$,
  2
);

SELECT pg_temp.phase6_expect_true(
  'the disabled factor key appears in the snapshot but never in the results',
  $sql$(SELECT (phase6_runs.payload ->> 'model')::text LIKE '%"retired"%'
            AND (phase6_runs.payload -> 'results' -> 0 -> 'normalized_metrics' ? 'retired') IS FALSE
            AND (phase6_runs.payload -> 'results' -> 0 -> 'normalized_metrics' ? 'customers')
          FROM phase6_runs WHERE label = 'disabled-500')$sql$
);

-- A workspace can have no branch at all: the distance is then explicitly null
-- and coverage scores zero, while the rest of the analysis stays valid.
DELETE FROM public.branches WHERE id = '50000000-0000-4000-8000-000000000003';

INSERT INTO phase6_runs (label, payload)
SELECT 'no-branch-500', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
  500,
  (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
  'analysis'
);

SELECT pg_temp.phase6_expect_true(
  'a workspace with no branch reports an explicit null distance and zero coverage',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'nearest_branch_id') IS NULL
            AND (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'nearest_branch_distance_meters') IS NULL
            AND (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'branch_distance_score')::numeric = 0
            AND (phase6_runs.payload -> 'results' -> 0 -> 'raw_metrics' ->> 'branches_count')::numeric = 0
          FROM phase6_runs WHERE label = 'no-branch-500')$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'removing a branch leaves the customer and competition scores untouched',
  $sql$(SELECT (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric
          FROM phase6_runs WHERE label = 'no-branch-500')$sql$,
  62.5
);

-- ---------------------------------------------------------------------------
-- Analysis history
-- ---------------------------------------------------------------------------
SELECT pg_temp.phase6_expect_numeric(
  'the history honours its limit and returns stored payloads',
  $sql$SELECT pg_catalog.count(*) FROM public.list_location_analyses(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021',
          NULL,
          4
        )$sql$,
  4
);

SELECT pg_temp.phase6_expect_true(
  'a history entry carries the stored payload of one of the runs, results included',
  $sql$(SELECT pg_catalog.bool_and(
                 (entry.analysis -> 'analysis' ->> 'id') IN (
                   SELECT payload -> 'analysis' ->> 'id' FROM phase6_runs
                 )
                 AND pg_catalog.jsonb_array_length(entry.analysis -> 'results') >= 1
                 AND (entry.analysis -> 'results' -> 0 ->> 'final_score') IS NOT NULL
               )
          FROM public.list_location_analyses(
                 '00000000-0000-4000-8000-000000000011',
                 '00000000-0000-4000-8000-000000000021',
                 NULL,
                 4
               ) AS entry)$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'the history limit is honoured',
  $sql$SELECT pg_catalog.count(*) FROM public.list_location_analyses(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021',
          NULL,
          1
        )$sql$,
  1
);

SELECT pg_temp.phase6_expect_numeric(
  'the mode filter keeps only comparisons',
  $sql$SELECT pg_catalog.count(*) FROM public.list_location_analyses(
          '00000000-0000-4000-8000-000000000011',
          '00000000-0000-4000-8000-000000000021',
          'comparison',
          20
        )$sql$,
  2
);

SELECT pg_temp.phase6_expect_error(
  'an unknown mode filter is refused',
  $sql$SELECT pg_catalog.count(*) FROM public.list_location_analyses(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    'forecast',
    5
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'the analysis history of a foreign workspace is refused',
  $sql$SELECT pg_catalog.count(*) FROM public.list_location_analyses(
    '00000000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000020',
    NULL,
    5
  )$sql$,
  '42501'
);

-- ---------------------------------------------------------------------------
-- Model editing must never rewrite a stored analysis
-- ---------------------------------------------------------------------------
INSERT INTO phase6_runs (label, payload)
SELECT 'snapshot-before-edit', public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
  500,
  (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
  'analysis'
);

CREATE TEMP TABLE phase6_edit_probe (version_before integer, version_after integer, rescored numeric);
GRANT ALL ON phase6_edit_probe TO authenticated;

INSERT INTO phase6_edit_probe (version_before)
SELECT model.version
  FROM public.scoring_models AS model
  JOIN phase6_models AS probe ON probe.model_id = model.id
 WHERE probe.label = 'threshold';

-- A different definition: the customer factor now weighs 100 and the
-- competition factor is gone.
UPDATE phase6_factor_specs
   SET weight = 100,
       configuration = '{"points": [{"value": 0, "score": 0}, {"value": 4, "score": 100}], "missing_score": 0}'::jsonb
 WHERE model_label = 'threshold' AND factor_key = 'customers';

DELETE FROM phase6_factor_specs WHERE model_label = 'threshold' AND factor_key = 'competition';

UPDATE phase6_edit_probe
   SET version_after = public.update_scoring_model(
     (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
     'Phase 6 Threshold Model (edited)',
     'Edited by the suite: one factor at full weight.',
     'active',
     pg_temp.phase6_factor_payload('threshold')
   );

SELECT pg_temp.phase6_expect_true(
  'saving a model advances its revision',
  $sql$(SELECT version_after > version_before FROM phase6_edit_probe)$sql$
);

SELECT pg_temp.phase6_expect_true(
  'the stored analysis keeps its own snapshot, score and contributions',
  $sql$(SELECT (phase6_runs.payload -> 'analysis' ->> 'model_version')::integer = phase6_edit_probe.version_before
            AND (phase6_runs.payload -> 'analysis' ->> 'model_name') = 'Phase 6 Threshold Model'
            AND (phase6_runs.payload -> 'results' -> 0 ->> 'final_score')::numeric = 62.5
            AND pg_catalog.jsonb_array_length(phase6_runs.payload -> 'results' -> 0 -> 'factor_contributions') = 2
          FROM phase6_runs, phase6_edit_probe
          WHERE phase6_runs.label = 'snapshot-before-edit')$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'reading the old analysis still returns the score it was run with',
  $sql$(SELECT (public.get_location_analysis(
            '00000000-0000-4000-8000-000000000011',
            (SELECT (payload -> 'analysis' ->> 'id')::uuid FROM phase6_runs WHERE label = 'snapshot-before-edit')
          ) -> 'results' -> 0 ->> 'final_score')::numeric)$sql$,
  62.5
);

UPDATE phase6_edit_probe
   SET rescored = (public.run_location_analysis(
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000021',
  ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
  500,
  (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
  'analysis'
) -> 'results' -> 0 ->> 'final_score')::numeric;

SELECT pg_temp.phase6_expect_numeric(
  'a new run uses the edited definition: three customers of four score 75',
  $sql$(SELECT rescored FROM phase6_edit_probe)$sql$,
  75
);

-- ---------------------------------------------------------------------------
-- Freshness signal
-- ---------------------------------------------------------------------------
UPDATE public.customers
   SET revenue = revenue
 WHERE id = '00000000-0000-4000-8000-000000000060';

SELECT pg_temp.phase6_expect_true(
  'a stored analysis is flagged once workspace data changes after the snapshot',
  $sql$(SELECT (public.get_location_analysis(
            '00000000-0000-4000-8000-000000000011',
            (SELECT (payload -> 'analysis' ->> 'id')::uuid FROM phase6_runs WHERE label = 'snapshot-before-edit')
          ) -> 'analysis' ->> 'may_be_outdated')::boolean)$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'flagging an analysis does not change the score it recorded',
  $sql$(SELECT (public.get_location_analysis(
            '00000000-0000-4000-8000-000000000011',
            (SELECT (payload -> 'analysis' ->> 'id')::uuid FROM phase6_runs WHERE label = 'snapshot-before-edit')
          ) -> 'results' -> 0 ->> 'final_score')::numeric)$sql$,
  62.5
);

SELECT pg_temp.phase6_expect_true(
  'a stored analysis is reproducible through the read RPC without re-reading the model',
  $sql$(SELECT (public.get_location_analysis(
            '00000000-0000-4000-8000-000000000011',
            (SELECT (payload -> 'analysis' ->> 'id')::uuid FROM phase6_runs WHERE label = 'snapshot-before-edit')
          ) -> 'model' -> 'model' ->> 'name') = 'Phase 6 Threshold Model')$sql$
);

-- ---------------------------------------------------------------------------
-- Rejected definitions and inputs (the database is the authority)
-- ---------------------------------------------------------------------------
SELECT pg_temp.phase6_expect_error(
  'enabled weights below 100 are rejected',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Bad Weight Model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 90, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'enabled weights above 100 are rejected',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Overweight Model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100.5, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a model where every factor is disabled is rejected',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 All Disabled Model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}, "enabled": false}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'duplicate factor keys are rejected',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Duplicate Key Model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 50, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}, {"key": "customers", "label": "Customers again", "metric": "customers_count", "weight": 50, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'descending threshold values are rejected',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Descending Threshold Model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 10, "score": 0}, {"value": 5, "score": 100}]}}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a positive threshold that decreases is rejected',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Non Monotonic Model',
    NULL,
    'active',
    '[{"key": "customers", "label": "Customers", "metric": "customers_count", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 100}, {"value": 5, "score": 0}]}}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'min_max on a negative factor is rejected: use inverse_min_max',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Wrong Method Model',
    NULL,
    'active',
    '[{"key": "competition", "label": "Competition", "metric": "competitors_count", "weight": 100, "direction": "negative", "normalization": "min_max", "configuration": {}}]'::jsonb
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a metric nothing measures is rejected by the table constraint',
  $sql$SELECT public.create_scoring_model(
    '00000000-0000-4000-8000-000000000011',
    'Phase 6 Unknown Metric Model',
    NULL,
    'active',
    '[{"key": "magic", "label": "Magic score", "metric": "ai_prediction", "weight": 100, "direction": "positive", "normalization": "threshold", "configuration": {"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}}]'::jsonb
  )$sql$,
  '23514'
);

SELECT pg_temp.phase6_expect_error(
  'a direct insert that breaks the weight rule is refused at commit time',
  $sql$DO $unbalanced$
       BEGIN
         INSERT INTO public.scoring_model_factors (
           model_id, workspace_id, key, label, metric, weight, direction, normalization, configuration
         ) VALUES (
           (SELECT model_id FROM phase6_models WHERE label = 'threshold'),
           '00000000-0000-4000-8000-000000000011',
           'unbalanced', 'Unbalanced', 'locations_count', 10, 'positive', 'threshold',
           '{"points": [{"value": 0, "score": 0}, {"value": 1, "score": 100}]}'::jsonb
         );
         EXECUTE 'SET CONSTRAINTS scoring_model_factors_weights_balanced IMMEDIATE';
       END
       $unbalanced$;$sql$,
  '23514'
);

SELECT pg_temp.phase6_expect_error(
  'an analysis with six candidates is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY[
      '00000000-0000-4000-8000-000000000063'::uuid, '00000000-0000-4000-8000-000000000064'::uuid,
      '00000000-0000-4000-8000-000000000065'::uuid, '00000000-0000-4000-8000-000000000066'::uuid,
      '00000000-0000-4000-8000-000000000063'::uuid, '00000000-0000-4000-8000-000000000064'::uuid
    ],
    500, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'analysis'
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'repeated candidate ids are refused even when the array is short',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000063'::uuid, '00000000-0000-4000-8000-000000000063'::uuid],
    500, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'analysis'
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a comparison with one candidate is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
    500, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'comparison'
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a radius under 100 m is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
    99, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'analysis'
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a radius over 20 km is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
    20001, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'analysis'
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'an unknown mode is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
    500, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'forecast'
  )$sql$,
  '22023'
);

SELECT pg_temp.phase6_expect_error(
  'a candidate outside the chosen project is refused',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['50000000-0000-4000-8000-000000000001'::uuid],
    500, (SELECT model_id FROM phase6_models WHERE label = 'threshold'), 'analysis'
  )$sql$,
  'P0002'
);

SELECT pg_temp.phase6_expect_error(
  'an inactive model cannot be scored with',
  $sql$SELECT public.run_location_analysis(
    '00000000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000021',
    ARRAY['00000000-0000-4000-8000-000000000063'::uuid],
    500,
    (SELECT id FROM public.scoring_models
      WHERE name = 'Phase 6 Draft Model' AND status = 'draft'),
    'analysis'
  )$sql$,
  '22023'
);

-- ---------------------------------------------------------------------------
-- Function-level units
-- ---------------------------------------------------------------------------
SELECT pg_temp.phase6_expect_numeric(
  'interpolation clamps below the first stop',
  $sql$SELECT public.scoring_interpolate('[{"value": 10, "score": 20}, {"value": 20, "score": 80}]'::jsonb, 0)$sql$,
  20
);

SELECT pg_temp.phase6_expect_numeric(
  'interpolation clamps above the last stop',
  $sql$SELECT public.scoring_interpolate('[{"value": 10, "score": 20}, {"value": 20, "score": 80}]'::jsonb, 500)$sql$,
  80
);

SELECT pg_temp.phase6_expect_numeric(
  'interpolation is linear between stops',
  $sql$SELECT public.scoring_interpolate('[{"value": 10, "score": 20}, {"value": 20, "score": 80}]'::jsonb, 15)$sql$,
  50
);

SELECT pg_temp.phase6_expect_numeric(
  'interpolation rounds to two decimals',
  $sql$SELECT public.scoring_interpolate('[{"value": 0, "score": 0}, {"value": 3, "score": 100}]'::jsonb, 1)$sql$,
  33.33
);

SELECT pg_temp.phase6_expect_true(
  'a one-point threshold curve is invalid',
  $sql$SELECT public.scoring_threshold_points_valid('[{"value": 0, "score": 0}]'::jsonb, 'positive') IS FALSE$sql$
);

SELECT pg_temp.phase6_expect_true(
  'a curve with a score above 100 is invalid',
  $sql$SELECT public.scoring_threshold_points_valid('[{"value": 0, "score": 0}, {"value": 1, "score": 101}]'::jsonb, 'positive') IS FALSE$sql$
);

SELECT pg_temp.phase6_expect_true(
  'a neutral direction accepts a curve that both rises and falls',
  $sql$SELECT public.scoring_threshold_points_valid('[{"value": 0, "score": 0}, {"value": 1, "score": 100}, {"value": 2, "score": 40}]'::jsonb, 'neutral')$sql$
);

SELECT pg_temp.phase6_expect_numeric(
  'metric values read JSON numbers',
  $sql$SELECT public.scoring_metric_value('{"customers_count": 4}'::jsonb, 'customers_count')$sql$,
  4
);

SELECT pg_temp.phase6_expect_numeric(
  'metric values read decimal-safe strings',
  $sql$SELECT public.scoring_metric_value('{"customers_revenue_total": "1300.02"}'::jsonb, 'customers_revenue_total')$sql$,
  1300.02
);

SELECT pg_temp.phase6_expect_true(
  'a missing metric is null, never zero',
  $sql$SELECT public.scoring_metric_value('{}'::jsonb, 'customers_count') IS NULL$sql$
);

SELECT pg_temp.phase6_expect_text(
  'metric text keeps the original serialized decimal',
  $sql$SELECT public.scoring_metric_text('{"customers_revenue_total": "1300.02"}'::jsonb, 'customers_revenue_total')$sql$,
  '1300.02'
);

DO $phase6_engine_summary$
DECLARE
  run_count integer;
  analysis_count integer;
  result_count integer;
BEGIN
  SELECT pg_catalog.count(*) INTO run_count FROM phase6_runs;
  SELECT pg_catalog.count(*) INTO analysis_count FROM public.location_analyses
   WHERE workspace_id = '00000000-0000-4000-8000-000000000011';
  SELECT pg_catalog.count(*) INTO result_count FROM public.location_analysis_results
   WHERE workspace_id = '00000000-0000-4000-8000-000000000011';

  RAISE NOTICE 'Scoring engine scenarios passed: % payloads, % stored analyses, % stored results',
    run_count, analysis_count, result_count;
  RAISE NOTICE 'Phase 6 scoring engine checks passed';
END;
$phase6_engine_summary$;

ROLLBACK;
