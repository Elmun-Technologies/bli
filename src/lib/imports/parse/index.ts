/**
 * File inspection: turns a raw upload into `{headers, rows, sheets}` without
 * writing anything anywhere. Pure, deterministic and unit-testable, so the API
 * routes stay thin and the same code powers the fixtures smoke test.
 */
import { IMPORT_LIMITS, IMPORT_MAX_SHEET_NAME_LENGTH, type ImportFileType } from '../limits';
import { ImportParseError } from './errors';
import { parseCsvSource } from './csv';
import { parseXlsxSource, type XlsxSheet } from './xlsx';

export { ImportParseError } from './errors';

export interface ImportSheet {
  name: string;
  /** 0-based index in the workbook. */
  index: number;
  rowCount: number;
  /** True when this sheet has a usable header row and at least one data row. */
  usable: boolean;
}

export interface ParsedImportSource {
  fileType: ImportFileType;
  /** Sheet actually inspected. `null` for CSV. */
  sheetName: string | null;
  sheets: ImportSheet[];
  headers: string[];
  /** Data rows (header excluded, empty rows dropped), original values as text. */
  rows: string[][];
  /** 1-based file line number of each row, for `source_row_number`. */
  rowNumbers: number[];
  warnings: string[];
}

export interface ParseOptions {
  /** Sheet name to read for XLSX. Omit to auto-select a single-sheet workbook. */
  sheetName?: string | null;
}

export type SourceType = 'csv' | 'xlsx';

/**
 * Determines the real file type from its content, not from the uploaded MIME
 * type or the filename alone. A `.csv` that is really a ZIP (xlsx) or a `.xlsx`
 * that is really text is reported as `mismatch`, because trusting the extension
 * or the reported MIME type is exactly the kind of thing an attacker controls.
 */
export type SourceSniff =
  | { type: 'csv' }
  | { type: 'xlsx' }
  | { type: 'unknown'; reason: 'legacy_xls' | 'binary' };

export function detectSourceType(bytes: Uint8Array): SourceSniff {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return { type: 'xlsx' };
  }
  // OLE2 compound files are legacy .xls, which Phase 5 refuses.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
  ) {
    return { type: 'unknown', reason: 'legacy_xls' };
  }
  const head = decodeUtf8(bytes.subarray(0, 2048));
  if (head.includes('\u0000')) return { type: 'unknown', reason: 'binary' };
  return { type: 'csv' };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function extensionOf(filename: string): SourceType | 'unknown' {
  const lower = filename.toLocaleLowerCase('en');
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return 'unknown';
}

export async function inspectImportSource(
  bytes: Uint8Array,
  filename: string,
  options: ParseOptions = {},
): Promise<ParsedImportSource> {
  if (bytes.length === 0) {
    throw new ImportParseError('empty_file', 'The file is empty.');
  }
  if (bytes.length > IMPORT_LIMITS.maxFileBytes) {
    const megabytes = (IMPORT_LIMITS.maxFileBytes / (1024 * 1024)).toFixed(0);
    throw new ImportParseError('file_too_large', `Files must be ${megabytes} MB or smaller.`);
  }

  const extension = extensionOf(filename);
  const detected = detectSourceType(bytes);

  if (extension === 'unknown') {
    if (detected.type === 'xlsx') {
      throw new ImportParseError('unsupported_type', 'Only .csv and .xlsx files can be imported.');
    }
    if (detected.type === 'unknown' && detected.reason === 'legacy_xls') {
      throw new ImportParseError(
        'unsupported_type',
        'Only .csv and .xlsx files can be imported. Legacy .xls workbooks are not supported; save as .xlsx.',
      );
    }
    throw new ImportParseError('unsupported_type', 'Only .csv and .xlsx files can be imported.');
  }

  if (detected.type === 'unknown') {
    if (detected.type === 'unknown' && detected.reason === 'legacy_xls') {
      throw new ImportParseError(
        'unsupported_type',
        'This file is not a readable .csv or .xlsx document. Legacy .xls workbooks are not supported; save as .xlsx.',
      );
    }
    throw new ImportParseError(
      'unreadable_file',
      `The file is named ${extension.toUpperCase()} but its content is not readable text.`,
    );
  }

  if (detected.type !== extension) {
    throw new ImportParseError(
      'file_type_mismatch',
      `The file is named ${extension.toUpperCase()} but its content is a ${detected.type.toUpperCase()} document.`,
    );
  }

  const source =
    detected.type === 'xlsx'
      ? await parseXlsxSource(bytes, filename, options)
      : parseCsvSource(bytes);

  applyLimits(source);
  return source;
}

/** Lists the sheets of an XLSX upload without validating its contents. */
export async function listImportSheets(bytes: Uint8Array, filename: string): Promise<ImportSheet[]> {
  const detected = detectSourceType(bytes);
  if (extensionOf(filename) !== 'xlsx' || detected.type !== 'xlsx') {
    throw new ImportParseError('unsupported_type', 'Sheets are only available for .xlsx workbooks.');
  }
  const workbook = await parseXlsxWorkbook(bytes);
  return workbook.map((sheet, index) => ({
    name: sheet.name.slice(0, IMPORT_MAX_SHEET_NAME_LENGTH),
    index,
    rowCount: sheet.rows.length,
    usable: sheet.rows.length > 1,
  }));
}

function applyLimits(source: ParsedImportSource): void {
  if (source.headers.length === 0) {
    throw new ImportParseError('missing_header', 'No column headers were found in the file.');
  }
  if (source.headers.length > IMPORT_LIMITS.maxColumns) {
    throw new ImportParseError(
      'too_many_columns',
      `The file has ${source.headers.length} columns; at most ${IMPORT_LIMITS.maxColumns} are supported.`,
    );
  }

  const headerKeys = new Map<string, string>();
  for (const header of source.headers) {
    if (header === '') {
      throw new ImportParseError('missing_header', 'Every column needs a header row value.');
    }
    const key = header.toLocaleLowerCase('en');
    if (headerKeys.has(key)) {
      throw new ImportParseError(
        'duplicate_header',
        `The column name "${header}" appears more than once; column names must be unique.`,
      );
    }
    headerKeys.set(key, header);
  }

  if (source.rows.length === 0) {
    throw new ImportParseError('no_data_rows', 'The file has a header row but no data rows.');
  }
  if (source.rows.length > IMPORT_LIMITS.maxRows) {
    throw new ImportParseError(
      'too_many_rows',
      `The file has ${source.rows.length} data rows; at most ${IMPORT_LIMITS.maxRows} can be imported in one import. Nothing was imported; split the file and try again.`,
    );
  }
}

// Re-exported so callers do not need to know which parser module is which.
export { parseXlsxWorkbook } from './xlsx';
import { parseXlsxWorkbook } from './xlsx';
export type { XlsxSheet };
