-- Phase 3 adds narrowly scoped, server-only PostGIS RPCs for the synthetic
-- Tashkent demo. These functions never accept a browser-selected workspace.
-- They independently bind all queries to atlas-demo/tashkent-demo.

CREATE OR REPLACE FUNCTION public.demo_viewport_features(
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_kinds text[] DEFAULT NULL,
  p_limit integer DEFAULT 2501
)
RETURNS TABLE (
  feature_id uuid,
  kind text,
  category text,
  display_name text,
  longitude double precision,
  latitude double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  viewport extensions.geography;
BEGIN
  IF p_west IS NULL OR p_south IS NULL OR p_east IS NULL OR p_north IS NULL
     OR NOT (p_west BETWEEN -180 AND 180)
     OR NOT (p_east BETWEEN -180 AND 180)
     OR NOT (p_south BETWEEN -90 AND 90)
     OR NOT (p_north BETWEEN -90 AND 90)
     OR p_west > p_east
     OR p_south > p_north THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid viewport bounds';
  END IF;

  IF p_east - p_west > 40
     OR p_north - p_south > 20
     OR (p_east - p_west) * (p_north - p_south) > 400 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Viewport is too large';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2501 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid viewport result limit';
  END IF;

  IF p_kinds IS NOT NULL AND EXISTS (
    SELECT 1
      FROM pg_catalog.unnest(p_kinds) AS requested_kind(value)
     WHERE requested_kind.value IS NULL
        OR requested_kind.value NOT IN ('places', 'competitors', 'branches', 'customers')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid map feature kind';
  END IF;

  viewport := extensions.st_makeenvelope(
    p_west, p_south, p_east, p_north, 4326
  )::extensions.geography;

  RETURN QUERY
  WITH demo_workspace AS (
    SELECT workspace.id
      FROM public.organizations AS organization
      JOIN public.workspaces AS workspace
        ON workspace.organization_id = organization.id
     WHERE organization.slug = 'atlas-demo'
       AND workspace.slug = 'tashkent-demo'
  ),
  viewport_features AS (
    SELECT location.id AS feature_id,
           'places'::text AS feature_kind,
           location.category,
           location.name AS display_name,
           location.spatial_point
      FROM public.locations AS location
      JOIN demo_workspace ON demo_workspace.id = location.workspace_id
     WHERE (p_kinds IS NULL OR 'places' = ANY (p_kinds))
       AND extensions.st_intersects(location.spatial_point, viewport)

    UNION ALL

    SELECT competitor.id,
           'competitors'::text,
           competitor.category,
           competitor.name,
           competitor.spatial_point
      FROM public.competitors AS competitor
      JOIN demo_workspace ON demo_workspace.id = competitor.workspace_id
     WHERE (p_kinds IS NULL OR 'competitors' = ANY (p_kinds))
       AND extensions.st_intersects(competitor.spatial_point, viewport)

    UNION ALL

    SELECT branch.id,
           'branches'::text,
           'Branch'::text,
           branch.name,
           branch.spatial_point
      FROM public.branches AS branch
      JOIN demo_workspace ON demo_workspace.id = branch.workspace_id
     WHERE (p_kinds IS NULL OR 'branches' = ANY (p_kinds))
       AND extensions.st_intersects(branch.spatial_point, viewport)

    UNION ALL

    -- Customer map features deliberately have no name, address, phone,
    -- company, revenue, external identifier, or raw row in their projection.
    SELECT customer.id,
           'customers'::text,
           'Customer'::text,
           NULL::text,
           customer.spatial_point
      FROM public.customers AS customer
      JOIN demo_workspace ON demo_workspace.id = customer.workspace_id
     WHERE (p_kinds IS NULL OR 'customers' = ANY (p_kinds))
       AND extensions.st_intersects(customer.spatial_point, viewport)
  )
  SELECT viewport_feature.feature_id,
         viewport_feature.feature_kind,
         viewport_feature.category,
         viewport_feature.display_name,
         extensions.st_x(viewport_feature.spatial_point::extensions.geometry),
         extensions.st_y(viewport_feature.spatial_point::extensions.geometry)
    FROM viewport_features AS viewport_feature
   ORDER BY viewport_feature.feature_kind, viewport_feature.feature_id
   LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.demo_radius_analysis(
  p_longitude double precision,
  p_latitude double precision,
  p_radius_meters double precision
)
RETURNS TABLE (
  customers_count bigint,
  customers_revenue_total text,
  competitors_count bigint,
  branches_count bigint,
  locations_count bigint,
  category_distribution jsonb,
  nearest_branch_id uuid,
  nearest_branch_name text,
  nearest_branch_distance_meters double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  demo_workspace_id uuid;
  candidate extensions.geography;
BEGIN
  IF p_longitude IS NULL OR p_latitude IS NULL
     OR NOT (p_longitude BETWEEN -180 AND 180)
     OR NOT (p_latitude BETWEEN -90 AND 90) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid analysis coordinates';
  END IF;

  IF p_radius_meters IS NULL OR NOT (p_radius_meters BETWEEN 100 AND 20000) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Radius must be between 100 and 20000 meters';
  END IF;

  SELECT workspace.id
    INTO demo_workspace_id
    FROM public.organizations AS organization
    JOIN public.workspaces AS workspace
      ON workspace.organization_id = organization.id
   WHERE organization.slug = 'atlas-demo'
     AND workspace.slug = 'tashkent-demo';

  IF demo_workspace_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Synthetic demo workspace not found';
  END IF;

  candidate := extensions.st_setsrid(
    extensions.st_makepoint(p_longitude, p_latitude), 4326
  )::extensions.geography;

  RETURN QUERY
  WITH customer_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count,
           COALESCE(pg_catalog.sum(customer.revenue), 0)::text AS revenue_total
      FROM public.customers AS customer
     WHERE customer.workspace_id = demo_workspace_id
       AND extensions.st_dwithin(
         customer.spatial_point, candidate, p_radius_meters, true
       )
  ),
  competitor_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count
      FROM public.competitors AS competitor
     WHERE competitor.workspace_id = demo_workspace_id
       AND extensions.st_dwithin(
         competitor.spatial_point, candidate, p_radius_meters, true
       )
  ),
  branch_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count
      FROM public.branches AS branch
     WHERE branch.workspace_id = demo_workspace_id
       AND extensions.st_dwithin(
         branch.spatial_point, candidate, p_radius_meters, true
       )
  ),
  location_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count
      FROM public.locations AS location
     WHERE location.workspace_id = demo_workspace_id
       AND extensions.st_dwithin(
         location.spatial_point, candidate, p_radius_meters, true
       )
  ),
  category_metrics AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'kind', category_rows.kind,
          'category', category_rows.category,
          'count', category_rows.count
        ) ORDER BY category_rows.kind, category_rows.category
      ),
      '[]'::jsonb
    ) AS distribution
      FROM (
        SELECT 'places'::text AS kind,
               location.category,
               pg_catalog.count(*)::bigint AS count
          FROM public.locations AS location
         WHERE location.workspace_id = demo_workspace_id
           AND extensions.st_dwithin(
             location.spatial_point, candidate, p_radius_meters, true
           )
         GROUP BY location.category

        UNION ALL

        SELECT 'competitors'::text,
               competitor.category,
               pg_catalog.count(*)::bigint
          FROM public.competitors AS competitor
         WHERE competitor.workspace_id = demo_workspace_id
           AND extensions.st_dwithin(
             competitor.spatial_point, candidate, p_radius_meters, true
           )
         GROUP BY competitor.category
      ) AS category_rows
  ),
  nearest_branch AS (
    SELECT branch.id,
           branch.name,
           extensions.st_distance(branch.spatial_point, candidate, true)::double precision AS distance_meters
      FROM public.branches AS branch
     WHERE branch.workspace_id = demo_workspace_id
     ORDER BY extensions.st_distance(branch.spatial_point, candidate, true), branch.id
     LIMIT 1
  )
  SELECT customer_metrics.count,
         customer_metrics.revenue_total,
         competitor_metrics.count,
         branch_metrics.count,
         location_metrics.count,
         category_metrics.distribution,
         nearest_branch.id,
         nearest_branch.name,
         nearest_branch.distance_meters
    FROM customer_metrics
    CROSS JOIN competitor_metrics
    CROSS JOIN branch_metrics
    CROSS JOIN location_metrics
    CROSS JOIN category_metrics
    LEFT JOIN nearest_branch ON true;
END;
$function$;

-- The elevated server role is explicitly granted only the read surface required
-- by these SECURITY INVOKER functions. Existing RLS stays enabled and no client
-- role receives either table privileges or function execution rights.
GRANT SELECT ON TABLE
  public.organizations,
  public.workspaces,
  public.locations,
  public.customers,
  public.competitors,
  public.branches
TO service_role;

REVOKE ALL ON FUNCTION public.demo_viewport_features(
  double precision, double precision, double precision, double precision, text[], integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.demo_viewport_features(
  double precision, double precision, double precision, double precision, text[], integer
) TO service_role;

REVOKE ALL ON FUNCTION public.demo_radius_analysis(
  double precision, double precision, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.demo_radius_analysis(
  double precision, double precision, double precision
) TO service_role;

COMMENT ON FUNCTION public.demo_viewport_features(
  double precision, double precision, double precision, double precision, text[], integer
) IS 'Returns PII-safe viewport features only from the atlas-demo/tashkent-demo synthetic workspace.';

COMMENT ON FUNCTION public.demo_radius_analysis(
  double precision, double precision, double precision
) IS 'Runs meter-based ST_DWithin aggregates and exact nearest-branch distance only in the atlas-demo/tashkent-demo synthetic workspace.';
