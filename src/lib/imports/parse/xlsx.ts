/**
 * XLSX parsing via `read-excel-file` (which never evaluates formulas - it reads
 * the cached result Excel stored alongside the formula, or nothing at all).
 *
 * Safety notes:
 *   * no `.xls` (OLE2) and no `.ods`/ZIP-with-other-contents: the entry sniffing
 *     in ../parse/index.ts rejects them before we get here;
 *   * workbook XML is parsed by the library into plain JS values, so no sheet
 *     macro, formula or Excel feature can execute;
 *   * only the selected sheet's cells are read; a workbook with 500 sheets costs
 *     nothing extra once the user picks one.
 */
import readXlsxFile from 'read-excel-file/node';
import { IMPORT_MAX_SHEET_NAME_LENGTH } from '../limits';
import { ImportParseError } from './errors';
import type { ParsedImportSource } from './index';

export interface XlsxSheet {
  name: string;
  rows: string[][];
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // read-excel-file returns real dates for date-formatted cells.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') {
    // Keep numbers exact: 1250.5 must not become "1250.5000000001".
    return Number.isInteger(value) ? String(value) : String(value);
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') {
    if ('text' in (value as Record<string, unknown>)) return String((value as { text: unknown }).text);
    if ('result' in (value as Record<string, unknown>)) return cellToText((value as { result: unknown }).result);
    return '';
  }
  return String(value);
}

/** Reads every sheet of the workbook into text matrices. */
export async function readWorkbookSheets(bytes: Uint8Array): Promise<XlsxSheet[]> {
  let result: unknown;
  try {
    result = await readXlsxFile(Buffer.from(bytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown workbook error';
    throw new ImportParseError('corrupt_file', `The workbook could not be read: ${message}`);
  }

  const sheets: XlsxSheet[] = [];
  const asArray = Array.isArray(result) ? result : [];
  const looksLikeSheets = asArray.every(
    (entry) => entry !== null && typeof entry === 'object' && 'sheet' in (entry as object),
  );

  if (looksLikeSheets && asArray.length > 0) {
    for (const entry of asArray as Array<{ sheet: string; data: unknown[][] }>) {
      sheets.push({
        name: String(entry.sheet ?? '').slice(0, IMPORT_MAX_SHEET_NAME_LENGTH) || `Sheet${sheets.length + 1}`,
        rows: normalizeMatrix(entry.data),
      });
    }
  } else {
    // Single-sheet workbook: the library returns the bare data matrix.
    sheets.push({ name: 'Sheet1', rows: normalizeMatrix(asArray as unknown[][]) });
  }

  if (sheets.length === 0) {
    throw new ImportParseError('empty_file', 'The workbook has no sheets.');
  }
  return sheets;
}

function normalizeMatrix(data: unknown): string[][] {
  if (!Array.isArray(data)) return [];
  return (data as unknown[][]).map((row) =>
    Array.isArray(row) ? row.map((cell) => cellToText(cell)) : [],
  );
}

/** Synchronous-looking helper used by the API routes (await it). */
export async function parseXlsxWorkbook(bytes: Uint8Array): Promise<XlsxSheet[]> {
  return readWorkbookSheets(bytes);
}

export async function parseXlsxSource(
  bytes: Uint8Array,
  _filename: string,
  options: { sheetName?: string | null } = {},
): Promise<ParsedImportSource> {
  const sheets = await readWorkbookSheets(bytes);
  const usable = sheets.filter((sheet) => sheet.rows.length > 1);
  const candidates = usable.length > 0 ? usable : sheets;

  let selected = options.sheetName
    ? sheets.find((sheet) => sheet.name === options.sheetName)
    : undefined;

  if (options.sheetName && !selected) {
    throw new ImportParseError('unknown_sheet', `The workbook has no sheet named "${options.sheetName}".`);
  }

  if (!selected && candidates.length > 1) {
    throw new ImportParseError(
      'sheet_selection_required',
      `The workbook contains ${candidates.length} sheets with data. Choose the sheet to import.`,
    );
  }

  selected = selected ?? candidates[0];

  // Keep the true spreadsheet row number of every non-empty row, so the staged
  // `source_row_number` matches the number the user sees in Excel.
  const meaningful = selected.rows
    .map((row, index) => ({ row, sheetRow: index + 1 }))
    .filter((entry) => entry.row.some((cell) => cell.trim() !== ''));

  if (meaningful.length === 0) {
    throw new ImportParseError('no_data_rows', `Sheet "${selected.name}" is empty.`);
  }

  const headers = meaningful[0].row.map((value) => value.replace(/\s+/g, ' ').trim());

  const dataRows: string[][] = [];
  const rowNumbers: number[] = [];
  const warnings: string[] = [];

  for (let index = 1; index < meaningful.length; index += 1) {
    const row = meaningful[index].row.slice(0, headers.length);
    while (row.length < headers.length) row.push('');
    dataRows.push(row);
    rowNumbers.push(meaningful[index].sheetRow);
  }

  if (usable.length > 1) {
    warnings.push(`Read sheet "${selected.name}" of ${sheets.length}.`);
  } else if (sheets.length > 1) {
    warnings.push(`Read sheet "${selected.name}"; the other ${sheets.length - 1} sheet(s) have no data.`);
  }

  return {
    fileType: 'xlsx',
    sheetName: selected.name,
    sheets: sheets.map((sheet, index) => ({
      name: sheet.name,
      index,
      rowCount: Math.max(sheet.rows.length - 1, 0),
      usable: sheet.rows.length > 1,
    })),
    headers,
    rows: dataRows,
    rowNumbers,
    warnings,
  };
}
