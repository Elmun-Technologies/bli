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

The map's current locations are deterministic **synthetic demo fixtures**, not loaded from Supabase or an external business directory. Configure `NEXT_PUBLIC_MAP_STYLE_URL` only if using an alternate compatible MapLibre style.

## Reproducible database verification

The verification script is `scripts/verify-database.sh`, exposed as `npm run verify:database`. It runs fail-fast and reports the stage on failure. It:

1. Checks that the project-locked Supabase CLI, Docker daemon and `psql` are available.
2. Starts the local Postgres environment through `supabase db start`.
3. Runs `supabase db reset --local --no-seed`, which destroys/recreates the local database and replays **every repository migration from zero**. It does not skip or rewrite failing SQL.
4. Runs `supabase/tests/phase2_integrity.sql` with `psql -X -v ON_ERROR_STOP=1`. The test prints actual PostgreSQL/PostGIS versions and verifies extension schema/version, required PostGIS functions, all ten tables, geography typmods/SRID, actual GiST index definitions, ownership constraints, deletion behavior, RLS/no policies, `PUBLIC`/client grants, and a rollback-only Tashkent distance sanity check.
5. Generates `src/lib/database/database.types.ts` using the local schema, atomically replacing the generated file only after the CLI succeeds.

**Warning:** `supabase db reset --local` is destructive to the local Supabase database. The SQL integrity script's own synthetic fixtures run inside a transaction and are rolled back. Do not point these commands at a production database.

Run the whole database and application gate locally with:

```bash
npm run verify
```

`npm run verify` runs `npm run verify:database`, then `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. A green TypeScript build alone does **not** prove that SQL migrations or PostGIS behavior work.

For an individual database run, derive the local connection string from the CLI rather than hardcoding credentials:

```bash
supabase db start
supabase db reset --local --no-seed
SUPABASE_DB_URL="$(supabase status --output env | awk -F= '$1 == "DB_URL" { sub(/^[^=]*=/, ""); gsub(/\"/, ""); print; exit }')"
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase2_integrity.sql
supabase gen types --lang typescript --local --schema public > src/lib/database/database.types.ts
```

The third line uses the CLI's current env output (`supabase status --output env`) and its `DB_URL` key. The package script is preferred because it checks the locked CLI version, fails with a stage label and safely handles generated-file replacement.

## GitHub Actions gate

`.github/workflows/database-integrity.yml` runs on every branch push, pull request and manual `workflow_dispatch`:

- Uses a fresh `ubuntu-24.04` runner with Docker; it does not restore or cache database volumes.
- Caches npm packages only and installs Supabase CLI through the official `supabase/setup-cli` action, using the exact `supabase@2.119.0` lockfile entry.
- Starts Postgres, resets from zero, runs the live catalog/integrity SQL assertions and generates database types.
- Requires the generated types to be committed and byte-for-byte current with the freshly migrated schema; uploads the verified type file as a short-lived artifact for review.
- Runs application tests, lint, typecheck and production build as separate visible steps.

A migration, PostGIS assertion, constraint/RLS assertion, type generation/drift check, or application step failure makes the workflow fail. The verification script labels the failing stage, writes the final 250 lines to the GitHub step summary, and uploads the full database verification log when available. npm dependencies may be cached; PostgreSQL/Docker state may not.

## Migration order and spatial preflight

```text
supabase/migrations/20261004000000_enable_postgis.sql
supabase/migrations/20261004010000_phase2_ownership_schema.sql
supabase/migrations/20261004020000_phase2_spatial_entities.sql
```

The Phase 2 preflight expects PostGIS in schema `extensions`, `extensions.geography`, geography `ST_DWithin`, and `pg_catalog.gen_random_uuid()`. `supabase/config.toml` targets PostgreSQL 17. The integrity test requires PostgreSQL 17 and PostGIS library version >=3.3.0, and logs the actual extension/library versions. An extension already installed in another schema is not moved by `CREATE EXTENSION IF NOT EXISTS`; the migration must fail until that state is deliberately resolved. Keep PostGIS types/functions schema-qualified.

## Generated database types and boundaries

The database verification script generates `src/lib/database/database.types.ts` from the just-reset local Postgres schema using the pinned Supabase CLI. **Do not hand-edit this generated file.** If it changes after `npm run verify:database`, review the migration that caused the change and commit the regenerated output; CI fails on uncommitted or stale generated types.

Generated Supabase row types are persistence-only. Map code receives validated domain values and the PII-allow-listed GeoJSON DTO, never raw database rows. Keep customer name, phone, address and revenue out of generic map source properties. The SQL migrations remain canonical; the generated file must come from an applied schema, not a hand-authored approximation.

## Current local verification status

The project CLI is installed and reports `2.119.0`, but Docker and `psql` are unavailable in this workspace. Therefore local database startup, migration replay, PostGIS/catalog assertions and database type generation **have not run here**. CI is the intended real PostgreSQL/PostGIS verification environment; no database result should be claimed until its workflow succeeds.

## Application checks

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

These application checks complement—not replace—the clean database verification gate.
