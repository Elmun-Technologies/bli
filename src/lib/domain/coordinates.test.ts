import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCoordinates } from './coordinates';

test('validates the Tashkent longitude/latitude pair in GeoJSON order', () => {
  assert.deepEqual(validateCoordinates([69.2797, 41.3111]), [69.2797, 41.3111]);
});

test('accepts inclusive longitude and latitude boundaries', () => {
  assert.deepEqual(validateCoordinates([-180, -90]), [-180, -90]);
  assert.deepEqual(validateCoordinates([180, 90]), [180, 90]);
});

test('rejects malformed coordinate pairs and non-numeric values', () => {
  assert.throws(() => validateCoordinates(null), TypeError);
  assert.throws(() => validateCoordinates([69]), TypeError);
  assert.throws(() => validateCoordinates([69, 41, 1]), TypeError);
  assert.throws(() => validateCoordinates(['69', 41]), TypeError);
});

test('rejects non-finite values and values outside geographic bounds', () => {
  assert.throws(() => validateCoordinates([Number.NaN, 41]), RangeError);
  assert.throws(() => validateCoordinates([69, Number.POSITIVE_INFINITY]), RangeError);
  assert.throws(() => validateCoordinates([Number.NEGATIVE_INFINITY, 41]), RangeError);
  assert.throws(() => validateCoordinates([180.0001, 0]), RangeError);
  assert.throws(() => validateCoordinates([0, -90.0001]), RangeError);
});
