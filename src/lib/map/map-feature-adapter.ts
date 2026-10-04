import type { Feature, FeatureCollection, Point } from 'geojson';

import { validateCoordinates } from '@/lib/domain/coordinates';
import type {
  MapFeatureProperties,
  MapLocationFeatureInput,
} from '@/lib/domain/map-location';

export type MapPointFeature = Feature<Point, MapFeatureProperties>;
export type MapPointFeatureCollection = FeatureCollection<Point, MapFeatureProperties>;

const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DEMO_FIXTURE_ID_PATTERN = /^(?:customer|competitor|branch|place)-\d{2}$/;
const TRANSIENT_CANDIDATE_ID_PATTERN = /^candidate-site-\d+$/;

function validateMapFeatureId(value: string): string {
  if (
    !DATABASE_UUID_PATTERN.test(value) &&
    !DEMO_FIXTURE_ID_PATTERN.test(value) &&
    !TRANSIENT_CANDIDATE_ID_PATTERN.test(value)
  ) {
    throw new TypeError('Map feature IDs must be opaque database UUIDs or known synthetic fixture IDs.');
  }

  return value;
}

/**
 * Convert a validated, display-safe domain location into a GeoJSON point.
 * Only the explicit allow-list is copied, so extra properties on an input row
 * (including customer name, address, phone or revenue) cannot enter map data.
 */
export function toMapPointFeature(
  location: MapLocationFeatureInput,
): MapPointFeature {
  const [longitude, latitude] = validateCoordinates(location.coordinates);

  return {
    type: 'Feature',
    properties: {
      id: validateMapFeatureId(location.id),
      kind: location.kind,
      category: location.category,
    },
    geometry: {
      type: 'Point',
      coordinates: [longitude, latitude],
    },
  };
}

export function toMapPointFeatureCollection(
  locations: readonly MapLocationFeatureInput[],
): MapPointFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: locations.map(toMapPointFeature),
  };
}
