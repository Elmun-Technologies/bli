import 'server-only';

import { DEMO_LOCATIONS, MAP_LAYERS } from '@/lib/data/demo-locations';
import type { MapLayerId } from '@/lib/domain/map-location';

import type {
  BusinessFeatureKind,
  SafeMapFeature,
  SpatialFeatureKind,
  ViewportBounds,
  ViewportFeatureCollection,
} from './contracts';
import { MAX_VIEWPORT_FEATURES } from './dto';

const BUSINESS_KINDS = new Set<MapLayerId>(['places', 'competitors', 'branches']);

/**
 * Development-only display mode when the database is intentionally
 * unavailable. Fixtures are never used for radius analysis or any metric.
 */
export function buildFixtureViewportFeatureCollection(
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
): ViewportFeatureCollection {
  const requestedKinds = kinds ? new Set<SpatialFeatureKind>(kinds) : null;
  const matching = DEMO_LOCATIONS.filter((location) => {
    const [longitude, latitude] = location.coordinates;
    const inBounds =
      longitude >= bounds.west &&
      longitude <= bounds.east &&
      latitude >= bounds.south &&
      latitude <= bounds.north;
    const kindAllowed = !requestedKinds || requestedKinds.has(location.kind);
    return inBounds && kindAllowed;
  });

  const truncated = matching.length > MAX_VIEWPORT_FEATURES;
  const features = matching.slice(0, MAX_VIEWPORT_FEATURES).map((location): SafeMapFeature => {
    const [longitude, latitude] = location.coordinates;
    if (!BUSINESS_KINDS.has(location.kind)) {
      // Fixture customers mirror the strict database projection: no name.
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: { id: location.id, kind: 'customers', category: location.category },
      };
    }

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [longitude, latitude] },
      properties: {
        id: location.id,
        kind: location.kind as BusinessFeatureKind,
        category: location.category,
        name: location.name,
      },
    };
  });

  return {
    type: 'FeatureCollection',
    features,
    meta: {
      returnedCount: features.length,
      limit: MAX_VIEWPORT_FEATURES,
      truncated,
      bounds,
      kinds: kinds ?? null,
    },
  };
}

export function fixtureLayerDefinitions() {
  return MAP_LAYERS;
}
