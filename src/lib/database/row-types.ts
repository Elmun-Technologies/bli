/**
 * Explicit, read-only TypeScript mirrors of the Phase 2 SQL row columns.
 * The SQL migrations remain canonical; these are not generated or verified
 * against a live Supabase instance in this workspace.
 *
 * Keep this module in server/data-access code. Do not import it into map/UI
 * components. Parse geography and numeric wire values into validated domain
 * types before constructing any display or GeoJSON DTO.
 */
export type DatabaseUuid = string;
export type DatabaseTimestamp = string;
export type DatabaseDate = string;

export type DatabaseJsonValue =
  | string
  | number
  | boolean
  | null
  | DatabaseJsonValue[]
  | { [key: string]: DatabaseJsonValue };

export interface DatabaseJsonObject {
  [key: string]: DatabaseJsonValue;
}

/**
 * PostGIS geography serialization varies by query/driver (for example, text
 * output versus an explicitly requested GeoJSON object). Keep raw values
 * opaque until a boundary parser validates them.
 */
export type RawGeographyValue = unknown;

/** PostgreSQL numeric should be parsed without assuming binary float precision. */
export type RawNumericValue = string | number;

export interface OrganizationRow {
  readonly id: DatabaseUuid;
  readonly name: string;
  readonly slug: string;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface WorkspaceRow {
  readonly id: DatabaseUuid;
  readonly organization_id: DatabaseUuid;
  readonly name: string;
  readonly slug: string;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface ProjectRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly name: string;
  readonly description: string | null;
  readonly status: 'active' | 'archived';
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface DatasetRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly name: string;
  readonly description: string | null;
  readonly dataset_type: string;
  readonly source: string | null;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface ProjectDatasetRow {
  readonly project_id: DatabaseUuid;
  readonly dataset_id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly created_at: DatabaseTimestamp;
}

export interface LocationRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly dataset_id: DatabaseUuid;
  readonly name: string;
  readonly category: string;
  readonly subcategory: string | null;
  readonly address: string | null;
  readonly spatial_point: RawGeographyValue;
  readonly source: string | null;
  readonly external_id: string | null;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

/** Contains PII and commercial data; never pass this row to a map component. */
export interface CustomerRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly dataset_id: DatabaseUuid;
  readonly external_id: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly company: string | null;
  readonly address: string | null;
  readonly spatial_point: RawGeographyValue;
  readonly revenue: RawNumericValue | null;
  readonly order_count: number | null;
  readonly last_order_date: DatabaseDate | null;
  readonly segment: string | null;
  readonly source: string | null;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface CompetitorRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly dataset_id: DatabaseUuid;
  readonly external_id: string | null;
  readonly name: string;
  readonly brand: string | null;
  readonly category: string;
  readonly subcategory: string | null;
  readonly address: string | null;
  readonly spatial_point: RawGeographyValue;
  readonly source: string | null;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface BranchRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly dataset_id: DatabaseUuid;
  readonly external_id: string | null;
  readonly name: string;
  readonly address: string | null;
  readonly spatial_point: RawGeographyValue;
  readonly revenue: RawNumericValue | null;
  readonly customers_count: number | null;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface AnalysisLocationRow {
  readonly id: DatabaseUuid;
  readonly workspace_id: DatabaseUuid;
  readonly project_id: DatabaseUuid;
  readonly name: string;
  readonly address: string | null;
  readonly spatial_point: RawGeographyValue;
  readonly metadata: DatabaseJsonObject;
  readonly created_at: DatabaseTimestamp;
  readonly updated_at: DatabaseTimestamp;
}

export interface Phase2DatabaseRows {
  organizations: OrganizationRow;
  workspaces: WorkspaceRow;
  projects: ProjectRow;
  datasets: DatasetRow;
  project_datasets: ProjectDatasetRow;
  locations: LocationRow;
  customers: CustomerRow;
  competitors: CompetitorRow;
  branches: BranchRow;
  analysis_locations: AnalysisLocationRow;
}
