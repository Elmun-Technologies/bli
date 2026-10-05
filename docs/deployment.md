# Deployment and security notes

## Phase 6 deployment gate

Phase 6 adds configurable scoring models, saved candidate sites and stored analyses. Before
deploying it:

1. Ensure the clean-reset workflow is green **including**
   `supabase/tests/phase6_scoring_engine.sql`, `supabase/tests/phase6_scoring_rls.sql`, the
   generated-type drift check and all four end-to-end smokes.
2. Apply the Phase 6 migrations in timestamp order (`20261005090000` → `20261005092000`). The
   engine migration depends on Phase 2 (`analysis_locations`), Phase 3 (the radius RPC) and
   Phase 4 (`workspace_role`); replaying it out of order fails loudly.
3. **Seed one active model per workspace before users arrive.** Without an `active` model a run is
   refused with a safe validation error. The migration seeds nothing: the synthetic demo model lives
   in `supabase/seed.sql` and must never be deployed to a project with real users.
4. **Review the shipped factor definitions.** Weights, thresholds and directions are business
   choices, not engine defaults: change them through the API as an owner/admin, and remember that a
   save advances the model revision while stored analyses keep the revision they were run with.
5. **Decide how outdated data is handled.** The `may_be_outdated` flag is advisory; there is no
   automatic rescoring and no dataset version control. Tell operators to re-run an analysis after a
   material data load.
6. `run_location_analysis` is `SECURITY DEFINER` by design so that only the engine writes analyses
   and results. If it is ever changed, keep `search_path = pg_catalog`, schema-qualified references
   and the membership/role assertion before any write, and re-run the scoring suites.
7. There is no scoring job, queue or background worker: every analysis is an explicit user action and
   every endpoint is `dynamic`/`no-store`.
8. **Phase 6.5 project context:** apply `20261005093000_phase65_project_context.sql` (it replaces two
   RPC bodies, so no data migration is required) and re-run both scoring suites. Check that every
   workspace you deploy to has at least one **active** project: the interface shows the "No project is
   available…" empty state and refuses project-scoped mutations in a workspace with none, and with
   two or more projects it will not pick one for the user. Client code from before Phase 6.5 that
   omits `projectId` on a multi-project workspace now gets a `400 project_required` instead of an
   implicit (oldest-project) answer — update such callers before deploying.

## Phase 5 deployment gate

Phase 5 adds CSV/XLSX imports, private source-file storage and geocoding. Before
deploying it:

1. Ensure the clean-reset workflow is green **including**
   `supabase/tests/phase5_import_rls.sql`, `supabase/tests/phase5_geocoding.sql`,
   the generated-type drift check and all three end-to-end smokes.
2. Apply the Phase 5 migrations in timestamp order
   (`20261005050000` → `20261005080000`). The storage migration writes to
   `storage.buckets`/`storage.objects`, so it must run in a project where the
   Supabase Storage schema exists — it fails loudly otherwise.
3. **Geocoding is opt-in.** Either set `MAPBOX_ACCESS_TOKEN` (server-only, never
   `NEXT_PUBLIC_*`) plus optional `GEOCODING_COUNTRY_CODE`/`GEOCODING_PROXIMITY`
   for the pilot market, or leave geocoding unconfigured — in that case address-only
   rows report `503 geocoding_unavailable` and supplied coordinates still import
   normally. There is no Google default and no fallback provider.
4. **Mapbox terms are enforced in code:** the provider always sends
   `permanent=true`, because Phase 5 stores geocoded coordinates in a dataset.
   Do not change that flag; a temporary result may not be persisted.
5. **Review the geocoding thresholds** against real pilot data
   (`GEOCODING_ACCEPT_THRESHOLD`, `GEOCODING_REVIEW_THRESHOLD`,
   `GEOCODING_AMBIGUITY_DELTA`). The defaults are conservative on purpose:
   ambiguous or country-mismatched candidates always require a human decision.
6. **Decide the retention policy for source files.** Phase 5 keeps them for the
   lifetime of the import job and ships no lifecycle automation; the storage
   `DELETE` policy is what an operator or a later retention job would use.
7. **Keep `GEOCODING_PROVIDER=fake` out of production.** It exists for tests and
   CI only; the CI workflow sets it explicitly and the smoke passes it on to the
   server process.
8. Never deploy `supabase/seed.sql` or the deterministic `*@example.test`
   identities to a project with real users.

### Phase 4 deployment gate

Phase 4 adds authentication and workspace membership. Before deploying it:

1. Ensure the clean-reset workflow is green **including** `supabase/tests/phase2_integrity.sql`, `supabase/tests/phase3_spatial_queries.sql`, `supabase/tests/phase4_membership_rls.sql`, the generated-type drift check and both end-to-end smokes.
2. Apply `20261004040000_phase4_auth_membership.sql` in timestamp order. It requires Supabase Auth's `auth.users` table and fails loudly if it is missing.
3. Decide the auth configuration before the first real user: email/password provider, whether email confirmation is required, custom SMTP, and a password policy. Phase 4 deliberately ships **no** signup UI, invitation email, password reset, OAuth or magic links, so users are provisioned by the operator bootstrap (or your own administrative process) until a later phase adds them.
4. Create the first owner with the operator function, not with SQL inserts from an application role:

   ```sql
   SELECT public.bootstrap_workspace_owner(
     'acme', 'Acme Ltd', 'acme-main', 'Acme main workspace', '<auth-user-uuid>'
   );
   ```

   It runs with `service_role` (SQL editor or a controlled operator script), validates its inputs, requires an existing `auth.users` row, is idempotent for the same slugs, and creates the organization, workspace and first owner membership together. `public.grant_workspace_owner(workspace_id, user_id)` restores an owner on an existing workspace. Both are revoked from `PUBLIC`, `anon` and `authenticated`.
5. Verify the deployed database independently: run the Phase 4 suite (or an equivalent query) against staging, confirm `anon` cannot read or execute anything, and confirm the workspace-tampering cases still fail closed.
6. Never deploy `supabase/seed.sql` or the deterministic `*@example.test` identities to a project with real users; they are local/CI fixtures.

### Phase 3 deployment gate

Phase 3 adds the first live database path. Before deploying it:

1. Ensure the clean-reset workflow is green **including** `supabase/tests/phase3_spatial_queries.sql` and the generated-type drift check.
2. Apply `20261004030000_phase3_demo_spatial_queries.sql` in timestamp order.
3. Provision the synthetic demo workspace (`atlas-demo` / `tashkent-demo`). In a deployed environment this is created by an explicit, reviewed data-loading step; `supabase/seed.sql` is development/CI data and must not be run against production customer data.
4. Set `SUPABASE_SECRET_KEY` (preferred) or the legacy `SUPABASE_SERVICE_ROLE_KEY` as a **server-only** environment variable, never a `NEXT_PUBLIC_*` variable. `src/lib/supabase/admin.ts` imports `server-only`, so a client import fails the build instead of leaking the credential.
5. Keep `DATA_SOURCE=database`. The `fixtures` mode is a display-only development fallback and refuses analysis.

Phase 3 does not add login, membership, invitations, roles or user-scoped workspace selection. **The demo API is not a multi-tenant data API:** it is deliberately hard-wired to one synthetic workspace. Phase 4 keeps that property and adds the separate, membership-checked tenant API beside it; the two must never be merged (see [auth-security.md](auth-security.md)).

## Phase 2 deployment gate

Do not deploy these migrations to a production database until the dedicated clean-reset workflow has passed and a reviewer has inspected its PostgreSQL/PostGIS version, catalog assertions and generated types. The project-local Supabase CLI is pinned to `2.119.0`; Docker and `psql` are unavailable in this workspace, so local database behavior is **NOT VERIFIED LOCALLY**. See [setup.md](setup.md) for exact local commands and CI behavior.

Deploy in timestamp order and verify the PostGIS extension schema before applying Phase 2. The migrations require PostGIS in `extensions`, `extensions.geography`, geography `ST_DWithin`, and `pg_catalog.gen_random_uuid()`. They fail explicitly if assumptions are not met. An extension already installed in another schema is not moved automatically by `CREATE EXTENSION IF NOT EXISTS`; investigate before proceeding.

The `supabase/tests/phase2_integrity.sql`, `phase3_spatial_queries.sql` and `phase4_membership_rls.sql` scripts use transactions and roll their fixtures back. They are verification scripts, not seeds or production data migrations. `supabase/seed.sql` is synthetic development/CI demo data and must not be applied to a production database containing real customer data.

### Server credential handling

- The elevated key exists only in the server runtime environment and is read in one place (`src/lib/supabase/admin.ts`). Phase 4 adds a second, *unprivileged* server client (`src/lib/supabase/server.ts`, anon key + caller cookies) which is what all authenticated tenant requests use.
- It is never logged, never embedded in an error response, and never sent to the browser. Client-facing errors are structured as `{ error: { code, message } }` with codes limited to `invalid_request`, `demo_workspace_missing`, `database_unavailable`, `database_required` and `internal_error`; SQL text, stack traces and credentials are excluded.
- The API uses a stateless `@supabase/supabase-js` client with session persistence disabled; it never reuses the cookie-aware SSR client, so no user session could be inherited.

### Cache policy

All four spatial endpoints (the two public demo routes and the two authenticated tenant routes) are dynamic (`force-dynamic`, `revalidate = 0`) and return `Cache-Control: no-store`. Auth responses (`/api/auth/*`) are dynamic too, and the sign-in/sign-out routes are never cached. Radius analysis is a `POST` and is never cached, so a result cannot be served for a different coordinate or radius. Client fetches also use `cache: 'no-store'`. No CDN or Next.js data-cache layer sits in front of these responses in this phase.

## CI and local verification

`.github/workflows/database-integrity.yml` runs for every branch push, pull request and manual dispatch on a fresh `ubuntu-24.04` runner with Docker. It installs the pinned Supabase CLI from the project lockfile, starts the local Postgres container, resets the database with every migration from zero, executes the SQL assertions with fail-fast `psql`, generates and checks the committed database types, then runs application tests, lint, typecheck and production build. It caches npm dependencies only—not the database or Docker volume.

For a local clean run, install dependencies, ensure Docker and `psql` are available, then run `npm run verify` from the repository root. **This resets/destroys the local Supabase database.** The database-only command is `npm run verify:database`; it generates `src/lib/database/database.types.ts` from the verified local schema. `row-types.ts` only aliases generated rows; keep generated rows persistence-only and map them through validated domain types before DTO construction. Never point the command at production. A passing TypeScript build alone is not evidence that SQL migrations work.

## RLS and grants after Phase 4

RLS is enabled for `organizations`, `workspaces`, `workspace_members`,
`projects`, `datasets`, `project_datasets`, `locations`, `customers`,
`competitors`, `branches` and `analysis_locations`. Phase 4 adds deliberate,
member-scoped policies for `authenticated` and an explicit grant matrix; the
policy-by-policy and grant-by-grant detail is in
[auth-security.md](auth-security.md).

Rules that must not be relaxed:

- Never add a permissive placeholder policy (`USING (true)`) to make something
  work. There is no blanket policy in this schema, and CI fails the build if one
  appears.
- A policy cannot override the table privilege `REVOKE`: adding a policy without
  the matching deliberate `GRANT` still denies access. Both layers are asserted.
- Supabase grants `ALL` (including `TRUNCATE`, which RLS does not filter) on new
  `public` tables to `anon`/`authenticated`/`service_role` by default, so every
  new client-visible table must revoke first and then grant exactly what the
  documentation says. `supabase/tests/phase2_integrity.sql` checks for inherited
  `TRUNCATE`/`REFERENCES`/`TRIGGER` privileges and for a policy/privilege match.
- `anon` must keep zero table privileges and zero function `EXECUTE` rights.
- The only `SECURITY DEFINER` function is `public.workspace_role(uuid)`
  (`STABLE`, read-only, `search_path = pg_catalog`). Do not add more without the
  same discipline: explicit `search_path`, schema-qualified references, revoked
  `EXECUTE`, no dynamic SQL, authorization facts only, and an escalation test.
- `with check` expressions must repeat the role restriction, not just the
  workspace membership test; that is what stops an admin from granting `owner`.

The Supabase service-role/secret key bypasses RLS and must remain server-side.
Never expose it in `NEXT_PUBLIC_*`, browser bundles, client components, HTML,
logs or map feature properties.

Phase 3 uses that elevated credential for exactly two `SECURITY INVOKER` demo
RPCs whose `EXECUTE` is revoked from `PUBLIC`/`anon`/`authenticated` and granted
only to `service_role`. The functions bind themselves to the demo workspace, so
even the elevated path cannot be pointed at another tenant's workspace through
the API. `service_role` additionally receives `SELECT` on the six tables those
functions read. Phase 4 keeps that path unchanged and adds `service_role`-only
`EXECUTE` on the two bootstrap functions. Authenticated tenant requests never
use the elevated credential: they run through the cookie-aware anon client, so
the caller's JWT, RLS and the RPC's own membership assertion all apply.

## Tenant and data protection

Workspace ownership is checked by composite database FKs, not by an application-only convention, and Phase 4 adds two more independent layers: row-level security policies and per-table grants. Treat every workspace id from a URL, body or query parameter as untrusted input, resolve it through the membership resolver, and keep the database authoritative. A missing workspace and a foreign workspace must stay indistinguishable to the caller. Organization/workspace/project/dataset deletion is restricted around business data; only `project_datasets` association rows cascade when a parent project/dataset is deleted.

Customer names, phone numbers, addresses and revenue are sensitive. Use explicit column selection and server-only row-to-domain adapters.

- The viewport RPC's customer branch projects `NULL` for the display name and returns only id, kind, category and coordinates.
- `src/lib/spatial/dto.ts` and `src/lib/spatial/response.ts` independently reject a customer feature that carries a name or any unexpected property.
- `src/lib/map/map-feature-adapter.ts` still allow-lists only `id`, `kind`, `category` and validated coordinates for selection overlays.
- Radius analysis returns aggregates only; per-customer revenue and customer rows never leave the database. Customer revenue crosses the API as an exactly-formatted decimal string derived from PostgreSQL `numeric`, avoiding binary-float coercion.
- Business, competitor and branch features may carry an explicitly modelled display name; keep that allow-list explicit and never reuse it for customers.

Do not extend the customer map DTO with PII and never pass raw database rows to MapLibre.

Phase 5 makes real customer imports possible, so the PII boundary now has a
write path as well as a read path:

- Imported customer rows carry name, phone, address and revenue. The map DTO
  rules above are unchanged and apply to imported data automatically, because
  committed rows reach the map through the same Phase 3/4 projection.
- Import previews, exports and mapping screens are membership-scoped API
  responses with `Cache-Control: no-store`; they are not public and are not the
  map payload.
- Geocoding sends the address text (and only the address text) to the configured
  provider. Do not enable geocoding for a dataset whose addresses are themselves
  regulated, unless the provider terms are acceptable for that data.
- Before loading real customer data, define lawful purpose, consent/legal basis,
  retention/deletion, data provenance, access roles, backup handling and audit
  requirements. `import_jobs` now gives an audit header per upload (who, when,
  which file, which destination, exact counts), but it is not a substitute for a
  full compliance process.
- Source files are stored in a private bucket and are reachable only by
  owner/admin/analyst members of that workspace; deleting a job cascades its
  staged rows but does not delete the promoted business records or the stored
  source file.

## Migration and operational practice

- Use reviewed forward-only SQL migrations; back up production before schema changes.
- Test a clean reset and upgrades from a representative prior migration state in staging.
- Inspect `pg_extension.extnamespace` and PostGIS availability rather than relying on an environment's `search_path`.
- Monitor migration duration/locks on production-size data; Phase 2 creates empty tables/indexes but future indexes on populated tables may need concurrent/index rollout planning.
- Validate actual query plans and GiST selectivity with realistic, privacy-safe data before promising latency.
- Keep SQL test fixtures synthetic and transactionally rolled back.
- Re-run the Phase 3 isolation assertions after any change to the demo RPCs, the seed data or the workspace resolver: they are the proof that demo queries cannot read another workspace.
- Re-run the Phase 5 storage suite after any change to the bucket policies: it is the proof that a malformed object path grants nothing and that an object of another workspace is invisible.
- Confirm the spatial index probes still show GiST participation after query-shape changes; do not infer index health from DDL alone.

## Post-Phase-5 operational checklist

1. **Watch the private bucket.** `workspace-imports` has a 5 MB per-object limit
   and no lifecycle rule; decide when source files should be removed and who may
   do it.
2. **Geocoding cost and quota.** Each geocoding batch bills one request per row
   against the Mapbox account, driven by user actions (there is no background
   job). Monitor usage and keep `GEOCODING_PROVIDER=fake` out of production.
3. **Operator readiness.** The import wizard is available to owner/admin/analyst
   members; viewers are read-only, enforced by both RLS and the routes. Provide
   the destination dataset before a large import, or let an owner/admin create
   one during the commit.
4. **Re-run the Phase 5 suites** (`phase5_import_rls.sql`, `phase5_geocoding.sql`)
   after any change to the import tables, the storage policies or the workflow
   functions; the storage suite is the proof that a path never authorizes by
   itself.
5. **Re-run the Phase 6 suites** (`phase6_scoring_engine.sql`,
   `phase6_scoring_rls.sql`) after any change to the scoring tables, the factor
   rules or the scoring functions; the RLS suite is the proof that a score cannot
   be forged and that an old analysis keeps its snapshot.

## Post-Phase-4 operational checklist

Phase 4 closes the "no authorization" gap: authentication, membership, roles and
RLS are implemented and asserted. The remaining work before a real tenant
rollout is operational rather than architectural:

1. **Provision users for real.** There is no signup funnel, invitation email,
   password reset UI or admin console. Use the operator bootstrap (or your own
   reviewed process) to create the workspace and its first owner, then add
   members deliberately; every membership change must be an authorized database
   write, never a manual insert by an unprivileged role.
2. **Review auth settings in the Supabase project**: email/password provider,
   email confirmation, SMTP, password policy, JWT expiry and cookie settings.
   Phase 4 validates sessions server-side and never trusts client state, but the
   auth server's own configuration is a deployment decision.
3. **Decide whether the demo workspace stays public.** `/api/demo/*` is public by
   design and reads only synthetic data. Before real data is loaded anywhere,
   confirm the demo workspace remains synthetic, or remove the demo routes.
4. **Plan the audit trail.** `workspace_members` records who may act, but there
   is no audit log of who changed what yet; add one before multi-tenant
   production use if your compliance requirements demand it.
5. **Keep the elevated credential inventory current.** It is listed in
   [auth-security.md](auth-security.md); any new use must be justified and
   reviewed like the existing ones.
6. **Re-run the security suite after any policy, grant, trigger or RPC change**
   and keep the generated types current; the drift check is part of the gate.
