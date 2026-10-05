# Atlas — Location Intelligence Platform

A modular Web GIS and location-intelligence workspace for commercial site selection, customer coverage and market analysis. The first pilot is Tashkent, Uzbekistan; the application architecture is city- and country-agnostic.

> **Phase 5 (CSV/XLSX import, validation and geocoding) is implemented; Phases 1-4 are frozen and the clean database gate is green in GitHub Actions.** The public synthetic demo (`/api/demo/*`) is unchanged: display-safe PostGIS viewport features and `ST_DWithin` radius aggregates for the fixed demo workspace, served with a server-only elevated credential. The tenant path is unchanged too: email/password sign-in, server-validated sessions, a protected `/workspaces/[workspaceId]` route whose membership and role are resolved in the database, and authenticated viewport/analytic endpoints that run under the caller's own RLS-aware session. Phase 5 adds a six-step import wizard (upload, columns, mapping, validation, geocoding, commit) on top of the same trust model: a private per-workspace storage bucket, staging tables (`import_jobs`, `import_rows`), owner/admin/analyst-only writes, provider-abstracted geocoding that is Mapbox-permanent-only in production and a deterministic fake in CI, and a transactional commit that promotes validated rows into `customers`/`locations` with provenance. Bad rows are never silently discarded. Local database execution is unavailable in this workspace; CI is the verified database environment.

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
- **Phase 6 scoring:** `GET/POST /api/workspaces/[workspaceId]/scoring-models`, `GET/PATCH …/scoring-models/[modelId]`, `GET/POST …/candidates`, `GET/POST …/analyses`, `GET …/analyses/[analysisId]` and `POST …/comparisons`. A workspace model defines factors (metric, weight, direction, normalization, configuration); every score is a stored weighted sum on a 0–100 scale that the interface explains as raw → normalized → weight → contribution → total, and every analysis snapshots the model revision, weights and metrics it was run with. Nothing is scored automatically and no score is ever presented as a probability, a confidence or a prediction.
- **Phase 5 imports:** `POST /api/workspaces/[workspaceId]/imports` and its `file`, `mapping`, `geocode-batch`, `commit`, `rows`, `rows/{rowId}/point` and `errors.csv` children. CSV/XLSX uploads are sniffed by content (never MIME), stored in the private `workspace-imports` bucket and staged; every row ends `valid`, `needs_geocoding` or `invalid` with a machine-readable code, and nothing reaches a production table until an explicit, transactional, idempotent commit.

## Phase 4 authentication, membership and RLS

- **Sign-in:** `/sign-in` posts email/password to `POST /api/auth/sign-in`, which validates the session server-side through Supabase Auth and sets httpOnly SSR cookies. `POST /api/auth/sign-out` clears them. `src/proxy.ts` refreshes the session cookie; it is not a security boundary.
- **Tenant routes require membership.** `/workspaces/[workspaceId]`, `GET /api/workspaces/[workspaceId]/map/features` and `POST /api/workspaces/[workspaceId]/analysis/radius` resolve the caller's membership from the database on every request. Editing the workspace id in the URL can never widen access: a foreign workspace and a non-existent one produce the identical `403` body, a non-member reaches only the safe no-access state, and anonymous callers get `Session expired. Please sign in again.`
- **Roles are enforced in PostgreSQL.** `workspace_members` maps users to workspaces as `owner`, `admin`, `analyst` or `viewer`. The migration defines a deliberate policy per table and an explicit grant matrix (never `USING (true)`), and the last-owner protection and membership-immutability triggers make privilege escalation impossible through SQL, PostgREST or the app.
- **The tenant GIS RPCs run as the caller** under the cookie-aware anon client (`SECURITY INVOKER` plus a membership assertion), so RLS stays an independent protection layer. The elevated credential is not used for tenant reads or writes.
- **The public demo path is unchanged and separate:** `/api/demo/*` still serves only the fixed synthetic `atlas-demo`/`tashkent-demo` workspace with the server-only elevated client. Signing in grants no tenant access to it, and the demo RPCs remain `service_role`-only.
- **First owner:** `public.bootstrap_workspace_owner(...)` (service_role-only, validated, idempotent) creates an organization, workspace and its first owner atomically for production; CI/dev uses deterministic seed identities instead. There is no signup funnel and no invitation email.

The policy-by-policy and grant-by-grant reference, the elevated-credential inventory and the security test strategy live in [docs/auth-security.md](docs/auth-security.md).

## Phase 5 imports (CSV/XLSX → validated data)

- **Flow:** upload → inspect columns → map → validate → accept supplied coordinates → geocode address-only rows → preview → commit into a workspace dataset → view on the map.
- **Formats and limits:** `.csv` and `.xlsx` only, 5 MB, 10 000 rows, 100 columns, one selected sheet. The file type is decided by content (extension and MIME are never trusted); exceeding a limit rejects the whole file — never a silent partial import.
- **Mapping:** multilingual suggestions (Uzbek Latin, Russian/Cyrillic, English) for name, phone, address, latitude/longitude, revenue, orders, segment and id; every column stays editable.
- **Validation:** decimal-safe money (`numeric(18,2)`, never float equality), text-preserving phone numbers, ISO/`d/m/yyyy` dates, finite in-range coordinates, deterministic `external_id` duplicate detection, and a `coordinate_swap_suspected` warning — coordinates are **never** swapped automatically.
- **Geocoding:** a `GeocodingProvider` abstraction; the only production provider is Mapbox Geocoding v6 with `permanent=true` (results must be storable). Confidence thresholds decide accepted / review / rejected, ambiguous candidates require a human decision, and manual placement (`manual_override`) is authoritative. Batches are bounded (≤ 50), resumable, lease-based and idempotent — no background worker. CI uses the deterministic fake provider, so no build needs a token.
- **Commit:** a new or explicitly selected dataset of the same workspace, in one transaction, reporting exact counts; duplicate `external_id` rows are marked invalid and stay staged; replaying the commit inserts nothing and re-pointing it at another dataset is refused.
- **Safety:** private storage bucket with membership-scoped policies (a path never authorizes by itself), no `service_role` anywhere in the tenant import path, safe error codes only, and a formula-injection-safe CSV export of failed rows.

Details: [docs/imports.md](docs/imports.md) and [docs/geocoding.md](docs/geocoding.md).

## Phase 6 location scoring (configurable and explainable)

- **No hard-coded business truth.** A `scoring_models` row owns up to twelve `scoring_model_factors`; each factor names a measured metric, an integer/2-decimal weight, a direction (`positive`, `negative`, `neutral`), a normalization method (`threshold`, `min_max`, `inverse_min_max`) and a configuration. Enabled weights must total exactly 100 — enforced by a deferred database constraint, checked again on every server request and in the editor.
- **Server-authoritative metrics.** Raw metrics come from the PostGIS radius RPC (`customers_count`, exact `customers_revenue_total`, `competitors_count`, `branches_count`, `locations_count`, nearest branch distance, category distribution and documented derived densities). Normalization, rounding and the final `clamp(Σ contribution, 0, 100)` happen inside `public.run_location_analysis`; no scoring maths runs in JavaScript.
- **Explainable by construction.** Each stored contribution is `round(normalized × weight / 100, 2)`, and the stored score is their sum. The panel shows the raw value, the normalized value, the weight, the contribution and a sentence naming the method, and the sum is re-checked against the stored score before it is shown. Qualitative bands (80+ Strong, 60–79 Good, 40–59 Moderate, <40 Weak) are documented as UI wording only.
- **Reproducible snapshots.** `location_analyses` records workspace, project, candidate count, radius, model id, model **revision**, the model snapshot and the moment of the run; `location_analysis_results` records each candidate's raw metrics, normalized values, contributions and final score. Editing a model never recalculates a stored analysis, and a dataset-freshness flag (`may_be_outdated`) only warns — it never rewrites a score.
- **Comparison.** Two to five saved candidates (hard cap 5, enforced by validation and by the RPC) are scored with one shared radius; the map labels them A–E in stored rank order, the table is sortable by overall score, customer potential, competition or revenue, and an optional CSV export copies exactly the stored numbers.
- **Permissions.** Any member reads models, saved candidates and stored analyses; owner/admin/analyst run analyses, run comparisons and save candidates; only owner/admin create or edit models. RLS is enabled on all four Phase 6 tables with per-table policies and explicit grants, and every RPC re-asserts membership. No `service_role` is used anywhere in the scoring path.

Details: [docs/scoring.md](docs/scoring.md).

## Phase 2 database foundation (unchanged)

The ordered migrations add:

1. `organizations → workspaces → projects/datasets` ownership and a same-workspace many-to-many `project_datasets` relation.
2. `locations`, `customers`, `competitors`, `branches` and project-scoped `analysis_locations` point records.
3. Composite foreign keys that prevent cross-workspace references at the database layer, conservative deletion behavior, constraints, timestamp triggers and workspace-oriented indexes.
4. One authoritative `extensions.geography(Point,4326)` column per spatial record and a GiST index for each.
5. RLS enabled on every tenant table, plus revocation of `PUBLIC`, `anon` and `authenticated` table privileges (default-deny until membership policies were designed). Phase 4 then adds deliberate member-scoped policies and the matching grants.

`analysis_locations` represents deliberately saved candidates. A map click remains transient client state and is not inserted into the database.

## Public demo workspace and its security boundary (Phase 3, unchanged in Phase 4)

- The only live path that does **not** require a session is the synthetic workspace `atlas-demo` / `tashkent-demo`, resolved **server-side** from deterministic slugs in `src/lib/spatial/demo-workspace.ts`. The browser cannot choose a workspace UUID.
- The elevated credential is read in `src/lib/supabase/admin.ts`, a `server-only` module that prefers Supabase's secret key (`SUPABASE_SECRET_KEY`) and falls back to the legacy service-role key (`SUPABASE_SERVICE_ROLE_KEY`). It is never imported into a Client Component, never prefixed with `NEXT_PUBLIC_`, never logged and never returned in an error response.
- Spatial work runs through two narrowly scoped, independently testable SQL functions with `SECURITY INVOKER`: `public.demo_viewport_features(...)` and `public.demo_radius_analysis(...)`. `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated` and granted only to `service_role`.
- The `service_role` credential bypasses RLS by design; because it never reaches the browser and the RPCs bind themselves to the demo workspace, the demo cannot read another tenant's workspace through the API.
- Phase 4 keeps this path exactly as it was: still public, still fixed to the synthetic workspace, still the only elevated-credential read path. Being signed in changes nothing about it, and the tenant routes still require membership of their workspace — including for the demo workspace, whose tenant URL is `/workspaces/<id>` and not the demo API.

## Database verification gate

`.github/workflows/database-integrity.yml` is the release gate and it is the only environment that verifies the whole stack:

- it starts the full local Supabase stack (`supabase start` minus studio/mail/realtime/storage/analytics), replays every migration from zero and loads `supabase/seed.sql`;
- it runs the live Phase 2 catalog/integrity, Phase 3 spatial/index, Phase 4 membership/RLS/grant, Phase 5 import/storage and **Phase 6 scoring engine and scoring RLS** assertions with fail-fast `psql` (PostgreSQL 17.11, PostGIS 3.3.7 in CI);
- it regenerates `src/lib/database/database.types.ts` and fails on drift;
- it runs `npm test`, lint, typecheck and the production build;
- it runs four end-to-end smokes against the shipped production build: the fixtures smoke, the authenticated smoke (sign-in, protected page, selector, tenant GIS, workspace-id tampering, cross-workspace denial, the still-public demo endpoint, sign-out), the import smoke (wizard client → API → storage → staging → commit → map visibility) and the **scoring smoke** (models, saved candidates, a single analysis, a comparison, the stored read, snapshot survival across a model edit and every refusal path, with each response parsed by the shipped client parser).

Local SQL work is additionally verified before pushing with a PGlite + PostGIS harness that replays the migrations and runs the same suites, and the app-level gates (`npm test`, `npm run lint`, `npm run typecheck`, `npm run build`) run anywhere. Docker, `psql` and a local Supabase stack are still unavailable in the authoring sandbox, so the smokes and the live catalog assertions are only authoritative in CI.

**A green TypeScript build alone does not validate SQL.** See [docs/setup.md](docs/setup.md).

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
    api/demo/          Public demo viewport + radius route handlers
    api/auth/          Minimal sign-in and sign-out route handlers
    api/workspaces/    Authenticated tenant viewport, radius, import and dataset route handlers
    sign-in/           Sign-in page
    workspaces/        Workspace selector and the protected workspace page
  components/
    app/               Shell, search, layer control and PostGIS-backed analysis panel
    map/               Client-only MapLibre implementation, viewport loading and shared props
  lib/
    auth/              Safe messages, server session helpers, membership resolver, unit tests
    data/              Synthetic Tashkent fixtures (display-only fallback)
    domain/            Validated coordinates and domain types
    database/          Generated Supabase types and server-side row aliases
    imports/           Parsers, mapping, normalization, validation, geocoding, service, HTTP mapping
    geo/               Visual circle geometry and tests
    map/               PII-safe GeoJSON adapter and tests
    spatial/           DTOs, validation, client fetchers, demo resolver, tenant service
    supabase/          server.ts (cookie-aware anon) and admin.ts (server-only elevated)
  proxy.ts             Supabase session refresh (Next 16 proxy convention)
supabase/
  config.toml
  migrations/          Ordered Phase 1-5 SQL migrations
  seed.sql             Deterministic synthetic demo, isolation workspace and local auth users
  tests/               Rollback-only Phase 2/3/4/5 database assertions
docs/
  architecture.md
  auth-security.md
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

Open [http://localhost:3000](http://localhost:3000) for the public demo map, or [http://localhost:3000/workspaces](http://localhost:3000/workspaces) for the authenticated area (it redirects anonymous visitors to `/sign-in`). The map style and tiles are served by the configured external map provider; an internet connection is needed to load them. Database-backed mode additionally needs the server-side Supabase values and a seeded local project (see [docs/setup.md](docs/setup.md)); the seeded local identities sign in with the password `phase4-demo-password`. Without a database, set `DATA_SOURCE=fixtures` for a display-only preview; radius analysis stays disabled.

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
npm run smoke:fixtures   # needs no database
npm run smoke:auth       # needs a running, seeded local Supabase and its credentials
npm run smoke:imports    # needs the same; geocoding runs on the deterministic fake provider
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
| `GEOCODING_PROVIDER` | No | `mapbox` (default) or `fake`. CI and the import smoke use `fake`; there is no Google default. |
| `MAPBOX_ACCESS_TOKEN` | Yes to geocode | Server-only Mapbox token used with `permanent=true`. Missing token → geocoding reports `503 geocoding_unavailable`. |
| `GEOCODING_COUNTRY_CODE` / `GEOCODING_COUNTRY_NAME` | No | Country filter/bias for the provider (e.g. `uz`); the Tashkent bias is configuration, not code. |
| `GEOCODING_PROXIMITY` / `GEOCODING_LANGUAGE` | No | `longitude,latitude` proximity bias and IETF language for returned addresses. |
| `GEOCODING_ACCEPT_THRESHOLD` / `GEOCODING_REVIEW_THRESHOLD` / `GEOCODING_AMBIGUITY_DELTA` | No | Confidence policy (defaults `0.85` / `0.45` / `0.1`). |

Never use `NEXT_PUBLIC_*` for an elevated key, never import `src/lib/supabase/admin.ts` from a Client Component, and never log either key. `SUPABASE_ANON_KEY` is required for sign-in and the authenticated routes; the elevated key is used only by the public demo path, the operator bootstrap and CI setup. RLS is enabled everywhere with member-scoped policies: a policy never replaces a `GRANT`, and both layers are asserted in CI.

## Roadmap

1. **Phase 1 — foundation (implemented):** Next.js, Tailwind, MapLibre shell, synthetic Tashkent fixtures.
2. **Phase 2 / 2.5 — ownership/spatial schema and clean database gate (implemented):** workspace-safe tables, PostGIS geography, constraints/indexes, default-deny RLS, generated types, CI verification.
3. **Phase 3 — DB-backed demo map and radius analysis (implemented):** server-side viewport features, PostGIS `ST_DWithin` radius aggregates, safe DTOs, demo-workspace boundary, server-only elevated credential.
4. **Phase 4 — authentication and membership (implemented):** Supabase Auth email/password sign-in, `workspace_members` roles, deliberate per-table RLS policies with explicit grants, membership-checked tenant GIS RPCs, a protected workspace route and a minimal selector. The fixed demo path is unchanged.
5. **Phase 5 — data operations (implemented):** CSV/XLSX imports with column mapping, per-row validation, provenance, private storage, provider-abstracted geocoding (Mapbox permanent results, fake provider in CI), manual placement, transactional commit and a safe error export.
6. **Phase 6 — intelligence (implemented):** configurable, explainable location scoring with versioned model snapshots, saved candidate sites and a 2–5 site comparison.
7. **Phase 7 — reporting, tiles and optimization (not started):** vector tiles/`ST_AsMVT` at larger scale, exports and performance work.

## Documentation

- [Architecture and phase boundaries](docs/architecture.md)
- [Authentication, membership and RLS](docs/auth-security.md)
- [Database schema, functions and RLS](docs/database.md)
- [GIS concepts and spatial decisions](docs/gis-concepts.md)
- [Local development and Supabase setup](docs/setup.md)
- [Deployment checklist and security gates](docs/deployment.md)
- [Imports: formats, limits, geocoding and commit](docs/imports.md)
- [Geocoding providers, Mapbox v6 and confidence policy](docs/geocoding.md)
- [Location scoring: factors, normalization, snapshots and permissions](docs/scoring.md)
