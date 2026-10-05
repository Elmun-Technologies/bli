import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { IMPORT_LIMITS } from '../limits';
import { ImportParseError } from './errors';
import { detectSourceType, inspectImportSource, listImportSheets } from './index';
import { detectDelimiter, parseCsvSource } from './csv';
import { readWorkbookSheets } from './xlsx';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', '__fixtures__');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

function encoder(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test('CSV: parses headers, skips blank rows and preserves source row numbers', () => {
  const csv = 'name,phone,address\nA,1,Tashkent\n\nB,2,Samarqand\n';
  const parsed = parseCsvSource(encoder(csv));

  assert.deepEqual(parsed.headers, ['name', 'phone', 'address']);
  assert.deepEqual(parsed.rows, [
    ['A', '1', 'Tashkent'],
    ['B', '2', 'Samarqand'],
  ]);
  assert.deepEqual(parsed.rowNumbers, [2, 4]);
  assert.equal(parsed.fileType, 'csv');
  assert.equal(parsed.sheetName, null);
});

test('CSV: strips a UTF-8 BOM and decodes Cyrillic and Uzbek Latin text', () => {
  const csv = '\ufeffКлиент,Адрес\nАзиз Каримов,Ташкент\nO‘zbekiston,Chilonzor\n';
  const parsed = parseCsvSource(encoder(csv));

  assert.deepEqual(parsed.headers, ['Клиент', 'Адрес']);
  assert.deepEqual(parsed.rows, [
    ['Азиз Каримов', 'Ташкент'],
    ['O‘zbekiston', 'Chilonzor'],
  ]);
});

test('CSV: detects semicolon and tab separators', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.equal(detectDelimiter('a,b\n1,2'), ',');

  const parsed = parseCsvSource(encoder('name;address\nA;Tashkent'));
  assert.deepEqual(parsed.headers, ['name', 'address']);
  assert.match(parsed.warnings.join(' '), /";"/);
});

test('CSV: keeps quoted values intact and rejects binary content', async () => {
  const quoted = 'name,note\n"Karimov, Aziz","line one\nline two"\n';
  const parsed = parseCsvSource(encoder(quoted));
  assert.deepEqual(parsed.rows, [['Karimov, Aziz', 'line one\nline two']]);

  const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x00]);
  await assert.rejects(
    () => inspectImportSource(binary, 'photo.csv'),
    (error: ImportParseError) => error.code === 'unreadable_file',
  );
});

test('CSV: rejects duplicate headers, missing data and oversized row counts', async () => {
  await assert.rejects(
    () => inspectImportSource(encoder('name,Name\nA,B'), 'dupe.csv'),
    (error: ImportParseError) => error.code === 'duplicate_header',
  );

  await assert.rejects(
    () => inspectImportSource(encoder('name,address\n'), 'empty-rows.csv'),
    (error: ImportParseError) => error.code === 'no_data_rows',
  );

  const tooManyColumns = `${Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',')}\n${Array.from(
    { length: IMPORT_LIMITS.maxColumns + 1 },
    () => '1',
  ).join(',')}\n`;
  await assert.rejects(
    () => inspectImportSource(encoder(tooManyColumns), 'wide.csv'),
    (error: ImportParseError) => error.code === 'too_many_columns',
  );

  const rowLimit = `${['name', 'address'].join(',')}\n${Array.from(
    { length: IMPORT_LIMITS.maxRows + 1 },
    () => 'A,Tashkent',
  ).join('\n')}\n`;
  await assert.rejects(
    () => inspectImportSource(encoder(rowLimit), 'big.csv'),
    (error: ImportParseError) => error.code === 'too_many_rows',
  );
});

test('file type sniffing uses content, not the extension or the reported MIME type', async () => {
  const xlsx = fixture('customers-single-sheet.xlsx');
  assert.equal(detectSourceType(xlsx).type, 'xlsx');

  // A ZIP (xlsx) renamed to .csv is refused: the content and the name disagree.
  await assert.rejects(
    () => inspectImportSource(xlsx, 'disguised.csv'),
    (error: ImportParseError) => error.code === 'file_type_mismatch',
  );

  // Real legacy .xls (OLE2) is refused outright.
  const ole2 = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  await assert.rejects(
    () => inspectImportSource(ole2, 'legacy.xls'),
    (error: ImportParseError) => error.code === 'unsupported_type',
  );

  // A CSV named .xlsx is refused as well.
  await assert.rejects(
    () => inspectImportSource(encoder('name,address\nA,B\n'), 'actually.csv'.replace('.csv', '.xlsx')),
    (error: ImportParseError) => error.code === 'file_type_mismatch',
  );

  // Unsupported extensions never reach a parser.
  await assert.rejects(
    () => inspectImportSource(encoder('name\nA\n'), 'notes.txt'),
    (error: ImportParseError) => error.code === 'unsupported_type',
  );
  await assert.rejects(
    () => inspectImportSource(encoder('name\nA\n'), 'sheet.ods'),
    (error: ImportParseError) => error.code === 'unsupported_type',
  );
});

test('file size limit is enforced before parsing', async () => {
  const oversized = new Uint8Array(IMPORT_LIMITS.maxFileBytes + 1);
  oversized.fill(0x41);
  await assert.rejects(
    () => inspectImportSource(oversized, 'huge.csv'),
    (error: ImportParseError) => error.code === 'file_too_large',
  );
});

test('XLSX: a single-sheet workbook is auto-selected', async () => {
  const parsed = await inspectImportSource(fixture('customers-single-sheet.xlsx'), 'customers.xlsx');

  assert.equal(parsed.fileType, 'xlsx');
  assert.equal(parsed.sheetName, 'Mijozlar');
  assert.deepEqual(parsed.headers, [
    'Mijoz',
    'Telefon',
    'Manzil',
    'Savdo',
    'Buyurtma',
    'Sana',
    'Kategoriya',
  ]);
  assert.equal(parsed.sheets.length, 1);
  assert.equal(parsed.sheets[0].name, 'Mijozlar');
  assert.equal(parsed.sheets[0].usable, true);

  // The blank spreadsheet row is dropped but row numbers keep the file's shape.
  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(parsed.rowNumbers, [2, 4, 5, 6]);

  const formulaRow = parsed.rows.find((row) => row.includes('2000'));
  assert.ok(formulaRow, 'the cached formula result is imported as a value');
  const dateRow = parsed.rows.flat().find((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
  assert.ok(dateRow, 'Excel dates arrive as ISO strings');
});

test('XLSX: several usable sheets require an explicit choice, others are listed', async () => {
  const bytes = fixture('customers-multi-sheet.xlsx');
  const sheets = await listImportSheets(bytes, 'customers-multi-sheet.xlsx');
  assert.deepEqual(
    sheets.map((sheet) => sheet.name),
    ['Clients', 'Notes'],
  );
  assert.equal(sheets[0].usable, true);
  assert.equal(sheets[1].usable, true);

  await assert.rejects(
    () => inspectImportSource(bytes, 'customers-multi-sheet.xlsx'),
    (error: ImportParseError) => error.code === 'sheet_selection_required',
  );

  const parsed = await inspectImportSource(bytes, 'customers-multi-sheet.xlsx', { sheetName: 'Clients' });
  assert.equal(parsed.sheetName, 'Clients');
  assert.deepEqual(parsed.headers, ['Client', 'Telefon', 'Adres', 'Vyruchka']);

  const notes = await inspectImportSource(bytes, 'customers-multi-sheet.xlsx', { sheetName: 'Notes' });
  assert.deepEqual(notes.headers, ['Izoh']);

  await assert.rejects(
    () => inspectImportSource(bytes, 'customers-multi-sheet.xlsx', { sheetName: 'Missing' }),
    (error: ImportParseError) => error.code === 'unknown_sheet',
  );
});

test('XLSX: Cyrillic headers and data survive the round trip', async () => {
  const parsed = await inspectImportSource(fixture('customers-cyrillic.xlsx'), 'клиенты.xlsx');
  assert.deepEqual(parsed.headers, [
    'Клиент',
    'Телефон',
    'Адрес',
    'Широта',
    'Долгота',
    'Выручка',
    'Заказы',
  ]);
  assert.ok(parsed.rows.some((row) => row[0] === 'Анна Смирнова'));
  // Out-of-range and non-numeric cells are carried through for validation to
  // report - the parser never discards or repairs them.
  assert.ok(parsed.rows.some((row) => row.includes('91.5')));
  assert.ok(parsed.rows.some((row) => row.includes('not-money')));
});

test('XLSX: a corrupt workbook reports a safe error', async () => {
  const notAZip = new Uint8Array(200);
  notAZip.set(encoder('PK\u0003\u0004'), 0);
  for (let index = 4; index < notAZip.length; index += 1) notAZip[index] = index;
  await assert.rejects(
    () => inspectImportSource(notAZip, 'broken.xlsx'),
    (error: ImportParseError) => error.code === 'corrupt_file',
  );
});

test('XLSX: reading a workbook never executes formulas', async () => {
  const sheets = await readWorkbookSheets(fixture('customers-single-sheet.xlsx'));
  const cells = sheets.flatMap((sheet) => sheet.rows.flat());
  // Formula cells arrive as their cached value; nothing formula-shaped leaks in.
  assert.ok(!cells.some((value) => value.startsWith('=')));
  assert.ok(cells.includes('2000'));
});
