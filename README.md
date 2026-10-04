# Atlas — Location Intelligence Platform

A modular Web GIS and location-intelligence workspace for commercial site selection, customer coverage and market analysis. The first pilot is Tashkent, Uzbekistan; the application architecture is city- and country-agnostic.

> **Phase 4 (Supabase Auth + workspace membership + production RLS) is implemented; the clean database gate is green in GitHub Actions.** Two separate trust models now exist side by side. The public synthetic demo (`/api/demo/*`) is unchanged: display-safe PostGIS viewport features and `ST_DWithin` radius aggregates for the fixed demo workspace, served with a server-only elevated credential. The tenant path is new: email/password sign-in, server-validated sessions, a protected `/workspaces/[workspaceId]` route whose membership and role are resolved in the database, and authenticated viewport/analytic endpoints that run under the caller's own RLS-aware session. Owner/admin/analyst/viewer permissions are enforced by PostgreSQL policies and grants, never by the UI. Local database execution is unavailable in this workspace; CI is the verified database environment.

## Current capabilities

- Responsive B2B workspace shell with search, map layer controls and a real analysis panel.
- MapLibre GL JS with OpenFreeMap's no-key Positron style by default; pan, zoom, geolocation and client-side clustering over server-provided viewport features.
- Viewport loading from `GET /api/demo/map/features`: one request per completed map movement (`moveend`), previous requests aborted with `AbortController`, stale responses ignored, results capped at 2,500 features with explicit `truncated` metadata.
- Real radius analysis from `POST /api/demo/analysis/radius`: meter-based PostGIS `ST_DWithin` aggregates (customers, exact customer revenue, competitors, branches, POIs, category distribution) plus a server-calculated nearest branch.
- The client-side geodesic ring stays **visual only**; it is never the analytical source of truth.
- Display-safe DTOs: business/POI features may carry an explicit display name; customer map features carry only `id`, `kind` and `category` — never name, address, phone, company or revenue.
- Explicit data mode via `DATA_SOURCE`: `database` (default, PostGIS) or `fixtures` (display-only development fallback). A database failure is never silently replaced by fixture data, and radius analysis is refused in fixture mode.
- `server-only` elevated Supabase client for the demo RPCs; RLS remains default-deny with no client grants or policies.
- **Phase 4 authentication:** minimal email/password sign-in (`/sign-in`, `POST /api/auth/sign-in`), server-side sign-out, a session refreshed by `src/proxy.ts`, and safe error messages only (`Invalid email or password.`, `You do not have access to this workspace.`, `Session expired. Please sign in again.`). No signup funnel, password reset, OAuth, magic links or profile settings.
- **Phase 4 membership:** `workspace_members` maps auth users to workspaces with a role (`owner`, `admin`, `analyst`, `viewer`). The workspace selector lists only memberships the database returns for the caller.
- **Phase 4 tenant GIS:** `GET /api/workspaces/[workspaceId]/map/features` and `POST /api/workspaces/[workspaceId]/analysis/radius` validate the session, resolve membership, then execute a membership-asserting RPC under the caller's own session. A foreign workspace id and a non-existent one return the identical `403` body.

## Phase 2 database foundation (unchanged)

The ordered migrations add:

1. `organizations → workspaces → projects/datasets` ownership and a same-workspace many-to-many `project_datasets` relation.
2. `locations`, `customers`, `competitors`, `branches` and project-scoped `analysis_locations` point records.
3. Composite foreign keys that prevent cross-workspace references at the database layer, conservative deletion behavior, constraints, timestamp triggers and workspace-oriented indexes.
4. One authoritative `extensions.geography(Point,4326)` column per spatial record and a GiST index for each.
5. RLS enabled with **no policies**, plus revocation of `PUBLIC`, `anon` and `authenticated` table privileges (default-deny until membership policies are designed).

`analysis_locations` represents deliberately saved candidates. A map click remains transient client state and is not inserted into the database.

## Phase 3 demo workspace and security boundary

- The only live database path is the synthetic workspace `atlas-demo` / `tashkent-demo`, resolved **server-side** from deterministic slugs in `src/lib/spatial/demo-workspace.ts`. The browser cannot choose a workspace UUID.
- The elevated credential is read in `src/lib/supabase/admin.ts`, a `server-only` module that prefers Supabase's secret key (`SUPABASE_SECRET_KEY`) and falls back to the legacy service-role key (`SUPABASE_SERVICE_ROLE_KEY`). It is never imported into a Client Component, never prefixed with `NEXT_PUBLIC_`, never logged and never returned in an error response.
- Spatial work runs through two narrowly scoped, independently testable SQL functions with `SECURITY INVOKER`: `public.demo_viewport_features(...)` and `public.demo_radius_analysis(...)`. `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated` and granted only to `service_role`.
- The `service_role` credential bypasses RLS by design; because it never reaches the browser and the RPCs bind themselves to the demo workspace, the demo cannot read another tenant's workspace through the API.

## Database verification gate

**Local database status: NOT VERIFIED HERE.** The project-local Supabase CLI is pinned to `2.119.0`, but Docker and `psql` are unavailable in this workspace. `.github/workflows/database-integrity.yml` is the release gate: it starts a fresh database, replays every migration from zero, loads `supabase/seed.sql`, runs the live PostGIS/ownership/RLS/index/Phase 3 spatial assertions, generates and checks database types, then runs the app checks. **A green TypeScript build alone does not validate SQL.** See [docs/setup.md](docs/setup.md).

## Technology

- Next.js App Router, React and strict TypeScript
- Tailwind CSS v4
- MapLibre GL JS; replaceable MapLibre-compatible style URL
- Supabase/PostgreSQL/PostGIS with generated database types
- PostGIS `geography(Point,4326)`, GiST indexes and `ST_DWithin` meter-based analysis

## Repository layout

```text
src/
  app/                 App Router entry point, metadata and global styles
    api/demo/          Viewport feature and radius analysis route handlers
  components/
    app/               Shell, search, layer control and PostGIS-backed analysis panel
    map/               Client-only MapLibre implementation, viewport loading and shared props
  lib/
    data/              Synthetic Tashkent fixtures (display-only fallback)
    domain/            Validated coordinates and domain types
    database/          Generated Supabase types and server-side row aliases
    geo/               Visual circle geometry and tests
    map/               PII-safe GeoJSON adapter and tests
    spatial/           DTOs, validation, client fetchers, demo workspace resolver, server service
    supabase/          Server-only Supabase clients (SSR + elevated demo client)
supabase/
  config.toml
  migrations/          Ordered Phase 1–3 SQL migrations
  seed.sql             Deterministic synthetic demo + isolation workspace data
  tests/               Rollback-only Phase 2 and Phase 3 database assertions
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
cp .env.example .env.local  # edit values; see the environment table below
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The map style and tiles are served by the configured external map provider; an internet connection is needed to load them. Database-backed demo mode additionally needs the server-side Supabase values and a seeded local project (see [docs/setup.md](docs/setup.md)). Without them, set `DATA_SOURCE=fixtures` for a display-only preview; radius analysis stays disabled.

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
npm run smoke:fixtures
```

## Environment variables

| Variable | Required now? | Purpose |
| --- | --- | --- |
| `DATA_SOURCE` | No | `database` (default) or `fixtures`. Fixtures are display-only; analysis endpoints refuse to run. |
| `NEXT_PUBLIC_MAP_STYLE_URL` | No | Public MapLibre style URL; defaults to `https://tiles.openfreemap.org/styles/positron`. |
| `SUPABASE_URL` | Yes for database mode | Server-only Supabase project URL. |
| `SUPABASE_ANON_KEY` | No for the UI preview | Publishable/anon key for the cookie-aware SSR client factory. |
| `SUPABASE_SECRET_KEY` | Yes for database mode | Server-only elevated key for the demo spatial RPCs (preferred). |
| `SUPABASE_SERVICE_ROLE_KEY` | Legacy alternative | Server-only compatibility fallback when the project has no secret key. |

Never use `NEXT_PUBLIC_*` for an elevated key, never import `src/lib/supabase/admin.ts` from a Client Component, and never log either key. RLS remains default-deny: later authentication must add both explicit SQL `GRANT`s and membership-aware RLS policies — one does not replace the other.

## Roadmap

1. **Phase 1 — foundation (implemented):** Next.js, Tailwind, MapLibre shell, synthetic Tashkent fixtures.
2. **Phase 2 / 2.5 — ownership/spatial schema and clean database gate (implemented):** workspace-safe tables, PostGIS geography, constraints/indexes, default-deny RLS, generated types, CI verification.
3. **Phase 3 — DB-backed demo map and radius analysis (implemented):** server-side viewport features, PostGIS `ST_DWithin` radius aggregates, safe DTOs, demo-workspace boundary, server-only elevated credential.
4. **Phase 4 — authentication and membership (not started):** workspace membership, role-aware RLS policies plus explicit grants, `resolveWorkspaceContext()` generalized beyond the fixed demo workspace.
5. **Phase 5 — data operations (not started):** validated imports, provenance, privacy/retention controls and customer layers.
6. **Phase 6 — intelligence (not started):** configurable, explainable scores and candidate comparison.
7. **Phase 7 — reporting, tiles and optimization (not started):** vector tiles/`ST_AsMVT` at larger scale, exports and performance work.

## Documentation

- [Architecture and phase boundaries](docs/architecture.md)
- [Database schema, functions and RLS](docs/database.md)
- [GIS concepts and spatial decisions](docs/gis-concepts.md)
- [Local development and Supabase setup](docs/setup.md)
- [Deployment checklist and security gates](docs/deployment.md)
