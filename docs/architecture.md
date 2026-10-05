# Architecture

## Product direction

BLI is a location-intelligence workspace for business users: select an analysis point, choose a radius, and compare customer activity, competitors, existing branches and places against that area. Phase 3 turns that into the first real product data flow for a synthetic pilot workspace; scoring, imports and territories remain later phases.

## Current implementation status

- **Phase 1 — implemented:** Next.js App Router interface, MapLibre map, selectable layers, radius control and map-click candidate state.
- **Phase 2 — implemented:** ownership schema, workspace-safe composite constraints, PostGIS geography point tables, indexes, timestamp triggers, default-deny RLS, runtime coordinate validation and PII-allow-listed map adapter.
- **Phase 2.5 — verification gate implemented:** pinned CLI, clean-reset script, live catalog/integrity assertions, generated types and GitHub Actions coverage.
- **Phase 3 — implemented:** database-backed demo map (viewport features), server-side PostGIS radius analysis, safe DTOs, server-only elevated credential, deterministic synthetic seed, cross-workspace isolation assertions.
- **Phase 4 — implemented:** Supabase Auth (email/password) with a minimal sign-in/sign-out surface, `workspace_members` with an owner/admin/analyst/viewer role enum, deliberate per-table RLS policies for `authenticated`, an explicit grant matrix, membership- and RLS-checked tenant viewport/radius RPCs, a protected `/workspaces/[workspaceId]` route and a membership-only workspace selector. The public demo path is unchanged.
- **Phase 5 — implemented:** a six-step import pipeline (upload → columns → mapping → validation → geocoding → commit) for CSV/XLSX files: content-sniffed parsing, multilingual column mapping, deterministic per-row validation with machine-readable errors, private storage with membership-scoped policies, a provider-abstracted geocoder (Mapbox Geocoding v6 permanent-only in production, a deterministic fake in CI), bounded resumable batches, manual placement, a transactional idempotent commit with provenance into `customers`/`locations`, and a formula-safe error export. No `service_role` is used anywhere in the tenant import path.
- **Phase 6 — implemented:** a versioned, workspace-owned scoring model (factors: metric, weight, direction, normalization), the `run_location_analysis` engine that measures every candidate through the existing PostGIS radius analysis and stores an immutable snapshot (raw metrics, normalized values, contributions, rank, model revision), a Locations section with saved-candidate, analysis, comparison and model-editor tabs, a strict payload parser shared by client and smoke, and the SQL/unit/smoke coverage described in [scoring.md](scoring.md).
- **Phase 6.5 — implemented:** explicit project context. There is no implicit "oldest project" selection left in the code base: a request names its project, the server verifies it against the caller's own workspace projects, a missing project id in a multi-project workspace is a safe `400`, a foreign or non-existent project id fails identically (no existence oracle), candidates and histories are project-scoped, mixed-project comparisons are refused by the engine, and scoring models stay workspace-owned and reusable across projects. A compact project selector (with a documented zero-project empty state) heads the Locations section.
- **LOCAL DATABASE NOT VERIFIED:** Docker and `psql` are unavailable in this workspace; local app checks do not substitute for the CI database gate.
- **NOT STARTED:** heatmaps, PDF reports, AI recommendations, routing, territories, server-side vector tiles, workspace invitations, administrative UI beyond the minimal selector, imports into other entity types, billing, CRM sync, dataset versioning, background workers and retention automation.

See [database.md](database.md) for migration/schema/RLS detail, [auth-security.md](auth-security.md) for the Phase 4 trust model, [imports.md](imports.md) and [geocoding.md](geocoding.md) for Phase 5, [scoring.md](scoring.md) for Phase 6/6.5 and [setup.md](setup.md) for verification instructions.

## Phase 3 data flow

```text
PostgreSQL / PostGIS  (geography(Point,4326), GiST indexes, seeded demo workspace)
        │  SECURITY INVOKER SQL functions
        ▼
public.demo_viewport_features(...)      public.demo_radius_analysis(...)
  ST_Intersects + envelope                ST_DWithin (meters, spheroid) + aggregates
        │  service_role-only EXECUTE           │  service_role-only EXECUTE
        ▼                                       ▼
server-only service (src/lib/spatial/service.ts, demo-workspace resolver)
        │  validated domain result → display-safe DTO (src/lib/spatial/dto.ts)
        ▼
Next.js route handlers
  GET  /api/demo/map/features              POST /api/demo/analysis/radius
        │  GeoJSON FeatureCollection            │  { analysis: RadiusAnalysisDTO }
        ▼                                       ▼
client fetchers with AbortController (src/lib/spatial/client.ts)
        │  response re-validation (src/lib/spatial/response.ts)
        ▼
MapLibre GeoJSON source + clustering      analysis panel rows (src/lib/spatial/analysis-view.ts)
```

Map components never see database rows: they consume `SafeMapFeature` (id/kind/category plus an explicitly allowed business `name`) and the analysis DTO. The RPC result is validated twice — once when mapping the narrow SQL projection to a DTO on the server, and again when the browser parses the API response.

## Layers and responsibilities

```text
Next.js route and app shell
  └── app components (selection, ephemeral candidate, analysis state)
       └── map view / interactive MapLibre map
            ├── viewport loading (moveend, AbortController, stale-response guard)
            ├── coordinate validation before display/use
            └── map feature adapter (strict property allow-list)

src/lib/spatial (server + shared)
  ├── contracts.ts        DTO shapes shared by server and client
  ├── validation.ts       raw request validation (bbox, radius, kinds)
  ├── demo-workspace.ts   server-only resolver for the fixed synthetic workspace
  ├── service.ts          server-only RPC calls (service_role, SECURITY INVOKER functions)
  ├── dto.ts              narrow SQL projection → display-safe DTO
  ├── response.ts         client-side re-validation of API payloads
  └── client.ts           fetch helpers with cancellation and structured errors

Supabase/PostgreSQL/PostGIS
  ├── organizations → workspaces → projects and datasets
  ├── project_datasets (same-workspace many-to-many)
  ├── workspace-owned point tables and project-owned analysis_locations
  └── demo_viewport_features / demo_radius_analysis (bound to atlas-demo/tashkent-demo)
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

Projects and datasets each belong to one workspace and can be related many-to-many only within that workspace. Business records point to datasets using `(dataset_id, workspace_id)`, while persisted `analysis_locations` point to projects using `(project_id, workspace_id)`. The application cannot create a cross-workspace association even if it sends inconsistent IDs.

## Phase 4 data flow (tenant path)

```text
browser ── POST /api/auth/sign-in ────────────► email/password → Supabase Auth
                                                 │ SSR session cookies (httpOnly)
browser ── GET /workspaces/[workspaceId] ────► Server Component
                                                 │ requireSessionUser()  (auth.getUser, server-validated)
                                                 │ resolveWorkspaceAccess()  (RLS-filtered membership + role)
                                                 ▼
                                        NoAccessState | workspace shell (role badge + selector)
browser ── GET/POST /api/workspaces/[id]/* ──► Route handler
                                                 │ session → membership → RLS-aware session client
                                                 ▼
                        public.workspace_viewport_features / workspace_radius_analysis
                                                 │ SECURITY INVOKER · membership assertion 42501 first
                                                 │ RLS filters every table read
                                                 ▼
                        same display-safe DTOs and client parsers as the demo path
```

The two paths share DTOs, validation and client parsers, but never credentials:
the demo path uses the elevated server client, the tenant path uses the caller's
cookie-aware anon client. `src/lib/spatial/server-boundary.test.ts` pins which
modules may import `@/lib/supabase/admin`.

## Phase 4 authorization model

1. **Sessions are validated server-side.** `getSessionUser()` calls
   `auth.getUser()`, so a forged or expired cookie cannot authorize anything.
   `src/proxy.ts` only refreshes cookies; it is not a security boundary.
2. **Membership is data, not UI state.** `workspace_members` is the only source
   of truth for who may touch a workspace, and every read of it goes through RLS.
   The workspace id in a URL or request body is untrusted input: the resolver
   returns the same `null` for "not a member" and "no such workspace".
3. **Role checks exist twice.** Route handlers resolve the caller's role for
   routing decisions, and the RPCs separately assert membership before touching
   data (raising `42501` before any bounds validation, so an unauthorized caller
   cannot even probe validation behaviour). Table-level writes are governed by
   RLS policies, so a handler mistake cannot become a data breach.
4. **Elevated credentials never serve tenant requests.** The service-role client
   is limited to the public demo path, the operator bootstrap and CI setup.
5. **Trustworthy defaults.** `anon` holds no privilege on any table and cannot
   execute any function. RLS remains enabled everywhere, with no `USING (true)`.

The full policy, grant and helper documentation lives in
[auth-security.md](auth-security.md); the schema section of
[database.md](database.md) records the migration-level detail.

## Phase 3 security model (public demo path, unchanged)

Authentication and workspace membership do not exist yet, so the live database path is deliberately narrow:

1. **One fixed workspace.** `resolveWorkspaceContext()` (`src/lib/spatial/demo-workspace.ts`) independently resolves the deterministic synthetic workspace (`atlas-demo` / `tashkent-demo`). The browser never sends a workspace identifier; neither route handler accepts one. A request field such as `workspaceId` is rejected as an unsupported field.
2. **Server-only elevated credential.** `src/lib/supabase/admin.ts` imports `server-only`, is used only by the server service module, prefers `SUPABASE_SECRET_KEY`, and falls back to the legacy `SUPABASE_SERVICE_ROLE_KEY` for projects that have not moved to secret keys. The cookie-aware SSR client is never reused for spatial RPCs.
3. **Narrow SQL surface.** Two `SECURITY INVOKER` functions own the workspace binding and the column projection. `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated` and granted only to `service_role`; the demo read tables additionally grant `SELECT` to `service_role` only. No `SECURITY DEFINER` function exists, and no generic administrative RPC or table endpoint is exposed.
4. **Default-deny RLS is unchanged.** No policies were added for `anon`/`authenticated`, and no client grants were introduced. Phase 3 does not weaken the Phase 2 posture.
5. **Future authorization boundary.** When authentication arrives, `resolveWorkspaceContext()` should be replaced by a membership-driven resolver; spatial services, DTOs and API contracts are designed to stay unchanged behind that boundary.

## Type and privacy boundaries

1. **SQL persistence contract:** the ordered migrations define Postgres rows and constraints. `src/lib/database/database.types.ts` is generated from the clean, verified Supabase schema; `row-types.ts` aliases those generated rows instead of redeclaring columns. Raw geography stays opaque until parsed.
2. **Domain/UI types:** `src/lib/domain/coordinates.ts` validates `[longitude, latitude]` tuples at runtime; `src/lib/domain/map-location.ts` describes UI locations and keeps `TransientCandidate` (unsaved click state) separate from persisted `analysis_locations`.
3. **Display-safe DTOs:** viewport features are `BusinessMapFeature` (id, kind, category, name) or `CustomerMapFeature` (id, kind, category). The customer projection has no name column at all in SQL, and the DTO mapper rejects a customer row that carries a display name. Radius analysis returns aggregates only — never a customer row, and never per-customer revenue. Revenue crosses the API as an exact decimal **string** derived from PostgreSQL `numeric`, so no binary-float coercion happens at any hop.

A map click only updates React state; it still does **not** write to `analysis_locations`.

## Spatial model

The authoritative point representation remains one `extensions.geography(Point,4326)` column per spatial row, with a GiST index per table. Metric operations use meters; GeoJSON output is produced by casting to `extensions.geometry` and reading X/Y explicitly, so no duplicate latitude/longitude columns are introduced.

- Radius analysis uses `extensions.st_dwithin(column, candidate, radius_meters, true)` (spheroidal, meter-based) and `extensions.st_distance(..., true)` for exact distances.
- Viewport loading uses `extensions.st_intersects(column, envelope)` where the envelope is built by `extensions.st_makeenvelope(west, south, east, north, 4326)::extensions.geography`.
- `ST_Buffer` + `ST_Intersects` is deliberately **not** used for radius search; `ST_DWithin` expresses the predicate directly and is index-friendly.
- GiST usability is asserted in CI with predicate-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` probes (sequential scans disabled for the probe). At demo scale the planner may still prefer a workspace B-tree index and filter; that is documented rather than forced.
- Antimeridian-crossing viewports are rejected in this phase. Global antimeridian support is future work; the demo area is Tashkent.
- Server-side vector tile clustering (`ST_AsMVT`/PMTiles) is out of scope; MapLibre clustering over capped viewport data is the Phase 3 approach.

## Phase 5 data flow (import → commit → map)

```text
browser wizard (Import section)
  POST /imports                     → import_jobs row (uploaded)
  POST /imports/{id}/file           → private bucket {workspace}/{import}/source.ext
                                    → content sniffing → headers/sheets stored on the job
  POST /imports/{id}/mapping        → download under the caller's own session
                                    → map columns → validate rows → upsert import_rows (staged)
  POST /imports/{id}/geocode-batch  → claim_import_geocoding_rows (lease, ≤50)
                                    → GeocodingProvider (Mapbox v6 permanent | fake)
                                    → apply_import_geocoding_results (idempotent)
  POST /imports/{id}/rows/{row}/point → set_import_row_manual_point (manual_override)
  POST /imports/{id}/commit         → commit_import_job: one transaction, exact counts,
                                      provenance columns, idempotent when replayed
                                    → customers/locations → existing tenant viewport RPCs
```

Every step runs through the cookie-aware authenticated client, so RLS and the role checks are enforced by PostgreSQL, not by the route handlers. The map layer is untouched: committed customers and locations reach it through the same Phase 3/4 viewport DTOs, so the PII allow-list still decides what the map may see.

Import state is the staging tables plus the job row; there is no queue and no worker, so an interrupted geocoding run resumes from where it stopped rather than restarting or losing work.

## Phase 6 data flow (score a site, explain the score)

```
Locations panel (client)
  GET  projects                                    → membership-checked routes (project selector)
  GET  scoring-models / candidates / analyses      → membership-checked routes, project-scoped
  POST analyses | comparisons                      → validation (explicit, verified projectId)
                                                     → run_location_analysis
                                                     (metrics → normalization → weights → score;
                                                      candidates must belong to that project)
  GET  analyses/{id}                               → the stored payload, exactly as written

run_location_analysis (database, authoritative)
  per candidate: workspace_radius_analysis (PostGIS, ST_DWithin on geography)
                 → raw metrics (counts, exact numeric revenue, distributions, distances)
                 → per factor: normalized value (threshold | min_max | inverse_min_max)
                 → contribution = round(normalized × weight / 100, 2)
                 → final score  = clamp(Σ contributions, 0, 100), 2 decimals
  → location_analyses (snapshot: model revision, factors, radius, data_snapshot_at)
  → location_analysis_results (raw, normalized, contributions, rank)

Map
  candidate markers A–E in stored rank order; the radius ring stays visual only
```

Rules that make the flow explainable and reproducible:

- No scoring maths runs in JavaScript. The client renders raw → normalized → weight →
  contribution → total from the stored payload and re-checks that the contributions sum to the
  stored score before showing them.
- The payload is the only interface between the two halves: `src/lib/scoring/payload.ts` parses it
  strictly (`final_score` may never silently become 0) and the smoke test feeds a real HTTP response
  through that same parser.
- A model is a workspace-owned definition, not code. Editing it advances its revision and never
  recalcs a stored analysis; the freshness flag is advisory only.
- Saving a candidate is an explicit user action (`POST …/candidates`); a map click only selects a
  point, so no analysis is ever triggered implicitly.
- The project is explicit too: `GET /projects` (or the `projects` array inside the candidates
  response) feeds a selector, every candidate/analysis/comparison call carries a `projectId`, the
  server verifies it against the caller's memberships, and the interface clears every selection that
  belonged to the previous project when the selector changes. The URL (`?project=<uuid>`) is a deep
  link only — the server re-validates on every request.

## Phase 7 data flow (stored analysis → report → PDF)

```text
stored analysis (Phase 6, immutable)
   │  POST /reports                       owner/admin/analyst
   ▼
ReportSnapshot (deterministic projection, canonical JSON, SHA-256 stored)
   │  frozen by a database trigger; nothing recomputes a number
   │  POST /reports/{id}/generate
   ▼
ReportViewModel ──┬─► ReportPreview (HTML, React)         GET /reports/{id}
                  │
                  ├─► ReportMapProvider (Mapbox static | fake fixture) ─► map.png
                  │
                  └─► ReportDocument (@react-pdf/renderer, Node, no browser) ─► report.pdf
   ▼
private bucket analysis-reports/{workspace}/{project}/{report}/…
   ▼
GET /reports/{id}/download  (session + membership + RLS re-checked, no-store)
```

Design rules:

- **Two steps, two artifacts.** Creating a report freezes the snapshot; generating
  produces the PDF. Regeneration re-renders the *same* snapshot and verifies its
  hash first.
- **One view model.** The preview and the PDF both render `ReportViewModel`; no
  business number is derived twice, and neither path reads the database for a
  figure.
- **The PDF is rendered in-process** by a pure-JavaScript renderer. No headless
  browser, no Docker, no external service, no network call at render time (the
  only outbound call is the optional static-map request).
- **Failure is safe.** A provider or render failure marks the report `failed`,
  keeps the snapshot untouched and allows a retry; no partial or misleading
  artifact is presented as a report.
- **Project context is unchanged from Phase 6.5.** A report belongs to one
  project, never mixes two, and never resolves a project implicitly.

## Caching policy

Spatial results depend on live demo data, the viewport and the radius. Both route handlers are `dynamic = 'force-dynamic'`, `revalidate = 0`, and return `Cache-Control: no-store`; client fetches use `cache: 'no-store'`. Radius analysis is a `POST` and is never cached, so a result can never be served for a different coordinate or radius. No cache-invalidation system is introduced in this phase.

## Code organization

```text
src/
  app/                             App Router routes and styles
  app/api/demo/map/features/       Viewport feature endpoint
  app/api/demo/analysis/radius/    Radius analysis endpoint
  components/app/                  Top bar, layer control, analysis panel and state helpers
  components/map/                  MapLibre component, viewport loading and shared props
  lib/data/demo-locations.ts       Synthetic display-only fixtures (fixture mode)
  lib/domain/                      Runtime coordinate and domain types
  lib/database/                    Generated DB rows and server-side aliases
  lib/geo/                         Circle geometry helper and unit tests
  lib/map/                         PII-safe GeoJSON adapter and tests
  lib/spatial/                     DTOs, validation, service, client, fixtures adapter
  lib/imports/                     Limits, parsers, mapping, normalization, validation,
                                   geocoding (provider abstraction + batch runner),
                                   export, service (staging/commit), route guard, HTTP mapping
  lib/reports/                     Snapshot + hash, deterministic summary, view model,
                                   strict parser, validation, messages, service, route guard,
                                   HTTP mapping, map/ (provider, fake, Mapbox), pdf/
                                   (document, render, image rules), preview/ (HTML)
  lib/supabase/                    server.ts (anon SSR) and admin.ts (server-only elevated)
supabase/
  migrations/                      Ordered Phase 1-5 SQL migrations
  seed.sql                         Deterministic synthetic demo data (not a migration)
  tests/phase2_integrity.sql       Phase 2 catalog/integrity assertions (rollback-only)
  tests/phase3_spatial_queries.sql Phase 3 spatial/RPC/isolation assertions (rollback-only)
  tests/phase4_membership_rls.sql  Phase 4 membership/RLS/grant assertions (rollback-only)
  tests/phase5_import_rls.sql      Phase 5 import, storage, commit and grant assertions
  tests/phase5_geocoding.sql       Phase 5 geocoding batch/resume/idempotency assertions
  tests/phase6_scoring_engine.sql  Phase 6 scoring engine, snapshot and freshness assertions
  tests/phase6_scoring_rls.sql     Phase 6 scoring permissions and forgery assertions
  tests/phase7_reports_rls.sql     Phase 7 report permissions, lifecycle, immutability and
                                   storage-path assertions
```

## Future architecture checkpoints (not Phase 7 deliverables)

- Revisit server-side tiles/clustering only after measuring viewport volume at realistic data sizes.
- Portfolio/multi-analysis reporting only when a product definition exists; Phase 7 deliberately reports one stored analysis at a time.
- A job queue for very large reports only if a measured need appears; Phase 7 generation is synchronous and the UI says so.
- Retention automation (lifecycle rules on the import and report buckets) when an operator decides a policy; Phase 5 leaves source files and Phase 7 leaves report artifacts for the lifetime of their records.
- Streaming/resumable uploads and per-row editing only when a real need for files beyond 5 MB or 10 000 rows appears; the staging pipeline is already reusable for further target entities.
