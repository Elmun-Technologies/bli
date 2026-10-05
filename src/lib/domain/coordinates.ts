/** GeoJSON / web-map coordinate order: [longitude, latitude] in EPSG:4326. */
export type Coordinates = [longitude: number, latitude: number];

/**
 * Validate an untrusted coordinate pair before using it as domain or GeoJSON
 * data. Tuple typing alone cannot reject NaN, infinity or out-of-range values.
 */
export function validateCoordinates(value: unknown): Coordinates {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError('Coordinates must be a [longitude, latitude] pair.');
  }

  const longitude: unknown = value[0];
  const latitude: unknown = value[1];

  if (typeof longitude !== 'number' || typeof latitude !== 'number') {
    throw new TypeError('Longitude and latitude must both be numbers.');
  }

  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new RangeError('Longitude and latitude must be finite numbers.');
  }

  if (longitude < -180 || longitude > 180) {
    throw new RangeError('Longitude must be between -180 and 180 degrees.');
  }

  if (latitude < -90 || latitude > 90) {
    throw new RangeError('Latitude must be between -90 and 90 degrees.');
  }

  return [longitude, latitude];
}
