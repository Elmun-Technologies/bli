-- Phase 2, migration 2 of 2: workspace-owned geospatial business records.
-- Authoritative point representation: geography(Point, 4326). Metric-distance
-- operations use meters; GeoJSON is produced from an explicit geometry cast.

CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  subcategory text,
  address text,
  spatial_point extensions.geography(Point, 4326) NOT NULL,
  source text,
  external_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT locations_dataset_workspace_fk
    FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES public.datasets (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT locations_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT locations_category_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(category)) > 0),
  CONSTRAINT locations_external_id_nonempty CHECK (
    external_id IS NULL OR pg_catalog.char_length(pg_catalog.btrim(external_id)) > 0
  ),
  CONSTRAINT locations_source_nonempty CHECK (
    source IS NULL OR pg_catalog.char_length(pg_catalog.btrim(source)) > 0
  ),
  CONSTRAINT locations_point_coordinates_valid CHECK (
    NOT extensions.st_isempty(spatial_point::extensions.geometry)
    AND extensions.st_x(spatial_point::extensions.geometry) BETWEEN -180 AND 180
    AND extensions.st_y(spatial_point::extensions.geometry) BETWEEN -90 AND 90
  ),
  CONSTRAINT locations_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  external_id text,
  name text,
  phone text,
  company text,
  address text,
  spatial_point extensions.geography(Point, 4326) NOT NULL,
  revenue numeric(18, 2),
  order_count integer,
  last_order_date date,
  segment text,
  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT customers_dataset_workspace_fk
    FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES public.datasets (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT customers_name_nonempty CHECK (
    name IS NULL OR pg_catalog.char_length(pg_catalog.btrim(name)) > 0
  ),
  CONSTRAINT customers_external_id_nonempty CHECK (
    external_id IS NULL OR pg_catalog.char_length(pg_catalog.btrim(external_id)) > 0
  ),
  CONSTRAINT customers_order_count_nonnegative CHECK (order_count IS NULL OR order_count >= 0),
  CONSTRAINT customers_source_nonempty CHECK (
    source IS NULL OR pg_catalog.char_length(pg_catalog.btrim(source)) > 0
  ),
  CONSTRAINT customers_point_coordinates_valid CHECK (
    NOT extensions.st_isempty(spatial_point::extensions.geometry)
    AND extensions.st_x(spatial_point::extensions.geometry) BETWEEN -180 AND 180
    AND extensions.st_y(spatial_point::extensions.geometry) BETWEEN -90 AND 90
  ),
  CONSTRAINT customers_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.competitors (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  external_id text,
  name text NOT NULL,
  brand text,
  category text NOT NULL,
  subcategory text,
  address text,
  spatial_point extensions.geography(Point, 4326) NOT NULL,
  source text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT competitors_dataset_workspace_fk
    FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES public.datasets (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT competitors_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT competitors_category_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(category)) > 0),
  CONSTRAINT competitors_external_id_nonempty CHECK (
    external_id IS NULL OR pg_catalog.char_length(pg_catalog.btrim(external_id)) > 0
  ),
  CONSTRAINT competitors_source_nonempty CHECK (
    source IS NULL OR pg_catalog.char_length(pg_catalog.btrim(source)) > 0
  ),
  CONSTRAINT competitors_point_coordinates_valid CHECK (
    NOT extensions.st_isempty(spatial_point::extensions.geometry)
    AND extensions.st_x(spatial_point::extensions.geometry) BETWEEN -180 AND 180
    AND extensions.st_y(spatial_point::extensions.geometry) BETWEEN -90 AND 90
  ),
  CONSTRAINT competitors_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.branches (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  dataset_id uuid NOT NULL,
  external_id text,
  name text NOT NULL,
  address text,
  spatial_point extensions.geography(Point, 4326) NOT NULL,
  revenue numeric(18, 2),
  customers_count integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT branches_dataset_workspace_fk
    FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES public.datasets (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT branches_name_nonempty CHECK (pg_catalog.char_length(pg_catalog.btrim(name)) > 0),
  CONSTRAINT branches_external_id_nonempty CHECK (
    external_id IS NULL OR pg_catalog.char_length(pg_catalog.btrim(external_id)) > 0
  ),
  CONSTRAINT branches_customers_count_nonnegative CHECK (
    customers_count IS NULL OR customers_count >= 0
  ),
  CONSTRAINT branches_point_coordinates_valid CHECK (
    NOT extensions.st_isempty(spatial_point::extensions.geometry)
    AND extensions.st_x(spatial_point::extensions.geometry) BETWEEN -180 AND 180
    AND extensions.st_y(spatial_point::extensions.geometry) BETWEEN -90 AND 90
  ),
  CONSTRAINT branches_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE TABLE public.analysis_locations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  address text,
  spatial_point extensions.geography(Point, 4326) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT analysis_locations_project_workspace_fk
    FOREIGN KEY (project_id, workspace_id)
    REFERENCES public.projects (id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT analysis_locations_name_nonempty CHECK (
    pg_catalog.char_length(pg_catalog.btrim(name)) > 0
  ),
  CONSTRAINT analysis_locations_point_coordinates_valid CHECK (
    NOT extensions.st_isempty(spatial_point::extensions.geometry)
    AND extensions.st_x(spatial_point::extensions.geometry) BETWEEN -180 AND 180
    AND extensions.st_y(spatial_point::extensions.geometry) BETWEEN -90 AND 90
  ),
  CONSTRAINT analysis_locations_metadata_object CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

-- GiST indexes support index-aware geography spatial filters and nearest-distance candidates.
-- `ST_DWithin(geography, geography, meters)` can use these for radius lookups.
CREATE INDEX locations_spatial_gix ON public.locations USING gist (spatial_point);
CREATE INDEX customers_spatial_gix ON public.customers USING gist (spatial_point);
CREATE INDEX competitors_spatial_gix ON public.competitors USING gist (spatial_point);
CREATE INDEX branches_spatial_gix ON public.branches USING gist (spatial_point);
CREATE INDEX analysis_locations_spatial_gix ON public.analysis_locations USING gist (spatial_point);

-- Common scoped filters: workspace + dataset, then normalized category/segment.
CREATE INDEX locations_workspace_dataset_category_idx
  ON public.locations (workspace_id, dataset_id, category);
CREATE INDEX customers_workspace_dataset_segment_idx
  ON public.customers (workspace_id, dataset_id, segment);
CREATE INDEX competitors_workspace_dataset_category_idx
  ON public.competitors (workspace_id, dataset_id, category);
CREATE INDEX branches_workspace_dataset_idx
  ON public.branches (workspace_id, dataset_id);
CREATE INDEX analysis_locations_workspace_project_created_idx
  ON public.analysis_locations (workspace_id, project_id, created_at DESC);

-- External IDs are ingestion/upsert keys within their owning dataset.
CREATE UNIQUE INDEX locations_dataset_external_id_uidx
  ON public.locations (dataset_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX customers_dataset_external_id_uidx
  ON public.customers (dataset_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX competitors_dataset_external_id_uidx
  ON public.competitors (dataset_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX branches_dataset_external_id_uidx
  ON public.branches (dataset_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TRIGGER locations_set_updated_at
  BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER customers_set_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER competitors_set_updated_at
  BEFORE UPDATE ON public.competitors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER branches_set_updated_at
  BEFORE UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER analysis_locations_set_updated_at
  BEFORE UPDATE ON public.analysis_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The ownership tables were secured in migration 1. These new tenant-scoped
-- data tables likewise have RLS enabled, no policies and no client grants.
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_locations ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  public.locations,
  public.customers,
  public.competitors,
  public.branches,
  public.analysis_locations
FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.customers IS
  'Workspace/dataset-scoped customer records. Contact, address and revenue fields are PII/sensitive and must not be returned in generic map DTOs.';
COMMENT ON COLUMN public.customers.revenue IS
  'Exact decimal amount; numeric avoids floating-point currency errors.';
COMMENT ON TABLE public.analysis_locations IS
  'Persisted, project-scoped candidate locations. Transient map-click candidates remain client state until explicitly saved in a later phase.';
COMMENT ON COLUMN public.locations.spatial_point IS
  'Authoritative WGS84 point as geography(Point,4326); longitude/latitude scalars are intentionally not duplicated.';
COMMENT ON COLUMN public.customers.spatial_point IS
  'Authoritative WGS84 point as geography(Point,4326); longitude/latitude scalars are intentionally not duplicated.';
COMMENT ON COLUMN public.competitors.spatial_point IS
  'Authoritative WGS84 point as geography(Point,4326); longitude/latitude scalars are intentionally not duplicated.';
COMMENT ON COLUMN public.branches.spatial_point IS
  'Authoritative WGS84 point as geography(Point,4326); longitude/latitude scalars are intentionally not duplicated.';
COMMENT ON COLUMN public.analysis_locations.spatial_point IS
  'Authoritative WGS84 point as geography(Point,4326); longitude/latitude scalars are intentionally not duplicated.';
