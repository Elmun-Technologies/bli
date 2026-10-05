-- Phase 2, migration 1 of 2: organization/workspace/project/dataset ownership.
-- Assumptions are checked explicitly so this migration never depends on an
-- accidental search_path or silently uses an unexpected PostGIS installation.
DO $preflight$
DECLARE
  postgis_schema name;
BEGIN
  IF pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION
      'Phase 2 requires pg_catalog.gen_random_uuid(); this Supabase project must run PostgreSQL 13 or newer';
  END IF;

  SELECT namespace.nspname
    INTO postgis_schema
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = extension.extnamespace
   WHERE extension.extname = 'postgis';

  IF postgis_schema IS DISTINCT FROM 'extensions' THEN
    RAISE EXCEPTION
      'Phase 2 expects PostGIS in schema "extensions"; found %',
      COALESCE(postgis_schema::text, '<not installed>');
  END IF;

  IF pg_catalog.to_regtype('extensions.geography') IS NULL THEN
    RAISE EXCEPTION 'PostGIS geography type was not found in schema "extensions"';
  END IF;

  IF pg_catalog.to_regprocedure(
       'extensions.st_dwithin(extensions.geography,extensions.geography,double precision,boolean)'
     ) IS NULL THEN
    RAISE EXCEPTION 'PostGIS ST_DWithin(geography, geography, meters, spheroid) is unavailable';
  END IF;
END;
$preflight$;

-- Shared trigger implementation for mutable business tables. clock_timestamp()
-- records the actual update instant, even during a longer open transaction.
CREATE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$function$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT organizations_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT organizations_slug_format CHECK (
    slug = pg_catalog.lower(pg_catalog.btrim(slug))
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT organizations_slug_unique UNIQUE (slug),
  CONSTRAINT organizations_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.workspaces (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT workspaces_organization_fk
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations (id)
    ON DELETE RESTRICT,
  CONSTRAINT workspaces_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT workspaces_slug_format CHECK (
    slug = pg_catalog.lower(pg_catalog.btrim(slug))
    AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT workspaces_organization_slug_unique UNIQUE (organization_id, slug),
  CONSTRAINT workspaces_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT projects_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  CONSTRAINT projects_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT projects_status_valid CHECK (status IN ('active', 'archived')),
  CONSTRAINT projects_workspace_identity_unique UNIQUE (id, workspace_id),
  CONSTRAINT projects_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.datasets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  dataset_type text NOT NULL,
  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT datasets_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  CONSTRAINT datasets_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT datasets_type_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(dataset_type)) > 0),
  CONSTRAINT datasets_source_nonempty CHECK (source IS NULL OR pg_catalog.char_length(pg_catalog.btrim(source)) > 0),
  -- Required target for child-table composite FKs that enforce workspace ownership.
  CONSTRAINT datasets_workspace_identity_unique UNIQUE (id, workspace_id),
  CONSTRAINT datasets_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

-- Projects and datasets share a workspace but remain independently reusable.
CREATE TABLE public.project_datasets (
  project_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT project_datasets_pk PRIMARY KEY (project_id, dataset_id),
  CONSTRAINT project_datasets_workspace_fk
    FOREIGN KEY (workspace_id)
    REFERENCES public.workspaces (id)
    ON DELETE RESTRICT,
  -- Deleting a project or dataset removes only this association row.
  CONSTRAINT project_datasets_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects (id, workspace_id)
    ON DELETE CASCADE,
  CONSTRAINT project_datasets_dataset_workspace_fk
    FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES public.datasets (id, workspace_id)
    ON DELETE CASCADE
);

CREATE INDEX projects_workspace_status_created_idx
  ON public.projects (workspace_id, status, created_at DESC);
CREATE INDEX datasets_workspace_created_idx
  ON public.datasets (workspace_id, created_at DESC);
CREATE INDEX project_datasets_dataset_workspace_project_idx
  ON public.project_datasets (dataset_id, workspace_id, project_id);
CREATE INDEX project_datasets_workspace_idx
  ON public.project_datasets (workspace_id);

CREATE TRIGGER organizations_set_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workspaces_set_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER projects_set_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER datasets_set_updated_at
  BEFORE UPDATE ON public.datasets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Secure the ownership tables as soon as they are created. There are no
-- policies or client grants until authentication/member policies are designed.
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_datasets ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.organizations,
  public.workspaces,
  public.projects,
  public.datasets,
  public.project_datasets
FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.project_datasets IS
  'Workspace-scoped many-to-many association; composite foreign keys prohibit cross-workspace links.';
COMMENT ON CONSTRAINT projects_workspace_identity_unique ON public.projects IS
  'Supports composite foreign keys that verify project/workspace ownership.';
COMMENT ON CONSTRAINT datasets_workspace_identity_unique ON public.datasets IS
  'Supports composite foreign keys that verify dataset/workspace ownership.';
