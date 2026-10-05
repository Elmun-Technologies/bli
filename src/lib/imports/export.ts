/**
 * Import error export (CSV).
 *
 * The exported file is the user's own data, so the format is boring and exact:
 * row number, the relevant original fields, the error code and a safe message.
 * No stack traces, no SQL, no internal identifiers.
 *
 * Formula injection: a spreadsheet opens `=HYPERLINK(...)`, `+cmd`, `-...` and
 * `@...` as a formula. Every cell that starts with one of those characters (or
 * a tab/CR that Excel strips into one) is prefixed with an apostrophe, which
 * Excel and LibreOffice treat as literal text. This is applied to exported data
 * from an untrusted upload, never to trusted literals.
 */
import { stringify } from 'csv-stringify/sync';

export interface ExportRow {
  rowNumber: number;
  fields: Record<string, string | null>;
  errorCode: string;
  errorField: string;
  errorMessage: string;
}

const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function neutralizeFormulaCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (text === '') return '';
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

export function buildErrorCsv(rows: ExportRow[], extraColumns: string[] = []): string {
  const columns = ['row_number', 'error_code', 'error_field', 'error_message', ...extraColumns];
  const records = rows.map((row) => {
    const record: Record<string, string> = {
      row_number: String(row.rowNumber),
      error_code: neutralizeFormulaCell(row.errorCode),
      error_field: neutralizeFormulaCell(row.errorField),
      error_message: neutralizeFormulaCell(row.errorMessage),
    };
    for (const column of extraColumns) {
      record[column] = neutralizeFormulaCell(row.fields[column] ?? null);
    }
    return record;
  });

  return stringify(records, { header: true, columns });
}

/** Filename for the export, derived safely from the original upload name. */
export function buildErrorExportFilename(originalFilename: string): string {
  // Keep only the last path segment first: "../../etc/passwd" is "passwd", not a
  // path the export could ever be written to.
  const bareName = originalFilename.split(/[\\/]/).pop() ?? originalFilename;
  const lastDot = bareName.lastIndexOf('.');
  const withoutExtension = lastDot > 0 ? bareName.slice(0, lastDot) : bareName;
  const base = withoutExtension
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s._-]+/, '')
    .slice(0, 80)
    .replace(/[\s._-]+$/, '');
  return `${base || 'import'}-errors.csv`;
}
