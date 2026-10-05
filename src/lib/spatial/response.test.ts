import assert from 'node:assert/strict';
import test from 'node:test';

import { toRadiusAnalysisDTO, toViewportFeatureCollection } from './dto';
import { parseRadiusAnalysisResponse, parseViewportFeatureCollection } from './response';

const BOUNDS = { west: 69.2, south: 41.25, east: 69.36, north: 41.37 };
const CUSTOMER_ID = '40000000-0000-4000-8000-000000000001';
const BRANCH_ID = '30000000-0000-4000-8000-000000000001';

function viewportRows() {
  return [
    {
      feature_id: CUSTOMER_ID,
      kind: 'customers',
      category: 'Customer',
      display_name: null,
      longitude: 69.2797,
      latitude: 41.3111,
    },
    {
      feature_id: BRANCH_ID,
      kind: 'branches',
      category: 'Branch',
      display_name: 'Synthetic branch 000',
      longitude: 69.2797,
      latitude: 41.3111,
    },
  ];
}

test('viewport DTO keeps business names and never emits customer names', () => {
  const collection = toViewportFeatureCollection(viewportRows(), BOUNDS, null);

  assert.equal(collection.type, 'FeatureCollection');
  assert.equal(collection.meta.returnedCount, 2);
  assert.equal(collection.meta.truncated, false);

  const customer = collection.features.find((feature) => feature.properties.kind === 'customers');
  assert.ok(customer);
  assert.deepEqual(Object.keys(customer.properties).sort(), ['category', 'id', 'kind']);
  assert.equal(JSON.stringify(collection).includes('display_name'), false);

  const branch = collection.features.find((feature) => feature.properties.kind === 'branches');
  assert.ok(branch);
  assert.equal(branch.properties.kind === 'branches' && branch.properties.name, 'Synthetic branch 000');
});

test('customer map rows with extra fields are rejected before serialization', () => {
  const [customerRow] = viewportRows();
  assert.throws(
    () =>
      toViewportFeatureCollection(
        [{ ...customerRow, display_name: 'Synthetic private name' }],
        BOUNDS,
        null,
      ),
    TypeError,
  );
  assert.throws(
    () => toViewportFeatureCollection([{ ...customerRow, phone: '+998000000000' }], BOUNDS, null),
    TypeError,
  );
});

test('viewport truncation is reported explicitly at the configured cap', () => {
  const rows = Array.from({ length: 2_501 }, (_, index) => ({
    ...viewportRows()[1],
    feature_id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  }));

  const collection = toViewportFeatureCollection(rows, BOUNDS, null);
  assert.equal(collection.features.length, 2_500);
  assert.equal(collection.meta.returnedCount, 2_500);
  assert.equal(collection.meta.limit, 2_500);
  assert.equal(collection.meta.truncated, true);
});

test('viewport API response parser accepts a valid PII-free payload', () => {
  const payload = toViewportFeatureCollection(viewportRows(), BOUNDS, ['customers', 'branches']);
  const parsed = parseViewportFeatureCollection(JSON.parse(JSON.stringify(payload)));

  assert.equal(parsed.features.length, 2);
  assert.deepEqual(parsed.meta.kinds, ['customers', 'branches']);
  assert.equal(JSON.stringify(parsed).includes('display_name'), false);
});

test('viewport API response parser rejects PII smuggled into customer features', () => {
  const payload = toViewportFeatureCollection(viewportRows(), BOUNDS, null);
  const tampered = JSON.parse(JSON.stringify(payload));

  tampered.features[0].properties.name = 'Synthetic private name';
  assert.throws(() => parseViewportFeatureCollection(tampered), TypeError);

  const inconsistent = JSON.parse(JSON.stringify(payload));
  inconsistent.meta.returnedCount = 5;
  assert.throws(() => parseViewportFeatureCollection(inconsistent), TypeError);

  const overLimit = JSON.parse(JSON.stringify(payload));
  overLimit.meta.truncated = false;
  overLimit.features = new Array(2_501).fill(payload.features[0]);
  overLimit.meta.returnedCount = 2_501;
  assert.throws(() => parseViewportFeatureCollection(overLimit), TypeError);
});

test('radius DTO converts exact numeric aggregates without float coercion', () => {
  const dto = toRadiusAnalysisDTO(
    {
      customers_count: 1284,
      customers_revenue_total: '123456789012345678.99',
      competitors_count: 24,
      branches_count: 9,
      locations_count: 40,
      category_distribution: [
        { kind: 'places', category: 'pharmacy', count: 18 },
        { kind: 'places', category: 'market', count: 22 },
        { kind: 'competitors', category: 'grocery', count: 24 },
      ],
      nearest_branch_id: BRANCH_ID,
      nearest_branch_name: 'Synthetic branch 000',
      nearest_branch_distance_meters: 152.4,
    },
    { candidate: { longitude: 69.2797, latitude: 41.3111 }, radiusMeters: 1_000 },
  );

  assert.equal(dto.customersRevenueTotal, '123456789012345678.99');
  assert.equal(dto.customersCount, 1284);
  assert.equal(dto.categoryDistribution.length, 3);
  assert.equal(dto.nearestBranch?.distanceMeters, 152.4);
});

test('radius DTO rejects unsafe numeric aggregates and mismatched categories', () => {
  const valid = {
    customers_count: 10,
    customers_revenue_total: '100.00',
    competitors_count: 2,
    branches_count: 1,
    locations_count: 3,
    category_distribution: [
      { kind: 'places', category: 'retail', count: 3 },
      { kind: 'competitors', category: 'grocery', count: 2 },
    ],
    nearest_branch_id: null,
    nearest_branch_name: null,
    nearest_branch_distance_meters: null,
  };
  const request = { candidate: { longitude: 69.2797, latitude: 41.3111 }, radiusMeters: 500 };

  assert.equal(toRadiusAnalysisDTO(valid, request).nearestBranch, null);

  assert.throws(
    () => toRadiusAnalysisDTO({ ...valid, customers_count: Number.MAX_SAFE_INTEGER + 2 }, request),
    TypeError,
  );
  assert.throws(
    () => toRadiusAnalysisDTO({ ...valid, customers_revenue_total: 1e21 }, request),
    TypeError,
  );
  assert.throws(
    () =>
      toRadiusAnalysisDTO(
        { ...valid, category_distribution: [{ kind: 'places', category: 'retail', count: 1 }] },
        request,
      ),
    TypeError,
  );
});

test('radius API response parser accepts the client contract and rejects extensions', () => {
  const analysis = toRadiusAnalysisDTO(
    {
      customers_count: 12,
      customers_revenue_total: '8123.40',
      competitors_count: 4,
      branches_count: 2,
      locations_count: 6,
      category_distribution: [
        { kind: 'places', category: 'retail', count: 6 },
        { kind: 'competitors', category: 'grocery', count: 4 },
      ],
      nearest_branch_id: BRANCH_ID,
      nearest_branch_name: 'Synthetic branch 000',
      nearest_branch_distance_meters: 240.5,
    },
    { candidate: { longitude: 69.2797, latitude: 41.3111 }, radiusMeters: 1_000 },
  );

  const parsed = parseRadiusAnalysisResponse({ analysis: JSON.parse(JSON.stringify(analysis)) });
  assert.equal(parsed.customersCount, 12);

  assert.throws(
    () => parseRadiusAnalysisResponse({ analysis: { ...analysis, customers: [1, 2, 3] } }),
    TypeError,
  );
  assert.throws(
    () => parseRadiusAnalysisResponse({ analysis: { ...analysis, customersRevenueTotal: 8123.4 } }),
    TypeError,
  );
});
