import assert from 'node:assert/strict';
import test from 'node:test';

import { validateImportRows, type StagedRowInput } from './validation';
import type { ColumnMapping } from './column-mapping';

const CUSTOMER_MAPPING: ColumnMapping = {
  Mijoz: 'name',
  Telefon: 'phone',
  Manzil: 'address',
  Kenglik: 'latitude',
  Uzunlik: 'longitude',
  Savdo: 'revenue',
  Buyurtma: 'order_count',
  Sana: 'last_order_date',
  'Tashqi ID': 'external_id',
};

function rows(...values: Array<Record<string, unknown>>): StagedRowInput[] {
  return values.map((value, index) => ({ rowNumber: index + 2, rawData: value }));
}

test('validation: a complete row is valid and normalized exactly', () => {
  const { results, mappingErrors } = validateImportRows(
    rows({
      Mijoz: 'Ali Valiyev',
      Telefon: '+998901112233',
      Manzil: 'Toshkent, Amir Temur 1',
      Kenglik: '41.3111',
      Uzunlik: '69.2797',
      Savdo: '1 250 000,50',
      Buyurtma: '12',
      Sana: '2026-01-15',
      'Tashqi ID': 'C-1',
    }),
    CUSTOMER_MAPPING,
    'customers',
  );

  assert.deepEqual(mappingErrors, []);
  assert.equal(results.length, 1);
  const [result] = results;
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.errors, []);
  assert.equal(result.latitude, 41.3111);
  assert.equal(result.longitude, 69.2797);
  assert.equal(result.normalized.revenue, '1250000.50');
  assert.equal(result.normalized.order_count, '12');
  assert.equal(result.normalized.last_order_date, '2026-01-15');
  assert.equal(result.normalized.phone, '+998901112233');
  assert.equal(result.coordinateWarning, null);
});

test('validation: an address-only row needs geocoding, and keeps the original address', () => {
  const { results } = validateImportRows(
    rows({ Mijoz: 'Zuhra Karimova', Manzil: ' Samarqand, Registon 5 ', Kenglik: '', Uzunlik: '' }),
    CUSTOMER_MAPPING,
    'customers',
  );

  const [result] = results;
  assert.equal(result.status, 'needs_geocoding');
  assert.equal(result.geocodingAddress, 'Samarqand, Registon 5');
  assert.equal(result.latitude, null);
  assert.equal(result.longitude, null);
  assert.deepEqual(result.errors, []);
  assert.equal(result.normalized.address, 'Samarqand, Registon 5');
});

test('validation: a row with neither coordinates nor an address is invalid, never dropped', () => {
  const { results } = validateImportRows(
    rows({ Mijoz: 'No Address', Manzil: '   ', Kenglik: '', Uzunlik: '' }),
    CUSTOMER_MAPPING,
    'customers',
  );

  const [result] = results;
  assert.equal(result.status, 'invalid');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'missing_spatial_input');
  assert.equal(result.errors[0].field, 'address');
});

test('validation: every error carries a row number, a field, a code and a safe message', () => {
  const { results } = validateImportRows(
    rows(
      { Mijoz: 'Bad Coordinates', Kenglik: '91.5', Uzunlik: '181.2', Manzil: 'Tashkent' },
      { Mijoz: 'Bad Money', Savdo: 'not-money', Manzil: 'Tashkent' },
      { Mijoz: 'Bad Count', Buyurtma: '3.5', Manzil: 'Tashkent' },
      { Mijoz: 'Bad Date', Sana: '31.02.2026', Manzil: 'Tashkent' },
      { Mijoz: 'Half Coordinate', Kenglik: '41.3', Manzil: 'Tashkent' },
      { Mijoz: 'Unsupported', Savdo: '1e6', Manzil: 'Tashkent' },
    ),
    CUSTOMER_MAPPING,
    'customers',
  );

  assert.deepEqual(
    results.map((result) => result.status),
    ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid'],
  );

  const codes = results.flatMap((result) => result.errors.map((error) => error.code));
  assert.ok(codes.includes('invalid_latitude'));
  assert.ok(codes.includes('invalid_longitude'));
  assert.ok(codes.includes('invalid_number'));
  assert.ok(codes.includes('invalid_date'));
  assert.ok(codes.includes('missing_required_value'));

  for (const result of results) {
    for (const error of result.errors) {
      assert.ok(error.field.length > 0);
      assert.ok(error.message.length > 0 && error.message.length < 200);
      assert.ok(!/select |insert |policy |public\./i.test(error.message), 'no SQL leaks into user messages');
      assert.ok(!error.message.includes('at Object.'), 'no stack traces in user messages');
    }
  }

  assert.equal(results[0].rowNumber, 2);
  assert.equal(results[5].rowNumber, 7);
});

test('validation: swapped coordinates are surfaced as a warning, never auto-corrected', () => {
  const { results } = validateImportRows(
    // A Seoul export: 126.978 belongs in the longitude column, 37.566 in the
    // latitude column, but this file has them the other way round.
    rows({ Mijoz: 'Swapped', Kenglik: '126.978', Uzunlik: '37.566', Manzil: 'Seoul' }),
    CUSTOMER_MAPPING,
    'customers',
  );

  const [result] = results;
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.some((error) => error.code === 'invalid_latitude'));
  assert.ok(result.errors.some((error) => error.code === 'coordinate_swap_suspected'));
  assert.equal(result.coordinateWarning, 'Latitude and longitude look swapped. Confirm the column mapping.');
  // Nothing was corrected for the user: the row stays invalid and staged, and
  // the value that did parse is reported as-is rather than reinterpreted.
  assert.equal(result.status, 'invalid');
  assert.equal(result.latitude, null);
  assert.equal(result.longitude, 37.566);
});

test('validation: duplicate external ids are reported deterministically (first row wins)', () => {
  const { results } = validateImportRows(
    rows(
      { Mijoz: 'First', 'Tashqi ID': 'C-9', Manzil: 'Tashkent' },
      { Mijoz: 'Second', 'Tashqi ID': 'C-9', Manzil: 'Tashkent' },
      { Mijoz: 'Third', 'Tashqi ID': 'C-9', Manzil: 'Tashkent' },
    ),
    CUSTOMER_MAPPING,
    'customers',
  );

  assert.equal(results[0].status, 'needs_geocoding');
  assert.equal(results[1].status, 'invalid');
  assert.equal(results[2].status, 'invalid');
  assert.equal(results[1].errors[0].code, 'duplicate_external_id');
  assert.match(results[1].errors[0].message, /row 2/);
  assert.match(results[2].errors[0].message, /row 2/);
});

test('validation: locations use the same pipeline with their own required fields', () => {
  const mapping: ColumnMapping = {
    Nomi: 'name',
    Turi: 'category',
    Manzil: 'address',
    Kenglik: 'latitude',
    Uzunlik: 'longitude',
  };

  const { results } = validateImportRows(
    rows(
      { Nomi: 'Chorsu Bazaar', Turi: 'market', Manzil: 'Tashkent', Kenglik: '41.326', Uzunlik: '69.235' },
      { Nomi: '', Turi: 'market', Manzil: 'Tashkent' },
    ),
    mapping,
    'locations',
  );

  assert.equal(results[0].status, 'valid');
  assert.equal(results[0].normalized.name, 'Chorsu Bazaar');
  assert.equal(results[1].status, 'invalid');
  assert.ok(results[1].errors.some((error) => error.code === 'missing_required_value' && error.field === 'name'));
});

test('validation: an unusable mapping stops the run with mapping errors, not row errors', () => {
  const { results, mappingErrors } = validateImportRows(
    rows({ Mijoz: 'Ali' }),
    { Mijoz: 'name' },
    'customers',
  );
  assert.deepEqual(results, []);
  assert.ok(mappingErrors.length > 0);
  assert.match(mappingErrors.join(' '), /Latitude and Longitude, or an Address/);
});

test('validation: a mapped-but-empty optional column stays null', () => {
  const { results } = validateImportRows(
    rows({ Mijoz: 'Ali', Savdo: '', Buyurtma: '', Sana: '', Manzil: 'Tashkent' }),
    CUSTOMER_MAPPING,
    'customers',
  );
  assert.equal(results[0].status, 'needs_geocoding');
  assert.equal(results[0].normalized.revenue, null);
  assert.equal(results[0].normalized.order_count, null);
  assert.equal(results[0].normalized.last_order_date, null);
});
