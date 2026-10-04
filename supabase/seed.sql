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
