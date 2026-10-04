# Deployment and security notes

## Phase 3 deployment gate

Phase 3 adds the first live database path. Before deploying it:

1. Ensure the clean-reset workflow is green **including** `supabase/tests/phase3_spatial_queries.sql` and the generated-type drift check.
2. Apply `20261004030000_phase3_demo_spatial_queries.sql` in timestamp order.
3. Provision the synthetic demo workspace (`atlas-demo` / `tashkent-demo`). In a deployed environment this is created by an explicit, reviewed data-loading step; `supabase/seed.sql` is development/CI data and must not be run against production customer data.
4. Set `SUPABASE_SECRET_KEY` (preferred) or the legacy `SUPABASE_SERVICE_ROLE_KEY` as a **server-only** environment variable, never a `NEXT_PUBLIC_*` variable. `src/lib/supabase/admin.ts` imports `server-only`, so a client import fails the build instead of leaking the credential.
5. Keep `DATA_SOURCE=database`. The `fixtures` mode is a display-only development fallback and refuses analysis.

Phase 3 does not add login, membership, invitations, roles or user-scoped workspace selection. **The demo API is not a multi-tenant data API:** it is deliberately hard-wired to one synthetic workspace until authenticated membership exists.

## Phase 2 deployment gate

Do not deploy these migrations to a production database until the dedicated clean-reset workflow has passed and a reviewer has inspected its PostgreSQL/PostGIS version, catalog assertions and generated types. The project-local Supabase CLI is pinned to `2.119.0`; Docker and `psql` are unavailable in this workspace, so local database behavior is **NOT VERIFIED LOCALLY**. See [setup.md](setup.md) for exact local commands and CI behavior.

Deploy in timestamp order and verify the PostGIS extension schema before applying Phase 2. The migrations require PostGIS in `extensions`, `extensions.geography`, geography `ST_DWithin`, and `pg_catalog.gen_random_uuid()`. They fail explicitly if assumptions are not met. An extension already installed in another schema is not moved automatically by `CREATE EXTENSION IF NOT EXISTS`; investigate before proceeding.

The `supabase/tests/phase2_integrity.sql` and `supabase/tests/phase3_spatial_queries.sql` scripts use transactions and roll their fixtures back. They are verification scripts, not seeds or production data migrations. `supabase/seed.sql` is synthetic development/CI demo data and must not be applied to a production database containing real customer data.

### Server credential handling

- The elevated key exists only in the server runtime environment and is read in one place (`src/lib/supabase/admin.ts`).
- It is never logged, never embedded in an error response, and never sent to the browser. Client-facing errors are structured as `{ error: { code, message } }` with codes limited to `invalid_request`, `demo_workspace_missing`, `database_unavailable`, `database_required` and `internal_error`; SQL text, stack traces and credentials are excluded.
- The API uses a stateless `@supabase/supabase-js` client with session persistence disabled; it never reuses the cookie-aware SSR client, so no user session could be inherited.

### Cache policy

Both spatial endpoints are dynamic (`force-dynamic`, `revalidate = 0`) and return `Cache-Control: no-store`. Radius analysis is a `POST` and is never cached, so a result cannot be served for a different coordinate or radius. Client fetches also use `cache: 'no-store'`. No CDN or Next.js data-cache layer sits in front of these responses in this phase.

## CI and local verification

`.github/workflows/database-integrity.yml` runs for every branch push, pull request and manual dispatch on a fresh `ubuntu-24.04` runner with Docker. It installs the pinned Supabase CLI from the project lockfile, starts the local Postgres container, resets the database with every migration from zero, executes the SQL assertions with fail-fast `psql`, generates and checks the committed database types, then runs application tests, lint, typecheck and production build. It caches npm dependencies only—not the database or Docker volume.

For a local clean run, install dependencies, ensure Docker and `psql` are available, then run `npm run verify` from the repository root. **This resets/destroys the local Supabase database.** The database-only command is `npm run verify:database`; it generates `src/lib/database/database.types.ts` from the verified local schema. `row-types.ts` only aliases generated rows; keep generated rows persistence-only and map them through validated domain types before DTO construction. Never point the command at production. A passing TypeScript build alone is not evidence that SQL migrations work.

## RLS is default-deny

RLS is enabled for `organizations`, `workspaces`, `projects`, `datasets`, `project_datasets`, `locations`, `customers`, `competitors`, `branches` and `analysis_locations`. Phase 2 creates **no RLS policies** and revokes table privileges from `PUBLIC`, `anon` and `authenticated`. This is intentional: these tables are not yet an authenticated user-facing data API.

Do not add a permissive placeholder policy (`USING (true)`) to make the demo work. Phase 1 continues to use client-side synthetic fixtures and does not need database policies. Later authentication work must define workspace membership and role semantics and implement **both** narrowly scoped SQL `GRANT`s and membership-aware RLS policies. A policy cannot override the table privilege `REVOKE`; adding policies without the required grants still denies access. Verify both layers under `anon`, `authenticated` and server-side roles.

The Supabase service-role/secret key bypasses RLS and must remain server-side. Never expose it in `NEXT_PUBLIC_*`, browser bundles, client components, HTML, logs or map feature properties.

Phase 3 uses that elevated credential for exactly two `SECURITY INVOKER` RPCs whose `EXECUTE` is revoked from `PUBLIC`/`anon`/`authenticated` and granted only to `service_role`. The functions bind themselves to the demo workspace, so even the elevated path cannot be pointed at another tenant's workspace through the API. `service_role` additionally receives `SELECT` on the six tables those functions read. No table-level API is exposed, no `SECURITY DEFINER` function exists, and `anon`/`authenticated` gained no privileges or policies.

## Tenant and data protection

Workspace ownership is checked by composite database FKs, not by an application-only convention. Keep workspace IDs in future queries and derive/authorize them from the authenticated request rather than trusting client-supplied identifiers. Organization/workspace/project/dataset deletion is restricted around business data; only `project_datasets` association rows cascade when a parent project/dataset is deleted.

Customer names, phone numbers, addresses and revenue are sensitive. Use explicit column selection and server-only row-to-domain adapters.

- The viewport RPC's customer branch projects `NULL` for the display name and returns only id, kind, category and coordinates.
- `src/lib/spatial/dto.ts` and `src/lib/spatial/response.ts` independently reject a customer feature that carries a name or any unexpected property.
- `src/lib/map/map-feature-adapter.ts` still allow-lists only `id`, `kind`, `category` and validated coordinates for selection overlays.
- Radius analysis returns aggregates only; per-customer revenue and customer rows never leave the database. Customer revenue crosses the API as an exactly-formatted decimal string derived from PostgreSQL `numeric`, avoiding binary-float coercion.
- Business, competitor and branch features may carry an explicitly modelled display name; keep that allow-list explicit and never reuse it for customers.

Do not extend the customer map DTO with PII and never pass raw database rows to MapLibre.

Current fixtures are synthetic and no external data feeds are loaded. Before any real customer import, define lawful purpose, consent/legal basis, retention/deletion, data provenance, access roles, backup handling and audit requirements. Those policies are not inferred or implemented by this schema.

## Migration and operational practice

- Use reviewed forward-only SQL migrations; back up production before schema changes.
- Test a clean reset and upgrades from a representative prior migration state in staging.
- Inspect `pg_extension.extnamespace` and PostGIS availability rather than relying on an environment's `search_path`.
- Monitor migration duration/locks on production-size data; Phase 2 creates empty tables/indexes but future indexes on populated tables may need concurrent/index rollout planning.
- Validate actual query plans and GiST selectivity with realistic, privacy-safe data before promising latency.
- Keep SQL test fixtures synthetic and transactionally rolled back.
- Re-run the Phase 3 isolation assertions after any change to the demo RPCs, the seed data or the workspace resolver: they are the proof that demo queries cannot read another workspace.
- Confirm the spatial index probes still show GiST participation after query-shape changes; do not infer index health from DDL alone.

## Authentication and policy readiness

Phase 3 is still not a launch-ready tenant-facing data service. The API is bound to a single synthetic workspace and must not be repurposed for arbitrary workspaces before authorization exists. Before generalizing it:

1. Add workspace membership and role model, then replace the fixed `resolveWorkspaceContext()` with a membership-driven resolver (the spatial services, DTOs and API contracts are designed to stay unchanged).
2. Decide organization/workspace-level administrator semantics.
3. Implement minimal `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants and policy predicates tied to the verified auth identity.
4. Test that each role can access only its workspace and cannot infer another workspace through joins, associations, RPCs or storage.
5. Generate and review Supabase TypeScript database types only after the local schema has been applied and inspected.
6. Map raw database rows through validated domain types before any display/map DTO is constructed.
7. Test that one workspace cannot observe another through the spatial RPCs, viewport queries, aggregates or nearest-branch results.
