-- Deterministic, synthetic demo data for local development and clean DB CI.
-- This file is deliberately outside supabase/migrations and contains no real
-- customer contacts or identifying customer attributes.

INSERT INTO public.organizations (id, name, slug, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'Atlas Synthetic Demo', 'atlas-demo', '{"synthetic": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workspaces (id, organization_id, name, slug, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', 'Tashkent Synthetic Demo', 'tashkent-demo', '{"synthetic": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Synthetic Isolation Test', 'isolation-test', '{"synthetic": true, "test_only": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.projects (id, workspace_id, name, description, status, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000010', 'Tashkent Retail Pilot', 'Synthetic seed project for the map and radius-analysis demo.', 'active', '{"synthetic": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000011', 'Isolation Test Project', 'Synthetic-only cross-workspace isolation test data.', 'active', '{"synthetic": true, "test_only": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.datasets (id, workspace_id, name, description, dataset_type, source, metadata)
VALUES
  ('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000010', 'Synthetic locations', 'Synthetic point-of-interest sample.', 'locations', 'synthetic-seed', '{"synthetic": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000010', 'Synthetic competitors', 'Synthetic competitor sample.', 'competitors', 'synthetic-seed', '{"synthetic": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000010', 'Synthetic branches', 'Synthetic branch sample.', 'branches', 'synthetic-seed', '{"synthetic": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000010', 'Synthetic customers', 'Synthetic, non-identifying customer aggregate sample.', 'customers', 'synthetic-seed', '{"synthetic": true, "no_contact_fields": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000011', 'Isolation locations', 'Synthetic cross-workspace location.', 'locations', 'synthetic-seed', '{"synthetic": true, "test_only": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000011', 'Isolation competitors', 'Synthetic cross-workspace competitor.', 'competitors', 'synthetic-seed', '{"synthetic": true, "test_only": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-000000000011', 'Isolation branches', 'Synthetic cross-workspace branch.', 'branches', 'synthetic-seed', '{"synthetic": true, "test_only": true}'::jsonb),
  ('00000000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-000000000011', 'Isolation customers', 'Synthetic cross-workspace customer aggregate.', 'customers', 'synthetic-seed', '{"synthetic": true, "test_only": true, "no_contact_fields": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
VALUES
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000010'),
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000031', '00000000-0000-4000-8000-000000000010'),
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000032', '00000000-0000-4000-8000-000000000010'),
  ('00000000-0000-4000-8000-000000000020', '00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000010'),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000034', '00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000035', '00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000036', '00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000037', '00000000-0000-4000-8000-000000000011')
ON CONFLICT (project_id, dataset_id) DO NOTHING;

-- One explicit center point per kind guarantees a predictable 500 m smoke test.
INSERT INTO public.locations
  (id, workspace_id, dataset_id, name, category, spatial_point, source, external_id, metadata)
VALUES
  ('10000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000030', 'Synthetic Tashkent POI 000', 'retail', extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 'synthetic-seed', 'synthetic-location-000', '{"synthetic": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.locations
  (id, workspace_id, dataset_id, name, category, spatial_point, source, external_id, metadata)
SELECT
  ('10000000-0000-4000-8000-' || pg_catalog.lpad(pg_catalog.to_hex(sample.number), 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000030',
  'Synthetic Tashkent POI ' || pg_catalog.lpad(sample.number::text, 3, '0'),
  (ARRAY['retail', 'pharmacy', 'grocery', 'cafe', 'market', 'clinic', 'hotel', 'bank'])[((sample.number - 1) % 8) + 1],
  extensions.st_setsrid(
    extensions.st_makepoint(
      (69.2797 + (((sample.number * 37) % 91) - 45) / 1000.0)::double precision,
      (41.3111 + (((sample.number * 53) % 81) - 40) / 1000.0)::double precision
    ), 4326
  )::extensions.geography,
  'synthetic-seed',
  'synthetic-location-' || pg_catalog.lpad(sample.number::text, 3, '0'),
  '{"synthetic": true}'::jsonb
FROM pg_catalog.generate_series(1, 40) AS sample(number)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.competitors
  (id, workspace_id, dataset_id, external_id, name, brand, category, spatial_point, source, metadata)
VALUES
  ('20000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000031', 'synthetic-competitor-000', 'Synthetic competitor 000', 'Synthetic brand', 'grocery', extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 'synthetic-seed', '{"synthetic": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.competitors
  (id, workspace_id, dataset_id, external_id, name, brand, category, spatial_point, source, metadata)
SELECT
  ('20000000-0000-4000-8000-' || pg_catalog.lpad(pg_catalog.to_hex(sample.number), 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000031',
  'synthetic-competitor-' || pg_catalog.lpad(sample.number::text, 3, '0'),
  'Synthetic competitor ' || pg_catalog.lpad(sample.number::text, 3, '0'),
  'Synthetic brand',
  (ARRAY['grocery', 'pharmacy', 'cafe', 'retail'])[((sample.number - 1) % 4) + 1],
  extensions.st_setsrid(
    extensions.st_makepoint(
      (69.2797 + (((sample.number * 29) % 73) - 36) / 1000.0)::double precision,
      (41.3111 + (((sample.number * 47) % 67) - 33) / 1000.0)::double precision
    ), 4326
  )::extensions.geography,
  'synthetic-seed',
  '{"synthetic": true}'::jsonb
FROM pg_catalog.generate_series(1, 24) AS sample(number)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.branches
  (id, workspace_id, dataset_id, external_id, name, spatial_point, revenue, customers_count, metadata)
VALUES
  ('30000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000032', 'synthetic-branch-000', 'Synthetic branch 000', extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 12850.00, 120, '{"synthetic": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.branches
  (id, workspace_id, dataset_id, external_id, name, spatial_point, revenue, customers_count, metadata)
SELECT
  ('30000000-0000-4000-8000-' || pg_catalog.lpad(pg_catalog.to_hex(sample.number), 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000032',
  'synthetic-branch-' || pg_catalog.lpad(sample.number::text, 3, '0'),
  'Synthetic branch ' || pg_catalog.lpad(sample.number::text, 3, '0'),
  extensions.st_setsrid(
    extensions.st_makepoint(
      (69.2797 + (((sample.number * 31) % 31) - 15) / 1000.0)::double precision,
      (41.3111 + (((sample.number * 43) % 29) - 14) / 1000.0)::double precision
    ), 4326
  )::extensions.geography,
  (10000 + sample.number * 251)::numeric(18,2),
  80 + sample.number * 3,
  '{"synthetic": true}'::jsonb
FROM pg_catalog.generate_series(1, 8) AS sample(number)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.customers
  (id, workspace_id, dataset_id, external_id, name, phone, company, address, spatial_point, revenue, order_count, segment, source, metadata)
VALUES
  ('40000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000033', 'synthetic-customer-000', NULL, NULL, NULL, NULL, extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 125.50, 2, 'synthetic-retail', 'synthetic-seed', '{"synthetic": true, "no_contact_fields": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.customers
  (id, workspace_id, dataset_id, external_id, name, phone, company, address, spatial_point, revenue, order_count, segment, source, metadata)
SELECT
  ('40000000-0000-4000-8000-' || pg_catalog.lpad(pg_catalog.to_hex(sample.number), 12, '0'))::uuid,
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000033',
  'synthetic-customer-' || pg_catalog.lpad(sample.number::text, 3, '0'),
  NULL,
  NULL,
  NULL,
  NULL,
  extensions.st_setsrid(
    extensions.st_makepoint(
      (69.2797 + (((sample.number * 41) % 91) - 45) / 1000.0)::double precision,
      (41.3111 + (((sample.number * 59) % 81) - 40) / 1000.0)::double precision
    ), 4326
  )::extensions.geography,
  ((((sample.number * 137) % 80000) + 5000)::numeric / 100)::numeric(18,2),
  (sample.number % 9) + 1,
  (ARRAY['synthetic-retail', 'synthetic-services', 'synthetic-food'])[((sample.number - 1) % 3) + 1],
  'synthetic-seed',
  '{"synthetic": true, "no_contact_fields": true}'::jsonb
FROM pg_catalog.generate_series(1, 240) AS sample(number)
ON CONFLICT (id) DO NOTHING;

-- Every isolation-workspace feature is colocated with the demo center so the
-- SQL integration suite can prove the demo RPCs never cross workspace bounds.
INSERT INTO public.locations
  (id, workspace_id, dataset_id, name, category, spatial_point, source, external_id, metadata)
VALUES
  ('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000034', 'Isolation synthetic location', 'test-only', extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 'synthetic-seed', 'isolation-location-001', '{"synthetic": true, "test_only": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.competitors
  (id, workspace_id, dataset_id, external_id, name, brand, category, spatial_point, source, metadata)
VALUES
  ('50000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000035', 'isolation-competitor-001', 'Isolation synthetic competitor', 'Synthetic test brand', 'test-only', extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 'synthetic-seed', '{"synthetic": true, "test_only": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.branches
  (id, workspace_id, dataset_id, external_id, name, spatial_point, revenue, customers_count, metadata)
VALUES
  ('50000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000036', 'isolation-branch-001', 'Isolation synthetic branch', extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 9999.00, 50, '{"synthetic": true, "test_only": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.customers
  (id, workspace_id, dataset_id, external_id, name, phone, company, address, spatial_point, revenue, order_count, segment, source, metadata)
VALUES
  ('50000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000037', 'isolation-customer-001', NULL, NULL, NULL, NULL, extensions.st_setsrid(extensions.st_makepoint(69.2797, 41.3111), 4326)::extensions.geography, 999.99, 1, 'test-only', 'synthetic-seed', '{"synthetic": true, "test_only": true, "no_contact_fields": true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Phase 4 deterministic identities (local development and clean-DB CI only)
-- ---------------------------------------------------------------------------
-- These are synthetic Supabase Auth users that exist so workspace membership and
-- membership-aware RLS can be exercised end to end. They are NOT production
-- identities and must never be seeded into a deployed project; the operator path
-- for real environments is public.bootstrap_workspace_owner(), documented in
-- docs/auth-security.md.
--
-- Role coverage:
--   owner-a@example.test    owner   of workspace tashkent-demo (workspace A)
--   admin-a@example.test    admin   of workspace A
--   analyst-a@example.test  analyst of workspace A
--   viewer-a@example.test   viewer  of workspace A
--   owner-b@example.test    owner   of workspace isolation-test (workspace B)
--   outsider@example.test   no membership anywhere
--   operator@example.test  no membership; actor for the server/operator bootstrap test only
DO $phase4_seed_preflight$
BEGIN
  IF pg_catalog.to_regprocedure('extensions.crypt(text,text)') IS NULL THEN
    RAISE EXCEPTION 'pgcrypto must be installed in the extensions schema to seed deterministic auth users';
  END IF;
  IF pg_catalog.to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is required to seed deterministic auth users';
  END IF;
END;
$phase4_seed_preflight$;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Owner A"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'admin-a@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Admin A"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'analyst-a@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Analyst A"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'viewer-a@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Viewer A"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-b@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Owner B"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'operator@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Bootstrap Operator"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'outsider@example.test', extensions.crypt('phase4-demo-password', extensions.gen_salt('bf')), pg_catalog.now(), '{"provider":"email","providers":["email"]}'::jsonb, '{"synthetic":true,"display_name":"Synthetic Outsider"}'::jsonb, pg_catalog.now(), pg_catalog.now(), '', '', '', '')
ON CONFLICT (id) DO NOTHING;

-- GoTrue requires a matching email identity row for password sign-in. The
-- NOT EXISTS guard avoids depending on a specific unique-constraint name.
INSERT INTO auth.identities (
  id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
SELECT pg_catalog.gen_random_uuid(),
       seeded_user.id::text,
       seeded_user.id,
       pg_catalog.jsonb_build_object('sub', seeded_user.id::text, 'email', seeded_user.email),
       'email',
       pg_catalog.now(),
       pg_catalog.now(),
       pg_catalog.now()
  FROM auth.users AS seeded_user
 WHERE seeded_user.id IN (
         'a1000000-0000-4000-8000-000000000001',
         'a1000000-0000-4000-8000-000000000002',
         'a1000000-0000-4000-8000-000000000003',
         'a1000000-0000-4000-8000-000000000004',
         'b1000000-0000-4000-8000-000000000001',
         'c1000000-0000-4000-8000-000000000001',
         'd1000000-0000-4000-8000-000000000001'
       )
   AND NOT EXISTS (
         SELECT 1
           FROM auth.identities AS existing_identity
          WHERE existing_identity.provider = 'email'
            AND existing_identity.provider_id = seeded_user.id::text
       );

INSERT INTO public.workspace_members (workspace_id, user_id, role)
VALUES
  ('00000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000001', 'owner'),
  ('00000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000002', 'admin'),
  ('00000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000003', 'analyst'),
  ('00000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000004', 'viewer'),
  ('00000000-0000-4000-8000-000000000011', 'b1000000-0000-4000-8000-000000000001', 'owner')
ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role;
