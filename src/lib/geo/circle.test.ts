import assert from 'node:assert/strict';
import test from 'node:test';

import type { Coordinates } from '@/lib/domain/coordinates';
import { createCirclePolygon } from './circle';

function haversineDistanceMeters(
  [longitudeA, latitudeA]: Coordinates,
  [longitudeB, latitudeB]: Coordinates,
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(latitudeB - latitudeA);
  const longitudeDelta = radians(longitudeB - longitudeA);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(latitudeA)) *
      Math.cos(radians(latitudeB)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

test('circle polygon is closed and its vertices are approximately the requested distance', () => {
  const center: Coordinates = [69.2797, 41.3111];
  const radiusMeters = 1_000;
  const circle = createCirclePolygon(center, radiusMeters);
  const ring = circle.geometry.coordinates[0];

  assert.equal(circle.type, 'Feature');
  assert.equal(circle.geometry.type, 'Polygon');
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(ring.length, 73);

  for (const vertex of ring.slice(0, -1)) {
    assert.ok(
      Math.abs(
        haversineDistanceMeters(center, [vertex[0], vertex[1]]) - radiusMeters,
      ) < 0.1,
      'each vertex should lie on the requested geodesic radius',
    );
  }
});

test('circle polygon rejects invalid radius and vertex count', () => {
  assert.throws(() => createCirclePolygon([0, 0], 0), RangeError);
  assert.throws(() => createCirclePolygon([0, 0], Number.NaN), RangeError);
  assert.throws(() => createCirclePolygon([0, 0], 100, 8), RangeError);
});

test('circle polygon normalizes longitudes across the antimeridian', () => {
  const circle = createCirclePolygon([179.999, 0], 1_000);
  const longitudes = circle.geometry.coordinates[0].map(([longitude]) => longitude);

  assert.ok(longitudes.every((longitude) => longitude >= -180 && longitude <= 180));
});
