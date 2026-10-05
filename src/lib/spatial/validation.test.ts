import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SpatialValidationError,
  parseRadiusAnalysisRequest,
  parseViewportQuery,
  validateViewportBounds,
} from './validation';

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

test('viewport query parses a valid Tashkent bounding box', () => {
  const parsed = parseViewportQuery(
    params({ west: '69.20', south: '41.25', east: '69.36', north: '41.37', kinds: 'places,customers' }),
  );

  assert.deepEqual(parsed.bounds, { west: 69.2, south: 41.25, east: 69.36, north: 41.37 });
  assert.deepEqual(parsed.kinds, ['places', 'customers']);
});

test('viewport query treats a missing kinds filter as all kinds', () => {
  const parsed = parseViewportQuery(params({ west: '69.2', south: '41.25', east: '69.36', north: '41.37' }));
  assert.equal(parsed.kinds, null);
});

test('viewport query rejects invalid bounds, unknown fields and unknown kinds', () => {
  assert.throws(
    () => parseViewportQuery(params({ west: '69.36', south: '41.25', east: '69.20', north: '41.37' })),
    SpatialValidationError,
  );
  assert.throws(
    () => parseViewportQuery(params({ west: '69.2', south: '41.25', east: '69.36', north: '41.37', radius: '500' })),
    SpatialValidationError,
  );
  assert.throws(
    () => parseViewportQuery(params({ west: '69.2', south: '41.25', east: '69.36', north: '41.37', kinds: 'admins' })),
    SpatialValidationError,
  );
  assert.throws(
    () => parseViewportQuery(params({ west: '69.2', south: '41.25', east: '69.36', north: '41.37', kinds: 'places,,customers' })),
    SpatialValidationError,
  );
  assert.throws(
    () => parseViewportQuery(params({ west: '69.2', south: '41.25', east: '69.36', north: 'abc' })),
    SpatialValidationError,
  );
});

test('viewport bounds reject antimeridian crossing, inverted axes and broad windows', () => {
  assert.throws(
    () => validateViewportBounds({ west: 170, south: -10, east: -170, north: 10 }),
    SpatialValidationError,
  );
  assert.throws(
    () => validateViewportBounds({ west: 10, south: 30, east: 20, north: 10 }),
    SpatialValidationError,
  );
  assert.throws(
    () => validateViewportBounds({ west: -180, south: -90, east: 180, north: 90 }),
    SpatialValidationError,
  );
});

test('radius analysis request accepts valid presets and custom values', () => {
  for (const radiusMeters of [100, 500, 1_000, 3_000, 5_000, 20_000]) {
    const parsed = parseRadiusAnalysisRequest({
      candidate: { longitude: 69.2797, latitude: 41.3111 },
      radiusMeters,
    });
    assert.equal(parsed.radiusMeters, radiusMeters);
    assert.deepEqual(parsed.candidate, { longitude: 69.2797, latitude: 41.3111 });
  }
});

test('radius analysis request rejects out-of-range, non-finite and malformed input', () => {
  const candidate = { longitude: 69.2797, latitude: 41.3111 };

  assert.throws(() => parseRadiusAnalysisRequest({ candidate, radiusMeters: 99 }), SpatialValidationError);
  assert.throws(() => parseRadiusAnalysisRequest({ candidate, radiusMeters: 20_001 }), SpatialValidationError);
  assert.throws(() => parseRadiusAnalysisRequest({ candidate, radiusMeters: Number.NaN }), SpatialValidationError);
  assert.throws(
    () => parseRadiusAnalysisRequest({ candidate, radiusMeters: '500' as unknown as number }),
    SpatialValidationError,
  );
  assert.throws(
    () => parseRadiusAnalysisRequest({ candidate: { longitude: 181, latitude: 41.3 }, radiusMeters: 500 }),
    SpatialValidationError,
  );
  assert.throws(() => parseRadiusAnalysisRequest({ candidate, radiusMeters: 500, workspaceId: 'x' }), SpatialValidationError);
  assert.throws(() => parseRadiusAnalysisRequest(null), SpatialValidationError);
});
