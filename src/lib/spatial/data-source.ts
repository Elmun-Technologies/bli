export const DATA_SOURCE_MODES = ['database', 'fixtures'] as const;
export type DataSourceMode = (typeof DATA_SOURCE_MODES)[number];

/** Database mode is the explicit default; invalid values never fall back to fixtures. */
export function resolveDataSourceMode(value = process.env.DATA_SOURCE): DataSourceMode {
  if (value === undefined || value === '' || value === 'database') return 'database';
  if (value === 'fixtures') return 'fixtures';

  throw new Error('DATA_SOURCE must be either "database" or "fixtures".');
}
