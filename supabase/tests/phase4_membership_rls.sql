-- Phase 4 workspace membership and Row Level Security assertions.
--
-- Run only against a local/test Supabase database after `supabase db reset`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase4_membership_rls.sql
--
-- Every scenario runs as a real database role (`authenticated`, `anon`,
-- `service_role`) with real JWT claims in `request.jwt.claims`, so the policies
-- under test are exactly the policies PostgREST applies. Nothing relies on
-- application checks, hidden UI or client-side filtering, and every change is
-- rolled back.
--
-- Denied INSERTs raise insufficient_privilege; denied UPDATE/DELETE usually
-- match zero rows, because RLS filters the USING clause. Both shapes are
-- asserted explicitly.
BEGIN;

-- ---------------------------------------------------------------------------
-- Preflight: deterministic seed identities and memberships
-- ---------------------------------------------------------------------------
DO $phase4_preflight$
DECLARE
  missing text;
BEGIN
  SELECT pg_catalog.string_agg(expected.email, ', ')
    INTO missing
    FROM (VALUES
      ('owner-a@example.test'),
      ('admin-a@example.test'),
      ('analyst-a@example.test'),
      ('viewer-a@example.test'),
      ('owner-b@example.test'),
      ('outsider@example.test')
    ) AS expected(email)
   WHERE NOT EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.email = expected.email);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Deterministic Phase 4 identities are missing: %', missing;
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.workspace_members) < 5 THEN
    RAISE EXCEPTION 'Seed workspace memberships are missing';
  END IF;

  RAISE NOTICE 'Preflight: six deterministic auth identities and the seeded memberships are present';
END;
$phase4_preflight$;

-- ---------------------------------------------------------------------------
-- Test scaffolding (created as the superuser / table owner, used by the roles)
-- ---------------------------------------------------------------------------

-- The seeded per-workspace row counts. The expectations are computed from the
-- data itself, so the suite keeps working when the synthetic seed grows, while
-- every scenario still asserts an exact match with what RLS should expose.
CREATE TEMP TABLE phase4_expected (
  relation_name text PRIMARY KEY,
  workspace_a_rows bigint NOT NULL,
  workspace_b_rows bigint NOT NULL
);

INSERT INTO phase4_expected (relation_name, workspace_a_rows, workspace_b_rows)
SELECT seed_relation.relation_name,
       (SELECT pg_catalog.count(*) FROM public.projects WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.projects WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
  FROM (VALUES ('projects')) AS seed_relation(relation_name)
UNION ALL SELECT 'datasets',
       (SELECT pg_catalog.count(*) FROM public.datasets WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.datasets WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'project_datasets',
       (SELECT pg_catalog.count(*) FROM public.project_datasets WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.project_datasets WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'locations',
       (SELECT pg_catalog.count(*) FROM public.locations WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.locations WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'customers',
       (SELECT pg_catalog.count(*) FROM public.customers WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.customers WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'competitors',
       (SELECT pg_catalog.count(*) FROM public.competitors WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.competitors WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'branches',
       (SELECT pg_catalog.count(*) FROM public.branches WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.branches WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'analysis_locations',
       (SELECT pg_catalog.count(*) FROM public.analysis_locations WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.analysis_locations WHERE workspace_id = '00000000-0000-4000-8000-000000000011')
UNION ALL SELECT 'workspace_members',
       (SELECT pg_catalog.count(*) FROM public.workspace_members WHERE workspace_id = '00000000-0000-4000-8000-000000000010'),
       (SELECT pg_catalog.count(*) FROM public.workspace_members WHERE workspace_id = '00000000-0000-4000-8000-000000000011');

-- Asserts that the caller sees exactly the authorized rows: every workspace A
-- row, no workspace B row. Executed with the caller's own privileges, so RLS
-- does the filtering and the expectation is the independent check.
CREATE FUNCTION pg_temp.phase4_expect_scope(
  p_expect_workspace_a boolean,
  p_expect_workspace_b boolean
)
RETURNS void
LANGUAGE plpgsql
AS $phase4_scope$
DECLARE
  expected record;
  visible_a bigint;
  visible_b bigint;
BEGIN
  FOR expected IN SELECT * FROM pg_temp.phase4_expected ORDER BY relation_name LOOP
    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.count(*) FROM public.%I WHERE workspace_id = %L',
      expected.relation_name, '00000000-0000-4000-8000-000000000010'
    ) INTO visible_a;
    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.count(*) FROM public.%I WHERE workspace_id = %L',
      expected.relation_name, '00000000-0000-4000-8000-000000000011'
    ) INTO visible_b;

    IF p_expect_workspace_a AND visible_a <> expected.workspace_a_rows THEN
      RAISE EXCEPTION '%: caller sees % workspace A rows, expected %',
        expected.relation_name, visible_a, expected.workspace_a_rows;
    END IF;
    IF NOT p_expect_workspace_a AND visible_a <> 0 THEN
      RAISE EXCEPTION '%: caller sees % workspace A rows without a membership',
        expected.relation_name, visible_a;
    END IF;
    IF p_expect_workspace_b AND visible_b <> expected.workspace_b_rows THEN
      RAISE EXCEPTION '%: caller sees % workspace B rows, expected %',
        expected.relation_name, visible_b, expected.workspace_b_rows;
    END IF;
    IF NOT p_expect_workspace_b AND visible_b <> 0 THEN
      RAISE EXCEPTION '%: caller sees % workspace B rows without a membership',
        expected.relation_name, visible_b;
    END IF;
  END LOOP;
END;
$phase4_scope$;

GRANT SELECT ON pg_temp.phase4_expected TO authenticated;

-- A second organization exists only so the "re-parent a workspace" scenario has
-- a genuinely different organization to target; no workspace belongs to it, so
-- it stays invisible to every member under the organizations policy.
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-4000-8000-00000000face', 'Phase 4 Other Org', 'phase4-other-org');

-- Capture the Phase 3 demo RPC output through its service_role-only path so the
-- authenticated twins can be compared field by field for the same workspace and
-- the same inputs.
SET LOCAL ROLE service_role;
CREATE TEMP TABLE phase4_demo_viewport AS
SELECT * FROM public.demo_viewport_features(69.20, 41.25, 69.36, 41.37, NULL, 2501);
CREATE TEMP TABLE phase4_demo_radius AS
SELECT * FROM public.demo_radius_analysis(69.2897, 41.3111, 500);
RESET ROLE;

GRANT SELECT ON phase4_demo_viewport, phase4_demo_radius TO authenticated;

-- ---------------------------------------------------------------------------
-- Bootstrap (operator path): service_role only
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';
DO $phase4_bootstrap_denied$
DECLARE
  denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.bootstrap_workspace_owner(
      'phase4-test-org', 'Phase 4 Test Org', 'phase4-test-workspace', 'Phase 4 Test Workspace',
      'd1000000-0000-4000-8000-000000000001'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Authenticated caller executed the owner bootstrap'; END IF;

  denied := false;
  BEGIN
    PERFORM public.grant_workspace_owner(
      '00000000-0000-4000-8000-000000000010',
      'a1000000-0000-4000-8000-000000000004'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Authenticated caller granted the owner role directly'; END IF;

  RAISE NOTICE 'Bootstrap: authenticated callers are refused the operator path';
END;
$phase4_bootstrap_denied$;

SET LOCAL ROLE service_role;
DO $phase4_bootstrap_operator$
DECLARE
  first_call record;
  second_call record;
  created_role public.workspace_member_role;
BEGIN
  SELECT * INTO first_call FROM public.bootstrap_workspace_owner(
    'phase4-test-org', 'Phase 4 Test Org', 'phase4-test-workspace', 'Phase 4 Test Workspace',
    'd1000000-0000-4000-8000-000000000001'
  );
  IF first_call.workspace_id IS NULL OR first_call.membership_id IS NULL THEN
    RAISE EXCEPTION 'Bootstrap did not return the created workspace and membership';
  END IF;
  IF first_call.created_workspace IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Bootstrap did not report the new workspace as created';
  END IF;

  SELECT role INTO created_role FROM public.workspace_members WHERE id = first_call.membership_id;
  IF created_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Bootstrap did not grant the owner role';
  END IF;

  SELECT * INTO second_call FROM public.bootstrap_workspace_owner(
    'phase4-test-org', 'Phase 4 Test Org', 'phase4-test-workspace', 'Phase 4 Test Workspace',
    'd1000000-0000-4000-8000-000000000001'
  );
  IF second_call.workspace_id IS DISTINCT FROM first_call.workspace_id THEN
    RAISE EXCEPTION 'Repeated bootstrap created a second workspace instead of reusing it';
  END IF;
  IF second_call.created_workspace IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Repeated bootstrap reported a false creation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = first_call.workspace_id
       AND user_id = 'd1000000-0000-4000-8000-000000000001'
       AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Bootstrap membership is missing after the second call';
  END IF;

  RAISE NOTICE 'Bootstrap: service_role creates organization, workspace and first owner atomically and idempotently';
END;
$phase4_bootstrap_operator$;

-- ---------------------------------------------------------------------------
-- Helper functions: authorization facts only, no public oracle
-- ---------------------------------------------------------------------------
SET LOCAL ROLE anon;
-- Adversarial: even if an anon request carried a valid-looking user claim, the
-- anon role must not reach tenant data or the membership helpers.
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"anon"}';
DO $phase4_anon$
DECLARE
  denied boolean;
BEGIN
  -- anon holds no table privileges at all, so it is refused before RLS is even
  -- consulted: not an empty result set, a privilege error.
  IF pg_catalog.has_table_privilege('anon', 'public.workspaces', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.locations', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.customers', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.workspace_members', 'SELECT') THEN
    RAISE EXCEPTION 'anon holds SELECT on a tenant table';
  END IF;

  denied := false;
  BEGIN
    PERFORM 1 FROM public.workspaces;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon read workspaces'; END IF;

  denied := false;
  BEGIN
    PERFORM 1 FROM public.workspace_members;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon read the membership roster'; END IF;

  denied := false;
  BEGIN
    PERFORM public.workspace_role('00000000-0000-4000-8000-000000000010');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon executed workspace_role'; END IF;

  denied := false;
  BEGIN
    PERFORM public.is_workspace_member('00000000-0000-4000-8000-000000000010');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon executed is_workspace_member'; END IF;

  denied := false;
  BEGIN
    PERFORM public.has_workspace_role(
      '00000000-0000-4000-8000-000000000010', ARRAY['owner']::public.workspace_member_role[]
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon executed has_workspace_role'; END IF;

  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon executed the tenant viewport RPC'; END IF;

  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_radius_analysis('00000000-0000-4000-8000-000000000010', 69.2897, 41.3111, 500);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon executed the tenant radius RPC'; END IF;

  RAISE NOTICE 'anon: zero tenant reads, zero RPCs and no helper execution, even with a forged user claim';
END;
$phase4_anon$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';
DO $phase4_authenticated_demo_boundary$
DECLARE
  denied boolean;
BEGIN
  -- The public demo RPCs stay on the elevated server-only path: an ordinary
  -- authenticated session cannot call them.
  denied := false;
  BEGIN
    PERFORM * FROM public.demo_viewport_features(69.20, 41.25, 69.36, 41.37, NULL, 2501);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'An authenticated member executed the public demo viewport RPC'; END IF;

  denied := false;
  BEGIN
    PERFORM * FROM public.demo_radius_analysis(69.2897, 41.3111, 500);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'An authenticated member executed the public demo radius RPC'; END IF;

  RAISE NOTICE 'Helpers: the public demo RPCs remain service_role-only';
END;
$phase4_authenticated_demo_boundary$;

DO $phase4_helpers$
BEGIN
  IF public.workspace_role('00000000-0000-4000-8000-000000000010') IS DISTINCT FROM 'analyst' THEN
    RAISE EXCEPTION 'workspace_role did not report the caller role in their own workspace';
  END IF;
  IF public.workspace_role('00000000-0000-4000-8000-000000000011') IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_role disclosed a role in a workspace the caller does not belong to';
  END IF;
  IF public.is_workspace_member('00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'is_workspace_member returned true for a foreign workspace';
  END IF;
  IF public.has_workspace_role('00000000-0000-4000-8000-000000000010', ARRAY['owner']::public.workspace_member_role[]) THEN
    RAISE EXCEPTION 'has_workspace_role reported an owner role for an analyst';
  END IF;
  IF NOT public.has_workspace_role('00000000-0000-4000-8000-000000000010', ARRAY['owner','admin','analyst']::public.workspace_member_role[]) THEN
    RAISE EXCEPTION 'has_workspace_role did not report the caller role';
  END IF;
  IF public.workspace_role(NULL) IS NOT NULL OR public.is_workspace_member(NULL) THEN
    RAISE EXCEPTION 'The helpers answered for a NULL workspace';
  END IF;

  RAISE NOTICE 'Helpers: only the caller''s own role is disclosed; foreign and NULL workspaces report NULL/false';
END;
$phase4_helpers$;

-- ---------------------------------------------------------------------------
-- VIEWER: read-only, including the read-only GIS RPCs
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000004","role":"authenticated"}';
DO $phase4_viewer$
DECLARE
  affected integer;
  denied boolean;
  viewport_rows bigint;
  radius_row record;
BEGIN
  -- PASS: exactly the authorized rows, nothing from workspace B.
  PERFORM pg_temp.phase4_expect_scope(true, false);

  IF (SELECT pg_catalog.count(*) FROM public.workspaces) <> 1 THEN
    RAISE EXCEPTION 'Viewer does not see exactly one workspace';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '00000000-0000-4000-8000-000000000010') THEN
    RAISE EXCEPTION 'Viewer cannot read their own workspace';
  END IF;

  -- PASS: the read-only GIS surface works for a viewer.
  SELECT pg_catalog.count(*) INTO viewport_rows
    FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, ARRAY['places'], 2501
    );
  IF viewport_rows = 0 THEN RAISE EXCEPTION 'Viewer could not use the authenticated viewport RPC'; END IF;

  SELECT * INTO radius_row
    FROM public.workspace_radius_analysis('00000000-0000-4000-8000-000000000010', 69.2897, 41.3111, 500);
  IF radius_row.customers_count IS NULL THEN
    RAISE EXCEPTION 'Viewer could not use the authenticated radius RPC';
  END IF;

  -- FAIL: no writes anywhere.
  denied := false;
  BEGIN
    INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000030',
      'Viewer insert attempt', 'test-only', 'SRID=4326;POINT(69.3 41.3)'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Viewer inserted a location'; END IF;

  denied := false;
  BEGIN
    INSERT INTO public.projects (workspace_id, name) VALUES ('00000000-0000-4000-8000-000000000010', 'Viewer project');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Viewer inserted a project'; END IF;

  denied := false;
  BEGIN
    INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020',
      'Viewer candidate', 'SRID=4326;POINT(69.3 41.3)'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Viewer persisted an analysis location'; END IF;

  UPDATE public.projects SET name = 'Viewer rewrite' WHERE id = '00000000-0000-4000-8000-000000000020';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Viewer updated a project'; END IF;

  UPDATE public.customers SET segment = 'viewer-rewrite'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Viewer updated customers'; END IF;

  DELETE FROM public.locations WHERE workspace_id = '00000000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Viewer deleted locations'; END IF;

  -- FAIL: workspace settings and membership mutations, including self-promotion.
  UPDATE public.workspaces SET name = 'Viewer rewrite' WHERE id = '00000000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Viewer updated workspace settings'; END IF;

  denied := false;
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES ('00000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001', 'viewer');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Viewer inserted a membership'; END IF;

  UPDATE public.workspace_members SET role = 'owner'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000004';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Viewer escalated their own role'; END IF;

  DELETE FROM public.workspace_members
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000002';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Viewer deleted a membership'; END IF;

  IF public.workspace_role('00000000-0000-4000-8000-000000000010') IS DISTINCT FROM 'viewer' THEN
    RAISE EXCEPTION 'Viewer role changed during the viewer scenario';
  END IF;

  RAISE NOTICE 'Viewer: exact reads, read-only GIS RPCs, no writes, no settings and no membership mutations';
END;
$phase4_viewer$;

-- ---------------------------------------------------------------------------
-- ANALYST: analytical writes, no administration
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';
DO $phase4_analyst$
DECLARE
  affected integer;
  denied boolean;
  inserted_location uuid;
  inserted_candidate uuid;
BEGIN
  PERFORM pg_temp.phase4_expect_scope(true, false);

  -- PASS: analytical writes inside their own workspace.
  INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
  VALUES (
    '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000030',
    'Analyst analytical location', 'test-only', 'SRID=4326;POINT(69.2810 41.3120)'
  ) RETURNING id INTO inserted_location;
  IF inserted_location IS NULL THEN RAISE EXCEPTION 'Analyst could not insert an analytical location'; END IF;

  UPDATE public.locations SET category = 'test-only-updated' WHERE id = inserted_location;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Analyst could not update their analytical location'; END IF;

  DELETE FROM public.locations WHERE id = inserted_location;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Analyst could not delete their analytical location'; END IF;

  -- A saved candidate is an explicit analyst action (map clicks are never
  -- auto-persisted); an analyst can save, rename and discard their own.
  INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
  VALUES (
    '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020',
    'Analyst saved candidate', 'SRID=4326;POINT(69.2820 41.3130)'
  ) RETURNING id INTO inserted_candidate;

  UPDATE public.analysis_locations SET name = 'Analyst saved candidate renamed' WHERE id = inserted_candidate;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Analyst could not update a saved candidate'; END IF;

  DELETE FROM public.analysis_locations WHERE id = inserted_candidate;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Analyst could not delete a saved candidate'; END IF;

  UPDATE public.customers SET segment = 'analyst-updated'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND external_id IS NOT NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 0 THEN RAISE EXCEPTION 'Analyst could not update business records'; END IF;

  -- FAIL: no project/dataset administration.
  denied := false;
  BEGIN
    INSERT INTO public.projects (workspace_id, name) VALUES ('00000000-0000-4000-8000-000000000010', 'Analyst project');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Analyst inserted a project'; END IF;

  denied := false;
  BEGIN
    INSERT INTO public.datasets (workspace_id, name, dataset_type)
    VALUES ('00000000-0000-4000-8000-000000000010', 'Analyst dataset', 'locations');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Analyst inserted a dataset'; END IF;

  UPDATE public.projects SET name = 'Analyst rewrite' WHERE id = '00000000-0000-4000-8000-000000000020';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Analyst updated a project'; END IF;

  DELETE FROM public.datasets WHERE id = '00000000-0000-4000-8000-000000000031';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Analyst deleted a dataset'; END IF;

  -- FAIL: branches stay owner/admin-only by design.
  denied := false;
  BEGIN
    INSERT INTO public.branches (workspace_id, dataset_id, name, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000032',
      'Analyst branch', 'SRID=4326;POINT(69.2830 41.3140)'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Analyst inserted a branch'; END IF;

  -- FAIL: membership administration and self-promotion.
  denied := false;
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES ('00000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000003', 'admin');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Analyst inserted themselves as an admin'; END IF;

  UPDATE public.workspace_members SET role = 'admin'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Analyst promoted themselves to admin'; END IF;

  IF public.workspace_role('00000000-0000-4000-8000-000000000010') IS DISTINCT FROM 'analyst' THEN
    RAISE EXCEPTION 'Analyst role changed during the analyst scenario';
  END IF;

  RAISE NOTICE 'Analyst: analytical writes only; no project/dataset/branch administration and no membership mutation';
END;
$phase4_analyst$;

-- ---------------------------------------------------------------------------
-- ANALYST: cross-workspace and tampered identifiers
-- ---------------------------------------------------------------------------
DO $phase4_cross_workspace$
DECLARE
  affected integer;
  denied boolean;
BEGIN
  -- FAIL: reading another workspace.
  IF EXISTS (SELECT 1 FROM public.locations WHERE workspace_id = '00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Analyst read a foreign workspace''s locations';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE workspace_id = '00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Analyst read a foreign workspace''s customers';
  END IF;
  IF EXISTS (SELECT 1 FROM public.projects WHERE workspace_id = '00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Analyst read a foreign workspace''s projects';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspace_members WHERE workspace_id = '00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Analyst read a foreign workspace''s roster';
  END IF;

  -- FAIL: writing into another workspace.
  denied := false;
  BEGIN
    INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000034',
      'Cross-workspace location', 'test-only', 'SRID=4326;POINT(69.29 41.32)'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Analyst wrote into a foreign workspace'; END IF;

  UPDATE public.locations SET name = 'Cross-workspace rewrite'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000011';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Analyst updated a foreign workspace row'; END IF;

  DELETE FROM public.locations WHERE workspace_id = '00000000-0000-4000-8000-000000000011';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Analyst deleted a foreign workspace row'; END IF;

  UPDATE public.customers SET segment = 'cross-workspace'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000011';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Analyst updated a foreign workspace customer'; END IF;

  -- FAIL: relocating an own-workspace row into another workspace.
  denied := false;
  BEGIN
    UPDATE public.locations
       SET workspace_id = '00000000-0000-4000-8000-000000000011'
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND external_id IS NOT NULL;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Analyst moved a row into another workspace'; END IF;

  -- FAIL: dataset tampering — a workspace A row cannot reference workspace B's dataset.
  denied := false;
  BEGIN
    INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000034',
      'Tampered dataset reference', 'test-only', 'SRID=4326;POINT(69.2910 41.3210)'
    );
  EXCEPTION WHEN foreign_key_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A foreign dataset reference was accepted'; END IF;

  -- FAIL: retagging an existing row onto a foreign dataset.
  denied := false;
  BEGIN
    UPDATE public.locations
       SET dataset_id = '00000000-0000-4000-8000-000000000034'
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND external_id IS NOT NULL;
  EXCEPTION WHEN foreign_key_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A foreign dataset retag was accepted'; END IF;

  -- FAIL: project tampering through analysis_locations.
  denied := false;
  BEGIN
    INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000021',
      'Tampered project reference', 'SRID=4326;POINT(69.2920 41.3220)'
    );
  EXCEPTION WHEN foreign_key_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A foreign project reference was accepted'; END IF;

  RAISE NOTICE 'Cross-workspace: reads, writes, row moves and dataset/project tampering are all refused';
END;
$phase4_cross_workspace$;

-- ---------------------------------------------------------------------------
-- ADMIN: data administration and non-owner membership administration
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated"}';
DO $phase4_admin$
DECLARE
  affected integer;
  denied boolean;
  created_project uuid;
  created_dataset uuid;
BEGIN
  PERFORM pg_temp.phase4_expect_scope(true, false);

  -- PASS: project, dataset and project_datasets administration.
  INSERT INTO public.projects (workspace_id, name) VALUES ('00000000-0000-4000-8000-000000000010', 'Admin project')
  RETURNING id INTO created_project;
  IF created_project IS NULL THEN RAISE EXCEPTION 'Admin could not create a project'; END IF;

  UPDATE public.projects SET name = 'Admin project renamed' WHERE id = created_project;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not update a project'; END IF;

  INSERT INTO public.datasets (workspace_id, name, dataset_type)
  VALUES ('00000000-0000-4000-8000-000000000010', 'Admin dataset', 'locations')
  RETURNING id INTO created_dataset;
  IF created_dataset IS NULL THEN RAISE EXCEPTION 'Admin could not create a dataset'; END IF;

  INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
  VALUES (created_project, created_dataset, '00000000-0000-4000-8000-000000000010');

  DELETE FROM public.project_datasets
   WHERE project_id = created_project AND dataset_id = created_dataset;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not unlink a project dataset'; END IF;

  DELETE FROM public.projects WHERE id = created_project;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not delete a project'; END IF;

  DELETE FROM public.datasets WHERE id = created_dataset;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not delete a dataset'; END IF;

  -- PASS: business data and branches.
  INSERT INTO public.branches (workspace_id, dataset_id, name, spatial_point)
  VALUES (
    '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000032',
    'Admin branch', 'SRID=4326;POINT(69.2840 41.3150)'
  );
  DELETE FROM public.branches
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010' AND name = 'Admin branch';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not delete a branch'; END IF;

  -- PASS: workspace settings.
  UPDATE public.workspaces SET name = 'Tashkent Synthetic Demo Workspace'
   WHERE id = '00000000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not update workspace settings'; END IF;

  -- PASS: manage non-owner memberships.
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES ('00000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001', 'viewer');

  UPDATE public.workspace_members SET role = 'analyst'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'c1000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not change a viewer to analyst'; END IF;

  UPDATE public.workspace_members SET role = 'admin'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'c1000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not promote a member to admin'; END IF;

  DELETE FROM public.workspace_members
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'c1000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Admin could not remove a non-owner member'; END IF;

  -- FAIL: owner assignment and owner administration.
  denied := false;
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES ('00000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001', 'owner');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Admin granted the owner role'; END IF;

  denied := false;
  BEGIN
    UPDATE public.workspace_members SET role = 'owner'
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND user_id = 'a1000000-0000-4000-8000-000000000002';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Admin promoted themselves to owner'; END IF;

  -- The role is unchanged after the refused escalation.
  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_members
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND user_id = 'a1000000-0000-4000-8000-000000000002'
       AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin row no longer has the admin role after the refused escalation';
  END IF;

  UPDATE public.workspace_members SET role = 'viewer'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Admin demoted an owner'; END IF;

  DELETE FROM public.workspace_members
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Admin removed an owner'; END IF;

  IF (SELECT pg_catalog.count(*) FROM public.workspace_members
       WHERE workspace_id = '00000000-0000-4000-8000-000000000010' AND role = 'owner') <> 1 THEN
    RAISE EXCEPTION 'Owner count changed unexpectedly during the admin scenario';
  END IF;

  -- FAIL: cross-workspace administration.
  denied := false;
  BEGIN
    INSERT INTO public.projects (workspace_id, name) VALUES ('00000000-0000-4000-8000-000000000011', 'Admin foreign project');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Admin created a project in a foreign workspace'; END IF;

  UPDATE public.workspaces SET name = 'Admin rewrite' WHERE id = '00000000-0000-4000-8000-000000000011';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Admin renamed a foreign workspace'; END IF;

  IF public.workspace_role('00000000-0000-4000-8000-000000000010') IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'Admin role changed during the admin scenario';
  END IF;

  RAISE NOTICE 'Admin: full data administration and non-owner membership management; no owner assignment and no cross-workspace access';
END;
$phase4_admin$;

-- ---------------------------------------------------------------------------
-- OWNER: full administration with last-owner protection
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}';
DO $phase4_owner$
DECLARE
  affected integer;
  denied boolean;
  touched uuid;
BEGIN
  PERFORM pg_temp.phase4_expect_scope(true, false);

  -- PASS: workspace settings.
  UPDATE public.workspaces SET name = 'Tashkent Synthetic Demo' WHERE id = '00000000-0000-4000-8000-000000000010';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Owner could not update workspace settings'; END IF;

  -- The workspace identity (organization and slug) is immutable: the public demo
  -- path resolves the synthetic workspace by slug, so renaming it would let one
  -- workspace capture another workspace's traffic.
  denied := false;
  BEGIN
    UPDATE public.workspaces SET slug = 'renamed-demo' WHERE id = '00000000-0000-4000-8000-000000000010';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Owner renamed the workspace slug'; END IF;

  denied := false;
  BEGIN
    UPDATE public.workspaces SET organization_id = '00000000-0000-4000-8000-00000000face'
     WHERE id = '00000000-0000-4000-8000-000000000010';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Owner re-parented a workspace to another organization'; END IF;

  -- PASS: owner assignment, then demotion and removal while another owner remains.
  UPDATE public.workspace_members SET role = 'owner'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000004'
  RETURNING id INTO touched;
  IF touched IS NULL THEN RAISE EXCEPTION 'Owner could not assign the owner role'; END IF;

  UPDATE public.workspace_members SET role = 'viewer'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000004'
  RETURNING id INTO touched;
  IF touched IS NULL THEN RAISE EXCEPTION 'Owner could not demote a non-final owner'; END IF;

  UPDATE public.workspace_members SET role = 'owner'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000004'
  RETURNING id INTO touched;
  IF touched IS NULL THEN RAISE EXCEPTION 'Owner could not promote a member to owner'; END IF;

  DELETE FROM public.workspace_members
   WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
     AND user_id = 'a1000000-0000-4000-8000-000000000004';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Owner could not remove a non-final owner'; END IF;

  -- FAIL: the final owner can neither be demoted, re-roled nor deleted, even by
  -- themselves, and membership rows can never be re-pointed at another user.
  denied := false;
  BEGIN
    UPDATE public.workspace_members SET role = 'viewer'
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND user_id = 'a1000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'The final owner was demoted'; END IF;

  denied := false;
  BEGIN
    DELETE FROM public.workspace_members
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND user_id = 'a1000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'The final owner was deleted'; END IF;

  denied := false;
  BEGIN
    UPDATE public.workspace_members SET user_id = 'c1000000-0000-4000-8000-000000000001'
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND user_id = 'a1000000-0000-4000-8000-000000000001';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A membership row was re-pointed at another user'; END IF;

  denied := false;
  BEGIN
    UPDATE public.workspace_members SET workspace_id = '00000000-0000-4000-8000-000000000011'
     WHERE workspace_id = '00000000-0000-4000-8000-000000000010'
       AND user_id = 'a1000000-0000-4000-8000-000000000002';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A membership row was moved to another workspace'; END IF;

  IF (SELECT pg_catalog.count(*) FROM public.workspace_members
       WHERE workspace_id = '00000000-0000-4000-8000-000000000010' AND role = 'owner') <> 1 THEN
    RAISE EXCEPTION 'Owner count changed unexpectedly during the owner scenario';
  END IF;

  -- FAIL: cross-workspace access is refused even for an owner.
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = '00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Owner read a foreign workspace';
  END IF;
  UPDATE public.projects SET name = 'Owner foreign rewrite'
   WHERE workspace_id = '00000000-0000-4000-8000-000000000011';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Owner updated a foreign workspace project'; END IF;

  RAISE NOTICE 'Owner: full workspace administration with enforced last-owner protection and no cross-workspace reach';
END;
$phase4_owner$;

-- ---------------------------------------------------------------------------
-- WORKSPACE B: membership is per workspace, never per organization
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated"}';
DO $phase4_workspace_b$
DECLARE
  affected integer;
BEGIN
  PERFORM pg_temp.phase4_expect_scope(false, true);

  IF NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '00000000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Owner B cannot read workspace B';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = '00000000-0000-4000-8000-000000000010') THEN
    RAISE EXCEPTION 'Owner B can read workspace A: membership is not workspace-scoped';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.workspace_members) <> 1 THEN
    RAISE EXCEPTION 'Owner B sees memberships outside their own workspace';
  END IF;

  -- Both workspaces share one synthetic organization. Organization read follows
  -- a membership, but workspace data never follows organization membership.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'atlas-demo') THEN
    RAISE EXCEPTION 'Owner B cannot read the organization they belong to';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.organizations) <> 1 THEN
    RAISE EXCEPTION 'Organizations are visible beyond the caller''s memberships';
  END IF;

  UPDATE public.workspaces SET name = 'Synthetic Isolation Test' WHERE id = '00000000-0000-4000-8000-000000000011';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Owner B could not update workspace B'; END IF;

  RAISE NOTICE 'Workspace B: membership is workspace-scoped; a shared organization never grants workspace access';
END;
$phase4_workspace_b$;

-- ---------------------------------------------------------------------------
-- NON-MEMBER: no tenant access at all
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}';
DO $phase4_non_member$
DECLARE
  denied boolean;
BEGIN
  PERFORM pg_temp.phase4_expect_scope(false, false);

  IF EXISTS (SELECT 1 FROM public.organizations) THEN
    RAISE EXCEPTION 'Non-member read organizations';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workspaces) THEN
    RAISE EXCEPTION 'Non-member read workspaces';
  END IF;
  IF public.workspace_role('00000000-0000-4000-8000-000000000010') IS NOT NULL THEN
    RAISE EXCEPTION 'Non-member was given a role';
  END IF;

  denied := false;
  BEGIN
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES ('00000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000001', 'owner');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Non-member created their own membership'; END IF;

  denied := false;
  BEGIN
    INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
    VALUES (
      '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000030',
      'Non-member insert', 'test-only', 'SRID=4326;POINT(69.30 41.30)'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Non-member inserted a tenant row'; END IF;

  -- FAIL: tenant RPCs raise instead of returning an empty, metadata-bearing 200.
  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Non-member executed the workspace viewport RPC'; END IF;

  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_radius_analysis('00000000-0000-4000-8000-000000000010', 69.2897, 41.3111, 500);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Non-member executed the workspace radius RPC'; END IF;

  RAISE NOTICE 'Non-member: no reads, no writes, no memberships and no tenant RPC execution';
END;
$phase4_non_member$;

-- ---------------------------------------------------------------------------
-- WORKSPACE-ID TAMPERING: a member of A cannot use B's identifier
-- ---------------------------------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated"}';
DO $phase4_tampering$
DECLARE
  denied boolean;
BEGIN
  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-000000000011', 69.20, 41.25, 69.36, 41.37, NULL, 2501
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Workspace-id tampering succeeded on the viewport RPC'; END IF;

  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_radius_analysis('00000000-0000-4000-8000-000000000011', 69.2797, 41.3111, 5000);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Workspace-id tampering succeeded on the radius RPC'; END IF;

  -- A fabricated id must fail exactly like a real foreign id: no existence oracle.
  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-00000000dead', 69.20, 41.25, 69.36, 41.37, NULL, 2501
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A fabricated workspace id was not refused'; END IF;

  denied := false;
  BEGIN
    PERFORM * FROM public.workspace_radius_analysis('00000000-0000-4000-8000-00000000dead', 69.2797, 41.3111, 5000);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A fabricated workspace id was not refused by the radius RPC'; END IF;

  RAISE NOTICE 'Tampering: workspace-id substitution and fabricated ids are refused identically by both tenant RPCs';
END;
$phase4_tampering$;

-- ---------------------------------------------------------------------------
-- Authenticated GIS parity with the Phase 3 demo path, and PII safety
-- ---------------------------------------------------------------------------
DO $phase4_rpc_parity$
DECLARE
  demo_rows bigint;
  workspace_rows bigint;
  mismatches bigint;
  demo_radius record;
  workspace_radius record;
BEGIN
  SELECT pg_catalog.count(*) INTO demo_rows FROM phase4_demo_viewport;
  SELECT pg_catalog.count(*) INTO workspace_rows
    FROM public.workspace_viewport_features('00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501);
  IF demo_rows <> workspace_rows THEN
    RAISE EXCEPTION 'Authenticated viewport RPC returned % rows, demo RPC returned %', workspace_rows, demo_rows;
  END IF;

  SELECT pg_catalog.count(*) INTO mismatches
    FROM public.workspace_viewport_features('00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501) AS workspace_feature
   WHERE NOT EXISTS (
     SELECT 1 FROM phase4_demo_viewport AS demo_feature
      WHERE demo_feature.feature_id = workspace_feature.feature_id
   );
  IF mismatches <> 0 THEN
    RAISE EXCEPTION 'Authenticated viewport RPC returned % rows that the demo RPC does not', mismatches;
  END IF;

  SELECT pg_catalog.count(*) INTO mismatches
    FROM phase4_demo_viewport AS demo_feature
   WHERE NOT EXISTS (
     SELECT 1 FROM public.workspace_viewport_features(
       '00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501
     ) AS workspace_feature
      WHERE workspace_feature.feature_id = demo_feature.feature_id
   );
  IF mismatches <> 0 THEN
    RAISE EXCEPTION 'The authenticated viewport RPC is missing % rows the demo RPC returns', mismatches;
  END IF;

  SELECT pg_catalog.count(*) INTO mismatches
    FROM public.workspace_viewport_features('00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501) AS workspace_feature
    JOIN phase4_demo_viewport AS demo_feature USING (feature_id)
   WHERE workspace_feature.kind IS DISTINCT FROM demo_feature.kind
      OR workspace_feature.category IS DISTINCT FROM demo_feature.category
      OR workspace_feature.display_name IS DISTINCT FROM demo_feature.display_name
      OR workspace_feature.longitude IS DISTINCT FROM demo_feature.longitude
      OR workspace_feature.latitude IS DISTINCT FROM demo_feature.latitude;
  IF mismatches <> 0 THEN
    RAISE EXCEPTION 'Authenticated viewport RPC has % rows whose fields differ from the demo RPC', mismatches;
  END IF;

  -- The colocated workspace B isolation rows must never be visible through
  -- workspace A, and customer features must not carry display names.
  IF EXISTS (
    SELECT 1 FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, NULL, 2501
    ) AS feature
     WHERE feature.feature_id IN (
       '50000000-0000-4000-8000-000000000001',
       '50000000-0000-4000-8000-000000000002',
       '50000000-0000-4000-8000-000000000003',
       '50000000-0000-4000-8000-000000000004'
     )
  ) THEN
    RAISE EXCEPTION 'The authenticated viewport RPC leaked a workspace B isolation feature';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.workspace_viewport_features(
      '00000000-0000-4000-8000-000000000010', 69.20, 41.25, 69.36, 41.37, ARRAY['customers'], 2501
    ) AS feature
     WHERE feature.display_name IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'The authenticated viewport RPC exposed a customer display name';
  END IF;

  SELECT * INTO demo_radius FROM phase4_demo_radius;
  SELECT * INTO workspace_radius
    FROM public.workspace_radius_analysis('00000000-0000-4000-8000-000000000010', 69.2897, 41.3111, 500);

  IF workspace_radius.customers_count IS DISTINCT FROM demo_radius.customers_count
     OR workspace_radius.customers_revenue_total IS DISTINCT FROM demo_radius.customers_revenue_total
     OR workspace_radius.competitors_count IS DISTINCT FROM demo_radius.competitors_count
     OR workspace_radius.branches_count IS DISTINCT FROM demo_radius.branches_count
     OR workspace_radius.locations_count IS DISTINCT FROM demo_radius.locations_count
     OR workspace_radius.category_distribution IS DISTINCT FROM demo_radius.category_distribution
     OR workspace_radius.nearest_branch_id IS DISTINCT FROM demo_radius.nearest_branch_id
     OR workspace_radius.nearest_branch_name IS DISTINCT FROM demo_radius.nearest_branch_name
     OR workspace_radius.nearest_branch_distance_meters IS DISTINCT FROM demo_radius.nearest_branch_distance_meters THEN
    RAISE EXCEPTION 'Authenticated radius RPC (% ) disagrees with the demo RPC (%)', workspace_radius, demo_radius;
  END IF;

  RAISE NOTICE 'Parity: the authenticated viewport and radius RPCs match the Phase 3 demo RPCs exactly for workspace A, leak no workspace B rows and expose no customer display names';
END;
$phase4_rpc_parity$;

-- ---------------------------------------------------------------------------
-- GRANT STRATEGY: the privilege matrix is exactly the documented one
-- ---------------------------------------------------------------------------
-- Supabase grants ALL privileges on new tables in `public` to anon and
-- authenticated by default, so this block proves the migrations revoked those
-- inherited grants and re-granted only the documented set. TRUNCATE matters
-- most: it is not filtered by RLS.
RESET ROLE;
DO $phase4_privilege_matrix$
DECLARE
  expected record;
  forbidden text;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('organizations',      true,  false, false, false),
      ('workspaces',         true,  false, true,  false),
      ('workspace_members',  true,  true,  true,  true),
      ('projects',           true,  true,  true,  true),
      ('datasets',           true,  true,  true,  true),
      ('project_datasets',   true,  true,  false, true),
      ('locations',          true,  true,  true,  true),
      ('customers',          true,  true,  true,  true),
      ('competitors',        true,  true,  true,  true),
      ('branches',           true,  true,  true,  true),
      ('analysis_locations', true,  true,  true,  true)
    ) AS grant_matrix(table_name, can_select, can_insert, can_update, can_delete)
  LOOP
    IF pg_catalog.has_table_privilege('authenticated', pg_catalog.format('public.%I', expected.table_name), 'SELECT') IS DISTINCT FROM expected.can_select
       OR pg_catalog.has_table_privilege('authenticated', pg_catalog.format('public.%I', expected.table_name), 'INSERT') IS DISTINCT FROM expected.can_insert
       OR pg_catalog.has_table_privilege('authenticated', pg_catalog.format('public.%I', expected.table_name), 'UPDATE') IS DISTINCT FROM expected.can_update
       OR pg_catalog.has_table_privilege('authenticated', pg_catalog.format('public.%I', expected.table_name), 'DELETE') IS DISTINCT FROM expected.can_delete THEN
      RAISE EXCEPTION 'authenticated privilege matrix mismatch on public.%', expected.table_name;
    END IF;

    -- No DDL escape hatches for authenticated, and no privileges at all for anon.
    FOREACH forbidden IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege('authenticated', pg_catalog.format('public.%I', expected.table_name), forbidden) THEN
        RAISE EXCEPTION 'authenticated inherited % on public.%', forbidden, expected.table_name;
      END IF;
    END LOOP;

    FOREACH forbidden IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege('anon', pg_catalog.format('public.%I', expected.table_name), forbidden) THEN
        RAISE EXCEPTION 'anon holds % on public.%', forbidden, expected.table_name;
      END IF;
    END LOOP;

    -- service_role keeps the operator/elevated access the platform grants it.
    IF NOT pg_catalog.has_table_privilege('service_role', pg_catalog.format('public.%I', expected.table_name), 'SELECT')
       OR NOT pg_catalog.has_table_privilege('service_role', pg_catalog.format('public.%I', expected.table_name), 'INSERT')
       OR NOT pg_catalog.has_table_privilege('service_role', pg_catalog.format('public.%I', expected.table_name), 'UPDATE')
       OR NOT pg_catalog.has_table_privilege('service_role', pg_catalog.format('public.%I', expected.table_name), 'DELETE') THEN
      RAISE EXCEPTION 'service_role lost the operator privileges on public.%', expected.table_name;
    END IF;
  END LOOP;

  RAISE NOTICE 'Grants: authenticated holds exactly the documented matrix, anon holds nothing, service_role keeps the elevated path';
END;
$phase4_privilege_matrix$;

ROLLBACK;
