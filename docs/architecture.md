# Architecture

## Product direction

BLI is a location-intelligence workspace for business users: select an analysis point, choose a radius, and (in future phases) compare customer activity, competitors, existing branches and places against that area. Phase 1 is still a demo interface with deterministic fixture data; Phase 2 adds only the persistence and type boundaries. No live database/map-data loading, scoring, enrichment, or Phase 3 analytics were added here.

## Current implementation status

- **Phase 1 — implemented:** Next.js App Router interface, MapLibre map, synthetic Tashkent fixtures, selectable layers, radius control and map-click candidate state.
- **Phase 2 — implemented in source:** ownership schema, workspace-safe composite constraints, PostGIS geography point tables, indexes, timestamp triggers, default-deny RLS, runtime coordinate validation and PII-allow-list GeoJSON adapter.
- **Phase 2.5 — verification gate implemented:** a project-pinned CLI, clean-reset script, live catalog/integrity assertions, generated types and GitHub Actions coverage. The latest complete workflow run is the release authority.
- **LOCAL DATABASE NOT VERIFIED:** Docker and `psql` are unavailable in this workspace; local app checks do not substitute for the CI database gate.
- **NOT STARTED:** membership/authentication policies, live data access, imports, analytics, territories or scoring.

See [database.md](database.md) for exact migration/schema/RLS detail and [setup.md](setup.md) for verification instructions.

## Layers and responsibilities

```text
Next.js route and app shell
  └── app components (selection and ephemeral candidate state)
       └── map view / interactive MapLibre map
            ├── synthetic fixture data for Phase 1 only
            ├── coordinate validation before display/use
            └── map feature adapter (strict property allow-list)

Supabase/PostgreSQL/PostGIS (Phase 2 schema only; no runtime reads/writes)
  ├── organizations → workspaces → projects and datasets
  ├── project_datasets (same-workspace many-to-many)
  └── workspace-owned point tables and project-owned analysis_locations
```

### Ownership graph

```text
organizations
└── workspaces
    ├── projects ────┐
    │                ├── project_datasets (composite same-workspace FKs)
    ├── datasets ────┘
    │   ├── locations
    │   ├── customers
    │   ├── competitors
    │   └── branches
    └── analysis_locations (composite project/workspace FK)
```

Projects and datasets each belong to one workspace. They can be related many-to-many only within that workspace. Business records point to datasets using `(dataset_id, workspace_id)`, while persisted `analysis_locations` point to projects using `(project_id, workspace_id)`. The application cannot create a cross-workspace association even if it sends inconsistent IDs.

## Type and privacy boundaries

Phase 2 defines distinct modules:

1. **SQL persistence contract:** the ordered SQL migrations define Postgres rows and constraints. `src/lib/database/database.types.ts` is generated from the clean, verified Supabase schema; `row-types.ts` contains aliases to those generated rows rather than duplicate column definitions. Raw geography is emitted as `unknown` and remains opaque until parsed. Keep all generated rows server-side and treat SQL constraints as canonical.
2. **Domain/UI types:** `src/lib/domain/coordinates.ts` validates longitude/latitude tuples at runtime. `src/lib/domain/map-location.ts` describes UI locations and distinguishes `TransientCandidate` (unsaved UI state) from the persisted `analysis_locations` table defined in SQL.
3. **Map DTO:** `src/lib/map/map-feature-adapter.ts` emits GeoJSON Point features with only `id`, `kind` and `category` properties. It accepts no name, address, phone or revenue fields; IDs are restricted to opaque database UUIDs or known synthetic fixture/candidate IDs. Coordinates are revalidated before serialization. This DTO, not a database row, is the MapLibre boundary. It omits `name` for every entity kind today. Phase 3/4 should keep customer DTOs strongly PII-limited; a separate normal business/POI DTO may explicitly allow a display name after review. Do not broaden this customer-safe DTO as a shortcut.

Current fixtures are synthetic and continue to drive the interface. A map-click candidate only updates component state; it does **not** write to `analysis_locations`. That table is reserved for a candidate the user deliberately persists later. No map-click or database write path is added in Phase 2.

## Data access and security status

There are no repositories, API routes, Supabase queries, or map-data loaders in Phase 2. All ten ownership/business tables enable row-level security and intentionally have no policies; `PUBLIC`, `anon`, and `authenticated` table privileges are revoked. This is default-deny, not a usable logged-in data API. Do not add broad or `USING (true)` policies. Authentication work must define workspace membership and add **both** explicit role-aware RLS policies and the necessary SQL `GRANT`s; a policy alone cannot restore privileges removed by `REVOKE`.

The service role is not a browser credential. Future database queries should stay server-side, select only columns required for the task, check workspace membership, and map raw rows through a validated domain adapter before producing map DTOs. PII must not leak into generic GeoJSON or MapLibre source properties.

## Spatial model

The Phase 2 point representation is one authoritative `extensions.geography(Point,4326)` column per spatial row. It provides meter-based `ST_DWithin` queries with a direct GiST index, and avoids inconsistent duplicated latitude/longitude columns. Use explicit schema-qualified PostGIS functions and types; convert to `extensions.geometry` for GeoJSON serialization or geometry-only topology operations. Geography `<->` is a spherical nearest-neighbor candidate order; use spheroidal `ST_Distance(..., true)` when ranking precision matters.

No proximity calculation, territory overlay, heatmap, routing, customer density, or scoring query is implemented yet.

## Code organization

```text
src/
  app/                         App Router routes and styles
  components/app/              Top bar, controls and analysis panel
  components/map/              MapLibre component and shared map props
  lib/data/demo-locations.ts   Synthetic Phase 1 fixtures only
  lib/domain/                  Runtime coordinate and domain types
  lib/database/                Generated DB rows and server-side aliases
  lib/geo/                     Circle geometry helper and unit tests
  lib/map/                     PII-safe GeoJSON adapter and tests
  lib/supabase/                Supabase server client (not yet used for feature data)
supabase/
  migrations/                  Ordered Phase 1 and Phase 2 SQL migrations
  tests/phase2_integrity.sql   Rollback-only local DB integrity assertions
```

## Future architecture checkpoints (not Phase 2 deliverables)

- Add a `workspace_members` relationship and authentication/role-aware RLS before any client-visible persistence path.
- Regenerate database types after migrations have actually applied to the clean local/CI schema; do not leak them into React/map code.
- Add server-side data access with workspace checks, safe selected columns and explicit row-to-domain/DTO mapping.
- Define stable external IDs, data lineage, retention and import validation before real customer data is loaded.
- Add analytics only after product definitions, data quality checks and a server-side query contract are agreed.
