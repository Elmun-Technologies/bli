# GIS concepts and spatial decisions

## Status and scope

Phase 2 established spatial storage and safe map serialization. Phase 3 adds the first real spatial data flow: viewport feature loading and meter-based radius analysis against PostGIS. It still does not implement scoring, density heatmaps, territory polygons, routing or statistical inference. The clean database gate runs in GitHub Actions; local migration replay is **NOT VERIFIED HERE** because Docker and `psql` are unavailable in this workspace. Check the latest CI run for actual SQL results.

## Coordinates

All input and GeoJSON Point coordinates use `[longitude, latitude]` (WGS84 / EPSG:4326), not `[latitude, longitude]`. Runtime validation in `src/lib/domain/coordinates.ts` rejects malformed pairs, strings, non-finite values and coordinates outside longitude `[-180,180]` or latitude `[-90,90]`. Validation is applied at the map-click boundary, circle generation and map DTO boundary. Database point columns also use PostGIS `geography(Point,4326)` and coordinate checks. PostGIS normalizes out-of-range coordinates when converting geometry to geography, so raw scalar bounds cannot be inferred from the stored point. Reject raw coordinates at the input/domain boundary before casting. The rollback-only SQL test verifies the stored geography is canonical, and the domain unit tests verify raw out-of-range values are rejected.

Coordinate reference systems and unit types should remain explicit. SRID 4326 coordinates expressed as raw numbers are angular degrees, not meters. The selected `geography` representation supplies meter-aware distance operations for the radius-centric product.

## Storage choice: one `geography(Point, 4326)` column

The five point-record tables store one authoritative `spatial_point extensions.geography(Point, 4326)` value each: `locations`, `customers`, `competitors`, `branches` and `analysis_locations`. Do not add duplicate authoritative longitude/latitude columns.

Why geography for this phase:

- `ST_DWithin(geography, geography, distance_meters)` uses meter distances and spheroidal calculation by default (unless explicitly passed `false`). It is a natural fit for local business-radius queries and avoids accidentally treating longitude/latitude degrees as meters.
- A direct GiST index on geography supports index-aware candidate filtering for spatial predicates, including `ST_DWithin`.
- Geography supports global coordinates while allowing the product's local Tashkent queries to use consistent meter units.

Tradeoffs:

- Geography is not the best representation for every geometry operation. Polygon overlays/topology are commonly more flexible with geometry.
- Geography KNN `<->` orders by spherical distance; use it to shortlist candidates, then refine/reorder with `ST_Distance(a, b, true)` when accurate spheroidal ordering is important.
- If a future analysis is strictly local and needs a projected planar CRS or complex polygon operations, choose and document an appropriate projected geometry representation as a derived value. Do not silently reinterpret EPSG:4326 values as projected meters.

## Implemented query patterns (Phase 3)

### Radius analysis — `ST_DWithin` is authoritative

```sql
-- public.demo_radius_analysis(...) inside the demo workspace only
SELECT count(*), COALESCE(sum(revenue), 0)::text
FROM public.customers
WHERE workspace_id = <demo workspace resolved in SQL>
  AND extensions.st_dwithin(
        spatial_point,
        extensions.st_setsrid(extensions.st_makepoint($1, $2), 4326)::extensions.geography,
        $3,      -- radius in meters
        true     -- spheroidal distance
      );
```

`ST_DWithin(geography, geography, meters, true)` is used directly instead of `ST_Buffer` + `ST_Intersects`: it expresses the predicate exactly, uses meters rather than degrees, and can use the geography GiST index. The nearest branch uses `extensions.st_distance(spatial_point, candidate, true)` for exact spheroidal ordering, with `branch.id` as a deterministic tiebreaker.

### Viewport loading — geography `ST_Intersects`

```sql
-- public.demo_viewport_features(...) inside the demo workspace only
SELECT id, category, name,
       extensions.st_x(spatial_point::extensions.geometry),
       extensions.st_y(spatial_point::extensions.geometry)
FROM public.locations
WHERE extensions.st_intersects(
        spatial_point,
        extensions.st_makeenvelope($1, $2, $3, $4, 4326)::extensions.geography
      )
LIMIT $5;
```

The window is built once from validated `west/south/east/north` values. There is no second spatial column and no duplicated latitude/longitude column: X/Y are derived from the authoritative geography by an explicit geometry cast only for output. Ordinary (non-antimeridian) bounding boxes are sufficient for the Tashkent pilot; antimeridian-crossing requests are rejected with a validation error and global support is future work.

### Result caps and request behaviour

- The API requests `cap + 1` rows from the RPC, where the cap is **2,500** features per viewport. The extra row detects truncation rather than silently dropping data, and the response carries `meta.returnedCount`, `meta.limit` and `meta.truncated`.
- The browser issues one request per `moveend` (not per pixel), aborts the previous request with `AbortController`, and ignores any response whose sequence is no longer current, so a slow older request can never overwrite a newer viewport.
- Very broad viewports (beyond the server limits) are not requested at all; the UI reports "Zoom in to load the Tashkent demo area".

### Index-plan evidence

The Phase 3 SQL suite runs predicate-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` probes with sequential scans disabled *for the probe only* and asserts the matching GiST index appears in the plan for both `ST_DWithin` and `ST_Intersects` on all four point tables, printing the observed plan times. The demo dataset is intentionally tiny, so the planner may legitimately prefer a B-tree/workspace filter or a sequential scan in production-shaped queries; the probe proves the index is *usable* by this query shape without pinning a fragile plan string.

Observed in the clean CI run `37218349921` (PostgreSQL 17.11, PostGIS 3.3.7, ~40/25/9/241 seeded rows): `ST_DWithin` plan times were 0.032 ms (customers), 0.013 ms (competitors), 0.007 ms (branches) and 0.013 ms (locations); `ST_Intersects` plan times were 0.716 ms (customers), 0.084 ms (competitors), 0.039 ms (branches) and 0.130 ms (locations). Every probe reported the matching `*_spatial_gix` GiST index. These are micro-dataset probe timings for index-plan verification, **not** production performance numbers. Full workload benchmarking with realistic, privacy-safe data is still future work.

GeoJSON is produced from explicit X/Y extraction of the geography's geometry cast rather than `ST_AsGeoJSON` in the RPC, keeping the SQL projection narrow and the DTO construction in one place. The fixture adapter (`DATA_SOURCE=fixtures`) remains display-only and never feeds analysis.

## Geometry boundary

Use geography for authoritative point storage and meter-distance filtering. For future polygon territory/intersection work:

1. Keep polygon geometry SRID explicit (typically EPSG:4326 for interchange or a suitable projected CRS for metric planar work).
2. Cast the point to `extensions.geometry` for geometry-only operations, ensuring matching SRIDs.
3. Prefer `ST_Covers` where boundary points should count as inside; choose `ST_Contains` only if its boundary exclusion is intentional.
4. Validate/fix polygon geometry during ingestion; do not let malformed polygons silently corrupt analysis.
5. Establish a product requirement for antimeridian, polar and invalid topology cases before generalizing beyond the local use case.

No polygon schema or query is included in Phase 2.

## Units and shapes

- Database geography distances and the UI radius are in **meters**.
- Coordinates are `[longitude, latitude]` in degrees.
- GeoJSON points use `[longitude, latitude]` arrays.
- The demo radius circle remains a client-side illustrative shape. It reflects the selected radius immediately for orientation, but it is **not** the analytical source of truth: every count, nearest-branch distance and revenue figure comes from the PostGIS RPC.
- Viewport feature loading, radius analysis and nearest-branch calculation are all server-side. The browser never downloads all branches (or all customers) to compute proximity.
- Client-side MapLibre clustering over the capped viewport data is intentionally retained. Server-side vector tile clustering (`ST_AsMVT`, PMTiles, tile servers) is explicitly out of scope for Phase 3 and belongs to a later scale phase.
- `analysis_locations` stores only intentionally persisted project candidates. A map click remains transient React state until an explicit future save workflow exists.

## Indexes

Every spatial point table declares a GiST index on `spatial_point`, and B-tree indexes separately cover workspace/dataset/category/segment/project filters and external-ID uniqueness. Phase 2 asserts GiST index presence from the catalog; Phase 3 additionally asserts that the actual `ST_DWithin` and `ST_Intersects` predicates used by the RPCs can use those indexes, and prints the observed plan execution times in CI. Index selectivity and latency at production volume still require benchmarking with realistic, privacy-safe data.
