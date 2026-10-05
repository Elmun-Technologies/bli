/**
 * CSV parsing (RFC 4180 with the usual real-world tolerance).
 *
 * Delimiter detection covers comma, semicolon and tab, quoting is handled by
 * `csv-parse`, and formulas are never executed because CSV has no formula
 * concept - values that start with `=`, `+`, `-` or `@` are treated as text and
 * the export step neutralizes them so a downloaded file cannot run anything.
 */
import { parse } from 'csv-parse/sync';
import { ImportParseError } from './errors';
import type { ParsedImportSource } from './index';

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Detects the delimiter from the first non-empty lines, ignoring quoted parts. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 10);
  let best = ',';
  let bestScore = -1;

  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => countUnquoted(line, delimiter));
    if (counts.length === 0) continue;
    const first = counts[0];
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length;
    const score = consistent * 100 + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function countUnquoted(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

export function parseCsvSource(bytes: Uint8Array): ParsedImportSource {
  const warnings: string[] = [];
  let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

  // Reject binary content that survives the sniffing step (a renamed image, a
  // PDF, an encrypted workbook) instead of importing scrambled bytes.
  const replacementCharacters = (text.match(/\ufffd/g) ?? []).length;
  if (replacementCharacters > 0 && replacementCharacters / Math.max(text.length, 1) > 0.01) {
    throw new ImportParseError(
      'unreadable_file',
      'The file is not valid UTF-8 text. CSV files must be UTF-8 encoded.',
    );
  }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (text.trim() === '') {
    throw new ImportParseError('empty_file', 'The file has no content.');
  }

  const delimiter = detectDelimiter(text);
  if (delimiter !== ',') {
    warnings.push(`Detected "${delimiter === '\t' ? 'tab' : delimiter}" as the column separator.`);
  }

  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parse(text, {
      bom: true,
      columns: false,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      delimiter,
      info: true,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parser error';
    throw new ImportParseError('unreadable_file', `The CSV could not be read: ${message}`);
  }

  if (records.length === 0) {
    throw new ImportParseError('empty_file', 'The file has no content.');
  }

  const headerRecord = records[0];
  const headers = headerRecord.record.map((value) => value.replace(/\s+/g, ' ').trim());
  const rowCount = headerRecord.record.length;

  const rows: string[][] = [];
  const rowNumbers: number[] = [];

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (record.record.length > rowCount) {
      warnings.push(
        `Row ${record.info.lines} has ${record.record.length} values but the header has ${rowCount} columns; the extra values were ignored.`,
      );
    }
    if (record.record.length < rowCount) {
      warnings.push(`Row ${record.info.lines} is missing ${rowCount - record.record.length} value(s).`);
    }
    const padded = record.record.slice(0, rowCount);
    while (padded.length < rowCount) padded.push('');
    rows.push(padded);
    // `info.lines` is the last line of the record; walk back over newlines that
    // belong to quoted values so the number is the line the row starts on.
    const embeddedNewlines = record.record.reduce(
      (sum, value) => sum + (value.match(/\n/g) ?? []).length,
      0,
    );
    rowNumbers.push(record.info.lines - embeddedNewlines);
  }

  return {
    fileType: 'csv',
    sheetName: null,
    sheets: [],
    headers,
    rows,
    rowNumbers,
    warnings: dedupeWarnings(warnings),
  };
}

function dedupeWarnings(warnings: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const warning of warnings) {
    const key = warning.replace(/\d+/g, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(warning);
    if (result.length >= 5) break;
  }
  return result;
}
