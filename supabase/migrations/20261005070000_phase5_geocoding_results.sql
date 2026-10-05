-- Phase 5 (part 3 of 3): apply geocoding batch results.
--
-- The geocoding provider is called from the server (never the browser), but the
-- write must still be one atomic, authorized, idempotent step, so it happens
-- here rather than as N row updates from the API route:
--
--   * SECURITY INVOKER: RLS on import_rows applies on top of the explicit
--     owner/admin/analyst assertion. No service_role anywhere.
--   * Only rows still marked 'geocoding' (i.e. claimed by a batch) are touched,
--     so replaying a batch - a retry, a double click, two open tabs - never
--     duplicates work or moves a completed row.
--   * A successful geocode promotes the staged row to 'valid' with typed
--     coordinates, which is exactly what commit_import_job later reads.
--   * Ambiguous, no-match, rate-limited and provider-error rows stay staged and
--     reviewable; a provider outage is never a permanent failure.

CREATE OR REPLACE FUNCTION public.apply_import_geocoding_results(
  p_import_job_id uuid,
  p_results jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  job public.import_jobs;
  entry jsonb;
  staged public.import_rows;
  row_status text;
  applied integer := 0;
  accepted integer := 0;
  ambiguous integer := 0;
  no_match integer := 0;
  rate_limited integer := 0;
  provider_error integer := 0;
  skipped integer := 0;
  result jsonb;
  counters record;
  longitude_value double precision;
  latitude_value double precision;
BEGIN
  IF p_import_job_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Import job id is required';
  END IF;
  IF p_results IS NULL
     OR pg_catalog.jsonb_typeof(p_results) <> 'array'
     OR pg_catalog.jsonb_array_length(p_results) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A non-empty result array is required';
  END IF;
  IF pg_catalog.jsonb_array_length(p_results) > 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A geocoding batch may not exceed 50 rows';
  END IF;

  -- Read first (RLS decides), then authorize, then write - so a viewer gets the
  -- role error and an outsider cannot tell the job exists.
  SELECT * INTO job FROM public.import_jobs AS target WHERE target.id = p_import_job_id;
  IF job.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Import job not found';
  END IF;
  IF NOT public.has_workspace_role(
       job.workspace_id,
       ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Applying geocoding results requires owner, admin or analyst membership';
  END IF;

  FOR entry IN SELECT * FROM pg_catalog.jsonb_array_elements(p_results) LOOP
    row_status := entry ->> 'status';

    IF row_status NOT IN ('success', 'ambiguous', 'no_match', 'rate_limited', 'provider_error') THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = pg_catalog.format('Unsupported geocoding status: %s', COALESCE(row_status, 'null'));
    END IF;

    IF row_status = 'success' THEN
      longitude_value := NULLIF(entry ->> 'longitude', '')::double precision;
      latitude_value := NULLIF(entry ->> 'latitude', '')::double precision;
      IF longitude_value IS NULL OR latitude_value IS NULL
         OR longitude_value <> longitude_value OR latitude_value <> latitude_value
         OR longitude_value < -180 OR longitude_value > 180
         OR latitude_value < -90 OR latitude_value > 90 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Geocoding result coordinates are invalid';
      END IF;
    ELSE
      longitude_value := NULL;
      latitude_value := NULL;
    END IF;

    SELECT * INTO staged
      FROM public.import_rows AS target
     WHERE target.id = (entry ->> 'row_id')::uuid
       AND target.import_job_id = p_import_job_id
       AND target.geocoding_status = 'geocoding';

    IF staged.id IS NULL THEN
      -- Already applied, never claimed, or claimed by another worker: ignore.
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    result := pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        'provider', entry ->> 'provider',
        'decision', entry ->> 'decision',
        'reason', entry ->> 'reason',
        'confidence', NULLIF(entry ->> 'confidence', '')::double precision,
        'relevance', NULLIF(entry ->> 'relevance', '')::double precision,
        'provider_result_id', entry ->> 'provider_result_id',
        'formatted_address', entry ->> 'formatted_address',
        'accuracy', entry ->> 'accuracy',
        'feature_type', entry ->> 'feature_type',
        'country_code', entry ->> 'country_code',
        'match_confidence', entry ->> 'match_confidence',
        'retry_after_ms', NULLIF(entry ->> 'retry_after_ms', '')::integer,
        'message', entry ->> 'message',
        'attempts', staged.geocoding_attempts,
        'alternatives', CASE
          WHEN pg_catalog.jsonb_typeof(entry -> 'alternatives') = 'array'
            THEN entry -> 'alternatives'
          ELSE NULL
        END,
        'recorded_at', pg_catalog.now()
      )
    );

    IF row_status = 'success' THEN
      UPDATE public.import_rows AS target
         SET longitude = longitude_value,
             latitude = latitude_value,
             geocoding_status = 'success',
             geocoding_claimed_at = NULL,
             validation_status = 'valid',
             validation_errors = '[]'::jsonb,
             geocoding_result = result
       WHERE target.id = staged.id;
      accepted := accepted + 1;
    ELSE
      UPDATE public.import_rows AS target
         SET geocoding_status = row_status::public.import_row_geocoding_status,
             geocoding_claimed_at = NULL,
             geocoding_result = result
       WHERE target.id = staged.id;
      IF row_status = 'ambiguous' THEN ambiguous := ambiguous + 1;
      ELSIF row_status = 'no_match' THEN no_match := no_match + 1;
      ELSIF row_status = 'rate_limited' THEN rate_limited := rate_limited + 1;
      ELSE provider_error := provider_error + 1;
      END IF;
    END IF;

    applied := applied + 1;
  END LOOP;

  SELECT * INTO counters FROM public.refresh_import_job_counters(p_import_job_id);

  RETURN pg_catalog.jsonb_build_object(
    'applied', applied,
    'skipped', skipped,
    'accepted', accepted,
    'ambiguous', ambiguous,
    'no_match', no_match,
    'rate_limited', rate_limited,
    'provider_error', provider_error,
    'total_rows', counters.total_rows,
    'valid_rows', counters.valid_rows,
    'invalid_rows', counters.invalid_rows,
    'needs_geocoding_rows', counters.needs_geocoding_rows,
    'geocoded_rows', counters.geocoded_rows,
    'failed_geocoding_rows', counters.failed_geocoding_rows,
    'committed_rows', counters.committed_rows,
    'job_status', counters.job_status
  );
END;
$function$;

COMMENT ON FUNCTION public.apply_import_geocoding_results(uuid, jsonb) IS
  'Applies one batch of provider results to claimed import_rows (idempotent: only rows still in geocoding status are touched), promotes successful rows to valid and refreshes job counters. SECURITY INVOKER with an explicit owner/admin/analyst assertion.';

REVOKE ALL ON FUNCTION public.apply_import_geocoding_results(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_import_geocoding_results(uuid, jsonb)
  TO authenticated;
