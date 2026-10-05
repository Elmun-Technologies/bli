-- Phase 3 live PostGIS/RPC integration assertions against deterministic seed.sql.
-- Read-only assertions and plan probes are rolled back at the end.
BEGIN;

DO $phase3_test$
DECLARE
  demo_workspace_id uuid;
  isolation_workspace_id uuid;
  candidate extensions.geography;
  viewport extensions.geography;
  result_500 record;
  result_1000 record;
  result_3000 record;
  result_5000 record;
  empty_result record;
  expected_customer_count bigint;
  expected_revenue text;
  combined_customer_count bigint;
  expected_branch_id uuid;
  expected_branch_name text;
  expected_branch_distance double precision;
  viewport_count bigint;
  customer_feature_count bigint;
  category_count bigint;
  function_oid regprocedure;
  plan_json json;
  probe record;
  plan_query text;
  spatial_index_name text;
BEGIN
  SELECT workspace.id
    INTO demo_workspace_id
    FROM public.organizations AS organization
    JOIN public.workspaces AS workspace
      ON workspace.organization_id = organization.id
   WHERE organization.slug = 'atlas-demo'
     AND workspace.slug = 'tashkent-demo';

  SELECT workspace.id
    INTO isolation_workspace_id
    FROM public.organizations AS organization
    JOIN public.workspaces AS workspace
      ON workspace.organization_id = organization.id
   WHERE organization.slug = 'atlas-demo'
     AND workspace.slug = 'isolation-test';

  IF demo_workspace_id IS NULL OR isolation_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Synthetic workspaces required by Phase 3 seed.sql were not found';
  END IF;

  candidate := extensions.st_setsrid(
    extensions.st_makepoint(69.2797, 41.3111), 4326
  )::extensions.geography;
  viewport := extensions.st_makeenvelope(69.20, 41.25, 69.36, 41.37, 4326)::extensions.geography;

  SELECT * INTO result_500
    FROM public.demo_radius_analysis(69.2797, 41.3111, 500);
  SELECT * INTO result_1000
    FROM public.demo_radius_analysis(69.2797, 41.3111, 1000);
  SELECT * INTO result_3000
    FROM public.demo_radius_analysis(69.2797, 41.3111, 3000);
  SELECT * INTO result_5000
    FROM public.demo_radius_analysis(69.2797, 41.3111, 5000);

  IF result_500.customers_count < 1
     OR result_500.competitors_count < 1
     OR result_500.branches_count < 1
     OR result_500.locations_count < 1 THEN
    RAISE EXCEPTION 'The 500 m radius should include each colocated synthetic demo feature kind';
  END IF;

  IF result_1000.customers_count < result_500.customers_count
     OR result_3000.customers_count < result_1000.customers_count
     OR result_5000.customers_count < result_3000.customers_count
     OR result_1000.competitors_count < result_500.competitors_count
     OR result_3000.competitors_count < result_1000.competitors_count
     OR result_5000.competitors_count < result_3000.competitors_count
     OR result_1000.branches_count < result_500.branches_count
     OR result_3000.branches_count < result_1000.branches_count
     OR result_5000.branches_count < result_3000.branches_count
     OR result_1000.locations_count < result_500.locations_count
     OR result_3000.locations_count < result_1000.locations_count
     OR result_5000.locations_count < result_3000.locations_count THEN
    RAISE EXCEPTION 'Radius aggregates must be monotone for 500 m, 1 km, 3 km and 5 km';
  END IF;

  SELECT pg_catalog.count(*)::bigint,
         COALESCE(pg_catalog.sum(customer.revenue), 0)::text
    INTO expected_customer_count, expected_revenue
    FROM public.customers AS customer
   WHERE customer.workspace_id = demo_workspace_id
     AND extensions.st_dwithin(customer.spatial_point, candidate, 500, true);

  IF result_500.customers_count <> expected_customer_count
     OR result_500.customers_revenue_total <> expected_revenue THEN
    RAISE EXCEPTION 'Customer count/revenue aggregate does not match server-side geography ST_DWithin';
  END IF;

  SELECT pg_catalog.count(*)::bigint
    INTO combined_customer_count
    FROM public.customers AS customer
   WHERE customer.workspace_id IN (demo_workspace_id, isolation_workspace_id)
     AND extensions.st_dwithin(customer.spatial_point, candidate, 500, true);

  IF combined_customer_count <= result_500.customers_count THEN
    RAISE EXCEPTION 'Cross-workspace fixture is not inside the 500 m test radius';
  END IF;

  IF result_500.customers_count <> (
    SELECT pg_catalog.count(*)::bigint
      FROM public.customers AS customer
     WHERE customer.workspace_id = demo_workspace_id
       AND extensions.st_dwithin(customer.spatial_point, candidate, 500, true)
  ) THEN
    RAISE EXCEPTION 'Cross-workspace customer row leaked into demo radius result';
  END IF;

  SELECT branch.id,
         branch.name,
         extensions.st_distance(branch.spatial_point, candidate, true)::double precision
    INTO expected_branch_id, expected_branch_name, expected_branch_distance
    FROM public.branches AS branch
   WHERE branch.workspace_id = demo_workspace_id
   ORDER BY extensions.st_distance(branch.spatial_point, candidate, true), branch.id
   LIMIT 1;

  IF result_500.nearest_branch_id IS DISTINCT FROM expected_branch_id
     OR result_500.nearest_branch_name IS DISTINCT FROM expected_branch_name
     OR result_500.nearest_branch_distance_meters IS DISTINCT FROM expected_branch_distance THEN
    RAISE EXCEPTION 'Nearest branch id/name/distance must be calculated server-side from demo workspace only';
  END IF;

  SELECT COALESCE(pg_catalog.sum((category_item.value ->> 'count')::bigint), 0)
    INTO category_count
    FROM pg_catalog.jsonb_array_elements(result_500.category_distribution) AS category_item(value);

  IF category_count <> result_500.locations_count + result_500.competitors_count THEN
    RAISE EXCEPTION 'Category distribution must group all in-radius locations and competitors';
  END IF;

  IF NOT pg_catalog.jsonb_typeof(result_500.category_distribution) = 'array' THEN
    RAISE EXCEPTION 'Category distribution must be a JSON array';
  END IF;

  SELECT pg_catalog.count(*)::bigint
    INTO viewport_count
    FROM public.demo_viewport_features(69.20, 41.25, 69.36, 41.37, NULL, 2501);

  IF viewport_count < 100 THEN
    RAISE EXCEPTION 'Viewport query did not return the expected synthetic Tashkent feature mix (got %) ', viewport_count;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.demo_viewport_features(69.20, 41.25, 69.36, 41.37, NULL, 2501) AS feature
     WHERE feature.feature_id IN (
       '50000000-0000-4000-8000-000000000001',
       '50000000-0000-4000-8000-000000000002',
       '50000000-0000-4000-8000-000000000003',
       '50000000-0000-4000-8000-000000000004'
     )
  ) THEN
    RAISE EXCEPTION 'Viewport feature query leaked a row from the isolation workspace';
  END IF;

  SELECT pg_catalog.count(*)::bigint
    INTO customer_feature_count
    FROM public.demo_viewport_features(
      69.20, 41.25, 69.36, 41.37, ARRAY['customers']::text[], 2501
    ) AS feature
   WHERE feature.kind = 'customers'
     AND feature.display_name IS NULL;

  IF customer_feature_count < 1 THEN
    RAISE EXCEPTION 'Customer viewport projection should contain safe anonymous points with no display name';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.demo_viewport_features(
        69.20, 41.25, 69.36, 41.37, ARRAY['customers']::text[], 2501
      ) AS feature
     WHERE feature.kind <> 'customers'
  ) THEN
    RAISE EXCEPTION 'Viewport kind filter did not restrict results to customers';
  END IF;

  SELECT pg_catalog.count(*)::bigint
    INTO viewport_count
    FROM public.demo_viewport_features(10, 10, 11, 11, NULL, 2501);
  IF viewport_count <> 0 THEN
    RAISE EXCEPTION 'A viewport with no Tashkent demo points must return an empty feature set';
  END IF;

  SELECT * INTO empty_result
    FROM public.demo_radius_analysis(0, 0, 500);
  IF empty_result.customers_count <> 0
     OR empty_result.customers_revenue_total <> '0'
     OR empty_result.competitors_count <> 0
     OR empty_result.branches_count <> 0
     OR empty_result.locations_count <> 0
     OR empty_result.category_distribution <> '[]'::jsonb THEN
    RAISE EXCEPTION 'An empty radius must return zero counts, zero revenue and an empty category distribution';
  END IF;

  BEGIN
    PERFORM 1
      FROM public.demo_radius_analysis(69.2797, 41.3111, 99);
    RAISE EXCEPTION 'Radius validation should reject 99 meters';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  BEGIN
    PERFORM 1
      FROM public.demo_viewport_features(10, 10, 9, 11, NULL, 2501);
    RAISE EXCEPTION 'Viewport validation should reject west greater than east';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  SELECT 'public.demo_viewport_features(double precision,double precision,double precision,double precision,text[],integer)'::regprocedure
    INTO function_oid;
  IF pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Viewport RPC execution must be limited to service_role';
  END IF;

  SELECT 'public.demo_radius_analysis(double precision,double precision,double precision)'::regprocedure
    INTO function_oid;
  IF pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'Radius RPC execution must be limited to service_role';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.oid IN (
       'public.demo_viewport_features(double precision,double precision,double precision,double precision,text[],integer)'::regprocedure,
       'public.demo_radius_analysis(double precision,double precision,double precision)'::regprocedure
     )
       AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Phase 3 query functions must remain SECURITY INVOKER';
  END IF;

  -- The dataset is intentionally small. Disabling sequential scans only for
  -- these predicate-only probes verifies that the geography operators used by
  -- the RPCs can use GiST. The workspace filter may make a sequential/tenant
  -- index cheaper at this demo scale; this is not a production-plan assertion
  -- or a hardcoded full-plan comparison.
  PERFORM pg_catalog.set_config('enable_seqscan', 'off', true);
  FOR probe IN
    SELECT * FROM (VALUES
      ('customers', 'customers_spatial_gix'),
      ('competitors', 'competitors_spatial_gix'),
      ('branches', 'branches_spatial_gix'),
      ('locations', 'locations_spatial_gix')
    ) AS spatial_probe(table_name, index_name)
  LOOP
    spatial_index_name := probe.index_name;
    plan_query := pg_catalog.format(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT entity.id FROM public.%I AS entity WHERE extensions.st_dwithin(entity.spatial_point, $1::extensions.geography, 1000, true)',
      probe.table_name
    );
    EXECUTE plan_query INTO plan_json USING candidate;
    IF plan_json::text NOT LIKE '%' || spatial_index_name || '%' THEN
      RAISE EXCEPTION 'GiST index % was not available to a representative ST_DWithin query on %', spatial_index_name, probe.table_name;
    END IF;
    RAISE NOTICE 'ST_DWithin plan used %; execution time % ms',
      spatial_index_name,
      plan_json -> 0 -> 'Plan' ->> 'Actual Total Time';

    plan_query := pg_catalog.format(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT entity.id FROM public.%I AS entity WHERE extensions.st_intersects(entity.spatial_point, $1::extensions.geography)',
      probe.table_name
    );
    EXECUTE plan_query INTO plan_json USING viewport;
    IF plan_json::text NOT LIKE '%' || spatial_index_name || '%' THEN
      RAISE EXCEPTION 'GiST index % was not available to a representative ST_Intersects viewport query on %', spatial_index_name, probe.table_name;
    END IF;
    RAISE NOTICE 'ST_Intersects plan used %; execution time % ms',
      spatial_index_name,
      plan_json -> 0 -> 'Plan' ->> 'Actual Total Time';
  END LOOP;

  RAISE NOTICE 'Phase 3 spatial assertions passed: 500 m, 1 km, 3 km, 5 km, empty radius, nearest branch, categories, aggregate revenue, viewport filter and cross-workspace isolation.';
END;
$phase3_test$;

ROLLBACK;
