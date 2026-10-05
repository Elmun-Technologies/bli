import assert from 'node:assert/strict';
import test from 'node:test';

import { IMPORT_LIMITS } from './limits';
import {
  buildGeocodingQuery,
  normalizeAddress,
  normalizeTextCell,
  parseCalendarDate,
  parseCoordinate,
  parseDecimalAmount,
  parseWholeNumber,
} from './normalize';

test('text: trims, collapses whitespace, maps empty to null and strips control characters', () => {
  assert.deepEqual(normalizeTextCell('  Ali   Valiyev \n'), { ok: true, value: 'Ali Valiyev' });
  assert.deepEqual(normalizeTextCell('   '), { ok: true, value: null });
  assert.deepEqual(normalizeTextCell(null), { ok: true, value: null });
  assert.deepEqual(normalizeTextCell('A\u0000B\u001fC'), { ok: true, value: 'A B C' });

  const tooLong = normalizeTextCell('x'.repeat(IMPORT_LIMITS.maxCellLength + 1));
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.issue.code, 'value_too_long');
});

test('money: decimal amounts are normalized exactly, never through a float', () => {
  const cases: Array<[string, string]> = [
    ['1250000.50', '1250000.50'],
    ['1250000.5', '1250000.50'],
    ['1250000', '1250000.00'],
    ['1,250,000.50', '1250000.50'],
    ['1 250 000,50', '1250000.50'],
    ['1.250.000', '1250000.00'],
    ['0', '0.00'],
    ['(1234.50)', '-1234.50'],
    ['-0', '0.00'],
    ['  980000  ', '980000.00'],
    ['.5', '0.50'],
    ['12,5', '12.50'],
    ['12,500', '12500.00'],
  ];

  for (const [input, expected] of cases) {
    const result = parseDecimalAmount(input);
    assert.equal(result.ok, true, `${input} should parse`);
    if (result.ok) assert.equal(result.value, expected, `${input} -> ${expected}`);
  }

  // Exactness: a value that a float would corrupt survives untouched.
  const exact = parseDecimalAmount('90071992547409.99');
  assert.equal(exact.ok, true);
  if (exact.ok) assert.equal(exact.value, '90071992547409.99');
});

test('money: invalid amounts are reported, not coerced', () => {
  for (const input of ['not-money', '12.345', '1e6', '12.5.5', '-', 'abc123', '12345678901234567']) {
    const result = parseDecimalAmount(input);
    assert.equal(result.ok, false, `${input} must be rejected`);
    if (!result.ok) assert.equal(result.issue.code, 'invalid_number');
  }
  assert.deepEqual(parseDecimalAmount(''), { ok: true, value: null });
});

test('integers: order counts accept whole numbers and reject fractions', () => {
  assert.deepEqual(parseWholeNumber('12'), { ok: true, value: '12' });
  assert.deepEqual(parseWholeNumber(' 1 200 '), { ok: true, value: '1200' });
  assert.deepEqual(parseWholeNumber('3.0'), { ok: true, value: '3' });
  assert.deepEqual(parseWholeNumber(''), { ok: true, value: null });

  const fraction = parseWholeNumber('3.5');
  assert.equal(fraction.ok, false);
  const negative = parseWholeNumber('-3');
  assert.equal(negative.ok, false);
});

test('coordinates: finite and in range, with the same bounds as Phase 2', () => {
  assert.deepEqual(parseCoordinate('41.3111', 'latitude'), { ok: true, value: 41.3111 });
  assert.deepEqual(parseCoordinate('69,2897', 'longitude'), { ok: true, value: 69.2897 });
  assert.deepEqual(parseCoordinate('   -180  ', 'longitude'), { ok: true, value: -180 });
  assert.deepEqual(parseCoordinate('90', 'latitude'), { ok: true, value: 90 });
  assert.deepEqual(parseCoordinate('', 'latitude'), { ok: true, value: null });

  for (const [input, kind] of [
    ['91.5', 'latitude'],
    ['181.2', 'longitude'],
    ['NaN', 'latitude'],
    ['Infinity', 'longitude'],
    ['1e400', 'latitude'],
    ['Tashkent', 'latitude'],
  ] as const) {
    const result = parseCoordinate(input, kind);
    assert.equal(result.ok, false, `${input} must be rejected as ${kind}`);
    if (!result.ok) assert.equal(result.issue.code, `invalid_${kind}`);
  }
});

test('dates: ISO and unambiguous day-first dates only', () => {
  assert.deepEqual(parseCalendarDate('2026-01-15'), { ok: true, value: '2026-01-15' });
  assert.deepEqual(parseCalendarDate('2026-01-15T00:00:00.000Z'), { ok: true, value: '2026-01-15' });
  assert.deepEqual(parseCalendarDate('15.01.2026'), { ok: true, value: '2026-01-15' });
  assert.deepEqual(parseCalendarDate('15/01/2026'), { ok: true, value: '2026-01-15' });
  assert.deepEqual(parseCalendarDate(''), { ok: true, value: null });

  // Ambiguous and impossible dates are refused rather than guessed.
  assert.equal(parseCalendarDate('2026-02-30').ok, false);
  assert.equal(parseCalendarDate('03/04/2026').ok, false);
  assert.equal(parseCalendarDate('01.12.2026').ok, false);
  assert.equal(parseCalendarDate('32.01.2026').ok, false);
  assert.equal(parseCalendarDate('January 2026').ok, false);
});

test('addresses: normalization is conservative and keeps the original wording', () => {
  assert.equal(normalizeAddress('  Toshkent,   Amir Temur 1  '), 'Toshkent, Amir Temur 1');
  assert.equal(normalizeAddress(''), null);

  // The query used for geocoding may gain a country, never a city.
  assert.equal(buildGeocodingQuery('Amir Temur 1'), 'Amir Temur 1');
  assert.equal(buildGeocodingQuery('Amir Temur 1', { country: 'Uzbekistan' }), 'Amir Temur 1, Uzbekistan');
  assert.equal(
    buildGeocodingQuery('Amir Temur 1, Uzbekistan', { country: 'Uzbekistan' }),
    'Amir Temur 1, Uzbekistan',
  );
});
