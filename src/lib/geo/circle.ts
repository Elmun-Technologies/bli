import type { Feature, Polygon } from 'geojson';

import { validateCoordinates, type Coordinates } from '@/lib/domain/coordinates';

const EARTH_RADIUS_METERS = 6_371_008.8;
const DEGREES_PER_RADIAN = 180 / Math.PI;

/**
 * Creates a geodesic circle polygon for map display, using great-circle
 * destinations from the center. This is a visual radius overlay only; it does
 * not calculate nearby metrics, which must be queried in PostGIS.
 */
export function createCirclePolygon(
  center: Coordinates,
  radiusMeters: number,
  vertexCount = 72,
): Feature<Polygon, { radiusMeters: number }> {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new RangeError('Radius must be a positive, finite number of meters.');
  }

  if (!Number.isInteger(vertexCount) || vertexCount < 12) {
    throw new RangeError('A circle needs at least 12 integer vertices.');
  }

  const [longitude, latitude] = validateCoordinates(center);
  const latitudeRadians = latitude / DEGREES_PER_RADIAN;
  const longitudeRadians = longitude / DEGREES_PER_RADIAN;
  const angularDistance = radiusMeters / EARTH_RADIUS_METERS;
  const ring: Coordinates[] = [];

  for (let index = 0; index <= vertexCount; index += 1) {
    const bearing = (index / vertexCount) * Math.PI * 2;
    const destinationLatitude = Math.asin(
      Math.sin(latitudeRadians) * Math.cos(angularDistance) +
        Math.cos(latitudeRadians) *
          Math.sin(angularDistance) *
          Math.cos(bearing),
    );
    const destinationLongitude =
      longitudeRadians +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
        Math.cos(angularDistance) -
          Math.sin(latitudeRadians) * Math.sin(destinationLatitude),
      );
    const longitudeDegrees = destinationLongitude * DEGREES_PER_RADIAN;
    const normalizedLongitude = ((longitudeDegrees + 540) % 360) - 180;

    ring.push([
      normalizedLongitude,
      destinationLatitude * DEGREES_PER_RADIAN,
    ]);
  }

  // GeoJSON linear rings must be closed. The final bearing is the first point,
  // but copy the tuple to keep the closure explicit and independent.
  ring[ring.length - 1] = [...ring[0]];

  return {
    type: 'Feature',
    properties: { radiusMeters },
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };
}
