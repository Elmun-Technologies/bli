# GIS concepts and Phase 2 spatial decisions

## Status and scope

Phase 2 establishes spatial storage and safe map serialization boundaries only. It does **not** load live database rows into the map and does not implement proximity analysis, customer-density scoring, territory polygons, routing or statistical inference. SQL migrations and the integrity script are present but **NOT VERIFIED LOCALLY** because Supabase CLI, Docker and `psql` are unavailable in this workspace.

## Coordinates

All input and GeoJSON Point coordinates use `[longitude, latitude]` (WGS84 / EPSG:4326), not `[latitude, longitude]`. Runtime validation in `src/lib/domain/coordinates.ts` rejects malformed pairs, strings, non-finite values and coordinates outside longitude `[-180,180]` or latitude `[-90,90]`. Validation is applied at the map-click boundary, circle generation and map DTO boundary. Database point columns also use PostGIS `geography(Point,4326)` and coordinate checks. PostGIS normalizes longitude when converting geometry to geography, so a raw longitude such as `181` is normalized rather than rejected after the cast; the database cannot recover the original scalar from the stored geography. Reject raw coordinates at the input/domain boundary before casting. PostGIS rejects latitude outside `[-90,90]`, and the rollback-only SQL test verifies both behaviors.

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

## Query patterns (future use only)

A meter-radius search should use an index-aware predicate, with the query point made in longitude/latitude order and cast to geography:

```sql
SELECT id, category
FROM public.locations
WHERE workspace_id = $1
  AND dataset_id = $2
  AND extensions.st_dwithin(
        spatial_point,
        extensions.st_setsrid(extensions.st_makepoint($3, $4), 4326)::extensions.geography,
        $5 -- distance in meters
      );
```

The GiST index returns candidate rows and the predicate filters by the requested distance. Verify real workloads with `EXPLAIN (ANALYZE, BUFFERS)`; an index existing in DDL does not guarantee a specific plan for every table size or query shape.

GeoJSON output should explicitly cast geography to geometry before `ST_AsGeoJSON`, then convert coordinates to the domain/map DTO. The current client fixture adapter is independent of database rows; there is no SQL/API query that loads records into the map.

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
- The demo radius circle remains a client-side illustrative shape and is not a database result or an authoritative territory polygon.
- `analysis_locations` stores only intentionally persisted project candidates. A map click remains transient React state until an explicit future save workflow exists.

## Indexes

Every Phase 2 spatial point table declares a GiST index on `spatial_point`. B-tree indexes separately cover workspace/dataset/category/segment/project filters and external-ID uniqueness. The SQL integrity script asserts GiST index presence, but that database assertion has **not been executed locally**. Index usefulness and query plans remain to be benchmarked with realistic, privacy-safe data.
