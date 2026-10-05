-- Phase 6: configurable, explainable location scoring.
--
-- The engine keeps five things apart, in this order:
--
--   RAW METRIC      -> what PostGIS measured inside the radius (counts, money)
--   NORMALIZED      -> the same metric expressed on a 0..100 scale, by the
--                      factor's own method (threshold curve or comparison set)
--   WEIGHT          -> the factor's share of the model, percentages summing to 100
--   CONTRIBUTION    -> normalized * weight / 100
--   FINAL SCORE     -> the sum of the contributions, clamped to 0..100
--
-- Nothing stores only a mysterious final score: every result row carries the raw
-- metrics, the normalized values, the factor contributions and the full model
-- snapshot that produced them. A model edit never rewrites an old analysis.
--
-- Raw spatial metrics come from public.workspace_radius_analysis (Phase 4), which
-- wraps the same ST_DWithin queries as the Phase 3 demo path. No spatial logic is
-- re-implemented here, and no metric is invented in JavaScript.
--
-- Weights are percentages: enabled factors must total exactly 100. The rule is
-- enforced by a deferred constraint trigger, so it cannot be bypassed by writing
-- to the tables directly, and by the model RPCs, which validate the payload
-- before writing so the API can return a precise, safe message.
--
-- Money stays decimal: revenue is read from PostgreSQL numeric, used as numeric
-- for every calculation, and serialized to the payload as text.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE public.scoring_model_status AS ENUM ('draft', 'active', 'archived');

-- Direction says which way the raw metric points:
--   positive - more is better (customers, revenue, commercial activity)
--   negative - more is worse (competition)
--   neutral  - no monotonic claim; only a threshold curve may express it
CREATE TYPE public.scoring_factor_direction AS ENUM ('positive', 'negative', 'neutral');

-- How a raw metric becomes 0..100:
--   min_max          scale against the compared candidate set (positive only)
--   inverse_min_max  the same scale inverted (negative only)
--   threshold        an authored value/score curve (absolute, works for one site)
CREATE TYPE public.scoring_normalization AS ENUM ('min_max', 'inverse_min_max', 'threshold');

-- ---------------------------------------------------------------------------
-- scoring_models
-- ---------------------------------------------------------------------------

CREATE TABLE public.scoring_models (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  status public.scoring_model_status NOT NULL DEFAULT 'draft',
  -- Revision counter of the factor definition. It is 0 only while a model has no
  -- factors yet; every factor statement (and every model save through
  -- update_scoring_model) advances it by one, so an analysis can always say
  -- which revision it scored with.
  version integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT scoring_models_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  CONSTRAINT scoring_models_created_by_fk
    FOREIGN KEY (created_by)
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  -- Composite FK target for the factor and analysis tables, so a model can never
  -- be cited from another workspace.
  CONSTRAINT scoring_models_workspace_identity_unique UNIQUE (id, workspace_id),
  CONSTRAINT scoring_models_name_nonempty CHECK (
    pg_catalog.char_length(pg_catalog.btrim(name)) > 0
  ),
  CONSTRAINT scoring_models_name_length CHECK (pg_catalog.char_length(name) <= 120),
  CONSTRAINT scoring_models_description_length CHECK (
    description IS NULL OR pg_catalog.char_length(description) <= 500
  ),
  CONSTRAINT scoring_models_version_nonnegative CHECK (version >= 0)
);

CREATE UNIQUE INDEX scoring_models_workspace_name_key
  ON public.scoring_models (workspace_id, pg_catalog.lower(pg_catalog.btrim(name)));

CREATE INDEX scoring_models_workspace_status_idx
  ON public.scoring_models (workspace_id, status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Threshold configuration validation
-- ---------------------------------------------------------------------------

-- A threshold factor is an ordered list of value/score stops:
--   [{"value": 0, "score": 0}, {"value": 500, "score": 50}, {"value": 1000, "score": 100}]
-- Values must ascend; scores must be within 0..100 and follow the declared
-- direction (positive: never decrease, negative: never increase, neutral: an
-- explicit curve the author owns, so any monotonicity is accepted).
CREATE OR REPLACE FUNCTION public.scoring_threshold_points_valid(
  p_points jsonb,
  p_direction public.scoring_factor_direction
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  point jsonb;
  previous_value numeric;
  previous_score numeric;
  current_value numeric;
  current_score numeric;
  position integer := 0;
BEGIN
  IF p_points IS NULL OR pg_catalog.jsonb_typeof(p_points) <> 'array' THEN
    RETURN false;
  END IF;
  IF pg_catalog.jsonb_array_length(p_points) < 2 THEN
    RETURN false;
  END IF;

  FOR point IN SELECT value FROM pg_catalog.jsonb_array_elements(p_points) AS entry(value) LOOP
    position := position + 1;

    IF pg_catalog.jsonb_typeof(point) <> 'object'
       OR NOT (point ? 'value')
       OR NOT (point ? 'score')
       OR pg_catalog.jsonb_typeof(point -> 'value') <> 'number'
       OR pg_catalog.jsonb_typeof(point -> 'score') <> 'number' THEN
      RETURN false;
    END IF;

    current_value := (point ->> 'value')::numeric;
    current_score := (point ->> 'score')::numeric;

    IF current_score < 0 OR current_score > 100 THEN
      RETURN false;
    END IF;

    IF position > 1 THEN
      IF current_value <= previous_value THEN
        RETURN false;
      END IF;
      IF p_direction = 'positive' AND current_score < previous_score THEN
        RETURN false;
      END IF;
      IF p_direction = 'negative' AND current_score > previous_score THEN
        RETURN false;
      END IF;
    END IF;

    previous_value := current_value;
    previous_score := current_score;
  END LOOP;

  RETURN true;
END;
$function$;

COMMENT ON FUNCTION public.scoring_threshold_points_valid(jsonb, public.scoring_factor_direction) IS
  'Validates a threshold factor configuration: ascending values, scores within 0..100, and monotonic scores matching the factor direction. IMMUTABLE so it can be used from a CHECK constraint.';

-- Piecewise-linear interpolation over the validated stops. Below the first stop
-- the first score applies, above the last stop the last score applies, so a
-- threshold factor never returns something outside its authored curve.
CREATE OR REPLACE FUNCTION public.scoring_interpolate(p_points jsonb, p_value numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  first_value numeric := (p_points -> 0 ->> 'value')::numeric;
  first_score numeric := (p_points -> 0 ->> 'score')::numeric;
  last_index integer := pg_catalog.jsonb_array_length(p_points) - 1;
  last_value numeric := (p_points -> last_index ->> 'value')::numeric;
  last_score numeric := (p_points -> last_index ->> 'score')::numeric;
  lower_value numeric;
  lower_score numeric;
  upper_value numeric;
  upper_score numeric;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_value <= first_value THEN
    RETURN pg_catalog.round(first_score, 2);
  END IF;
  IF p_value >= last_value THEN
    RETURN pg_catalog.round(last_score, 2);
  END IF;

  SELECT (entry.value ->> 'value')::numeric, (entry.value ->> 'score')::numeric
    INTO upper_value, upper_score
    FROM pg_catalog.jsonb_array_elements(p_points) AS entry(value)
   WHERE (entry.value ->> 'value')::numeric >= p_value
   ORDER BY (entry.value ->> 'value')::numeric
   LIMIT 1;

  SELECT (entry.value ->> 'value')::numeric, (entry.value ->> 'score')::numeric
    INTO lower_value, lower_score
    FROM pg_catalog.jsonb_array_elements(p_points) AS entry(value)
   WHERE (entry.value ->> 'value')::numeric < upper_value
   ORDER BY (entry.value ->> 'value')::numeric DESC
   LIMIT 1;

  IF upper_value = lower_value THEN
    RETURN pg_catalog.round(upper_score, 2);
  END IF;

  RETURN pg_catalog.round(
    lower_score + (p_value - lower_value) * (upper_score - lower_score) / (upper_value - lower_value),
    2
  );
END;
$function$;

COMMENT ON FUNCTION public.scoring_interpolate(jsonb, numeric) IS
  'Piecewise-linear interpolation between threshold stops, clamped to the authored curve. IMMUTABLE, deterministic rounding to two decimals.';

-- ---------------------------------------------------------------------------
-- scoring_model_factors
-- ---------------------------------------------------------------------------

CREATE TABLE public.scoring_model_factors (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  model_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  metric text NOT NULL,
  weight numeric(5,2) NOT NULL,
  direction public.scoring_factor_direction NOT NULL,
  normalization public.scoring_normalization NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT scoring_model_factors_model_fk
    FOREIGN KEY (model_id, workspace_id)
    REFERENCES public.scoring_models (id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT scoring_model_factors_model_key_unique UNIQUE (model_id, key),
  CONSTRAINT scoring_model_factors_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT scoring_model_factors_label_nonempty CHECK (
    pg_catalog.char_length(pg_catalog.btrim(label)) > 0
  ),
  -- Only metrics the radius analysis actually produces (or derives from it) are
  -- selectable; a factor cannot promise a number nothing measures.
  CONSTRAINT scoring_model_factors_metric_supported CHECK (
    metric = ANY (ARRAY[
      'customers_count',
      'customers_revenue_total',
      'competitors_count',
      'branches_count',
      'locations_count',
      'nearest_branch_distance_meters',
      'customers_per_sq_km',
      'competitors_per_sq_km',
      'revenue_per_sq_km',
      'customer_to_competitor_ratio',
      'branch_distance_score',
      'commercial_poi_density'
    ]::text[])
  ),
  CONSTRAINT scoring_model_factors_weight_range CHECK (weight >= 0 AND weight <= 100),
  CONSTRAINT scoring_model_factors_enabled_weight_positive CHECK (NOT enabled OR weight > 0),
  -- One spelling per intent: min_max is the positive comparison method,
  -- inverse_min_max is the negative one, and a threshold curve carries its own
  -- direction (validated against its points).
  CONSTRAINT scoring_model_factors_method_direction CHECK (
    (normalization = 'min_max' AND direction = 'positive')
    OR (normalization = 'inverse_min_max' AND direction = 'negative')
    OR normalization = 'threshold'
  ),
  CONSTRAINT scoring_model_factors_configuration_object CHECK (
    pg_catalog.jsonb_typeof(configuration) = 'object'
  ),
  CONSTRAINT scoring_model_factors_configuration_shape CHECK (
    (
      NOT (configuration ? 'missing_score')
      OR (
        pg_catalog.jsonb_typeof(configuration -> 'missing_score') = 'number'
        AND (configuration ->> 'missing_score')::numeric BETWEEN 0 AND 100
      )
    )
    AND (
      NOT (configuration ? 'degenerate_score')
      OR (
        pg_catalog.jsonb_typeof(configuration -> 'degenerate_score') = 'number'
        AND (configuration ->> 'degenerate_score')::numeric BETWEEN 0 AND 100
      )
    )
    AND (
      normalization <> 'threshold'
      OR (
        configuration ? 'points'
        AND public.scoring_threshold_points_valid(configuration -> 'points', direction)
      )
    )
  ),
  CONSTRAINT scoring_model_factors_sort_order_nonnegative CHECK (sort_order >= 0)
);

CREATE INDEX scoring_model_factors_model_order_idx
  ON public.scoring_model_factors (model_id, sort_order, key);

-- ---------------------------------------------------------------------------
-- location_analyses
-- ---------------------------------------------------------------------------

CREATE TABLE public.location_analyses (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scoring_model_id uuid NOT NULL,
  model_name text NOT NULL,
  model_version integer NOT NULL,
  -- Full copy of the model definition used for this run (all factors, enabled or
  -- not). This is what keeps an old analysis explainable after the model moves on.
  model_snapshot jsonb NOT NULL,
  mode text NOT NULL DEFAULT 'analysis',
  radius_meters integer NOT NULL,
  candidate_count integer NOT NULL,
  data_snapshot_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT location_analyses_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  CONSTRAINT location_analyses_project_fk
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects (id, workspace_id)
    ON DELETE RESTRICT,
  -- A foreign scoring model is impossible: the composite FK has to match both id
  -- and workspace.
  CONSTRAINT location_analyses_model_fk
    FOREIGN KEY (scoring_model_id, workspace_id)
    REFERENCES public.scoring_models (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT location_analyses_created_by_fk
    FOREIGN KEY (created_by)
    REFERENCES auth.users (id)
    ON DELETE RESTRICT,
  CONSTRAINT location_analyses_workspace_identity_unique UNIQUE (id, workspace_id),
  CONSTRAINT location_analyses_mode_valid CHECK (mode IN ('analysis', 'comparison')),
  CONSTRAINT location_analyses_radius_range CHECK (radius_meters BETWEEN 100 AND 20000),
  CONSTRAINT location_analyses_candidate_count_range CHECK (candidate_count BETWEEN 1 AND 5),
  CONSTRAINT location_analyses_model_version_positive CHECK (model_version >= 0),
  CONSTRAINT location_analyses_snapshot_object CHECK (pg_catalog.jsonb_typeof(model_snapshot) = 'object')
);

CREATE INDEX location_analyses_workspace_created_idx
  ON public.location_analyses (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- analysis_locations: composite identity for the candidate FK
-- ---------------------------------------------------------------------------

-- Additive only: the table already has a unique id; this makes (id, workspace_id)
-- referenceable so a scoring result cannot point at a foreign candidate.
ALTER TABLE public.analysis_locations
  ADD CONSTRAINT analysis_locations_workspace_identity_unique UNIQUE (id, workspace_id);

-- ---------------------------------------------------------------------------
-- location_analysis_results
-- ---------------------------------------------------------------------------

CREATE TABLE public.location_analysis_results (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  analysis_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  candidate_name text NOT NULL,
  longitude double precision NOT NULL,
  latitude double precision NOT NULL,
  final_score numeric(5,2) NOT NULL,
  rank integer NOT NULL,
  raw_metrics jsonb NOT NULL,
  normalized_metrics jsonb NOT NULL,
  factor_contributions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT location_analysis_results_analysis_fk
    FOREIGN KEY (analysis_id, workspace_id)
    REFERENCES public.location_analyses (id, workspace_id)
    ON DELETE CASCADE,
  -- Candidates are persisted analysis_locations; a result can never cite a
  -- candidate of another workspace or project.
  CONSTRAINT location_analysis_results_candidate_fk
    FOREIGN KEY (candidate_id, workspace_id)
    REFERENCES public.analysis_locations (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT location_analysis_results_analysis_candidate_unique UNIQUE (analysis_id, candidate_id),
  CONSTRAINT location_analysis_results_score_range CHECK (final_score BETWEEN 0 AND 100),
  CONSTRAINT location_analysis_results_rank_positive CHECK (rank >= 1),
  CONSTRAINT location_analysis_results_longitude_range CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT location_analysis_results_latitude_range CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT location_analysis_results_raw_object CHECK (pg_catalog.jsonb_typeof(raw_metrics) = 'object'),
  CONSTRAINT location_analysis_results_normalized_object CHECK (
    pg_catalog.jsonb_typeof(normalized_metrics) = 'object'
  ),
  CONSTRAINT location_analysis_results_contributions_array CHECK (
    pg_catalog.jsonb_typeof(factor_contributions) = 'array'
  )
);

CREATE INDEX location_analysis_results_analysis_rank_idx
  ON public.location_analysis_results (analysis_id, rank);

-- ---------------------------------------------------------------------------
-- Weight rule
-- ---------------------------------------------------------------------------

-- Deferred constraint trigger: the enabled weights of a model must total exactly
-- 100 at commit time. Deferring means a model can be written as one transaction
-- (create all factors, or replace every factor) without a transient invalid
-- state ever being visible to another transaction.
CREATE OR REPLACE FUNCTION public.assert_scoring_model_weights()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  target_model uuid;
  enabled_total numeric;
  enabled_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_model := OLD.model_id;
  ELSE
    target_model := NEW.model_id;
  END IF;

  -- A deleted model takes its factors with it; there is nothing left to weigh.
  IF NOT EXISTS (SELECT 1 FROM public.scoring_models AS model WHERE model.id = target_model) THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(pg_catalog.sum(factor.weight), 0), pg_catalog.count(*)
    INTO enabled_total, enabled_count
    FROM public.scoring_model_factors AS factor
   WHERE factor.model_id = target_model
     AND factor.enabled;

  IF enabled_count = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A scoring model needs at least one enabled factor';
  END IF;

  IF enabled_total <> 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = pg_catalog.format(
        'Enabled factor weights must total exactly 100 (currently %s)',
        enabled_total
      );
  END IF;

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.assert_scoring_model_weights() IS
  'Deferred constraint trigger: enabled factor weights must total exactly 100. SECURITY INVOKER, evaluates the final state of the transaction.';

-- Every factor statement advances the model revision. A statement level
-- trigger has no NEW/OLD row, so the affected models are read from the
-- transition tables; DISTINCT keeps one statement to one bump whatever the row
-- count. The model RPCs therefore advance the revision once for the delete and
-- once for the upsert of a save, which makes the revision a monotonic
-- definition counter rather than a save counter.
CREATE OR REPLACE FUNCTION public.bump_scoring_model_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  touched uuid[] := ARRAY[]::uuid[];
  affected uuid[];
BEGIN
  -- PostgreSQL only allows transition tables on a single-event trigger, so each
  -- event has its own trigger and the aliases are read dynamically: an alias
  -- that the firing trigger does not declare is never resolved.
  IF TG_OP <> 'DELETE' THEN
    EXECUTE 'SELECT pg_catalog.array_agg(DISTINCT model_id) FROM new_rows' INTO affected;
    touched := touched || COALESCE(affected, ARRAY[]::uuid[]);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    EXECUTE 'SELECT pg_catalog.array_agg(DISTINCT model_id) FROM old_rows' INTO affected;
    touched := touched || COALESCE(affected, ARRAY[]::uuid[]);
  END IF;

  IF pg_catalog.array_length(touched, 1) IS NULL THEN
    -- A statement that changed no factor rows leaves the revision alone.
    RETURN NULL;
  END IF;

  UPDATE public.scoring_models AS model
     SET version = model.version + 1
   WHERE model.id = ANY (touched);

  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.bump_scoring_model_version() IS
  'Statement level triggers with transition tables: advances scoring_models.version once per factor statement so an analysis can always record the definition revision it scored with.';

CREATE TRIGGER scoring_models_set_updated_at
  BEFORE UPDATE ON public.scoring_models
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER scoring_model_factors_set_updated_at
  BEFORE UPDATE ON public.scoring_model_factors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER scoring_models_prevent_workspace_move
  BEFORE UPDATE ON public.scoring_models
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

CREATE TRIGGER scoring_model_factors_prevent_workspace_move
  BEFORE UPDATE ON public.scoring_model_factors
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

CREATE TRIGGER location_analyses_prevent_workspace_move
  BEFORE UPDATE ON public.location_analyses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

CREATE TRIGGER location_analysis_results_prevent_workspace_move
  BEFORE UPDATE ON public.location_analysis_results
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

CREATE CONSTRAINT TRIGGER scoring_model_factors_weights_balanced
  AFTER INSERT OR UPDATE OR DELETE ON public.scoring_model_factors
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.assert_scoring_model_weights();

CREATE TRIGGER scoring_model_factors_bump_version_insert
  AFTER INSERT ON public.scoring_model_factors
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.bump_scoring_model_version();

CREATE TRIGGER scoring_model_factors_bump_version_update
  AFTER UPDATE ON public.scoring_model_factors
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.bump_scoring_model_version();

CREATE TRIGGER scoring_model_factors_bump_version_delete
  AFTER DELETE ON public.scoring_model_factors
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.bump_scoring_model_version();

-- ---------------------------------------------------------------------------
-- Freshness signal
-- ---------------------------------------------------------------------------

-- Lightweight dataset change signal: the most recent write to any spatial
-- business table of the workspace. It is deliberately not a dataset version -
-- it only answers "has anything changed since this analysis ran?".
CREATE OR REPLACE FUNCTION public.workspace_data_updated_at(p_workspace_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.max(recent.stamp)
    FROM (
      SELECT pg_catalog.max(customer.updated_at) AS stamp
        FROM public.customers AS customer
       WHERE customer.workspace_id = p_workspace_id
      UNION ALL
      SELECT pg_catalog.max(location.updated_at)
        FROM public.locations AS location
       WHERE location.workspace_id = p_workspace_id
      UNION ALL
      SELECT pg_catalog.max(competitor.updated_at)
        FROM public.competitors AS competitor
       WHERE competitor.workspace_id = p_workspace_id
      UNION ALL
      SELECT pg_catalog.max(branch.updated_at)
        FROM public.branches AS branch
       WHERE branch.workspace_id = p_workspace_id
    ) AS recent;
$function$;

COMMENT ON FUNCTION public.workspace_data_updated_at(uuid) IS
  'Most recent updated_at across customers/locations/competitors/branches of a workspace, or NULL when it has no spatial data. Used only to flag a saved analysis as possibly outdated. SECURITY INVOKER.';

-- ---------------------------------------------------------------------------
-- Metric helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.scoring_metric_value(p_metrics jsonb, p_metric text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_metrics IS NULL OR NOT (p_metrics ? p_metric) THEN NULL
    WHEN pg_catalog.jsonb_typeof(p_metrics -> p_metric) = 'null' THEN NULL
    WHEN pg_catalog.jsonb_typeof(p_metrics -> p_metric) = 'number' THEN (p_metrics ->> p_metric)::numeric
    ELSE NULLIF(p_metrics ->> p_metric, '')::numeric
  END;
$function$;

COMMENT ON FUNCTION public.scoring_metric_value(jsonb, text) IS
  'Reads a numeric metric out of a raw-metrics object, accepting JSON numbers and decimal-safe strings. Returns NULL when the metric is absent.';

CREATE OR REPLACE FUNCTION public.scoring_metric_text(p_metrics jsonb, p_metric text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_metrics IS NULL OR NOT (p_metrics ? p_metric) THEN NULL
    WHEN pg_catalog.jsonb_typeof(p_metrics -> p_metric) = 'null' THEN NULL
    ELSE p_metrics ->> p_metric
  END;
$function$;

COMMENT ON FUNCTION public.scoring_metric_text(jsonb, text) IS
  'Reads the original serialized value of a metric (money stays the exact decimal text the database produced).';

-- ---------------------------------------------------------------------------
-- Factor payload validation (shared by create and update)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.validate_scoring_factors(p_factors jsonb)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
DECLARE
  factor jsonb;
  enabled_total numeric := 0;
  enabled_count integer := 0;
  seen_keys text[] := ARRAY[]::text[];
  factor_key text;
  direction_value text;
  normalization_value text;
  weight_value numeric;
BEGIN
  IF p_factors IS NULL OR pg_catalog.jsonb_typeof(p_factors) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Factors must be a JSON array';
  END IF;
  IF pg_catalog.jsonb_array_length(p_factors) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A scoring model needs at least one factor';
  END IF;
  IF pg_catalog.jsonb_array_length(p_factors) > 12 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A scoring model may have at most 12 factors';
  END IF;

  FOR factor IN SELECT value FROM pg_catalog.jsonb_array_elements(p_factors) AS entry(value) LOOP
    IF pg_catalog.jsonb_typeof(factor) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Every factor must be a JSON object';
    END IF;

    factor_key := factor ->> 'key';
    IF factor_key IS NULL OR pg_catalog.btrim(factor_key) = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Every factor needs a key';
    END IF;
    IF factor_key = ANY (seen_keys) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Duplicate factor key: %s', factor_key);
    END IF;
    seen_keys := seen_keys || factor_key;

    IF COALESCE(pg_catalog.btrim(factor ->> 'label'), '') = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s needs a label', factor_key);
    END IF;

    IF COALESCE(factor ->> 'metric', '') = '' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s needs a metric', factor_key);
    END IF;

    direction_value := factor ->> 'direction';
    IF direction_value IS NULL OR direction_value NOT IN ('positive', 'negative', 'neutral') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s has an unsupported direction', factor_key);
    END IF;

    normalization_value := factor ->> 'normalization';
    IF normalization_value IS NULL OR normalization_value NOT IN ('min_max', 'inverse_min_max', 'threshold') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s has an unsupported normalization method', factor_key);
    END IF;

    IF normalization_value = 'min_max' AND direction_value <> 'positive' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s: min_max is the positive comparison method; use inverse_min_max for a negative factor', factor_key);
    END IF;
    IF normalization_value = 'inverse_min_max' AND direction_value <> 'negative' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s: inverse_min_max is the negative comparison method; use min_max for a positive factor', factor_key);
    END IF;

    IF factor ? 'weight' AND pg_catalog.jsonb_typeof(factor -> 'weight') = 'number' THEN
      weight_value := (factor ->> 'weight')::numeric;
      IF weight_value < 0 OR weight_value > 100 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s: weight must be between 0 and 100', factor_key);
      END IF;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = pg_catalog.format('Factor %s needs a numeric weight', factor_key);
    END IF;

    IF normalization_value = 'threshold'
       AND NOT public.scoring_threshold_points_valid(factor -> 'configuration' -> 'points', direction_value::public.scoring_factor_direction) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = pg_catalog.format(
          'Factor %s: threshold points must be at least two ascending value/score stops with scores in 0..100 that follow the declared direction',
          factor_key
        );
    END IF;

    IF COALESCE((factor -> 'enabled')::text, 'true') <> 'false' THEN
      enabled_count := enabled_count + 1;
      enabled_total := enabled_total + weight_value;
    END IF;
  END LOOP;

  IF enabled_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'At least one factor must stay enabled';
  END IF;
  IF enabled_total <> 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = pg_catalog.format('Enabled factor weights must total exactly 100 (currently %s)', enabled_total);
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.validate_scoring_factors(jsonb) IS
  'Validates a factor payload before it is written: keys, labels, metrics, direction/method pairing, threshold shape and the 100 percent weight rule. Raises 22023 with a safe, user-facing message.';

-- ---------------------------------------------------------------------------
-- Model write functions
-- ---------------------------------------------------------------------------

-- Factors are written in one statement so the deferred weight rule is satisfied
-- at commit and a new model reaches revision 1 in one step; the model row is
-- created in the same transaction.
CREATE OR REPLACE FUNCTION public.insert_scoring_factors(p_model_id uuid, p_workspace_id uuid, p_factors jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  INSERT INTO public.scoring_model_factors (
    model_id, workspace_id, key, label, metric, weight, direction, normalization,
    configuration, enabled, sort_order
  )
  SELECT
    p_model_id,
    p_workspace_id,
    factor.key,
    factor.label,
    factor.metric,
    factor.weight,
    factor.direction::public.scoring_factor_direction,
    factor.normalization::public.scoring_normalization,
    COALESCE(factor.configuration, '{}'::jsonb),
    COALESCE(factor.enabled, true),
    COALESCE(factor.sort_order, 0)
  FROM pg_catalog.jsonb_to_recordset(p_factors) AS factor(
    key text,
    label text,
    metric text,
    weight numeric,
    direction text,
    normalization text,
    configuration jsonb,
    enabled boolean,
    sort_order integer
  );
END;
$function$;

COMMENT ON FUNCTION public.insert_scoring_factors(uuid, uuid, jsonb) IS
  'Inserts a validated factor payload for a model in one statement (the deferred weight rule is checked at commit).';

CREATE OR REPLACE FUNCTION public.create_scoring_model(
  p_workspace_id uuid,
  p_name text,
  p_description text,
  p_status public.scoring_model_status,
  p_factors jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  new_model_id uuid;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id is required';
  END IF;
  IF public.has_workspace_role(
    p_workspace_id,
    ARRAY['owner', 'admin']::public.workspace_member_role[]
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Managing scoring models requires owner or admin membership';
  END IF;
  IF COALESCE(pg_catalog.btrim(p_name), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A scoring model needs a name';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'An authenticated user is required';
  END IF;

  PERFORM public.validate_scoring_factors(p_factors);

  INSERT INTO public.scoring_models (workspace_id, name, description, status, created_by)
  VALUES (
    p_workspace_id,
    pg_catalog.btrim(p_name),
    NULLIF(pg_catalog.btrim(COALESCE(p_description, '')), ''),
    COALESCE(p_status, 'active'),
    auth.uid()
  )
  RETURNING id INTO new_model_id;

  PERFORM public.insert_scoring_factors(new_model_id, p_workspace_id, p_factors);

  -- The factor insert advanced the revision to 1; a brand new model is version 1.
  RETURN new_model_id;
END;
$function$;

COMMENT ON FUNCTION public.create_scoring_model(uuid, text, text, public.scoring_model_status, jsonb) IS
  'Creates a scoring model and its factors in one transaction. SECURITY INVOKER: the RLS policies decide, with an explicit owner/admin assertion for a precise error.';

CREATE OR REPLACE FUNCTION public.update_scoring_model(
  p_model_id uuid,
  p_name text,
  p_description text,
  p_status public.scoring_model_status,
  p_factors jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  model public.scoring_models;
  revision integer;
BEGIN
  IF p_model_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Scoring model id is required';
  END IF;

  SELECT * INTO model FROM public.scoring_models AS target WHERE target.id = p_model_id;
  IF model.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Scoring model not found';
  END IF;
  IF public.has_workspace_role(
    model.workspace_id,
    ARRAY['owner', 'admin']::public.workspace_member_role[]
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Managing scoring models requires owner or admin membership';
  END IF;

  IF p_name IS NOT NULL AND pg_catalog.btrim(p_name) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A scoring model needs a name';
  END IF;

  IF p_factors IS NOT NULL THEN
    PERFORM public.validate_scoring_factors(p_factors);
  END IF;

  UPDATE public.scoring_models AS target
     SET name = COALESCE(pg_catalog.btrim(p_name), target.name),
         description = CASE
           WHEN p_description IS NULL THEN target.description
           ELSE NULLIF(pg_catalog.btrim(p_description), '')
         END,
         status = COALESCE(p_status, target.status)
   WHERE target.id = p_model_id;

  IF p_factors IS NOT NULL THEN
    -- Remove the factors the caller dropped, then upsert the rest. Both
    -- statements are one transaction, so the deferred weight rule sees only the
    -- final, balanced state.
    DELETE FROM public.scoring_model_factors AS factor
     WHERE factor.model_id = p_model_id
       AND factor.key <> ALL (
         SELECT entry.value ->> 'key'
           FROM pg_catalog.jsonb_array_elements(p_factors) AS entry(value)
       );

    INSERT INTO public.scoring_model_factors (
      model_id, workspace_id, key, label, metric, weight, direction, normalization,
      configuration, enabled, sort_order
    )
    SELECT
      p_model_id,
      model.workspace_id,
      factor.key,
      factor.label,
      factor.metric,
      factor.weight,
      factor.direction::public.scoring_factor_direction,
      factor.normalization::public.scoring_normalization,
      COALESCE(factor.configuration, '{}'::jsonb),
      COALESCE(factor.enabled, true),
      COALESCE(factor.sort_order, 0)
    FROM pg_catalog.jsonb_to_recordset(p_factors) AS factor(
      key text,
      label text,
      metric text,
      weight numeric,
      direction text,
      normalization text,
      configuration jsonb,
      enabled boolean,
      sort_order integer
    )
    ON CONFLICT (model_id, key) DO UPDATE
      SET label = EXCLUDED.label,
          metric = EXCLUDED.metric,
          weight = EXCLUDED.weight,
          direction = EXCLUDED.direction,
          normalization = EXCLUDED.normalization,
          configuration = EXCLUDED.configuration,
          enabled = EXCLUDED.enabled,
          sort_order = EXCLUDED.sort_order;
  END IF;

  -- The factor statements above have already advanced the revision through the
  -- statement level trigger; this reads back the value the caller should see.
  SELECT target.version INTO revision
    FROM public.scoring_models AS target
   WHERE target.id = p_model_id;

  RETURN revision;
END;
$function$;

COMMENT ON FUNCTION public.update_scoring_model(uuid, text, text, public.scoring_model_status, jsonb) IS
  'Updates a model and optionally replaces its whole factor set in one transaction. A save that changes factors advances the definition revision (delete plus upsert); a metadata-only save leaves it. SECURITY INVOKER with an explicit owner/admin assertion.';

-- ---------------------------------------------------------------------------
-- Analysis payload
-- ---------------------------------------------------------------------------

-- One builder for the wire shape, used by both the run RPC and the read RPC, so
-- a fresh analysis and a stored one can never disagree. SECURITY INVOKER: the
-- row level policies decide which analyses exist for the caller.
CREATE OR REPLACE FUNCTION public.location_analysis_payload(p_analysis_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'analysis', pg_catalog.jsonb_build_object(
      'id', analysis.id,
      'workspace_id', analysis.workspace_id,
      'project_id', analysis.project_id,
      'mode', analysis.mode,
      'radius_meters', analysis.radius_meters,
      'candidate_count', analysis.candidate_count,
      'scoring_model_id', analysis.scoring_model_id,
      'model_name', analysis.model_name,
      'model_version', analysis.model_version,
      'data_snapshot_at', analysis.data_snapshot_at,
      'created_at', analysis.created_at,
      'workspace_data_updated_at', public.workspace_data_updated_at(analysis.workspace_id),
      'may_be_outdated', (
        public.workspace_data_updated_at(analysis.workspace_id) IS NOT NULL
        AND public.workspace_data_updated_at(analysis.workspace_id) > analysis.data_snapshot_at
      )
    ),
    'model', analysis.model_snapshot,
    'results', COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'candidate_id', result.candidate_id,
            'candidate_name', result.candidate_name,
            'longitude', result.longitude,
            'latitude', result.latitude,
            'rank', result.rank,
            'final_score', result.final_score,
            'raw_metrics', result.raw_metrics,
            'normalized_metrics', result.normalized_metrics,
            'factor_contributions', result.factor_contributions
          )
          ORDER BY result.rank, pg_catalog.lower(result.candidate_name), result.candidate_id
        )
        FROM public.location_analysis_results AS result
       WHERE result.analysis_id = analysis.id
      ),
      '[]'::jsonb
    )
  )
  FROM public.location_analyses AS analysis
  WHERE analysis.id = p_analysis_id;
$function$;

COMMENT ON FUNCTION public.location_analysis_payload(uuid) IS
  'Builds the scoring wire payload (analysis header, model snapshot, per-candidate raw metrics, normalized values and contributions) for one analysis. SECURITY INVOKER, returns NULL when the caller cannot see the row.';

CREATE OR REPLACE FUNCTION public.get_location_analysis(p_workspace_id uuid, p_analysis_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  payload jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_analysis_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id and analysis id are required';
  END IF;
  IF NOT public.is_workspace_member(p_workspace_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Location analyses require workspace membership';
  END IF;

  payload := public.location_analysis_payload(p_analysis_id);
  IF payload IS NULL
     OR (payload -> 'analysis' ->> 'workspace_id')::uuid IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Location analysis not found';
  END IF;

  RETURN payload;
END;
$function$;

COMMENT ON FUNCTION public.get_location_analysis(uuid, uuid) IS
  'Returns one stored analysis payload for a workspace member; a foreign or missing analysis answers identically. SECURITY INVOKER so RLS stays an independent layer.';

-- ---------------------------------------------------------------------------
-- Run an analysis
-- ---------------------------------------------------------------------------

-- The authoritative scoring run. It reads PostGIS metrics from
-- public.workspace_radius_analysis, normalizes per factor, applies the weights of
-- the model snapshot and stores every intermediate value. SECURITY DEFINER
-- because the analysis tables are RPC-write-only (no INSERT grant), so this
-- function carries the full authorization work: membership, role, workspace and
-- project ownership of every candidate, and model ownership.
CREATE OR REPLACE FUNCTION public.run_location_analysis(
  p_workspace_id uuid,
  p_project_id uuid,
  p_candidate_ids uuid[],
  p_radius_meters integer,
  p_scoring_model_id uuid,
  p_mode text DEFAULT 'analysis'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  model public.scoring_models;
  factor_defs jsonb;
  enabled_count integer;
  enabled_total numeric;
  requested_count integer;
  found_count integer;
  candidate_ids uuid[];
  candidate_names text[];
  candidate_lons double precision[];
  candidate_lats double precision[];
  candidate_index integer;
  factor jsonb;
  analysis_id uuid;
  snapshot_at timestamptz := pg_catalog.now();
  metrics jsonb[] := ARRAY[]::jsonb[];
  normalized jsonb[] := ARRAY[]::jsonb[];
  contributions jsonb[] := ARRAY[]::jsonb[];
  scores numeric[] := ARRAY[]::numeric[];
  values numeric[];
  factor_key text;
  factor_label text;
  metric_key text;
  direction_value text;
  normalization_value text;
  weight_value numeric;
  missing_score numeric;
  degenerate_score numeric;
  threshold_points jsonb;
  raw_value numeric;
  normalized_value numeric;
  contribution numeric;
  min_value numeric;
  max_value numeric;
  rank_value integer;
  radius_metrics record;
  area_sq_km numeric;
  revenue_total numeric;
BEGIN
  -- -------------------------------------------------------------- validation
  IF p_workspace_id IS NULL OR p_project_id IS NULL OR p_scoring_model_id IS NULL
     OR p_candidate_ids IS NULL OR p_radius_meters IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'Workspace, project, candidates, radius and scoring model are required';
  END IF;

  IF p_mode IS NULL OR p_mode NOT IN ('analysis', 'comparison') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The mode must be analysis or comparison';
  END IF;

  IF p_radius_meters < 100 OR p_radius_meters > 20000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Radius must be between 100 and 20000 meters';
  END IF;

  requested_count := pg_catalog.array_length(p_candidate_ids, 1);
  IF requested_count IS NULL OR requested_count < 1 OR requested_count > 5 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Between 1 and 5 candidate locations are required';
  END IF;
  IF p_mode = 'comparison' AND requested_count < 2 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A comparison needs at least 2 candidate locations';
  END IF;
  IF requested_count <> (
    SELECT pg_catalog.count(DISTINCT entry.value)
      FROM pg_catalog.unnest(p_candidate_ids) AS entry(value)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Candidate locations must be distinct';
  END IF;

  -- Authorization precedes state errors, so an outsider learns nothing about
  -- whether the project, the model or the candidates exist.
  IF public.has_workspace_role(
    p_workspace_id,
    ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
  ) IS NOT TRUE THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Running a location analysis requires owner, admin or analyst membership';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.projects AS project
     WHERE project.id = p_project_id AND project.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Project not found';
  END IF;

  SELECT * INTO model
    FROM public.scoring_models AS target
   WHERE target.id = p_scoring_model_id
     AND target.workspace_id = p_workspace_id;
  IF model.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Scoring model not found';
  END IF;
  IF model.status <> 'active' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The scoring model is not active';
  END IF;

  SELECT
    pg_catalog.count(*),
    pg_catalog.array_agg(candidate.id ORDER BY pg_catalog.lower(candidate.name), candidate.id),
    pg_catalog.array_agg(candidate.name ORDER BY pg_catalog.lower(candidate.name), candidate.id),
    pg_catalog.array_agg(
      extensions.st_x(candidate.spatial_point::extensions.geometry)
      ORDER BY pg_catalog.lower(candidate.name), candidate.id
    ),
    pg_catalog.array_agg(
      extensions.st_y(candidate.spatial_point::extensions.geometry)
      ORDER BY pg_catalog.lower(candidate.name), candidate.id
    )
    INTO found_count, candidate_ids, candidate_names, candidate_lons, candidate_lats
    FROM public.analysis_locations AS candidate
   WHERE candidate.id = ANY(p_candidate_ids)
     AND candidate.workspace_id = p_workspace_id
     AND candidate.project_id = p_project_id;

  IF found_count <> requested_count THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'One or more candidate locations were not found in this project';
  END IF;

  -- ------------------------------------------------------------ model snapshot
  SELECT
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'key', factor.key,
        'label', factor.label,
        'metric', factor.metric,
        'weight', factor.weight,
        'direction', factor.direction,
        'normalization', factor.normalization,
        'configuration', factor.configuration,
        'enabled', factor.enabled,
        'sort_order', factor.sort_order
      )
      ORDER BY factor.sort_order, factor.key
    ),
    pg_catalog.count(*) FILTER (WHERE factor.enabled),
    COALESCE(pg_catalog.sum(factor.weight) FILTER (WHERE factor.enabled), 0)
    INTO factor_defs, enabled_count, enabled_total
    FROM public.scoring_model_factors AS factor
   WHERE factor.model_id = model.id;

  IF enabled_count IS NULL OR enabled_count = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'The scoring model has no enabled factors';
  END IF;
  IF enabled_total <> 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enabled factor weights must total exactly 100';
  END IF;

  -- -------------------------------------------------------------- raw metrics
  metrics := ARRAY[]::jsonb[];
  FOR candidate_index IN 1..found_count LOOP
    SELECT * INTO radius_metrics
      FROM public.workspace_radius_analysis(
        p_workspace_id,
        candidate_lons[candidate_index],
        candidate_lats[candidate_index],
        p_radius_meters::double precision
      );

    area_sq_km := pg_catalog.round(
      3.141592653589793 * pg_catalog.power(p_radius_meters::numeric / 1000, 2),
      4
    );
    -- Revenue is exact decimal text from the database; it is parsed to numeric
    -- for arithmetic and serialized back to text for the payload.
    revenue_total := COALESCE(
      NULLIF(radius_metrics.customers_revenue_total, '')::numeric,
      0
    );

    metrics[candidate_index] := pg_catalog.jsonb_build_object(
      'radius_meters', p_radius_meters,
      'area_sq_km', area_sq_km,
      'customers_count', radius_metrics.customers_count,
      'customers_revenue_total', revenue_total::text,
      'competitors_count', radius_metrics.competitors_count,
      'branches_count', radius_metrics.branches_count,
      'locations_count', radius_metrics.locations_count,
      'customers_per_sq_km', pg_catalog.round(radius_metrics.customers_count::numeric / area_sq_km, 4),
      'competitors_per_sq_km', pg_catalog.round(radius_metrics.competitors_count::numeric / area_sq_km, 4),
      'revenue_per_sq_km', pg_catalog.round(revenue_total / area_sq_km, 2)::text,
      'customer_to_competitor_ratio', pg_catalog.round(
        radius_metrics.customers_count::numeric / GREATEST(radius_metrics.competitors_count, 1),
        4
      ),
      -- Coverage is better when a branch is closer: 100 when a branch is at the
      -- candidate point, 0 when the nearest branch is at or beyond the radius or
      -- when the workspace has no branch at all.
      'branch_distance_score', CASE
        WHEN radius_metrics.nearest_branch_distance_meters IS NULL THEN 0
        ELSE pg_catalog.round(
          100::numeric * (
            1::numeric
            - LEAST(
                radius_metrics.nearest_branch_distance_meters::numeric,
                p_radius_meters::numeric
              ) / p_radius_meters::numeric
          ),
          2
        )
      END,
      'commercial_poi_density', pg_catalog.round(radius_metrics.locations_count::numeric / area_sq_km, 4),
      'nearest_branch_id', radius_metrics.nearest_branch_id,
      'nearest_branch_name', radius_metrics.nearest_branch_name,
      'nearest_branch_distance_meters', pg_catalog.round(
        radius_metrics.nearest_branch_distance_meters::numeric,
        2
      ),
      'category_distribution', radius_metrics.category_distribution
    );
  END LOOP;

  -- -------------------------------------------------- normalization + weights
  normalized := ARRAY(
    SELECT '{}'::jsonb FROM pg_catalog.generate_series(1, found_count)
  );
  contributions := ARRAY(
    SELECT '[]'::jsonb FROM pg_catalog.generate_series(1, found_count)
  );
  scores := ARRAY(
    SELECT 0::numeric FROM pg_catalog.generate_series(1, found_count)
  );

  FOR factor IN SELECT value FROM pg_catalog.jsonb_array_elements(factor_defs) AS entry(value) LOOP
    IF COALESCE((factor ->> 'enabled')::boolean, true) IS NOT TRUE THEN
      CONTINUE;
    END IF;

    factor_key := factor ->> 'key';
    factor_label := factor ->> 'label';
    metric_key := factor ->> 'metric';
    direction_value := factor ->> 'direction';
    normalization_value := factor ->> 'normalization';
    weight_value := (factor ->> 'weight')::numeric;
    threshold_points := factor -> 'configuration' -> 'points';
    missing_score := COALESCE((factor -> 'configuration' ->> 'missing_score')::numeric, 0);
    degenerate_score := COALESCE(
      (factor -> 'configuration' ->> 'degenerate_score')::numeric,
      50
    );

    values := ARRAY[]::numeric[];
    FOR candidate_index IN 1..found_count LOOP
      values[candidate_index] := public.scoring_metric_value(metrics[candidate_index], metric_key);
    END LOOP;

    IF normalization_value IN ('min_max', 'inverse_min_max') THEN
      SELECT pg_catalog.min(entry.value), pg_catalog.max(entry.value)
        INTO min_value, max_value
        FROM pg_catalog.unnest(values) AS entry(value)
       WHERE entry.value IS NOT NULL;
    ELSE
      min_value := NULL;
      max_value := NULL;
    END IF;

    FOR candidate_index IN 1..found_count LOOP
      raw_value := values[candidate_index];

      IF raw_value IS NULL THEN
        -- Explicit zero semantics: a candidate with no data for this metric
        -- scores the configured missing value (0 by default), never NULL.
        normalized_value := missing_score;
      ELSIF normalization_value = 'threshold' THEN
        normalized_value := public.scoring_interpolate(threshold_points, raw_value);
      ELSIF normalization_value = 'min_max' THEN
        IF min_value IS NULL OR max_value = min_value THEN
          -- The compared set cannot separate the candidates (one candidate, or
          -- every value equal): score the documented neutral midpoint.
          normalized_value := degenerate_score;
        ELSE
          normalized_value := pg_catalog.round((raw_value - min_value) * 100 / (max_value - min_value), 2);
        END IF;
      ELSE
        IF min_value IS NULL OR max_value = min_value THEN
          normalized_value := degenerate_score;
        ELSE
          normalized_value := pg_catalog.round((max_value - raw_value) * 100 / (max_value - min_value), 2);
        END IF;
      END IF;

      normalized_value := LEAST(100, GREATEST(0, normalized_value));
      contribution := pg_catalog.round(normalized_value * weight_value / 100, 2);

      normalized[candidate_index] := normalized[candidate_index]
        || pg_catalog.jsonb_build_object(factor_key, normalized_value);

      contributions[candidate_index] := contributions[candidate_index]
        || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'key', factor_key,
            'label', factor_label,
            'metric', metric_key,
            'direction', direction_value,
            'normalization', normalization_value,
            'weight', weight_value,
            'raw_value', raw_value,
            'raw_text', public.scoring_metric_text(metrics[candidate_index], metric_key),
            'normalized', normalized_value,
            'contribution', contribution
          )
        );

      scores[candidate_index] := scores[candidate_index] + contribution;
    END LOOP;
  END LOOP;

  -- ------------------------------------------------------------- persist + rank
  INSERT INTO public.location_analyses (
    workspace_id, project_id, scoring_model_id, model_name, model_version, model_snapshot,
    mode, radius_meters, candidate_count, data_snapshot_at, created_by
  )
  VALUES (
    p_workspace_id,
    p_project_id,
    model.id,
    model.name,
    model.version,
    pg_catalog.jsonb_build_object(
      'model', pg_catalog.jsonb_build_object(
        'id', model.id,
        'name', model.name,
        'description', model.description,
        'status', model.status,
        'version', model.version
      ),
      'factors', factor_defs
    ),
    p_mode,
    p_radius_meters,
    found_count,
    snapshot_at,
    auth.uid()
  )
  RETURNING id INTO analysis_id;

  FOR candidate_index IN 1..found_count LOOP
    scores[candidate_index] := LEAST(
      100,
      GREATEST(0, pg_catalog.round(scores[candidate_index], 2))
    );

    -- Competition ranking with a deterministic tie break on the candidate name,
    -- so the same inputs always produce the same ranks.
    SELECT pg_catalog.count(*) + 1
      INTO rank_value
      FROM pg_catalog.generate_series(1, found_count) AS entries(index)
     WHERE scores[entries.index] > scores[candidate_index]
        OR (
          scores[entries.index] = scores[candidate_index]
          AND (
            pg_catalog.lower(candidate_names[entries.index]),
            candidate_ids[entries.index]
          ) < (
            pg_catalog.lower(candidate_names[candidate_index]),
            candidate_ids[candidate_index]
          )
        );

    INSERT INTO public.location_analysis_results (
      analysis_id, workspace_id, candidate_id, candidate_name, longitude, latitude,
      final_score, rank, raw_metrics, normalized_metrics, factor_contributions
    )
    VALUES (
      analysis_id,
      p_workspace_id,
      candidate_ids[candidate_index],
      candidate_names[candidate_index],
      candidate_lons[candidate_index],
      candidate_lats[candidate_index],
      scores[candidate_index],
      rank_value,
      metrics[candidate_index],
      normalized[candidate_index],
      contributions[candidate_index]
    );
  END LOOP;

  RETURN public.location_analysis_payload(analysis_id);
END;
$function$;

COMMENT ON FUNCTION public.run_location_analysis(uuid, uuid, uuid[], integer, uuid, text) IS
  'Runs and stores a location analysis: PostGIS metrics for each candidate, per-factor normalization (threshold, min_max, inverse_min_max), weighted contributions and the final 0..100 score, with the full model snapshot. SECURITY DEFINER with explicit membership, role, project, candidate and model ownership checks.';

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.scoring_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scoring_model_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.location_analysis_results ENABLE ROW LEVEL SECURITY;

-- Models: every member reads them (an analyst must be able to score with the
-- workspace models and to explain an old analysis), only owner/admin write them.
CREATE POLICY scoring_models_select_member
  ON public.scoring_models
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY scoring_models_insert_owner_admin
  ON public.scoring_models
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY scoring_models_update_owner_admin
  ON public.scoring_models
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- No DELETE policy: models are archived, never removed, so stored analyses keep
-- a live reference to the model they snapshot.

CREATE POLICY scoring_model_factors_select_member
  ON public.scoring_model_factors
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY scoring_model_factors_insert_owner_admin
  ON public.scoring_model_factors
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY scoring_model_factors_update_owner_admin
  ON public.scoring_model_factors
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY scoring_model_factors_delete_owner_admin
  ON public.scoring_model_factors
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- Analyses: every member reads them; nobody writes them through the tables. The
-- only writer is run_location_analysis, which validates and snapshots in one
-- transaction, so a final score can never be forged by a direct insert.
CREATE POLICY location_analyses_select_member
  ON public.location_analyses
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY location_analysis_results_select_member
  ON public.location_analysis_results
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE
  public.scoring_models,
  public.scoring_model_factors,
  public.location_analyses,
  public.location_analysis_results
FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.scoring_models TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scoring_model_factors TO authenticated;
-- Analyses are read-only to API roles: run_location_analysis is the only writer,
-- so authenticated deliberately holds no INSERT, UPDATE or DELETE here.
GRANT SELECT ON TABLE public.location_analyses TO authenticated;
GRANT SELECT ON TABLE public.location_analysis_results TO authenticated;

-- anon keeps zero privileges: scoring is authenticated-only.
-- service_role keeps the platform default and is never used by the scoring API.

REVOKE ALL ON FUNCTION public.scoring_threshold_points_valid(jsonb, public.scoring_factor_direction)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoring_threshold_points_valid(jsonb, public.scoring_factor_direction)
  TO authenticated;

REVOKE ALL ON FUNCTION public.scoring_interpolate(jsonb, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoring_interpolate(jsonb, numeric) TO authenticated;

REVOKE ALL ON FUNCTION public.scoring_metric_value(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoring_metric_value(jsonb, text) TO authenticated;

REVOKE ALL ON FUNCTION public.scoring_metric_text(jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scoring_metric_text(jsonb, text) TO authenticated;

REVOKE ALL ON FUNCTION public.validate_scoring_factors(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_scoring_factors(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.insert_scoring_factors(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_scoring_factors(uuid, uuid, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.workspace_data_updated_at(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_data_updated_at(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.location_analysis_payload(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.location_analysis_payload(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.get_location_analysis(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_location_analysis(uuid, uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.create_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.update_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_scoring_model(uuid, text, text, public.scoring_model_status, jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.run_location_analysis(uuid, uuid, uuid[], integer, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_location_analysis(uuid, uuid, uuid[], integer, uuid, text)
  TO authenticated;

-- Trigger functions are never called directly.
REVOKE ALL ON FUNCTION public.assert_scoring_model_weights() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bump_scoring_model_version() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Table comments
-- ---------------------------------------------------------------------------

COMMENT ON TABLE public.scoring_models IS
  'Workspace-owned scoring model definitions (name, status, revision). A model is user-authored configuration, never a permanent business truth.';

COMMENT ON TABLE public.scoring_model_factors IS
  'One row per scoring dimension: which authoritative metric it reads, how it is normalized (threshold, min_max, inverse_min_max), which direction it points, and how much it weighs. Enabled weights must total exactly 100 at commit.';

COMMENT ON TABLE public.location_analyses IS
  'One explicit user run of a scoring model over 1..5 persisted candidate locations, with the full model snapshot, the radius and the dataset signal at run time. Never rewritten by later model edits.';

COMMENT ON TABLE public.location_analysis_results IS
  'Per candidate result of an analysis: raw PostGIS metrics, normalized per-factor values, weighted contributions and the final 0..100 score. The breakdown always adds up to the stored final score.';
