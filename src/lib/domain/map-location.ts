import type { Coordinates } from '@/lib/domain/coordinates';

export const MAP_LAYER_IDS = [
  'customers',
  'competitors',
  'branches',
  'places',
] as const;

export type MapLayerId = (typeof MAP_LAYER_IDS)[number];
export type LocationKind = MapLayerId | 'candidate';

/**
 * A display-level business location. This is not a database row; in particular,
 * it must not be populated with customer PII for generic map delivery.
 */
export interface DisplayLocation {
  id: string;
  name: string;
  kind: MapLayerId;
  category: string;
  address: string;
  coordinates: Coordinates;
}

/** Transient map-click selection; persistence belongs to analysis_locations. */
export interface TransientCandidate {
  id: string;
  name: string;
  kind: 'candidate';
  category: string;
  address: string;
  coordinates: Coordinates;
}

export type SelectedLocation = DisplayLocation | TransientCandidate;

/** Allow-listed, PII-safe input to the MapLibre GeoJSON adapter. */
export interface MapLocationFeatureInput {
  id: string;
  kind: LocationKind;
  category: string;
  coordinates: Coordinates;
}

/** Properties deliberately emitted to GeoJSON; no name, address, phone or revenue. */
export interface MapFeatureProperties {
  id: string;
  kind: LocationKind;
  category: string;
}
