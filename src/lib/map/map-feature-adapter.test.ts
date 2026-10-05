import assert from 'node:assert/strict';
import test from 'node:test';

import { toMapPointFeature, toMapPointFeatureCollection } from './map-feature-adapter';

const locationWithPrivateFields = {
  id: 'customer-01',
  kind: 'customers' as const,
  category: 'Customer',
  coordinates: [69.2797, 41.3111] as [number, number],
  name: 'Synthetic private name',
  address: 'Synthetic private address',
  phone: '+998000000000',
  revenue: 12345.67,
};

test('maps coordinates as longitude then latitude and emits a valid point feature', () => {
  const feature = toMapPointFeature(locationWithPrivateFields);

  assert.equal(feature.type, 'Feature');
  assert.equal(feature.geometry.type, 'Point');
  assert.deepEqual(feature.geometry.coordinates, [69.2797, 41.3111]);
  assert.deepEqual(feature.properties, {
    id: 'customer-01',
    kind: 'customers',
    category: 'Customer',
  });
});

test('map feature allow-list never serializes customer PII or commercial values', () => {
  const collection = toMapPointFeatureCollection([locationWithPrivateFields]);
  const serialized = JSON.stringify(collection);

  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.features.length, 1);
  assert.equal(serialized.includes('Synthetic private name'), false);
  assert.equal(serialized.includes('Synthetic private address'), false);
  assert.equal(serialized.includes('+998000000000'), false);
  assert.equal(serialized.includes('12345.67'), false);
});

test('map adapter rejects invalid coordinate values at runtime', () => {
  assert.throws(
    () => toMapPointFeature({ ...locationWithPrivateFields, coordinates: [181, 41] }),
    RangeError,
  );
  assert.throws(
    () => toMapPointFeature({ ...locationWithPrivateFields, coordinates: [69, Number.NaN] }),
    RangeError,
  );
});

test('map adapter refuses source identifiers that could contain contact data', () => {
  assert.throws(
    () => toMapPointFeature({ ...locationWithPrivateFields, id: '+998901234567' }),
    TypeError,
  );
});
