# Development and database verification setup

## Prerequisites

- Node.js 22 and npm (the app requires Node `>=20.19.0`).
- Docker Desktop/Engine with a running daemon.
- `psql` client.
- The Supabase CLI is pinned in `package.json` and `package-lock.json` as `2.119.0`; no global CLI installation is required. CI uses the official `supabase/setup-cli` action pinned to v3.0.1, which reads the exact package-lock version.

## Install and run the demo

```bash
npm ci
npm run dev
```

The default data mode is `database`: the map requests display-safe features from `/api/demo/map/features` and the analysis panel queries `/api/demo/analysis/radius`. That requires a seeded local Supabase/PostGIS project plus server-side credentials:

```bash
# .env.local
DATA_SOURCE=database
NEXT_PUBLIC_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/positron
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SECRET_KEY=<local service/secret key from `supabase status --output env`>
```

The elevated key is read only by `src/lib/supabase/admin.ts` (`server-only`) and is never sent to the browser. For a display-only preview without any database, set `DATA_SOURCE=fixtures`: the map then shows the deterministic synthetic fixtures and the analysis panel reports that analysis is disabled. Radius analysis **never** uses fixtures. There is no automatic fallback from a failing database request to fixture data — a database failure stays visible during development.

## Reproducible database verification

The verification script is `scripts/verify-database.sh`, exposed as `npm run verify:database`. It runs fail-fast and reports the stage on failure. It:

1. Checks that the project-locked Supabase CLI, Docker daemon and `psql` are available.
2. Starts the full local Supabase stack through `supabase start -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit` — PostgreSQL plus the Auth and REST services behind Kong. The full stack (not just the database container) is required because the authenticated smoke signs in through GoTrue and queries through PostgREST with real JWT claims. Studio, mail, realtime, storage and analytics containers are excluded to keep the gate fast.
3. Runs `supabase db reset --local`, which destroys/recreates the local database, replays **every repository migration from zero** and loads `supabase/seed.sql` (synthetic demo + isolation workspace). It does not skip or rewrite failing SQL.
4. Runs `supabase/tests/phase2_integrity.sql` with `psql -X -v ON_ERROR_STOP=1`. The test prints actual PostgreSQL/PostGIS versions and verifies extension schema/version, required PostGIS functions, all ten tables, geography typmods/SRID, actual GiST index definitions, ownership constraints, deletion behavior, RLS/no policies, `PUBLIC`/client grants, and a rollback-only Tashkent distance sanity check.
5. Runs `supabase/tests/phase3_spatial_queries.sql`. This asserts the seeded demo workspace is present, viewport/radius/nearest-branch/category/aggregate behavior at 500 m, 1 km, 3 km and 5 km, empty-radius behavior, request validation, `SECURITY INVOKER` + `service_role`-only execution, cross-workspace isolation (the colocated `isolation-test` rows must never appear), and GiST usability for the `ST_DWithin`/`ST_Intersects` predicates via predicate-only `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` probes.
6. Runs `supabase/tests/phase4_membership_rls.sql`. This suite connects as the real `anon`, `authenticated` and `service_role` roles and sets `request.jwt.claims`, so the policies exercised are exactly the ones PostgREST applies: helper disclosure, the per-role PASS/FAIL matrix, cross-workspace reads/writes and row moves, workspace-id tampering on the tenant RPCs, membership tampering (self-promotion, admin → owner, final-owner removal), workspace identity immutability, the grant matrix, and demo/tenant parity including PII checks.
7. Generates `src/lib/database/database.types.ts` using the local schema, atomically replacing the generated file only after the CLI succeeds.

**Warning:** `supabase db reset --local` is destructive to the local Supabase database. The SQL integrity script's own synthetic fixtures run inside a transaction and are rolled back. Do not point these commands at a production database.

Run the whole database and application gate locally with:

```bash
npm run verify
```

`npm run verify` runs `npm run verify:database`, then `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run smoke:fixtures`. The authenticated end-to-end smoke (`npm run smoke:auth`) is a separate command because it needs a running, seeded local Supabase stack plus credentials in the environment; CI runs it after the fixtures smoke. A green TypeScript build alone does **not** prove that SQL migrations or PostGIS behavior work.

For an individual database run, derive the local connection string from the CLI rather than hardcoding credentials:

```bash
supabase start -x realtime,storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit
supabase db reset --local
SUPABASE_DB_URL="$(supabase status --output env | awk -F= '$1 == "DB_URL" { sub(/^[^=]*=/, ""); gsub(/\"/, ""); print; exit }')"
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase2_integrity.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase3_spatial_queries.sql
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase4_membership_rls.sql
supabase gen types --lang typescript --local --schema public > src/lib/database/database.types.ts
```

The third line uses the CLI's current env output (`supabase status --output env`) and its `DB_URL` key. The package script is preferred because it checks the locked CLI version, fails with a stage label and safely handles generated-file replacement.

## GitHub Actions gate

`.github/workflows/database-integrity.yml` runs on every branch push, pull request and manual `workflow_dispatch`:

- Uses a fresh `ubuntu-24.04` runner with Docker; it does not restore or cache database volumes.
- Caches npm packages only and installs Supabase CLI through the official `supabase/setup-cli` action, using the exact `supabase@2.119.0` lockfile entry.
- Starts Postgres, resets from zero, loads the synthetic seed, runs the live Phase 2 catalog/integrity assertions and the Phase 3 spatial/isolation/index-plan assertions, then generates database types.
- Requires the generated types to be committed and byte-for-byte current with the freshly migrated schema; uploads the verified type file as a short-lived artifact for review.
- Runs application tests, lint, typecheck and production build as separate visible steps.

A migration, PostGIS assertion, constraint/RLS assertion, type generation/drift check, or application step failure makes the workflow fail. The verification script labels the failing stage, writes the final 250 lines to the GitHub step summary, and uploads the full database verification log when available. npm dependencies may be cached; PostgreSQL/Docker state may not.

## Migration order and spatial preflight

```text
supabase/migrations/20261004000000_enable_postgis.sql
supabase/migrations/20261004010000_phase2_ownership_schema.sql
supabase/migrations/20261004020000_phase2_spatial_entities.sql
supabase/migrations/20261004030000_phase3_demo_spatial_queries.sql
supabase/migrations/20261004040000_phase4_auth_membership.sql
```

The Phase 4 migration assumes Supabase Auth's `auth.users` table exists; it fails
loudly rather than silently skipping membership functionality.

The Phase 2 preflight expects PostGIS in schema `extensions`, `extensions.geography`, geography `ST_DWithin`, and `pg_catalog.gen_random_uuid()`. `supabase/config.toml` targets PostgreSQL 17. The integrity test requires the PostgreSQL major declared in `supabase/config.toml` (17) and PostGIS library version >=3.3.0, and logs the actual extension/library versions. CI never overrides that major; a supplementary local harness may state `bli.expected_postgres_major` explicitly so it can run the same assertions on a different supported major, and PostgreSQL 18 reports `ON DELETE RESTRICT` refusals as SQLSTATE 23001 where 17 reported 23503, which the ownership assertions accept by constraint name. An extension already installed in another schema is not moved by `CREATE EXTENSION IF NOT EXISTS`; the migration must fail until that state is deliberately resolved. Keep PostGIS types/functions schema-qualified.

## Generated database types and boundaries

The database verification script generates `src/lib/database/database.types.ts` from the just-reset local Postgres schema using the pinned Supabase CLI. **Do not hand-edit this generated file.** If it changes after `npm run verify:database`, review the migration that caused the change and commit the regenerated output; CI fails on uncommitted or stale generated types.

Generated Supabase row types are persistence-only. `row-types.ts` now aliases generated `Row` types and does not redeclare database columns. The CLI emits PostGIS geography as `unknown` and PostgreSQL `numeric` as `number`; `RawGeographyValue` and `RawNumericValue` are derived aliases, not edited fields. A future precision-sensitive mapper must use a decimal-safe representation rather than assume JavaScript numbers are exact. The generator does not infer SQL `CHECK` constraints into literal unions or object-only JSON types. Map code receives validated domain values and the PII-allow-listed GeoJSON DTO, never raw database rows. Keep customer name, phone, address and revenue out of generic map source properties. The SQL migrations remain canonical; the generated file must come from an applied and verified schema, not a hand-authored approximation.

## Current local verification status

The project CLI is installed and reports `2.119.0`, but Docker and `psql` are unavailable in this workspace, so local database startup, migration replay and catalog assertions have not run here. GitHub Actions is the authoritative live PostgreSQL/PostGIS verification path; inspect the latest run for migration, SQL assertion, type-drift and application-check results. Runtime observations from CI have reported PostgreSQL `17.11` and PostGIS extension/library `3.3.7`; use versions printed by an actual run rather than researched or expected values.

## Demo data and the workspace boundary

`supabase/seed.sql` (configured under `[db.seed]` in `supabase/config.toml`) is deterministic synthetic data: one organization (`atlas-demo`), the demo workspace (`tashkent-demo`) with four datasets, roughly 40 locations, 24 competitors, 8 branch rows, 240 customer rows around Tashkent, and a colocated `isolation-test` workspace used to prove cross-workspace isolation. Customer rows intentionally carry no name, phone, company or address values. It is development/CI seed data, not a migration and not production data.

`resolveWorkspaceContext()` resolves `atlas-demo`/`tashkent-demo` server-side. The browser never supplies a workspace identifier and the routes reject unknown fields such as `workspaceId`. When authentication and membership arrive, only this resolver changes; the spatial services, DTOs and API contracts stay as they are.

Both API routes are `force-dynamic` with `revalidate = 0` and return `Cache-Control: no-store`; radius analysis is a `POST` and is never cached across coordinates or radii.

## Application checks

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run smoke:fixtures
```

`npm test` covers domain, DTO, parser, validation and server-boundary units. `npm run smoke:fixtures` builds nothing itself; run it after `npm run build`, and it will start the production server with `DATA_SOURCE=fixtures` on a spare port (override with `SMOKE_PORT`), drive the shipped browser client against the shipped route handlers, and stop the server again. It needs no database or credentials, and it exists because database mode and fixtures mode can each pass their own tests while disagreeing with each other.

These application checks complement—not replace—the clean database verification gate.

## Signing in against a local stack

Phase 4 adds a minimal email/password sign-in flow. After `supabase start` and
`supabase db reset --local`, `supabase/seed.sql` has created deterministic
local identities (password `phase4-demo-password`):

| Email | Role |
| --- | --- |
| `owner-a@example.test` | owner of `tashkent-demo` |
| `admin-a@example.test` | admin of `tashkent-demo` |
| `analyst-a@example.test` | analyst of `tashkent-demo` |
| `viewer-a@example.test` | viewer of `tashkent-demo` |
| `owner-b@example.test` | owner of `isolation-test` (workspace B) |
| `outsider@example.test` | no membership (safe no-access state) |
| `operator@example.test` | no membership; used by the bootstrap test |

Then run the app in database mode and open
`http://localhost:3000/workspaces/<workspace-id>`. Anonymous visitors are
redirected to `/sign-in`; a signed-in user without membership in the requested
workspace gets the safe no-access state, and the selector lists only the
workspaces the database says they belong to. These identities are synthetic
**local/CI only** and must never be seeded into a deployed project.

The authenticated end-to-end smoke drives exactly that flow through the shipped
routes:

```bash
npm run build
export $(supabase status --output env | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY|SECRET_KEY|PUBLISHABLE_KEY)=' | xargs)  # or set the values yourself
export SUPABASE_URL="${API_URL:-$SUPABASE_URL}" SUPABASE_ANON_KEY="${ANON_KEY:-$PUBLISHABLE_KEY}" SUPABASE_SECRET_KEY="${SERVICE_ROLE_KEY:-$SECRET_KEY}"
npm run smoke:auth
```

It signs in (and deliberately fails a wrong password), checks the selector, the
protected page, both tenant GIS endpoints, workspace-id tampering (foreign and
missing workspaces must be indistinguishable), cross-workspace denial, the still
public demo endpoint, and that sign-out invalidates the session server-side. It
needs `SUPABASE_URL`, `SUPABASE_ANON_KEY` and an elevated key
(`SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`) for the public demo route,
and it starts the production server on `SMOKE_PORT` (default 3312).
