# Deployment and security notes

## Phase 2 deployment gate

Do not deploy these migrations to a production database until the dedicated clean-reset workflow has passed and a reviewer has inspected its PostgreSQL/PostGIS version, catalog assertions and generated types. The project-local Supabase CLI is pinned to `2.119.0`; Docker and `psql` are unavailable in this workspace, so local database behavior is **NOT VERIFIED LOCALLY**. See [setup.md](setup.md) for exact local commands and CI behavior.

Deploy in timestamp order and verify the PostGIS extension schema before applying Phase 2. The migrations require PostGIS in `extensions`, `extensions.geography`, geography `ST_DWithin`, and `pg_catalog.gen_random_uuid()`. They fail explicitly if assumptions are not met. An extension already installed in another schema is not moved automatically by `CREATE EXTENSION IF NOT EXISTS`; investigate before proceeding.

The `supabase/tests/phase2_integrity.sql` script uses a transaction and rolls its synthetic fixtures back. It is a verification script, not a seed or production data migration.

## CI and local verification

`.github/workflows/database-integrity.yml` runs for every branch push, pull request and manual dispatch on a fresh `ubuntu-24.04` runner with Docker. It installs the pinned Supabase CLI from the project lockfile, starts the local Postgres container, resets the database with every migration from zero, executes the SQL assertions with fail-fast `psql`, generates and checks the committed database types, then runs application tests, lint, typecheck and production build. It caches npm dependencies only—not the database or Docker volume.

For a local clean run, install dependencies, ensure Docker and `psql` are available, then run `npm run verify` from the repository root. **This resets/destroys the local Supabase database.** The database-only command is `npm run verify:database`; it generates `src/lib/database/database.types.ts` from the verified local schema. `row-types.ts` only aliases generated rows; keep generated rows persistence-only and map them through validated domain types before DTO construction. Never point the command at production. A passing TypeScript build alone is not evidence that SQL migrations work.

## RLS is default-deny

RLS is enabled for `organizations`, `workspaces`, `projects`, `datasets`, `project_datasets`, `locations`, `customers`, `competitors`, `branches` and `analysis_locations`. Phase 2 creates **no RLS policies** and revokes table privileges from `PUBLIC`, `anon` and `authenticated`. This is intentional: these tables are not yet an authenticated user-facing data API.

Do not add a permissive placeholder policy (`USING (true)`) to make the demo work. Phase 1 continues to use client-side synthetic fixtures and does not need database policies. Later authentication work must define workspace membership and role semantics and implement **both** narrowly scoped SQL `GRANT`s and membership-aware RLS policies. A policy cannot override the table privilege `REVOKE`; adding policies without the required grants still denies access. Verify both layers under `anon`, `authenticated` and server-side roles.

The Supabase service-role key bypasses RLS and must remain server-side. Never expose it in `NEXT_PUBLIC_*`, browser bundles, client components, HTML, logs or map feature properties. No live database reads/writes have been added in Phase 2.

## Tenant and data protection

Workspace ownership is checked by composite database FKs, not by an application-only convention. Keep workspace IDs in future queries and derive/authorize them from the authenticated request rather than trusting client-supplied identifiers. Organization/workspace/project/dataset deletion is restricted around business data; only `project_datasets` association rows cascade when a parent project/dataset is deleted.

Customer names, phone numbers, addresses and revenue are sensitive. Use explicit column selection and server-only row-to-domain adapters. `src/lib/map/map-feature-adapter.ts` allow-lists only `id`, `kind`, `category` and validated point coordinates; do not extend the map DTO with customer PII or pass raw database rows to MapLibre.

Current fixtures are synthetic and no external data feeds are loaded. Before any real customer import, define lawful purpose, consent/legal basis, retention/deletion, data provenance, access roles, backup handling and audit requirements. Those policies are not inferred or implemented by this schema.

## Migration and operational practice

- Use reviewed forward-only SQL migrations; back up production before schema changes.
- Test a clean reset and upgrades from a representative prior migration state in staging.
- Inspect `pg_extension.extnamespace` and PostGIS availability rather than relying on an environment's `search_path`.
- Monitor migration duration/locks on production-size data; Phase 2 creates empty tables/indexes but future indexes on populated tables may need concurrent/index rollout planning.
- Validate actual query plans and GiST selectivity with realistic, privacy-safe data before promising latency.
- Keep SQL test fixtures synthetic and transactionally rolled back.

## Authentication and policy readiness

Phase 2 is not a launch-ready tenant-facing data service. Before adding a runtime data loader:

1. Add workspace membership and role model.
2. Decide organization/workspace-level administrator semantics.
3. Implement minimal `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants and policy predicates tied to the verified auth identity.
4. Test that each role can access only its workspace and cannot infer another workspace through joins, associations, RPCs or storage.
5. Generate and review Supabase TypeScript database types only after the local schema has been applied and inspected.
6. Map raw database rows through validated domain types before any display/map DTO is constructed.
