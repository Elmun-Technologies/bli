-- Run only against a local/test Supabase database after `supabase db reset`:
-- psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/phase2_integrity.sql
-- All fixture rows are rolled back. This file is not a production seed.
BEGIN;

DO $phase2_integrity$
DECLARE
  expected_postgres_major integer;
  violated_constraint text;
  postgis_schema name;
  postgis_extension_version text;
  postgis_library_version text;
  postgis_version_parts text[];
  postgres_version_num integer;
  index_definition text;
  distance_meters double precision;
  organization_a uuid;
  organization_b uuid;
  workspace_a uuid;
  workspace_b uuid;
  project_a uuid;
  project_b uuid;
  project_c uuid;
  dataset_a uuid;
  dataset_b uuid;
  dataset_c uuid;
  customer_a uuid;
  point_wgs84 extensions.geography;
  point_a extensions.geography;
  point_b extensions.geography;
  table_name text;
  role_name text;
  privilege_name text;
  type_srid_count integer;
  rls_enabled boolean;
  policy_count integer;
  rejected boolean;
  timestamp_before timestamptz;
  timestamp_after timestamptz;
BEGIN
  SELECT namespace.nspname, extension.extversion
    INTO postgis_schema, postgis_extension_version
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'postgis';
  IF postgis_schema IS DISTINCT FROM 'extensions' THEN
    RAISE EXCEPTION 'Expected PostGIS in extensions; found %', COALESCE(postgis_schema::text, '<not installed>');
  END IF;

  -- The release gate pins the major version declared in supabase/config.toml.
  -- CI never sets the override below, so it always enforces the strict default
  -- of 17. A supplementary local harness running an equivalent PostGIS build on
  -- a different supported major may set bli.expected_postgres_major explicitly;
  -- this must never be set in the clean-database workflow.
  expected_postgres_major := COALESCE(
    pg_catalog.current_setting('bli.expected_postgres_major', true)::integer,
    17
  );
  postgres_version_num := pg_catalog.current_setting('server_version_num')::integer;
  IF postgres_version_num / 10000 <> expected_postgres_major THEN
    RAISE EXCEPTION 'Expected PostgreSQL % from supabase/config.toml; found %',
      expected_postgres_major, pg_catalog.current_setting('server_version');
  END IF;

  postgis_library_version := extensions.postgis_lib_version();
  postgis_version_parts := pg_catalog.string_to_array(postgis_library_version, '.');
  IF pg_catalog.array_length(postgis_version_parts, 1) IS NULL
     OR pg_catalog.array_length(postgis_version_parts, 1) < 2
     OR postgis_version_parts[1] !~ '^[0-9]+$'
     OR postgis_version_parts[2] !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Could not parse installed PostGIS library version: %', postgis_library_version;
  END IF;
  IF (postgis_version_parts[1]::integer, postgis_version_parts[2]::integer) < (3, 3) THEN
    RAISE EXCEPTION 'Expected PostGIS >= 3.3.0; found extension %, library %',
      postgis_extension_version, postgis_library_version;
  END IF;

  RAISE NOTICE 'PostgreSQL version: % (server_version_num=%)',
    pg_catalog.current_setting('server_version'), postgres_version_num;
  RAISE NOTICE 'PostGIS extension version: %, library version: %, full version: %',
    postgis_extension_version, postgis_library_version, extensions.postgis_full_version();

  IF pg_catalog.to_regprocedure(
       'extensions.st_dwithin(extensions.geography,extensions.geography,double precision,boolean)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'extensions.st_distance(extensions.geography,extensions.geography,boolean)'
     ) IS NULL
     OR pg_catalog.to_regprocedure('extensions.st_setsrid(extensions.geometry,integer)') IS NULL
     OR pg_catalog.to_regprocedure('extensions.st_makepoint(double precision,double precision)') IS NULL THEN
    RAISE EXCEPTION 'A required schema-qualified PostGIS geography/geometry function is unavailable in extensions';
  END IF;

  point_wgs84 := extensions.st_setsrid(
    extensions.st_makepoint(69.2797, 41.3111), 4326
  )::extensions.geography;

  -- Explicitly assert every required table exists in the public schema.
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'workspaces', 'projects', 'datasets', 'project_datasets',
    'locations', 'customers', 'competitors', 'branches', 'analysis_locations'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = table_name
         AND relation.relkind IN ('r', 'p')
    ) THEN
      RAISE EXCEPTION 'Required table public.% is missing', table_name;
    END IF;
  END LOOP;
  RAISE NOTICE 'All ten expected public tables exist';

  -- Verify every authoritative point column is geography(Point,4326), not an
  -- untyped geometry or a second latitude/longitude representation.
  FOREACH table_name IN ARRAY ARRAY[
    'locations', 'customers', 'competitors', 'branches', 'analysis_locations'
  ] LOOP
    SELECT pg_catalog.count(*)
      INTO type_srid_count
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = table_name
       AND attribute.attname = 'spatial_point'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.atttypid = pg_catalog.to_regtype('extensions.geography')
       AND extensions.postgis_typmod_srid(attribute.atttypmod) = 4326
       AND pg_catalog.lower(extensions.postgis_typmod_type(attribute.atttypmod)) = 'point';

    IF type_srid_count <> 1 THEN
      RAISE EXCEPTION '%.spatial_point is not geography(Point,4326)', table_name;
    END IF;

    index_definition := NULL;
    SELECT pg_catalog.pg_get_indexdef(index_metadata.indexrelid)
      INTO index_definition
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_index AS index_metadata
        ON index_metadata.indrelid = relation.oid
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
     WHERE namespace.nspname = 'public'
       AND relation.relname = table_name
       AND index_relation.relname = table_name || '_spatial_gix'
       AND access_method.amname = 'gist'
       AND index_metadata.indisvalid
       AND index_metadata.indisready;

    IF index_definition IS NULL OR pg_catalog.strpos(
      pg_catalog.lower(index_definition), 'using gist (spatial_point)'
    ) = 0 THEN
      RAISE EXCEPTION 'Missing valid GiST index on public.%.spatial_point; found %',
        table_name, COALESCE(index_definition, '<missing>');
    END IF;
    RAISE NOTICE 'Verified spatial index definition: %', index_definition;
  END LOOP;

  -- Every tenant-owned table is RLS-enabled and has no policy yet. Client
  -- roles also have no table privileges until authenticated policies arrive.
  FOREACH table_name IN ARRAY ARRAY[
    'organizations', 'workspaces', 'projects', 'datasets', 'project_datasets',
    'locations', 'customers', 'competitors', 'branches', 'analysis_locations'
  ] LOOP
    SELECT relation.relrowsecurity
      INTO rls_enabled
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = table_name;
    IF rls_enabled IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS is not enabled on public.%', table_name;
    END IF;

    SELECT pg_catalog.count(*)
      INTO policy_count
      FROM pg_catalog.pg_policy AS policy
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = policy.polrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = table_name;
    IF policy_count <> 0 THEN
      RAISE EXCEPTION 'Phase 2 should not create policies on public.%', table_name;
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) AS acl
       WHERE namespace.nspname = 'public'
         AND relation.relname = table_name
         AND acl.grantee = 0
    ) THEN
      RAISE EXCEPTION 'PUBLIC has an unintended table privilege on public.%', table_name;
    END IF;

    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH privilege_name IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ] LOOP
        IF pg_catalog.has_table_privilege(
          role_name,
          'public.' || table_name,
          privilege_name
        ) THEN
          RAISE EXCEPTION '% unexpectedly has % on public.%',
            role_name, privilege_name, table_name;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RAISE NOTICE 'RLS enabled, no policies present, PUBLIC/anon/authenticated table privileges absent';

  -- Build two tenants and valid same-workspace rows.
  INSERT INTO public.organizations (name, slug)
  VALUES ('Synthetic Org A', 'synthetic-org-a') RETURNING id INTO organization_a;
  INSERT INTO public.organizations (name, slug)
  VALUES ('Synthetic Org B', 'synthetic-org-b') RETURNING id INTO organization_b;

  INSERT INTO public.workspaces (organization_id, name, slug)
  VALUES (organization_a, 'Synthetic Workspace A', 'pilot') RETURNING id INTO workspace_a;
  INSERT INTO public.workspaces (organization_id, name, slug)
  VALUES (organization_b, 'Synthetic Workspace B', 'pilot') RETURNING id INTO workspace_b;

  INSERT INTO public.projects (workspace_id, name)
  VALUES (workspace_a, 'Synthetic Project A') RETURNING id INTO project_a;
  INSERT INTO public.projects (workspace_id, name)
  VALUES (workspace_b, 'Synthetic Project B') RETURNING id INTO project_b;
  INSERT INTO public.projects (workspace_id, name)
  VALUES (workspace_a, 'Synthetic Project C') RETURNING id INTO project_c;

  INSERT INTO public.datasets (workspace_id, name, dataset_type)
  VALUES (workspace_a, 'Synthetic Dataset A', 'customers') RETURNING id INTO dataset_a;
  INSERT INTO public.datasets (workspace_id, name, dataset_type)
  VALUES (workspace_b, 'Synthetic Dataset B', 'external') RETURNING id INTO dataset_b;
  INSERT INTO public.datasets (workspace_id, name, dataset_type)
  VALUES (workspace_a, 'Synthetic Dataset C', 'external') RETURNING id INTO dataset_c;

  INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
  VALUES (project_a, dataset_a, workspace_a);
  INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
  VALUES (project_b, dataset_b, workspace_b);
  INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
  VALUES (project_c, dataset_a, workspace_a);
  INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
  VALUES (project_a, dataset_c, workspace_a);

  -- Database constraints, not application logic, reject cross-workspace links.
  rejected := false;
  BEGIN
    INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
    VALUES (project_b, dataset_a, workspace_b);
  EXCEPTION WHEN foreign_key_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Workspace A Dataset A was incorrectly attached to Workspace B Project B';
  END IF;

  rejected := false;
  BEGIN
    INSERT INTO public.project_datasets (project_id, dataset_id, workspace_id)
    VALUES (project_a, dataset_b, workspace_a);
  EXCEPTION WHEN foreign_key_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Workspace B Dataset B was incorrectly attached to Workspace A Project A';
  END IF;

  rejected := false;
  BEGIN
    INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
    VALUES (workspace_a, project_b, 'Invalid cross-workspace candidate', point_wgs84);
  EXCEPTION WHEN foreign_key_violation THEN
    rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'Analysis location accepted a project from another workspace';
  END IF;

  -- All four dataset-owned record tables enforce (dataset_id, workspace_id).
  rejected := false;
  BEGIN
    INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
    VALUES (workspace_a, dataset_b, 'Invalid location', 'retail', point_wgs84);
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Locations accepted a foreign workspace dataset'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO public.customers (workspace_id, dataset_id, name, spatial_point)
    VALUES (workspace_a, dataset_b, 'Synthetic invalid customer', point_wgs84);
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Customers accepted a foreign workspace dataset'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO public.competitors (workspace_id, dataset_id, name, category, spatial_point)
    VALUES (workspace_a, dataset_b, 'Invalid competitor', 'retail', point_wgs84);
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Competitors accepted a foreign workspace dataset'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO public.branches (workspace_id, dataset_id, name, spatial_point)
    VALUES (workspace_a, dataset_b, 'Invalid branch', point_wgs84);
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Branches accepted a foreign workspace dataset'; END IF;

  -- PostGIS normalizes longitude/latitude during geometry-to-geography
  -- conversion, so the original scalars are no longer available to a table
  -- CHECK constraint. Assert that a geography made from out-of-range input is
  -- canonical before storage; the domain validator separately rejects raw
  -- out-of-range coordinates at the input boundary.
  point_a := extensions.st_setsrid(
    extensions.st_makepoint(181, 91), 4326
  )::extensions.geography;
  IF extensions.st_x(point_a::extensions.geometry) NOT BETWEEN -180 AND 180
     OR extensions.st_y(point_a::extensions.geometry) NOT BETWEEN -90 AND 90
     OR extensions.st_x(point_a::extensions.geometry) = 181
     OR extensions.st_y(point_a::extensions.geometry) = 91 THEN
    RAISE EXCEPTION 'PostGIS did not normalize out-of-range geography coordinates';
  END IF;
  INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
  VALUES (workspace_a, dataset_a, 'Normalized geography test', 'retail', point_a);

  INSERT INTO public.customers (workspace_id, dataset_id, name, revenue, spatial_point)
  VALUES (workspace_a, dataset_a, 'Synthetic customer', 123.45, point_wgs84)
  RETURNING id INTO customer_a;
  INSERT INTO public.locations (workspace_id, dataset_id, name, category, spatial_point)
  VALUES (workspace_a, dataset_a, 'Synthetic location', 'retail', point_wgs84);
  INSERT INTO public.competitors (workspace_id, dataset_id, name, category, spatial_point)
  VALUES (workspace_a, dataset_a, 'Synthetic competitor', 'retail', point_wgs84);
  INSERT INTO public.branches (workspace_id, dataset_id, name, spatial_point)
  VALUES (workspace_a, dataset_a, 'Synthetic branch', point_wgs84);
  INSERT INTO public.analysis_locations (workspace_id, project_id, name, spatial_point)
  VALUES (workspace_a, project_a, 'Synthetic saved candidate', point_wgs84);

  -- Live GIS sanity check: two nearby Tashkent points about 0.01 longitude
  -- degrees apart should be ~0.8 km. Geography distances and thresholds are meters.
  point_a := point_wgs84;
  point_b := extensions.st_setsrid(
    extensions.st_makepoint(69.2897, 41.3111), 4326
  )::extensions.geography;
  distance_meters := extensions.st_distance(point_a, point_b, true);

  IF distance_meters IS NULL OR distance_meters <= 0 OR distance_meters >= 100000 THEN
    RAISE EXCEPTION 'Tashkent spheroidal geography distance is not finite and positive: %',
      distance_meters;
  END IF;
  IF distance_meters < 700 OR distance_meters > 1000 THEN
    RAISE EXCEPTION 'Expected roughly 0.8 km between Tashkent points, got % (expected meters)',
      distance_meters;
  END IF;
  IF extensions.st_dwithin(point_a, point_b, distance_meters - 10, true) THEN
    RAISE EXCEPTION 'ST_DWithin incorrectly matched below the measured distance (% meters)',
      distance_meters - 10;
  END IF;
  IF NOT extensions.st_dwithin(point_a, point_b, distance_meters + 10, true) THEN
    RAISE EXCEPTION 'ST_DWithin failed above the measured distance (% meters)',
      distance_meters + 10;
  END IF;
  IF extensions.st_dwithin(point_a, point_b, 500, true)
     OR NOT extensions.st_dwithin(point_a, point_b, 1000, true) THEN
    RAISE EXCEPTION 'ST_DWithin thresholds did not behave consistently with meter-based distance';
  END IF;
  RAISE NOTICE 'Tashkent spheroidal geography distance: % meters; ST_DWithin thresholds passed',
    distance_meters;

  -- updated_at changes on update; the many-to-many cascade removes only the link.
  SELECT updated_at INTO timestamp_before
    FROM public.organizations WHERE id = organization_a;
  PERFORM pg_catalog.pg_sleep(0.01);
  UPDATE public.organizations SET name = 'Synthetic Org A Updated' WHERE id = organization_a;
  SELECT updated_at INTO timestamp_after
    FROM public.organizations WHERE id = organization_a;
  IF timestamp_after <= timestamp_before THEN
    RAISE EXCEPTION 'Reusable updated_at trigger did not advance timestamp';
  END IF;

  DELETE FROM public.projects WHERE id = project_c;
  IF EXISTS (
    SELECT 1 FROM public.project_datasets
     WHERE project_id = project_c AND dataset_id = dataset_a
  ) THEN
    RAISE EXCEPTION 'Deleting a project did not remove its association row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.datasets WHERE id = dataset_a) THEN
    RAISE EXCEPTION 'Deleting a project incorrectly deleted its reusable dataset';
  END IF;

  DELETE FROM public.datasets WHERE id = dataset_c;
  IF EXISTS (
    SELECT 1 FROM public.project_datasets
     WHERE project_id = project_a AND dataset_id = dataset_c
  ) THEN
    RAISE EXCEPTION 'Deleting a dataset did not remove only its association row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.projects WHERE id = project_a) THEN
    RAISE EXCEPTION 'Deleting a dataset incorrectly deleted its project';
  END IF;

  -- Business records, projects, datasets and workspaces are not cascade-deleted.
  -- PostgreSQL 17 reports an ON DELETE RESTRICT refusal as 23503
  -- (foreign_key_violation); PostgreSQL 18 reports it as 23001
  -- (restrict_violation) because RESTRICT is checked immediately and cannot be
  -- deferred. Both are accepted, but each delete must be refused by the
  -- specific ownership constraint that protects the referenced records.
  rejected := false;
  violated_constraint := NULL;
  BEGIN
    DELETE FROM public.datasets WHERE id = dataset_a;
  EXCEPTION
    WHEN foreign_key_violation OR restrict_violation THEN
      rejected := true;
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Referenced dataset deletion was not restricted'; END IF;
  IF violated_constraint IS DISTINCT FROM 'locations_dataset_workspace_fk'
     AND violated_constraint IS DISTINCT FROM 'customers_dataset_workspace_fk'
     AND violated_constraint IS DISTINCT FROM 'competitors_dataset_workspace_fk'
     AND violated_constraint IS DISTINCT FROM 'branches_dataset_workspace_fk' THEN
    RAISE EXCEPTION 'Dataset deletion was refused by an unexpected constraint: %',
      COALESCE(violated_constraint, '<none>');
  END IF;

  rejected := false;
  violated_constraint := NULL;
  BEGIN
    DELETE FROM public.projects WHERE id = project_a;
  EXCEPTION
    WHEN foreign_key_violation OR restrict_violation THEN
      rejected := true;
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Project deletion with saved analysis was not restricted'; END IF;
  IF violated_constraint IS DISTINCT FROM 'analysis_locations_project_workspace_fk' THEN
    RAISE EXCEPTION 'Project deletion was refused by an unexpected constraint: %',
      COALESCE(violated_constraint, '<none>');
  END IF;

  rejected := false;
  violated_constraint := NULL;
  BEGIN
    DELETE FROM public.workspaces WHERE id = workspace_a;
  EXCEPTION
    WHEN foreign_key_violation OR restrict_violation THEN
      rejected := true;
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Workspace deletion with business data was not restricted'; END IF;
  IF violated_constraint IS DISTINCT FROM 'projects_workspace_fk'
     AND violated_constraint IS DISTINCT FROM 'datasets_workspace_fk'
     AND violated_constraint IS DISTINCT FROM 'project_datasets_workspace_fk' THEN
    RAISE EXCEPTION 'Workspace deletion was refused by an unexpected constraint: %',
      COALESCE(violated_constraint, '<none>');
  END IF;

  rejected := false;
  violated_constraint := NULL;
  BEGIN
    DELETE FROM public.organizations WHERE id = organization_a;
  EXCEPTION
    WHEN foreign_key_violation OR restrict_violation THEN
      rejected := true;
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'Organization deletion with a workspace was not restricted'; END IF;
  IF violated_constraint IS DISTINCT FROM 'workspaces_organization_fk' THEN
    RAISE EXCEPTION 'Organization deletion was refused by an unexpected constraint: %',
      COALESCE(violated_constraint, '<none>');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = customer_a) THEN
    RAISE EXCEPTION 'Valid same-workspace customer row was not retained';
  END IF;

  RAISE NOTICE 'Phase 2 database integrity checks passed';
END;
$phase2_integrity$;

ROLLBACK;
