import assert from 'node:assert/strict';
import test from 'node:test';

import { buildErrorCsv, buildErrorExportFilename, neutralizeFormulaCell } from './export';

test('export: formula-leading cells are neutralized so a downloaded file cannot run anything', () => {
  assert.equal(neutralizeFormulaCell('=HYPERLINK("http://evil","click")'), '\'=HYPERLINK("http://evil","click")');
  assert.equal(neutralizeFormulaCell('+1+1'), "'+1+1");
  assert.equal(neutralizeFormulaCell('-2+3'), "'-2+3");
  assert.equal(neutralizeFormulaCell('@SUM(A1:A2)'), "'@SUM(A1:A2)");
  assert.equal(neutralizeFormulaCell('\tcmd|/c calc'), "'\tcmd|/c calc");
  assert.equal(neutralizeFormulaCell('Ali Valiyev'), 'Ali Valiyev');
  assert.equal(neutralizeFormulaCell(''), '');
  assert.equal(neutralizeFormulaCell(null), '');
});

test('export: the CSV carries row number, relevant fields, code and message', () => {
  const csv = buildErrorCsv(
    [
      {
        rowNumber: 4,
        fields: { name: 'Botir', address: 'Buxoro, Kogon 9', phone: '+998903334455' },
        errorCode: 'invalid_revenue',
        errorField: 'revenue',
        errorMessage: 'Amount is not a valid number.',
      },
      {
        rowNumber: 5,
        fields: { name: '=cmd()', address: 'Tashkent', phone: null },
        errorCode: 'missing_spatial_input',
        errorField: 'address',
        errorMessage: 'Row has no coordinates and no address to geocode.',
      },
    ],
    ['name', 'address', 'phone'],
  );

  const lines = csv.split('\n');
  assert.equal(lines[0], 'row_number,error_code,error_field,error_message,name,address,phone');
  // A "+" or "-" lead is neutralized too, so phone numbers are exported as
  // text (spreadsheets hide the apostrophe; a text editor shows the marker).
  assert.match(
    lines[1],
    /^4,invalid_revenue,revenue,Amount is not a valid number\.,Botir,"Buxoro, Kogon 9",'\+998903334455$/,
  );
  assert.match(lines[2], /^5,missing_spatial_input,address,/);
  assert.ok(lines[2].includes("'=cmd()"), 'the exported value is neutralized');
  assert.ok(!csv.includes('at Object.'), 'no stack traces');
});

test('export: filenames are sanitized against traversal and overflow', () => {
  assert.equal(buildErrorExportFilename('customers.csv'), 'customers-errors.csv');
  assert.equal(buildErrorExportFilename('../../etc/passwd'), 'passwd-errors.csv');
  assert.equal(buildErrorExportFilename('C:\\temp\\customers.xlsx'), 'customers-errors.csv');
  assert.equal(buildErrorExportFilename('клиенты.xlsx'), 'клиенты-errors.csv');
  assert.equal(buildErrorExportFilename('...'), 'import-errors.csv');
  assert.ok(buildErrorExportFilename(`${'a'.repeat(200)}.csv`).length <= 92);
});
