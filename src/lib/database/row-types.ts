/**
 * Compatibility aliases and data-access boundaries for generated database rows.
 * `database.types.ts` is the sole source of truth for SQL row columns and is
 * regenerated from the clean, verified local schema by `npm run verify:database`.
 * Do not redeclare row fields here or hand-edit the generated file.
 *
 * Keep raw rows in server/data-access code. Parse them into domain mappings
 * before constructing display DTOs; never pass customer rows to map components.
 */
import type { Database } from './database.types';

type PublicTables = Database['public']['Tables'];

/** A Row type derived directly from the generated public schema. */
export type DatabaseRow<TableName extends keyof PublicTables> =
  PublicTables[TableName]['Row'];

export type OrganizationRow = DatabaseRow<'organizations'>;
export type WorkspaceRow = DatabaseRow<'workspaces'>;
export type ProjectRow = DatabaseRow<'projects'>;
export type DatasetRow = DatabaseRow<'datasets'>;
export type ProjectDatasetRow = DatabaseRow<'project_datasets'>;
export type LocationRow = DatabaseRow<'locations'>;
/** Contains PII and commercial data; never pass this row to a map component. */
export type CustomerRow = DatabaseRow<'customers'>;
export type CompetitorRow = DatabaseRow<'competitors'>;
export type BranchRow = DatabaseRow<'branches'>;
export type AnalysisLocationRow = DatabaseRow<'analysis_locations'>;

/**
 * PostGIS geography is emitted as `unknown` by the Supabase type generator.
 * Keep that raw value opaque until a driver/query-specific parser validates it.
 */
export type RawGeographyValue = LocationRow['spatial_point'];

/**
 * Supabase currently generates PostgreSQL numeric fields as TypeScript number;
 * precision-sensitive domain mappings must not assume binary floats are exact.
 */
export type RawNumericValue = NonNullable<CustomerRow['revenue']>;

/** Every public Phase 2 table maps to its generated Row type. */
export type Phase2DatabaseRows = {
  [TableName in keyof PublicTables]: DatabaseRow<TableName>;
};
