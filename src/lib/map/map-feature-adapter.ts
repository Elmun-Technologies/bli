import type { Feature, FeatureCollection, Point } from 'geojson';

import { validateCoordinates } from '@/lib/domain/coordinates';
import type {
  MapFeatureProperties,
  MapLocationFeatureInput,
} from '@/lib/domain/map-location';
import { isAllowedMapFeatureId } from '@/lib/spatial/feature-id';

export type MapPointFeature = Feature<Point, MapFeatureProperties>;
export type MapPointFeatureCollection = FeatureCollection<Point, MapFeatureProperties>;

function validateMapFeatureId(value: string): string {
  if (!isAllowedMapFeatureId(value)) {
    throw new TypeError(
      'Map feature IDs must be opaque database UUIDs or known synthetic fixture IDs.',
    );
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
