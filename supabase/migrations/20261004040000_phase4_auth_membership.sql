-- Phase 4: Supabase Auth identity, workspace membership and membership-aware RLS.
--
-- This migration replaces the "no policies, no client grants" Phase 2 posture
-- with the intended Phase 4 posture: the database is the authoritative
-- authorization boundary, and every tenant row is reachable only through an
-- authenticated, workspace-scoped membership.
--
-- Phases 1-3 are unchanged. The public synthetic demo path (/api/demo/*) keeps
-- using its service_role-only SECURITY INVOKER RPCs against the fixed
-- atlas-demo/tashkent-demo workspace and is deliberately NOT a member of this
-- policy system: it can never read another workspace and it never becomes a
-- privilege escalator. Authenticated tenant access is a separate trust model
-- that requires membership even when the requested workspace is the demo one.

-- ---------------------------------------------------------------------------
-- Role model
-- ---------------------------------------------------------------------------

-- Roles are intentionally minimal and ordered by capability:
--   viewer  read-only workspace access
--   analyst viewer + analytical business data writes (locations, customers,
--           competitors, saved analysis locations)
--   admin   analyst + project/dataset administration and non-owner membership
--           administration
--   owner   full workspace administration including owner assignment
-- Authorization is a single role value per (workspace, user); there is no
-- permission engine and no organization-level parallel membership system.
CREATE TYPE public.workspace_member_role AS ENUM ('owner', 'admin', 'analyst', 'viewer');

COMMENT ON TYPE public.workspace_member_role IS
  'Workspace-scoped role. owner > admin > analyst > viewer; see docs/auth-security.md for the exact matrix.';

-- ---------------------------------------------------------------------------
-- Workspace membership
-- ---------------------------------------------------------------------------

CREATE TABLE public.workspace_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.workspace_member_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT workspace_members_workspace_user_unique UNIQUE (workspace_id, user_id),
  -- Membership is meaningless without its workspace. Deleting a workspace
  -- removes its memberships, but Phase 2 already restricts the deletion of any
  -- workspace that still owns projects or datasets.
  CONSTRAINT workspace_members_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE CASCADE,
  -- Supabase Auth is the only identity source; memberships are never keyed by
  -- an email address or an application-managed user id. Removing an auth user
  -- removes their memberships.
  CONSTRAINT workspace_members_user_fk
    FOREIGN KEY (user_id)
    REFERENCES auth.users (id)
    ON DELETE CASCADE
);

-- The membership lookup for "which workspaces may I see" is the hottest path in
-- Phase 4, so user_id is indexed separately from the composite unique key.
CREATE INDEX workspace_members_user_idx
  ON public.workspace_members (user_id);
CREATE INDEX workspace_members_workspace_role_idx
  ON public.workspace_members (workspace_id, role);

CREATE TRIGGER workspace_members_set_updated_at
  BEFORE UPDATE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.workspace_members IS
  'Workspace membership and role for an auth.users identity. This is the primary Phase 4 authorization boundary; there is no separate organization membership table.';
COMMENT ON COLUMN public.workspace_members.user_id IS
  'References auth.users(id). Memberships store no email, name or other auth profile data, so membership reads never leak auth-user private data.';

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------

-- The single SECURITY DEFINER helper in Phase 4.
--
-- Why it must be SECURITY DEFINER: every policy on public.workspace_members
-- needs to know the caller's role in a workspace, and a policy on that table
-- cannot query that table again (PostgreSQL RLS recursion). Confining the
-- privileged read to one STABLE, read-only, schema-qualified function keeps the
-- elevated surface auditable; every other helper is SECURITY INVOKER and builds
-- on this one.
--
-- Properties: no dynamic SQL, no writes, returns only the caller's own role
-- (never another user's role), fixed search_path = pg_catalog, EXECUTE revoked
-- from PUBLIC/anon and granted only to authenticated.
CREATE OR REPLACE FUNCTION public.workspace_role(p_workspace_id uuid)
RETURNS public.workspace_member_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT member.role
    FROM public.workspace_members AS member
   WHERE member.workspace_id = p_workspace_id
     AND member.user_id = auth.uid()
   LIMIT 1;
$function$;

COMMENT ON FUNCTION public.workspace_role(uuid) IS
  'Returns the calling user''s role in one workspace, or NULL when not a member (including anonymous callers). SECURITY DEFINER only to break workspace_members RLS recursion; read-only, fixed search_path, no dynamic SQL.';

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT public.workspace_role(p_workspace_id) IS NOT NULL;
$function$;

COMMENT ON FUNCTION public.is_workspace_member(uuid) IS
  'True when the calling user has any role in the workspace. SECURITY INVOKER; built on public.workspace_role(uuid).';

CREATE OR REPLACE FUNCTION public.has_workspace_role(
  p_workspace_id uuid,
  p_allowed_roles public.workspace_member_role[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT public.workspace_role(p_workspace_id) = ANY (p_allowed_roles);
$function$;

COMMENT ON FUNCTION public.has_workspace_role(uuid, public.workspace_member_role[]) IS
  'True when the calling user''s role in the workspace is one of the allowed roles. SECURITY INVOKER; built on public.workspace_role(uuid).';

REVOKE ALL ON FUNCTION public.workspace_role(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_role(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.is_workspace_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_member(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.has_workspace_role(uuid, public.workspace_member_role[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_workspace_role(uuid, public.workspace_member_role[])
  TO authenticated;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- A tenant record must never be moved to another workspace: that would let a
-- member of two workspaces (or a member of one who guesses another) relocate
-- rows across the authorization boundary instead of creating them where they
-- belong. Composite foreign keys still require (dataset_id, workspace_id) and
-- (project_id, workspace_id) pairs to belong to the same workspace, so this
-- trigger closes the remaining case where workspace_id itself changes.
CREATE OR REPLACE FUNCTION public.prevent_tenant_record_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Tenant records cannot be moved between workspaces';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.prevent_tenant_record_move() IS
  'BEFORE UPDATE trigger: rejects any change to workspace_id so tenant rows cannot be relocated across the authorization boundary. SECURITY INVOKER.';

CREATE OR REPLACE FUNCTION public.prevent_membership_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'A membership row cannot be re-pointed at another user or workspace';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.prevent_membership_reassignment() IS
  'BEFORE UPDATE trigger on workspace_members: only the role (and bookkeeping columns) may change. Re-pointing a membership would silently transfer authority. SECURITY INVOKER.';

-- Workspace slug and organization ownership are immutable in Phase 4. No
-- product flow renames slugs yet, and the public synthetic demo path resolves
-- its workspace by the atlas-demo/tashkent-demo slugs, so an authenticated
-- owner must not be able to rename the workspace out from under it.
CREATE OR REPLACE FUNCTION public.prevent_workspace_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Workspace organization and slug are immutable in Phase 4';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.prevent_workspace_identity_change() IS
  'BEFORE UPDATE trigger on workspaces: organization_id and slug are immutable so membership cannot be re-parented and the fixed synthetic demo slugs stay resolvable. SECURITY INVOKER.';

-- Last-owner protection. Runs as the caller (SECURITY INVOKER) because every
-- actor who is able to reach a membership mutation is already a member of that
-- workspace and can therefore see all of its membership rows under the
-- workspace_members SELECT policy. The elevated bootstrap path bypasses RLS
-- entirely, which is what allows the very first owner to be created.
CREATE OR REPLACE FUNCTION public.protect_workspace_last_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  remaining_owners bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    -- Promoting a member, or updating an owner without changing the role,
    -- never reduces the number of owners.
    RETURN NEW;
  END IF;

  SELECT pg_catalog.count(*)
    INTO remaining_owners
    FROM public.workspace_members AS member
   WHERE member.workspace_id = OLD.workspace_id
     AND member.role = 'owner'
     AND member.id <> OLD.id;

  IF remaining_owners = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A workspace must always retain at least one owner';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.protect_workspace_last_owner() IS
  'BEFORE UPDATE OR DELETE trigger on workspace_members: refuses to remove or demote the final owner. Runs for every path, including direct SQL, so it does not depend on UI or API checks. SECURITY INVOKER.';

-- ---------------------------------------------------------------------------
-- Integrity triggers: attach the enforcement points
-- ---------------------------------------------------------------------------
-- Functions alone enforce nothing, so every guard above is attached here. They
-- fire for every path (PostgREST, direct SQL, future server code) and do not
-- depend on any application or UI check.
CREATE TRIGGER projects_prevent_workspace_move
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER datasets_prevent_workspace_move
  BEFORE UPDATE ON public.datasets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER project_datasets_prevent_workspace_move
  BEFORE UPDATE ON public.project_datasets
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER locations_prevent_workspace_move
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER customers_prevent_workspace_move
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER competitors_prevent_workspace_move
  BEFORE UPDATE ON public.competitors
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER branches_prevent_workspace_move
  BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();
CREATE TRIGGER analysis_locations_prevent_workspace_move
  BEFORE UPDATE ON public.analysis_locations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_tenant_record_move();

CREATE TRIGGER workspace_members_prevent_reassignment
  BEFORE UPDATE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.prevent_membership_reassignment();
CREATE TRIGGER workspace_members_protect_last_owner
  BEFORE UPDATE OR DELETE ON public.workspace_members
  FOR EACH ROW EXECUTE FUNCTION public.protect_workspace_last_owner();

CREATE TRIGGER workspaces_prevent_identity_change
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.prevent_workspace_identity_change();

-- ---------------------------------------------------------------------------
-- Row Level Security: tenant tables
-- ---------------------------------------------------------------------------

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

-- organizations: readable only through membership of one of its workspaces.
-- No authenticated INSERT/UPDATE/DELETE: organizations are created by the
-- controlled server bootstrap only.
CREATE POLICY organizations_select_organization_member
  ON public.organizations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.workspaces AS workspace
       WHERE workspace.organization_id = organizations.id
         AND public.is_workspace_member(workspace.id)
    )
  );

-- workspaces: members read; owner/admin may update the Phase 4 supported
-- fields (name, metadata). INSERT and DELETE stay unavailable to clients.
CREATE POLICY workspaces_select_member
  ON public.workspaces
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(id));

CREATE POLICY workspaces_update_owner_admin
  ON public.workspaces
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(id, ARRAY['owner', 'admin']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- projects: members read; owner/admin write.
CREATE POLICY projects_select_member
  ON public.projects
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY projects_insert_owner_admin
  ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY projects_update_owner_admin
  ON public.projects
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY projects_delete_owner_admin
  ON public.projects
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- datasets: members read; owner/admin write. Analysts keep read-only access:
-- no Phase 4 workflow imports or creates datasets yet.
CREATE POLICY datasets_select_member
  ON public.datasets
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY datasets_insert_owner_admin
  ON public.datasets
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY datasets_update_owner_admin
  ON public.datasets
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY datasets_delete_owner_admin
  ON public.datasets
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- project_datasets: members read; owner/admin link and unlink. There is no
-- UPDATE policy because the composite primary key is the entire row.
CREATE POLICY project_datasets_select_member
  ON public.project_datasets
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY project_datasets_insert_owner_admin
  ON public.project_datasets
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY project_datasets_delete_owner_admin
  ON public.project_datasets
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- locations: members read; owner/admin/analyst write (analyst is the role that
-- maintains analytical business data).
CREATE POLICY locations_select_member
  ON public.locations
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY locations_insert_analyst
  ON public.locations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY locations_update_analyst
  ON public.locations
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY locations_delete_analyst
  ON public.locations
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

-- customers: members read; owner/admin/analyst write. RLS controls row access
-- only; the customer PII projection (id/kind/category) remains enforced
-- independently by the SQL projection, server DTOs and client parsers.
CREATE POLICY customers_select_member
  ON public.customers
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY customers_insert_analyst
  ON public.customers
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY customers_update_analyst
  ON public.customers
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY customers_delete_analyst
  ON public.customers
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

-- competitors: same baseline as locations.
CREATE POLICY competitors_select_member
  ON public.competitors
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY competitors_insert_analyst
  ON public.competitors
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY competitors_update_analyst
  ON public.competitors
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY competitors_delete_analyst
  ON public.competitors
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

-- branches: members read; owner/admin write. No Phase 4 workflow has an analyst
-- editing branches, so analysts stay read-only here on purpose.
CREATE POLICY branches_select_member
  ON public.branches
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY branches_insert_owner_admin
  ON public.branches
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY branches_update_owner_admin
  ON public.branches
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

CREATE POLICY branches_delete_owner_admin
  ON public.branches
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin']::public.workspace_member_role[]));

-- analysis_locations: members read; owner/admin/analyst write. Map clicks stay
-- transient in the browser and are only persisted by an explicit save.
CREATE POLICY analysis_locations_select_member
  ON public.analysis_locations
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY analysis_locations_insert_analyst
  ON public.analysis_locations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY analysis_locations_update_analyst
  ON public.analysis_locations
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

CREATE POLICY analysis_locations_delete_analyst
  ON public.analysis_locations
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner', 'admin', 'analyst']::public.workspace_member_role[]));

-- ---------------------------------------------------------------------------
-- Row Level Security: workspace_members
-- ---------------------------------------------------------------------------

-- Members see the membership roster of their own workspaces (the workspace
-- selector and member list). The table stores no auth profile columns.
CREATE POLICY workspace_members_select_member
  ON public.workspace_members
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(workspace_id));

-- Owners administer every role, including owner assignment.
CREATE POLICY workspace_members_insert_owner
  ON public.workspace_members
  FOR INSERT TO authenticated
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_member_role[]));

CREATE POLICY workspace_members_update_owner
  ON public.workspace_members
  FOR UPDATE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_member_role[]))
  WITH CHECK (public.has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_member_role[]));

CREATE POLICY workspace_members_delete_owner
  ON public.workspace_members
  FOR DELETE TO authenticated
  USING (public.has_workspace_role(workspace_id, ARRAY['owner']::public.workspace_member_role[]));

-- Admins may add and manage viewers, analysts and admins only. The INSERT and
-- UPDATE policies exclude the owner role in both directions, so an admin can
-- neither grant owner nor convert themselves (or anyone else) into an owner.
CREATE POLICY workspace_members_insert_admin
  ON public.workspace_members
  FOR INSERT TO authenticated
  WITH CHECK (
    public.has_workspace_role(workspace_id, ARRAY['admin']::public.workspace_member_role[])
    AND role = ANY (ARRAY['viewer', 'analyst', 'admin']::public.workspace_member_role[])
  );

CREATE POLICY workspace_members_update_admin
  ON public.workspace_members
  FOR UPDATE TO authenticated
  USING (
    public.has_workspace_role(workspace_id, ARRAY['admin']::public.workspace_member_role[])
    AND role = ANY (ARRAY['viewer', 'analyst', 'admin']::public.workspace_member_role[])
  )
  WITH CHECK (
    public.has_workspace_role(workspace_id, ARRAY['admin']::public.workspace_member_role[])
    AND role = ANY (ARRAY['viewer', 'analyst', 'admin']::public.workspace_member_role[])
  );

-- Admins may remove non-owner members; owner rows are invisible to this policy.
CREATE POLICY workspace_members_delete_admin
  ON public.workspace_members
  FOR DELETE TO authenticated
  USING (
    public.has_workspace_role(workspace_id, ARRAY['admin']::public.workspace_member_role[])
    AND role = ANY (ARRAY['viewer', 'analyst', 'admin']::public.workspace_member_role[])
  );

-- Viewers and analysts deliberately have no membership policy: they cannot read
-- other workspaces' rosters (handled by SELECT above) and cannot mutate
-- memberships at all.

-- ---------------------------------------------------------------------------
-- Table privileges
-- ---------------------------------------------------------------------------

-- Privileges are granted exactly where a policy exists, and nowhere else. RLS
-- remains enabled on every table, so a grant never implies row access.
--
-- The revoke comes first, and it names `authenticated` explicitly: Supabase
-- grants ALL privileges on new tables in `public` to anon/authenticated by
-- default (`ALTER DEFAULT PRIVILEGES`), which includes TRUNCATE. TRUNCATE is not
-- filtered by row level security, so an inherited TRUNCATE grant would be a real
-- hole even with RLS enabled. Phase 2 used the same revoke-then-grant shape.
REVOKE ALL PRIVILEGES ON TABLE
  public.organizations,
  public.workspaces,
  public.workspace_members,
  public.projects,
  public.datasets,
  public.project_datasets,
  public.locations,
  public.customers,
  public.competitors,
  public.branches,
  public.analysis_locations
FROM PUBLIC, anon, authenticated;

-- Granted back per table, exactly matching the policies defined above.
GRANT SELECT ON TABLE public.organizations TO authenticated;

GRANT SELECT, UPDATE ON TABLE public.workspaces TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workspace_members TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.datasets TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.project_datasets TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.locations,
  public.customers,
  public.competitors,
  public.branches,
  public.analysis_locations
TO authenticated;

-- anon keeps zero tenant privileges. The public demo path does not use anon
-- table grants; it uses its own service_role-only fixed-workspace RPCs.
-- service_role keeps the elevated access the platform grants it; that role is
-- never used for tenant reads or writes after a membership lookup.

-- ---------------------------------------------------------------------------
-- Authenticated tenant RPCs
-- ---------------------------------------------------------------------------

-- Authenticated equivalents of the Phase 3 demo RPCs. They differ in exactly
-- one way: the workspace is a parameter and authorization comes from RLS, not
-- from a hard-wired slug. Two independent layers protect every call —
--   1. the explicit membership assertion below, and
--   2. row level security on every table the query touches, which applies
--      because the functions are SECURITY INVOKER.
-- Even if a caller reaches these functions with another workspace's UUID, the
-- membership assertion raises and RLS would additionally return no rows.
CREATE OR REPLACE FUNCTION public.workspace_viewport_features(
  p_workspace_id uuid,
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_kinds text[] DEFAULT NULL,
  p_limit integer DEFAULT 2501
)
RETURNS TABLE (
  feature_id uuid,
  kind text,
  category text,
  display_name text,
  longitude double precision,
  latitude double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  viewport extensions.geography;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id is required';
  END IF;

  IF public.workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Workspace access requires membership';
  END IF;

  IF p_west IS NULL OR p_south IS NULL OR p_east IS NULL OR p_north IS NULL
     OR NOT (p_west BETWEEN -180 AND 180)
     OR NOT (p_east BETWEEN -180 AND 180)
     OR NOT (p_south BETWEEN -90 AND 90)
     OR NOT (p_north BETWEEN -90 AND 90)
     OR p_west > p_east
     OR p_south > p_north THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid viewport bounds';
  END IF;

  IF p_east - p_west > 40
     OR p_north - p_south > 20
     OR (p_east - p_west) * (p_north - p_south) > 400 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Viewport is too large';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2501 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid viewport result limit';
  END IF;

  IF p_kinds IS NOT NULL AND EXISTS (
    SELECT 1
      FROM pg_catalog.unnest(p_kinds) AS requested_kind(value)
     WHERE requested_kind.value IS NULL
        OR requested_kind.value NOT IN ('places', 'competitors', 'branches', 'customers')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid map feature kind';
  END IF;

  viewport := extensions.st_makeenvelope(
    p_west, p_south, p_east, p_north, 4326
  )::extensions.geography;

  RETURN QUERY
  WITH viewport_features AS (
    SELECT location.id AS feature_id,
           'places'::text AS feature_kind,
           location.category,
           location.name AS display_name,
           location.spatial_point
      FROM public.locations AS location
     WHERE location.workspace_id = p_workspace_id
       AND (p_kinds IS NULL OR 'places' = ANY (p_kinds))
       AND extensions.st_intersects(location.spatial_point, viewport)

    UNION ALL

    SELECT competitor.id,
           'competitors'::text,
           competitor.category,
           competitor.name,
           competitor.spatial_point
      FROM public.competitors AS competitor
     WHERE competitor.workspace_id = p_workspace_id
       AND (p_kinds IS NULL OR 'competitors' = ANY (p_kinds))
       AND extensions.st_intersects(competitor.spatial_point, viewport)

    UNION ALL

    SELECT branch.id,
           'branches'::text,
           'Branch'::text,
           branch.name,
           branch.spatial_point
      FROM public.branches AS branch
     WHERE branch.workspace_id = p_workspace_id
       AND (p_kinds IS NULL OR 'branches' = ANY (p_kinds))
       AND extensions.st_intersects(branch.spatial_point, viewport)

    UNION ALL

    -- Same PII-safe projection as the public demo path: customers contribute
    -- only id, kind and category.
    SELECT customer.id,
           'customers'::text,
           'Customer'::text,
           NULL::text,
           customer.spatial_point
      FROM public.customers AS customer
     WHERE customer.workspace_id = p_workspace_id
       AND (p_kinds IS NULL OR 'customers' = ANY (p_kinds))
       AND extensions.st_intersects(customer.spatial_point, viewport)
  )
  SELECT viewport_feature.feature_id,
         viewport_feature.feature_kind,
         viewport_feature.category,
         viewport_feature.display_name,
         extensions.st_x(viewport_feature.spatial_point::extensions.geometry),
         extensions.st_y(viewport_feature.spatial_point::extensions.geometry)
    FROM viewport_features AS viewport_feature
   ORDER BY viewport_feature.feature_kind, viewport_feature.feature_id
   LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.workspace_radius_analysis(
  p_workspace_id uuid,
  p_longitude double precision,
  p_latitude double precision,
  p_radius_meters double precision
)
RETURNS TABLE (
  customers_count bigint,
  customers_revenue_total text,
  competitors_count bigint,
  branches_count bigint,
  locations_count bigint,
  category_distribution jsonb,
  nearest_branch_id uuid,
  nearest_branch_name text,
  nearest_branch_distance_meters double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate extensions.geography;
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace id is required';
  END IF;

  IF public.workspace_role(p_workspace_id) IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Workspace access requires membership';
  END IF;

  IF p_longitude IS NULL OR p_latitude IS NULL
     OR NOT (p_longitude BETWEEN -180 AND 180)
     OR NOT (p_latitude BETWEEN -90 AND 90) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid analysis coordinates';
  END IF;

  IF p_radius_meters IS NULL OR NOT (p_radius_meters BETWEEN 100 AND 20000) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Radius must be between 100 and 20000 meters';
  END IF;

  candidate := extensions.st_setsrid(
    extensions.st_makepoint(p_longitude, p_latitude), 4326
  )::extensions.geography;

  RETURN QUERY
  WITH customer_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count,
           COALESCE(pg_catalog.sum(customer.revenue), 0)::text AS revenue_total
      FROM public.customers AS customer
     WHERE customer.workspace_id = p_workspace_id
       AND extensions.st_dwithin(
         customer.spatial_point, candidate, p_radius_meters, true
       )
  ),
  competitor_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count
      FROM public.competitors AS competitor
     WHERE competitor.workspace_id = p_workspace_id
       AND extensions.st_dwithin(
         competitor.spatial_point, candidate, p_radius_meters, true
       )
  ),
  branch_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count
      FROM public.branches AS branch
     WHERE branch.workspace_id = p_workspace_id
       AND extensions.st_dwithin(
         branch.spatial_point, candidate, p_radius_meters, true
       )
  ),
  location_metrics AS (
    SELECT pg_catalog.count(*)::bigint AS count
      FROM public.locations AS location
     WHERE location.workspace_id = p_workspace_id
       AND extensions.st_dwithin(
         location.spatial_point, candidate, p_radius_meters, true
       )
  ),
  category_metrics AS (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'kind', category_rows.kind,
          'category', category_rows.category,
          'count', category_rows.count
        ) ORDER BY category_rows.kind, category_rows.category
      ),
      '[]'::jsonb
    ) AS distribution
      FROM (
        SELECT 'places'::text AS kind,
               location.category,
               pg_catalog.count(*)::bigint AS count
          FROM public.locations AS location
         WHERE location.workspace_id = p_workspace_id
           AND extensions.st_dwithin(
             location.spatial_point, candidate, p_radius_meters, true
           )
         GROUP BY location.category

        UNION ALL

        SELECT 'competitors'::text,
               competitor.category,
               pg_catalog.count(*)::bigint
          FROM public.competitors AS competitor
         WHERE competitor.workspace_id = p_workspace_id
           AND extensions.st_dwithin(
             competitor.spatial_point, candidate, p_radius_meters, true
           )
         GROUP BY competitor.category
      ) AS category_rows
  ),
  nearest_branch AS (
    SELECT branch.id,
           branch.name,
           extensions.st_distance(branch.spatial_point, candidate, true)::double precision AS distance_meters
      FROM public.branches AS branch
     WHERE branch.workspace_id = p_workspace_id
     ORDER BY extensions.st_distance(branch.spatial_point, candidate, true), branch.id
     LIMIT 1
  )
  SELECT customer_metrics.count,
         customer_metrics.revenue_total,
         competitor_metrics.count,
         branch_metrics.count,
         location_metrics.count,
         category_metrics.distribution,
         nearest_branch.id,
         nearest_branch.name,
         nearest_branch.distance_meters
    FROM customer_metrics
    CROSS JOIN competitor_metrics
    CROSS JOIN branch_metrics
    CROSS JOIN location_metrics
    CROSS JOIN category_metrics
    LEFT JOIN nearest_branch ON true;
END;
$function$;

REVOKE ALL ON FUNCTION public.workspace_viewport_features(
  uuid, double precision, double precision, double precision, double precision, text[], integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_viewport_features(
  uuid, double precision, double precision, double precision, double precision, text[], integer
) TO authenticated;

REVOKE ALL ON FUNCTION public.workspace_radius_analysis(
  uuid, double precision, double precision, double precision
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_radius_analysis(
  uuid, double precision, double precision, double precision
) TO authenticated;

COMMENT ON FUNCTION public.workspace_viewport_features(
  uuid, double precision, double precision, double precision, double precision, text[], integer
) IS
  'Membership-checked, RLS-filtered viewport features for one workspace. SECURITY INVOKER so row level security applies; the workspace id is untrusted input and the membership assertion is only the first of the two layers.';

COMMENT ON FUNCTION public.workspace_radius_analysis(
  uuid, double precision, double precision, double precision
) IS
  'Membership-checked, RLS-filtered radius aggregates for one workspace. SECURITY INVOKER so row level security applies; returns aggregates only, never customer rows.';

-- ---------------------------------------------------------------------------
-- First-owner bootstrap (controlled server/operator path)
-- ---------------------------------------------------------------------------

-- Creates the organization, workspace and first owner membership atomically, or
-- ensures the owner membership when the workspace already exists. This is the
-- only supported way to create an organization or a workspace in Phase 4, and it
-- is deliberately not reachable from an authenticated session: EXECUTE is
-- revoked from PUBLIC/anon/authenticated and granted only to service_role, which
-- is the elevated, server-only credential.
--
-- SECURITY DEFINER is required because the caller must be able to insert rows
-- into RLS-protected ownership tables without being a member yet. The function
-- is narrowly scoped: fixed search_path, schema-qualified references, no dynamic
-- SQL, strict parameter validation, and it can only ever grant the owner role.
CREATE OR REPLACE FUNCTION public.bootstrap_workspace_owner(
  p_organization_slug text,
  p_organization_name text,
  p_workspace_slug text,
  p_workspace_name text,
  p_owner_user_id uuid
)
RETURNS TABLE (
  organization_id uuid,
  workspace_id uuid,
  membership_id uuid,
  created_workspace boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  organization uuid;
  workspace uuid;
  membership uuid;
  membership_rows integer;
  workspace_created boolean := false;
BEGIN
  IF p_organization_slug IS NULL OR p_organization_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid organization slug';
  END IF;
  IF p_workspace_slug IS NULL OR p_workspace_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid workspace slug';
  END IF;
  IF p_organization_name IS NULL
     OR pg_catalog.char_length(pg_catalog.btrim(p_organization_name)) = 0
     OR pg_catalog.char_length(p_organization_name) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid organization name';
  END IF;
  IF p_workspace_name IS NULL
     OR pg_catalog.char_length(pg_catalog.btrim(p_workspace_name)) = 0
     OR pg_catalog.char_length(p_workspace_name) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid workspace name';
  END IF;
  IF p_owner_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Owner user id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.id = p_owner_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Owner must be an existing auth user';
  END IF;

  -- Note: this function deliberately avoids `ON CONFLICT (column, ...)` inside
  -- its body. The output parameter names (organization_id, workspace_id) would
  -- collide with those unqualified column references at plpgsql parse time, so
  -- idempotency is expressed with an explicit re-select plus a unique_violation
  -- guard, which is equally race-safe.
  SELECT organization_row.id
    INTO organization
    FROM public.organizations AS organization_row
   WHERE organization_row.slug = p_organization_slug;

  IF organization IS NULL THEN
    BEGIN
      INSERT INTO public.organizations (name, slug, metadata)
      VALUES (pg_catalog.btrim(p_organization_name), p_organization_slug, '{"bootstrap": true}'::jsonb);
    EXCEPTION WHEN unique_violation THEN
      NULL; -- a concurrent bootstrap won the race; the re-select below resolves it
    END;

    SELECT organization_row.id
      INTO organization
      FROM public.organizations AS organization_row
     WHERE organization_row.slug = p_organization_slug;
  END IF;

  IF organization IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Organization could not be created';
  END IF;

  SELECT workspace_row.id
    INTO workspace
    FROM public.workspaces AS workspace_row
   WHERE workspace_row.organization_id = organization
     AND workspace_row.slug = p_workspace_slug;

  workspace_created := workspace IS NULL;

  IF workspace IS NULL THEN
    BEGIN
      INSERT INTO public.workspaces (organization_id, name, slug, metadata)
      VALUES (
        organization,
        pg_catalog.btrim(p_workspace_name),
        p_workspace_slug,
        '{"bootstrap": true}'::jsonb
      );
    EXCEPTION WHEN unique_violation THEN
      NULL; -- a concurrent bootstrap won the race; the re-select below resolves it
    END;

    SELECT workspace_row.id
      INTO workspace
      FROM public.workspaces AS workspace_row
     WHERE workspace_row.organization_id = organization
       AND workspace_row.slug = p_workspace_slug;
  END IF;

  IF workspace IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Workspace could not be created';
  END IF;

  -- Ensure the owner membership. Re-running the bootstrap for the recorded
  -- operator user restores or confirms their owner role; it never creates a
  -- second membership row.
  UPDATE public.workspace_members AS member
     SET role = 'owner'
   WHERE member.workspace_id = workspace
     AND member.user_id = p_owner_user_id;
  GET DIAGNOSTICS membership_rows = ROW_COUNT;

  IF membership_rows = 0 THEN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (workspace, p_owner_user_id, 'owner');
  END IF;

  SELECT member.id
    INTO membership
    FROM public.workspace_members AS member
   WHERE member.workspace_id = workspace
     AND member.user_id = p_owner_user_id;

  RETURN QUERY SELECT organization, workspace, membership, workspace_created;
END;
$function$;

REVOKE ALL ON FUNCTION public.bootstrap_workspace_owner(text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bootstrap_workspace_owner(text, text, text, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.bootstrap_workspace_owner(text, text, text, text, uuid) IS
  'Operator/server-only first-owner bootstrap: atomically creates (or reuses) the organization and workspace and grants the owner membership. service_role EXECUTE only.';

-- Grants or restores the owner role for an existing workspace. Still
-- service_role only: owner assignment is never available to admins and never
-- available to a self-serving authenticated session.
CREATE OR REPLACE FUNCTION public.grant_workspace_owner(
  p_workspace_id uuid,
  p_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  membership uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Workspace and user id are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces AS workspace WHERE workspace.id = p_workspace_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Workspace not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.id = p_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Owner must be an existing auth user';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (p_workspace_id, p_user_id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner'
  RETURNING id INTO membership;

  RETURN membership;
END;
$function$;

REVOKE ALL ON FUNCTION public.grant_workspace_owner(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_workspace_owner(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.grant_workspace_owner(uuid, uuid) IS
  'Operator/server-only owner assignment for an existing workspace. service_role EXECUTE only; admins use the workspace_members policies for all other roles.';
