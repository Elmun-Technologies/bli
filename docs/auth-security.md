# Authentication, membership and RLS

Phase 4 adds Supabase Auth (email/password), per-workspace membership and the
production Row Level Security model. This document records exactly what is
implemented: the schema, the helpers, every policy, the grant strategy, the
first-owner bootstrap, the demo/tenant boundary, the elevated-credential
inventory and the security tests that enforce all of it.

> Two trust models exist and are never mixed:
>
> * **Public demo** — `/api/demo/*`. Public, read-only, elevated server-only
>   client, hard-wired to the synthetic `atlas-demo` / `tashkent-demo` workspace.
> * **Tenant** — `/workspaces/[workspaceId]` and `/api/workspaces/[workspaceId]/*`.
>   Requires a server-validated session **and** membership, even for the synthetic
>   `tashkent-demo` workspace. No elevated client is involved.

## Auth flow

```text
browser ──POST /api/auth/sign-in (form or JSON)──► route handler
                                                    │ createSupabaseServerClient()  (anon key, cookies)
                                                    │ supabase.auth.signInWithPassword()
                                                    ▼
                                          Supabase Auth (GoTrue)
                                                    │ session cookies set through the SSR client
                                                    ▼
browser ──GET /workspaces, /workspaces/[id]─────────► Server Components
                                                    │ requireSessionUser() → auth.getUser() (server-validated)
                                                    │ resolveWorkspaceAccess() → RLS-filtered membership + role
                                                    ▼
browser ──GET/POST /api/workspaces/[id]/*───────────► Route handlers
                                                    │ session → membership/role → tenant RPC
                                                    │ runs as the caller: RLS + the RPC's own
                                                    │ membership assertion both apply
                                                    ▼
                                          PostgreSQL / PostGIS
```

* `src/proxy.ts` (Next 16 `proxy` file convention, the successor to
  `middleware.ts`) refreshes the Supabase session cookie on navigation. It is
  **not** an authorization gate: pages and route handlers re-validate the
  session server-side, and membership is always decided by the database.
* Client state is never authorization truth. The cookie is validated with
  `auth.getUser()` against the auth server on every protected request.
* Scope is deliberately minimal: email/password sign-in, sign-out, one protected
  workspace route, one workspace selector. There is no signup funnel, no
  password-reset UI, no OAuth, no magic links, no profile settings, no account
  deletion and no email invitations.

### Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/sign-in` | GET | Sign-in form (email, password, clear errors) |
| `/api/auth/sign-in` | POST | Form-encoded or JSON sign-in; sets SSR session cookies |
| `/api/auth/sign-out` | POST | Clears the session server-side |
| `/workspaces` | GET | Selector: only memberships RLS returns for the caller |
| `/workspaces/[workspaceId]` | GET | Protected workspace; membership resolved server-side |
| `/api/workspaces/[workspaceId]/map/features` | GET | Authenticated viewport features |
| `/api/workspaces/[workspaceId]/analysis/radius` | POST | Authenticated radius aggregates |

### Safe messages

The browser only ever sees wording from `src/lib/auth/messages.ts`:

* `Invalid email or password.`
* `You do not have access to this workspace.`
* `Session expired. Please sign in again.`
* `Your account is not a member of any workspace yet.`

No JWT contents, SQL text, policy names, schema details or credential hints are
returned or logged. Provider error messages are never forwarded: GoTrue
distinguishes unknown accounts from wrong passwords, so the sign-in route maps
every credential failure to the same response. A missing workspace and a foreign
workspace produce identical 403 bodies, so the API cannot be used as an
existence oracle.

## Workspace membership schema

```sql
CREATE TYPE public.workspace_member_role AS ENUM ('owner', 'admin', 'analyst', 'viewer');

CREATE TABLE public.workspace_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  role public.workspace_member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT workspace_members_workspace_user_unique UNIQUE (workspace_id, user_id)
);
```

* Indexes: `workspace_members_user_idx`, `workspace_members_workspace_role_idx`.
* No email, display name or other auth-profile column is duplicated here; the
  roster is a pure authorization table. `auth.users` stays the identity source
  and is never exposed through the API.
* The enum type is named `workspace_member_role`, not `workspace_role`, because
  the helper function `public.workspace_role(uuid)` shares that name and
  PostgreSQL parses `name(arg)` as a type cast when `name` is also a type.

### Integrity triggers

| Trigger | Table | Behaviour |
| --- | --- | --- |
| `*_prevent_workspace_move` | projects, datasets, project_datasets, locations, customers, competitors, branches, analysis_locations | `workspace_id` is immutable (SQLSTATE 42501) |
| `workspace_members_prevent_reassignment` | workspace_members | `workspace_id` and `user_id` are immutable |
| `workspaces_prevent_identity_change` | workspaces | `organization_id` and `slug` are immutable (the public demo path resolves its workspace by slug) |
| `workspace_members_protect_last_owner` | workspace_members | refuses any update or delete that would leave the workspace without an owner (SQLSTATE 23514) |

## Permission matrix (as implemented)

| Role | Read | Analytical write | Data administration | Imports (Phase 5) | Scoring (Phase 6) | Reports (Phase 7) | Membership administration | Owner assignment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **viewer** | workspace, organization (via membership), projects, datasets, project_datasets, locations, customers, competitors, branches, analysis_locations, membership roster of their own workspace(s); authenticated viewport + radius RPCs; import job metadata and staged-row preview; scoring models, saved candidates and stored analyses; **report history, preview and ready PDF downloads** | none | none | **read-only**: no upload, no mapping, no geocoding claim, no commit, no stored source file | **read-only**: models, saved candidates, stored analyses and comparisons; cannot run an analysis or save a candidate | **read-only**: list, preview and download ready reports; cannot create, generate, retry, rename or brand | none (cannot even change their own role) | no |
| **analyst** | viewer reads | locations, customers, competitors, analysis_locations (insert/update/delete inside their workspace) | none — projects, datasets, branches are read-only | create jobs, upload, map, validate, geocode, place points manually, commit into an **existing** dataset; cannot create a dataset | run analyses and comparisons, save candidate locations; **cannot create or edit a scoring model** | create a report from a stored analysis, generate/regenerate/retry its PDF, preview and download; **cannot brand or rename** | none | no |
| **admin** | all member reads | all analytical writes | projects, datasets, project_datasets, branches, business data | full import administration, including creating a destination dataset at commit time | run scoring and create, edit or archive scoring models | everything an analyst can do, plus report branding (title, company name, logo) | add/change/remove `viewer`, `analyst`, `admin` | no |
| **owner** | all member reads | all analytical writes | full data administration plus workspace settings (`name`, `metadata`) | full import administration, including creating a destination dataset at commit time | run scoring and create, edit or archive scoring models | everything an admin can do; reports are never deleted by anyone | full membership administration, including owner grant/change/remove subject to last-owner protection | yes |
| **service_role** | platform-default elevated access | operator paths only | `bootstrap_workspace_owner`, `grant_workspace_owner` | operator bootstrap only | no new grant and no call site on the tenant scoring path: the phase grants it nothing and no code path uses it (it keeps the platform default, as on every public table) | no new grant and no call site on the tenant report path: the phase grants it nothing and no report code path uses it (it keeps the platform default) | yes (operator) | no |

Branch data is intentionally owner/admin-only: nothing in Phase 1–3 required an
analyst to create branches, so the conservative choice is the implemented one.
Map clicks are still never persisted; `analysis_locations` rows only appear when
an analyst or administrator explicitly saves a candidate.

## RLS helpers

| Helper | Security | search_path | Returns | EXECUTE granted to |
| --- | --- | --- | --- | --- |
| `public.workspace_role(p_workspace_id uuid) → workspace_member_role` | `SECURITY DEFINER`, `STABLE`, read-only, no dynamic SQL | `pg_catalog` (all references schema-qualified, including `auth.uid()`) | the **caller's own** role in one workspace, or NULL when not a member (also NULL for anonymous callers) | `authenticated` only (`REVOKE … FROM PUBLIC, anon, authenticated` then `GRANT … TO authenticated`) |
| `public.is_workspace_member(p_workspace_id uuid) → boolean` | `SECURITY INVOKER` | `pg_catalog` | `workspace_role(...) IS NOT NULL` | `authenticated` only |
| `public.has_workspace_role(p_workspace_id uuid, p_allowed workspace_member_role[]) → boolean` | `SECURITY INVOKER` | `pg_catalog` | whether the caller's role is one of `p_allowed` | `authenticated` only |

**Why one SECURITY DEFINER function exists.** The `workspace_members` SELECT
policy must ask "what is the caller's role in this workspace?", which means
reading `workspace_members` from inside a policy on `workspace_members` — the
classic recursion problem. Confining that single privileged read to one small,
`STABLE`, read-only, schema-qualified function keeps the elevated surface
auditable. Everything else is `SECURITY INVOKER`. The function returns only the
caller's own role, cannot mutate anything, has no dynamic SQL, and its
`search_path` is pinned to `pg_catalog` so it cannot be hijacked. Tests assert
that it reports NULL for foreign workspaces and NULL for anonymous callers, and
that anon cannot execute any of the three helpers.

## Policies by table

Every policy is declared `TO authenticated` and every `USING`/`WITH CHECK`
expression is a membership or role test. There is no `USING (true)` and no
blanket policy; `supabase/tests/phase2_integrity.sql` fails the build if one
appears.

| Table | Policies |
| --- | --- |
| `organizations` | `organizations_select_organization_member` (SELECT: a workspace of this organization is visible to the caller). No INSERT/UPDATE/DELETE for authenticated — organizations are created only by the operator bootstrap. |
| `workspaces` | `workspaces_select_member` (SELECT), `workspaces_update_owner_admin` (UPDATE, owner/admin). No client INSERT or DELETE. |
| `workspace_members` | `workspace_members_select_member` (SELECT, any member — the roster of their own workspace); `_insert_owner` / `_update_owner` / `_delete_owner` (owner, any role); `_insert_admin` / `_update_admin` / `_delete_admin` (admin, restricted to `viewer`/`analyst`/`admin` in both directions). Viewers and analysts have no write policy at all. |
| `projects` | `projects_select_member`, `projects_insert_owner_admin`, `projects_update_owner_admin`, `projects_delete_owner_admin` |
| `datasets` | `datasets_select_member`, `datasets_insert_owner_admin`, `datasets_update_owner_admin`, `datasets_delete_owner_admin` |
| `project_datasets` | `project_datasets_select_member`, `project_datasets_insert_owner_admin`, `project_datasets_delete_owner_admin` (no UPDATE: a link is created or removed, never retargeted) |
| `locations` | `locations_select_member`, `_insert_analyst`, `_update_analyst`, `_delete_analyst` (owner/admin/analyst) |
| `customers` | `customers_select_member`, `_insert_analyst`, `_update_analyst`, `_delete_analyst` (owner/admin/analyst). RLS is row access only; the API's PII DTO allow-list is enforced independently in `src/lib/spatial/dto.ts`. |
| `competitors` | `competitors_select_member`, `_insert_analyst`, `_update_analyst`, `_delete_analyst` (owner/admin/analyst) |
| `branches` | `branches_select_member`, `_insert_owner_admin`, `_update_owner_admin`, `_delete_owner_admin` |
| `analysis_locations` | `analysis_locations_select_member`, `_insert_analyst`, `_update_analyst`, `_delete_analyst` (owner/admin/analyst) |
| `scoring_models` (Phase 6) | `scoring_models_select_member` (SELECT), `_insert_owner_admin`, `_update_owner_admin` (owner/admin). No client `DELETE`: a model is archived, never erased, so old analyses keep explaining themselves. |
| `scoring_model_factors` (Phase 6) | `scoring_model_factors_select_member` (SELECT through membership of the owning model's workspace), `_insert_owner_admin`, `_update_owner_admin`, `_delete_owner_admin`. An analyst can read a definition but never rewrite one. |
| `location_analyses` / `location_analysis_results` (Phase 6) | `SELECT` for members of the analysis workspace. Deliberately **no** client write policy: `public.run_location_analysis` is their only writer, so a score can never be forged by an insert or an update. |

Because the admin policies constrain `role` in **both** `USING` and
`WITH CHECK`, an admin can neither grant `owner` nor convert themselves into an
owner; owner rows are invisible to the admin UPDATE/DELETE policies entirely.
Composite foreign keys (`(dataset_id, workspace_id)`, `(project_id, workspace_id)`)
continue to reject cross-workspace references at the database layer, and the
immutability triggers close the "move an existing row" case.

## Import tables and storage policies (Phase 5)

| Object | Policy summary |
| --- | --- |
| `public.import_jobs` | `SELECT` for members (`has_workspace_role` on any role); `INSERT` only when the caller's own `created_by = auth.uid()` and their role is owner/admin/analyst; `UPDATE` scoped to owner/admin/analyst of that workspace; **no `DELETE` grant at all**. Completion fields (`status = 'completed'`, `committed_at`) are additionally protected by a trigger that only `public.commit_import_job` can satisfy. |
| `public.import_rows` | `SELECT` for members; `INSERT`/`UPDATE` for owner/admin/analyst; **no `DELETE` grant**, so staging is append-or-replace and an upload can never erase its own evidence. The composite FK plus an immutability trigger refuse re-parenting a row. |
| `storage.objects` (bucket `workspace-imports`) | Four policies (`SELECT`/`INSERT`/`UPDATE`/`DELETE`) for owner/admin/analyst, each deriving the workspace from the first object-path segment through `import_object_workspace_id(name)` and then calling `has_workspace_role(...)`. A malformed path resolves to `NULL` and grants nothing. A viewer gets no file access; `anon` gets nothing. Deletion is a Storage API operation that this policy authorizes; the platform refuses direct SQL deletion of stored objects, and the Phase 5 suite proves a direct attempt never destroys a file. |

The `import_jobs`/`import_rows` policies exist so the wizard can stage and read
its own work; every privileged transition (claiming geocoding work, applying
results, manual placement, committing, refreshing counters) is a
`SECURITY INVOKER` function that repeats the owner/admin/analyst assertion
itself, because a policy alone cannot express "only through this workflow".

## Report tables and storage policies (Phase 7)

| Object | Policy summary |
| --- | --- |
| `public.analysis_reports` | `SELECT` for any member of the row's workspace (`is_workspace_member`); `INSERT` only for owner/admin/analyst (`has_workspace_role(..., {owner,admin,analyst})`), and only with the caller's own `created_by`, a snapshot, a snapshot hash and `status = 'draft'`; `UPDATE` scoped the same way for the lifecycle, branding and presentation fields. **No `DELETE` grant for any role**, and no `anon` privilege at all. The `_protect_snapshot` trigger raises `42501` if an authorized updater tries to change the snapshot, its hash, the analysis link, the type, the creator or the creation timestamp, and `_prevent_move` blocks re-parenting. |
| `storage.objects` (bucket `analysis-reports`) | `SELECT` for any member and `INSERT`/`UPDATE` for owner/admin/analyst, each deriving the workspace from the **first three** object-path segments through `report_object_workspace_id(name)` (a malformed path resolves to `NULL` and grants nothing) and then calling the membership helper. **No `DELETE` policy and no `anon` policy**, so stored report artifacts are append-only from the client's perspective. The table's own CHECK constraints additionally require every stored path to start with the row's `workspace_id/project_id/report_id/` prefix, which makes a storage-path swap a constraint violation rather than a working exploit. |

## PostgreSQL grants

Supabase's `ALTER DEFAULT PRIVILEGES` grants **ALL** privileges on new tables in
`public` to `anon`, `authenticated` and `service_role` — including `TRUNCATE`,
which row level security does not filter. The Phase 4 migration therefore
releases the inherited grants first and then grants exactly the documented set:

| Table | `authenticated` | `anon` |
| --- | --- | --- |
| `organizations` | SELECT | none |
| `workspaces` | SELECT, UPDATE | none |
| `workspace_members` | SELECT, INSERT, UPDATE, DELETE | none |
| `projects`, `datasets` | SELECT, INSERT, UPDATE, DELETE | none |
| `project_datasets` | SELECT, INSERT, DELETE | none |
| `locations`, `customers`, `competitors`, `branches`, `analysis_locations` | SELECT, INSERT, UPDATE, DELETE | none |

`REVOKE ALL PRIVILEGES … FROM PUBLIC, anon, authenticated` also removes
`TRUNCATE`, `REFERENCES` and `TRIGGER` for the API roles, so a grant can never
exceed what the policies allow and no DDL-style privilege is reachable from a
browser session. `anon` is refused at the privilege layer, before RLS is even
consulted. The full matrix is asserted by
`supabase/tests/phase4_membership_rls.sql` and re-checked structurally by
`supabase/tests/phase2_integrity.sql`.

Functions follow the same discipline: `REVOKE ALL ON FUNCTION … FROM PUBLIC,
anon, authenticated` followed by an explicit `GRANT EXECUTE` to the single role
that needs it (`authenticated` for the three helpers and the two tenant RPCs,
`service_role` for the demo RPCs and the two bootstrap functions).

## Tenant GIS RPCs

`public.workspace_viewport_features(p_workspace_id, p_west, p_south, p_east,
p_north, p_kinds, p_limit)` and `public.workspace_radius_analysis(p_workspace_id,
p_longitude, p_latitude, p_radius_meters)` mirror the Phase 3 demo functions
field for field — same bounds/span/limit/kind validation, same PII-safe
projection (customers expose `id`/`kind`/`category` only), same aggregates-only
radius output — with one difference: the workspace is a parameter and both
authorization layers apply.

1. The function calls `public.workspace_role(p_workspace_id)` and raises
   `42501` unless the caller is a member. A non-existent workspace raises the
   identical error.
2. The functions are `SECURITY INVOKER`, so RLS filters every table they touch
   even if the assertion were bypassed.

`EXECUTE` is granted to `authenticated` only; `anon` and `service_role` cannot
call them at all. The routes resolve membership first
(`resolveWorkspaceAccess`), then execute the RPC under the caller's own
cookie-aware session — never `service_role` after a JavaScript membership
lookup, and never a client-supplied role.

## Scoring RPCs (Phase 6)

Every scoring RPC asserts membership itself and runs `SECURITY INVOKER` with an explicit
`search_path`, except `public.run_location_analysis`, which must write the two result tables that no
client may write. That function is `SECURITY DEFINER`, schema-qualifies every reference, sets
`search_path = pg_catalog`, checks `workspace_role` before doing anything and is the only Phase 6
function with that posture — the RLS suite asserts exactly that.

The query RPCs (`list_analysis_locations`, `save_analysis_location`, `list_location_analyses`,
`get_location_analysis`, `create_scoring_model`, `update_scoring_model`) are `SECURITY INVOKER`, so
RLS remains an independent layer behind every read and write. `anon` holds no `EXECUTE` right on any
of them.

### Explicit project context (Phase 6.5)

Scoring changed one thing after Phase 6: the server no longer selects a project on the caller's
behalf. There is no "oldest project", "first row" or "last used project" left in the code base, in
SQL or in TypeScript.

- **Reads and writes** resolve the caller's own projects first (a member read of `projects`, filtered
  by RLS) and accept a project id only when it is one of them. `listSavedCandidates`,
  `listStoredAnalyses`, `saveCandidate` and `runScoringAnalysis` all use that one resolver.
- **Identical refusals.** A missing project id in a multi-project workspace, a project id of another
  workspace, a project id that does not exist and a project the caller cannot see all return the same
  `400` body (`project_required`, "Select a project in this workspace before continuing."). The
  smoke test asserts the three bodies are byte-for-byte equal, so no route is an existence oracle.
- **Zero projects** is the only empty answer (`projectId: null`); mutations return `400 no_project`
  with the documented empty-state message. Nothing auto-creates a project.
- **One project** resolves unambiguously and the response always names it, so even the convenience
  path is explicit rather than silent.
- **Database backstop.** `run_location_analysis` still refuses a candidate that is not in the named
  project, `save_analysis_location` still verifies the project, and since
  `20261005093000_phase65_project_context.sql` the two list RPCs raise `P0002` for a project that does
  not belong to the named workspace instead of answering with an empty list. A non-member still gets
  `42501` from the membership check before any project is looked up.
- **Project creation** is an explicit owner/admin action through
  `POST /api/workspaces/{workspaceId}/projects`, running under the caller's own JWT against the
  existing `projects_insert_owner_admin` policy. The tenant path still never uses `service_role`.
- **Models stay workspace-owned.** Projects select from the workspace's scoring models; creating a
  project copies nothing, and the SQL engine suite asserts that the same model scores a candidate in
  either project.

## First-owner bootstrap

**Production / operator.** `public.bootstrap_workspace_owner(p_organization_slug,
p_organization_name, p_workspace_slug, p_workspace_name, p_owner_user_id)` is
`SECURITY DEFINER`, `service_role`-only (`REVOKE ALL … FROM PUBLIC, anon,
authenticated`), validates both slugs (`^[a-z0-9][a-z0-9-]{1,62}$`) and both
names, requires an existing `auth.users` row, and creates the organization,
workspace and first owner membership in one transaction. It is idempotent:
re-running it for the same slugs reuses the organization and workspace and
restores the owner membership instead of creating duplicates, and a concurrent
race is handled with a `unique_violation` guard rather than `ON CONFLICT`
(whose unqualified column list would collide with the function's output
parameter names). `public.grant_workspace_owner(p_workspace_id, p_user_id)`
performs the same owner assignment for an existing workspace. Both are also
usable from the Supabase SQL editor or a server-side operator script; arbitrary
authenticated users cannot reach either one, so nobody can grant themselves
`owner`.

**Development / CI.** `supabase/seed.sql` creates deterministic Supabase Auth
users with bcrypt password hashes and matching `auth.identities` rows:

| Identity | Password | Membership |
| --- | --- | --- |
| `owner-a@example.test` | `phase4-demo-password` | owner of `tashkent-demo` (workspace A) |
| `admin-a@example.test` | `phase4-demo-password` | admin of workspace A |
| `analyst-a@example.test` | `phase4-demo-password` | analyst of workspace A |
| `viewer-a@example.test` | `phase4-demo-password` | viewer of workspace A |
| `owner-b@example.test` | `phase4-demo-password` | owner of `isolation-test` (workspace B) |
| `outsider@example.test` | `phase4-demo-password` | no membership anywhere |
| `operator@example.test` | `phase4-demo-password` | no membership; actor for the bootstrap test |

These are synthetic local identities. Never seed them into a deployed project;
use the operator bootstrap (or Supabase's auth admin API) there. The seed also
refuses to run when `pgcrypto` or `auth.users` is unavailable, so it can never
silently half-apply.

## Last-owner protection

`workspace_members_protect_last_owner` is a `BEFORE UPDATE OR DELETE` trigger
that counts the remaining owners of the affected workspace and raises
`23514` (`A workspace must always retain at least one owner`) when the operation
would leave none. It is database-level, so it holds for direct SQL, PostgREST,
the app and any future service: disabled buttons or API checks are not part of
the guarantee. With more than one owner, an owner may demote or remove another
owner as long as at least one remains. `workspace_members_prevent_reassignment`
additionally blocks re-pointing a membership row at a different user or
workspace, which would otherwise transfer authority silently.

## Public demo isolation

* `/api/demo/map/features` and `/api/demo/analysis/radius` stay public and
  continue to use the elevated server-only client
  (`src/lib/supabase/admin.ts` → `src/lib/spatial/service.ts`).
* The demo RPCs remain `service_role`-only and bind themselves to the
  `atlas-demo` / `tashkent-demo` slugs. The browser cannot pass a workspace id,
  and no other workspace or customer PII is reachable through them.
* An authenticated member **cannot** call the demo RPCs (asserted in the Phase 4
  suite), and being signed in grants no tenant access: `/api/workspaces/tashkent-demo/...`
  still requires membership of that workspace through the tenant routes.
* Demo and tenant code paths never mix: the tenant modules never import the
  elevated client, and `src/lib/spatial/server-boundary.test.ts` fails the build
  if that changes.

## Elevated-credential inventory

Every remaining use of an elevated Supabase credential:

| Location | Purpose | Guardrails |
| --- | --- | --- |
| `src/lib/supabase/admin.ts` (module) | constructs the single elevated client | `server-only`, never imported by a Client Component, key never logged or returned |
| `src/lib/spatial/demo-workspace.ts` | resolves the fixed synthetic demo workspace by slug | read-only lookup of `organizations`/`workspaces` |
| `src/lib/spatial/service.ts` → `demo_viewport_features`, `demo_radius_analysis` | the public `/api/demo/*` path | RPCs are hard-wired to the demo workspace |
| `public.bootstrap_workspace_owner`, `public.grant_workspace_owner` | first-owner bootstrap and owner restoration | `SECURITY DEFINER`, validated parameters, `service_role`-only `EXECUTE` |
| CI/local setup (`supabase db reset`, `supabase/seed.sql`, workflow credentials) | deterministic database and test identities | local stack only, no production credentials |

The authenticated tenant GIS routes deliberately do **not** appear here: they use
the cookie-aware anon client (`src/lib/supabase/server.ts`) so the caller's own
JWT, RLS and the RPC membership assertion apply. The Supabase auth admin API is
not used at all; the only auth-admin-equivalent action is the local seed.

**Phase 5 adds no new elevated-credential use.** Every import route — including
the private-bucket upload, the download during mapping, the geocoding batches and
the commit — runs through the same cookie-aware client under the caller's own
session, and the commit function is `SECURITY INVOKER`. In particular, no import
path uses `service_role` to bypass RLS, and the map DTO boundary is unchanged, so
an imported customer reaches the browser with the same allow-listed fields as
before. The import smoke asserts the map payload carries no phone, address or
revenue after a real import.

**Phase 6 adds no new elevated-credential use.** Every scoring route uses the
cookie-aware anon client under the caller's own session; the phase grants
`service_role` nothing new and no scoring code path calls it (the role keeps the
platform default Supabase grants every public table, exactly as the Phase 4
migration documents), and the only `SECURITY DEFINER` function in the phase
(`run_location_analysis`) is a database object, not a credential. No scoring path
looks up membership in JavaScript and then switches to an elevated client, so RLS
and the RPC's own membership assertion stay independent of the route guard.

**Phase 7 adds no new elevated-credential use either.** The report routes use the
same cookie-aware anon client: the history, the preview, the creation, the
generation, the logo upload and the authorized download all run under the
caller's own session, so RLS on `analysis_reports` and the membership-scoped
`storage.objects` policies apply on every read and write. The report tables and
the `analysis-reports` bucket grant `service_role` nothing new and no report code
path uses it (the role keeps Supabase's platform default, as everywhere else in
`public`; the report API never switches to an elevated client, before or after a
membership lookup). The static-map token
(`MAPBOX_ACCESS_TOKEN`) is a *separate* server-only secret: it is read only in
`src/lib/reports/map/mapbox-provider.ts`, is never a `NEXT_PUBLIC_*` variable, is
never stored in a snapshot, a response, a log line or an artifact, and CI runs
with the deterministic fake provider so no build needs it at all.

**Phase 6.5 adds no new elevated-credential use either.** The project list and the
explicit project-creation endpoint (`/api/workspaces/{workspaceId}/projects`) run
through the same cookie-aware client: the read is filtered by the member policy on
`projects`, and the insert is allowed only by `projects_insert_owner_admin`. No
elevated client is used for project context anywhere, before or after the project
lookup.

## Workspace resolver and selector

* `listAuthorizedWorkspaces(userId)` reads `workspace_members` through the
  cookie-aware client with an explicit `user_id` filter, so the roster rows of
  other members never reach the selector and RLS decides which rows exist at all.
* `resolveWorkspaceAccess(userId, workspaceId)` returns the workspace plus the
  caller's role, or `null` — the same answer for "not a member" and "does not
  exist". The URL workspace id is treated as untrusted input everywhere.
* The selector renders only authorized memberships; there is no "fetch all
  workspaces and filter in the browser" path.

## Security test strategy

`supabase/tests/phase4_membership_rls.sql` runs against a freshly reset database
and executes every scenario as a real database role (`authenticated`, `anon`,
`service_role`) with real JWT claims in `request.jwt.claims`, so the policies
under test are exactly the policies PostgREST applies:

* helper disclosure (own role only, NULL for foreign and NULL workspaces, anon
  refused, forged claims on the `anon` role refused);
* per-role PASS/FAIL matrices for viewer, analyst, admin and owner, including
  exact row-scope checks (`sees exactly the authorized rows, no foreign rows`);
* cross-workspace reads, writes, row moves and dataset/project tampering;
* workspace-id tampering on both tenant RPCs, including fabricated ids;
* membership tampering: self-promotion, admin → owner, admin demoting an owner,
  re-pointing a membership, deleting the final owner;
* workspace identity immutability (slug, organization);
* grant-matrix assertions for `anon`, `authenticated` and `service_role`;
* parity between the authenticated viewport/radius RPCs and the Phase 3 demo
  RPCs, plus PII checks (no customer display names, no workspace B isolation
  rows), and that the demo RPCs stay `service_role`-only.

`supabase/tests/phase7_reports_rls.sql` extends the technique to Phase 7 and
executes, as the real roles and with a workspace built from scratch inside the
transaction (so it does not depend on the demo seed):

* the read matrix — a viewer lists, previews and (for a ready report) downloads,
  while a non-member, a foreign-workspace member and `anon` see nothing;
* the write matrix — owner/admin/analyst create and generate, a viewer's insert
  is refused and its update changes no row (RLS filters silently, so the suite
  asserts the row count rather than a raise);
* ownership — a report cannot be created from another workspace's analysis, from
  another project's analysis, or with a `storage_path` outside its own
  `workspace/project/report` prefix; re-parenting a row raises;
* the lifecycle matrix — `draft → generating → ready` requires an artifact and a
  `generated_at`, `ready → draft` is refused (`23514`), `failed → generating` is
  the documented retry, and a `ready` row can be regenerated;
* snapshot immutability — `UPDATE` on `snapshot`, `snapshot_hash`, `analysis_id`,
  `report_type`, `created_by` or `created_at` raises `42501` even for the owner;
* storage — the bucket is private with the documented limits, a viewer cannot
  write an object, a foreign member cannot read another workspace's prefix, and a
  malformed or swapped path resolves to `NULL`.

`supabase/tests/phase5_import_rls.sql` and `supabase/tests/phase5_geocoding.sql`
extend the same technique to Phase 5 and assert, among other things: a reviewer
cannot upload, map, claim or commit; a foreign workspace cannot read staged rows,
cite a dataset, commit a job or read a stored object; a malformed storage path
grants nothing; direct writes cannot claim completion; the completion fields are
committed only through the workflow function; duplicate `external_id` rows are
marked invalid rather than merged or dropped; a replayed commit inserts nothing; a
committed import cannot be re-pointed at a new dataset; and the two staging tables
have no `DELETE` privilege for `authenticated`.

`supabase/tests/phase6_scoring_rls.sql` covers the scoring phase the same way,
and adds Phase 6.5's project rule: a member naming another workspace's project
gets `P0002` from the list RPCs instead of an empty list, a non-member gets
`42501` before any project is looked up, a comparison cannot mix a candidate of
this workspace with one of another workspace, and a project that does not exist
answers exactly like a foreign one. `phase6_scoring_engine.sql` asserts the
project scoping of candidates and history plus the fact that one workspace-owned
model scores candidates in either project.

The end-to-end import smoke (`scripts/smoke-import-mode.ts`, run by
`npm run smoke:imports` and in CI) drives the **shipped** client modules against
the **shipped** production routes: it signs in, creates an import, uploads a real
CSV to the private bucket, maps and validates it, runs a fake-provider geocoding
batch, downloads the error export, commits (then replays and attempts to re-point
the commit), and finally reads the workspace viewport through the shipped GIS
client to prove no phone number, address or revenue can reach the map payload.
It also checks that a foreign workspace and a non-existent one produce the
identical refusal, that a viewer can read but not write, and that a crafted
upload body cannot redirect the file elsewhere. CI sets `GEOCODING_PROVIDER=fake`,
so the gate needs no Mapbox token and never calls the paid service.

`supabase/tests/phase6_scoring_engine.sql` and
`supabase/tests/phase6_scoring_rls.sql` extend the same technique to scoring. The
first drives the engine as real roles: weights that do not total 100, duplicate
keys, rejected threshold curves, a disabled factor, the all-equal degenerate
score, missing metrics, zero-data candidates, a very large metric, deterministic
rounding, clamping, ranking tie-breaks, comparison limits, a snapshot that
survives a model edit and the freshness flag. The second asserts the catalog
posture (RLS enabled on all four tables, the expected policies, no blanket
`USING (true)`/`WITH CHECK`, exactly one `SECURITY DEFINER` scoring function),
the full role matrix through the RPCs, cross-workspace moves, foreign model,
project, candidate and factor attempts (including the composite foreign key
refusal beside the RLS refusal), and that `anon` gets nothing. Phase 6.5 adds the
project-context assertions: a member naming another workspace's project gets
`P0002` (not an empty list), a non-member gets `42501` before the project is even
looked up, and a project that does not exist answers exactly like a foreign one.

The scoring smoke (`scripts/smoke-scoring-mode.ts`, run by `npm run smoke:scoring`
and in CI) drives the shipped scoring API against the shipped production build and
parses every raw HTTP response with the shipped client parser: models, saved
candidates, a single analysis, a comparison, the stored read, an owner model edit
that must not move a stored score, the refusal paths (analyst edit, viewer run,
foreign owner, outsider, anonymous) and the comparison CSV export. Phase 6.5
extends it with explicit project scenarios: creating Project B (owner only), the
unnamed-project `400` in a multi-project workspace, a foreign and a non-existent
project id failing with a byte-for-byte identical body on both the read and the
save path, Project A's candidates disappearing when Project B is listed and the
reverse, a mixed-project comparison being refused without storing anything, and
one workspace-owned model scoring a candidate in either project while each
project's history holds only its own analyses.

### Verified results

The Phase 4 commit is verified by a green GitHub Actions run
(`Database integrity` run 30 on `9123720`) that replayed every migration from
zero on PostgreSQL 17.11 / PostGIS 3.3.7 and passed:

- `supabase/tests/phase2_integrity.sql` — RLS enabled on all eleven tables, no
  blanket policy, no `PUBLIC` ACL, `anon` holds nothing, policy/privilege match
  still intact after the Phase 4 grants;
- `supabase/tests/phase3_spatial_queries.sql` — the demo spatial RPCs, isolation
  and index-plan assertions are unchanged and still green;
- `supabase/tests/phase4_membership_rls.sql` — every per-role, tampering,
  bootstrap, grant and parity scenario passes as the real `anon`,
  `authenticated` and `service_role` roles;
- the fixtures smoke and the authenticated smoke (all 13 scenarios, including
  workspace-id tampering against a foreign and a non-existent workspace).

The suite has also been run locally on a PGlite PostgreSQL 18.3 / PostGIS 3.6.2
harness that applies the same migrations against a faithful `auth` schema; it is
a supplementary harness, not a substitute for the CI database gate.

The report smoke (`scripts/smoke-report-mode.ts`, run by `npm run smoke:reports`
with `REPORT_MAP_PROVIDER=fake`) drives the shipped report routes and the shipped
client: it validates the PDF bytes it downloads (real `%PDF`, size, pagination,
the stored score, every candidate, every factor, the disclaimer) and asserts the
documented refusals — a foreign workspace owner (`403`, and `404` when the report
is addressed inside their own workspace), an outsider (`403`), an anonymous
caller (`401` with the safe session message), an unknown report id (`404`), a
download before generation (`400 report_not_ready`), a viewer creating or
generating (`403`), an SVG or oversized logo (`400`), a report created from
another project's analysis (`400`), and a path query that must be ignored. It
also fails the run if any customer-level marker or any prediction-style claim
appears in the snapshot, the preview JSON, the PDF text or the map artifact.

`scripts/smoke-auth-mode.ts` adds the browser-level path in CI: it starts the
production build, signs in with the seeded identities through the shipped routes
and cookies, and checks the selector, the protected page, both tenant GIS
endpoints, workspace-id tampering (foreign and missing produce identical
responses), cross-workspace denial, the still-public demo endpoint and
sign-out invalidation.
