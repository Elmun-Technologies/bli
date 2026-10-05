import assert from 'node:assert/strict';
import test from 'node:test';

import { DEMO_LOCATIONS } from '../data/demo-locations';
import { isAllowedMapFeatureId, isAllowedServerMapFeatureId } from './feature-id';
import { parseRadiusAnalysisResponse, parseViewportFeatureCollection } from './response';

/**
 * Regression cover for a real defect: the fixtures data source emitted ids such
 * as `customer-03`, while the client-side viewport parser only accepted UUIDs.
 * Database mode worked, so `DATA_SOURCE=fixtures` could never render in the
 * browser even though both halves were individually tested. These assertions
 * tie the fixture dataset, the identifier authority and the client parser
 * together, so the two sides can no longer drift apart.
 */

const BOUNDS = { west: 69.2, south: 41.25, east: 69.36, north: 41.37 };

function fixtureCollection() {
  return {
    type: 'FeatureCollection',
    features: DEMO_LOCATIONS.filter((location) => !location.id.startsWith('candidate-')).map(
      (location) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: location.coordinates },
        properties:
          location.kind === 'customers'
            ? { id: location.id, kind: 'customers', category: location.category }
            : {
                id: location.id,
                kind: location.kind,
                category: location.category,
                name: location.name,
              },
      }),
    ),
    meta: {
      returnedCount: DEMO_LOCATIONS.length,
      limit: 2_500,
      truncated: false,
      bounds: BOUNDS,
      kinds: null,
    },
  };
}

test('every demo fixture location id is acceptable to the server payload contract', () => {
  assert.ok(DEMO_LOCATIONS.length > 0);

  for (const location of DEMO_LOCATIONS) {
    if (location.id.startsWith('candidate-')) continue;
    assert.ok(
      isAllowedServerMapFeatureId(location.id),
      `fixture id ${location.id} would be rejected by the client parser`,
    );
  }
});

test('the client parser accepts a fixtures-mode viewport payload', () => {
  const payload = fixtureCollection();
  payload.meta.returnedCount = payload.features.length;

  const parsed = parseViewportFeatureCollection(payload);

  assert.equal(parsed.features.length, payload.features.length);
  assert.equal(parsed.meta.returnedCount, payload.features.length);
  for (const feature of parsed.features) {
    assert.ok(isAllowedServerMapFeatureId(feature.properties.id));
  }
});

test('the client parser still refuses contact-shaped and unknown identifiers', () => {
  const base = fixtureCollection();
  const template = base.features[0];
  assert.ok(template);

  for (const id of [
    'customer@example.com',
    '+998901234567',
    'external-42',
    'customer-1',
    'candidate-site-01',
    '  customer-01  ',
  ]) {
    assert.throws(
      () =>
        parseViewportFeatureCollection({
          ...base,
          features: [{ ...template, properties: { ...template.properties, id } }],
          meta: { ...base.meta, returnedCount: 1 },
        }),
      TypeError,
      `expected id ${JSON.stringify(id)} to be refused`,
    );
  }
});

test('the transient candidate marker stays client-only', () => {
  assert.equal(isAllowedMapFeatureId('candidate-site-12'), true);
  assert.equal(isAllowedServerMapFeatureId('candidate-site-12'), false);
});

test('radius analysis still requires opaque database UUIDs for branch ids', () => {
  const analysis = {
    candidate: [69.2797, 41.3111],
    radiusMeters: 500,
    customersCount: 0,
    customersRevenueTotal: '0',
    competitorsCount: 0,
    branchesCount: 0,
    locationsCount: 0,
    categoryDistribution: [],
    nearestBranch: { id: 'branch-01', name: 'Synthetic branch 000', distanceMeters: 837.38 },
  };

  assert.throws(
    () => parseRadiusAnalysisResponse({ analysis }),
    TypeError,
    'fixtures must never supply radius analysis identifiers',
  );

  const databaseBacked = {
    ...analysis,
    nearestBranch: {
      id: '30000000-0000-4000-8000-000000000000',
      name: 'Synthetic branch 000',
      distanceMeters: 837.38342717,
    },
  };
  assert.equal(
    parseRadiusAnalysisResponse({ analysis: databaseBacked }).nearestBranch?.id,
    '30000000-0000-4000-8000-000000000000',
  );
});
