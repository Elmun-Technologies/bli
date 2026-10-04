# Atlas — Location Intelligence Platform

A modular Web GIS and location-intelligence workspace for commercial site selection, customer coverage and market analysis. The first pilot is Tashkent, Uzbekistan; the application architecture is city- and country-agnostic.

> **Phase 2 schema and database release gate are implemented; local database execution is unavailable here.** The app remains a Phase 1 demo using synthetic fixtures. Phase 2 adds ownership/spatial migrations, tenant-integrity constraints, default-deny RLS, schema-generated database types and PII-safe map/domain boundaries. There is still no live database/map-data loading, authentication policy, import or analytics path. Do not load real customer data based on this branch alone.

## Current capabilities

- Responsive B2B workspace shell with search, map layer controls and contextual analysis panel.
- MapLibre GL JS with OpenFreeMap's no-key Positron style by default; pan, zoom, geolocation, clustered fixture layers, selection and transient map-click candidate placement.
- A client-side geodesic radius ring for visual orientation only. **No customer counts, revenue, scores or spatial metrics are calculated.**
- Clearly labelled synthetic example points near Tashkent districts; not a verified business directory or real customer records.
- Runtime longitude/latitude validation and a GeoJSON adapter that emits only `id`, `kind`, `category` and validated coordinates—never customer names, addresses, phone numbers or revenue.
- Server-only Supabase SSR client factory; no feature-data query or service-role key is used by the app.

## Phase 2 database foundation

The ordered migrations add:

1. `organizations → workspaces → projects/datasets` ownership and a same-workspace many-to-many `project_datasets` relation.
2. `locations`, `customers`, `competitors`, `branches` and project-scoped `analysis_locations` point records.
3. Composite foreign keys that prevent cross-workspace references at the database layer, conservative deletion behavior, constraints, timestamp triggers and workspace-oriented indexes.
4. One authoritative `extensions.geography(Point,4326)` column per spatial record and a GiST index for each.
5. RLS enabled with **no policies**, plus revocation of `PUBLIC`, `anon` and `authenticated` table privileges (default-deny until membership policies are designed).

`analysis_locations` represents deliberately saved candidates. A map click remains transient client state and is not inserted into the database.

**Local database status: NOT VERIFIED.** The project-local Supabase CLI is pinned to `2.119.0`, but Docker and `psql` are unavailable in this workspace. `.github/workflows/database-integrity.yml` is the release gate: it starts a fresh database, replays every migration, runs live PostGIS/ownership/RLS/index/deletion/distance assertions, generates and checks database types, and runs the app checks. PostgreSQL/PostGIS versions are reported from runtime by CI. A green TypeScript build alone does not validate SQL; check the latest full workflow before deployment or Phase 3. See [docs/setup.md](docs/setup.md).

## Technology

- Next.js App Router, React and strict TypeScript
- Tailwind CSS v4
- MapLibre GL JS; replaceable MapLibre-compatible style URL
- Supabase SSR client and PostgreSQL/PostGIS migration foundation
- GeoJSON fixtures, runtime coordinate validation and a geodesic display utility

## Repository layout

```text
src/
  app/                 App Router entry point, metadata and global styles
  components/
    app/               Shell, navigation, search and analysis-preview UI
    map/               Client-only MapLibre implementation and shared props
  lib/
    data/              Synthetic Tashkent fixtures
    domain/            Validated coordinates and domain types
    database/          Generated Supabase row types and server-side aliases
    geo/               Visual circle geometry and tests
    map/               PII-safe GeoJSON adapter and tests
    supabase/          Server-only Supabase client factory
supabase/
  config.toml
  migrations/          Phase 1 plus ordered Phase 2 SQL migrations
  tests/               Rollback-only Phase 2 database integrity assertions
docs/
  architecture.md
  database.md
  gis-concepts.md
  setup.md
  deployment.md
```

## Quick start

Requirements: Node.js 20.19 or newer and npm.

```bash
npm install
cp .env.example .env.local  # optional for the map preview; edit values as needed
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The map style and tiles are served by the configured external map provider; an internet connection is needed to load them. The supplied OpenFreeMap style does not require a key. See [docs/setup.md](docs/setup.md) for local Supabase/PostGIS setup and the migration verification gate.

Full clean database and application gate (requires Docker and `psql`; database reset is destructive to local data):

```bash
npm run verify
```

Application-only checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

The TypeScript checks do not apply or validate SQL migrations. See [docs/setup.md](docs/setup.md) for the exact CI sequence and generated-type review.

## Environment variables

| Variable | Required now? | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_MAP_STYLE_URL` | No | Public MapLibre style URL; defaults to `https://tiles.openfreemap.org/styles/positron`. |
| `SUPABASE_URL` | No for the UI preview | Server-only Supabase project URL used by the SSR client factory. |
| `SUPABASE_ANON_KEY` | No for the UI preview | Publishable/anon key used by the server-side SSR client factory. |

The map can be previewed without Supabase credentials. Do not add a Supabase service-role/secret key to `NEXT_PUBLIC_*`, browser code, source control or client bundles. Phase 2 creates no authenticated data routes; RLS stays default-deny with no policies or client grants. Later authentication must add both explicit SQL `GRANT`s and membership-aware RLS policies—one does not replace the other.

## Roadmap

1. **Phase 1 — foundation (implemented):** Next.js, Tailwind, MapLibre shell, synthetic Tashkent fixtures, Supabase environment wiring and PostGIS extension setup.
2. **Phase 2 — ownership/spatial schema and boundaries (implemented; release-gated):** workspace-safe tables, PostGIS geography, constraints/indexes, default-deny RLS, generated types, runtime coordinate validation and map DTO allow-list. The current latest clean CI workflow must be green before deployment or Phase 3.
3. **Phase 3 — authenticated map data (not started):** first define workspace memberships and role-aware RLS/grants; then build server-side data access and safe map feature delivery. Do not load live business data before those security gates.
4. **Phase 4 — spatial analysis (not started):** product-defined PostGIS radius metrics and location-analysis endpoints.
5. **Phase 5 — data operations (not started):** validated imports, provenance, privacy/retention controls and customer layers.
6. **Phase 6 — intelligence (not started):** configurable, explainable scores and candidate comparison.
7. **Phase 7 — reporting and optimization (not started):** exports, deployment hardening and performance improvements.

## Documentation

- [Architecture and phase boundaries](docs/architecture.md)
- [Database schema, relationships and RLS](docs/database.md)
- [GIS concepts and spatial decisions](docs/gis-concepts.md)
- [Local development and Supabase setup](docs/setup.md)
- [Deployment checklist and security gates](docs/deployment.md)
