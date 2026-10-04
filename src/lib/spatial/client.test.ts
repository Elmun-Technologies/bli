import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildViewportSearchParams,
  fetchViewportFeatures,
  requestRadiusAnalysis,
  SpatialApiError,
} from './client';
import { toRadiusAnalysisDTO, toViewportFeatureCollection } from './dto';

const BOUNDS = { west: 69.2, south: 41.25, east: 69.36, north: 41.37 };
const originalFetch = globalThis.fetch;

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(input, init))) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test('viewport query params serialise bounds and layer kinds', () => {
  const query = buildViewportSearchParams(BOUNDS, ['customers', 'branches']);
  const parsed = new URLSearchParams(query);

  assert.equal(parsed.get('west'), '69.2');
  assert.equal(parsed.get('north'), '41.37');
  assert.equal(parsed.get('kinds'), 'customers,branches');
  assert.equal(buildViewportSearchParams(BOUNDS, null).includes('kinds'), false);
});

test('viewport adapter parses a valid PII-free server response', async (t) => {
  t.after(restoreFetch);

  const payload = toViewportFeatureCollection(
    [
      {
        feature_id: '40000000-0000-4000-8000-000000000001',
        kind: 'customers',
        category: 'Customer',
        display_name: null,
        longitude: 69.2797,
        latitude: 41.3111,
      },
    ],
    BOUNDS,
    null,
  );

  stubFetch(
    () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );

  const collection = await fetchViewportFeatures(BOUNDS, null);
  assert.equal(collection.features.length, 1);
  assert.equal(collection.features[0].properties.kind, 'customers');
  assert.equal(JSON.stringify(collection).includes('phone'), false);
});

test('viewport adapter surfaces structured server errors', async (t) => {
  t.after(restoreFetch);

  stubFetch(
    () =>
      new Response(
        JSON.stringify({ error: { code: 'invalid_request', message: 'Viewport exceeds the supported demo area; zoom in and try again.' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
  );

  await assert.rejects(
    () => fetchViewportFeatures(BOUNDS, null),
    (error: unknown) => {
      assert.ok(error instanceof SpatialApiError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalid_request');
      return true;
    },
  );
});

test('viewport adapter rejects responses that smuggle customer names', async (t) => {
  t.after(restoreFetch);

  const payload = toViewportFeatureCollection(
    [
      {
        feature_id: '40000000-0000-4000-8000-000000000001',
        kind: 'customers',
        category: 'Customer',
        display_name: null,
        longitude: 69.2797,
        latitude: 41.3111,
      },
    ],
    BOUNDS,
    null,
  );
  const tampered = JSON.parse(JSON.stringify(payload));
  tampered.features[0].properties.name = 'Synthetic private name';

  stubFetch(() => new Response(JSON.stringify(tampered), { status: 200 }));

  await assert.rejects(() => fetchViewportFeatures(BOUNDS, null), TypeError);
});

test('radius adapter posts candidate coordinates and parses aggregates', async (t) => {
  t.after(restoreFetch);

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
      nearest_branch_id: '30000000-0000-4000-8000-000000000001',
      nearest_branch_name: 'Synthetic branch 000',
      nearest_branch_distance_meters: 240.5,
    },
    { candidate: { longitude: 69.2797, latitude: 41.3111 }, radiusMeters: 1_000 },
  );

  let capturedBody = '';
  stubFetch((input, init) => {
    assert.equal(String(input), '/api/demo/analysis/radius');
    assert.equal(init?.method, 'POST');
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ analysis }), { status: 200 });
  });

  const result = await requestRadiusAnalysis({
    candidate: { longitude: 69.2797, latitude: 41.3111 },
    radiusMeters: 1_000,
  });

  assert.deepEqual(JSON.parse(capturedBody), {
    candidate: { longitude: 69.2797, latitude: 41.3111 },
    radiusMeters: 1_000,
  });
  assert.equal(result.customersCount, 12);
  assert.equal(result.customersRevenueTotal, '8123.40');
  assert.equal(JSON.stringify(result).includes('phone'), false);
});

test('radius adapter propagates cancellation', async (t) => {
  t.after(restoreFetch);

  stubFetch(() => {
    const error = new DOMException('The operation was aborted.', 'AbortError');
    throw error;
  });

  const controller = new AbortController();
  await assert.rejects(
    () =>
      requestRadiusAnalysis(
        { candidate: { longitude: 69.2797, latitude: 41.3111 }, radiusMeters: 1_000 },
        controller.signal,
      ),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});
