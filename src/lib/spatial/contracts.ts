import type { Feature, FeatureCollection, Point } from 'geojson';

import type { Coordinates } from '@/lib/domain/coordinates';
import type { MapLayerId } from '@/lib/domain/map-location';

export const SPATIAL_FEATURE_KINDS = [
  'customers',
  'competitors',
  'branches',
  'places',
] as const satisfies readonly MapLayerId[];

export type SpatialFeatureKind = (typeof SPATIAL_FEATURE_KINDS)[number];
export type BusinessFeatureKind = Exclude<SpatialFeatureKind, 'customers'>;

export interface CustomerMapFeatureProperties {
  id: string;
  kind: 'customers';
  category: string;
}

export interface BusinessMapFeatureProperties {
  id: string;
  kind: BusinessFeatureKind;
  category: string;
  name: string;
}

export type SafeMapFeatureProperties =
  | CustomerMapFeatureProperties
  | BusinessMapFeatureProperties;

export type SafeMapFeature = Feature<Point, SafeMapFeatureProperties>;

export interface ViewportBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ViewportFeatureMetadata {
  returnedCount: number;
  limit: number;
  truncated: boolean;
  bounds: ViewportBounds;
  kinds: SpatialFeatureKind[] | null;
}

/** GeoJSON allow-list: customer properties have no name or customer fields. */
export interface ViewportFeatureCollection
  extends FeatureCollection<Point, SafeMapFeatureProperties> {
  meta: ViewportFeatureMetadata;
}

export interface RadiusAnalysisRequest {
  candidate: {
    longitude: number;
    latitude: number;
  };
  radiusMeters: number;
}

export interface CategoryCount {
  kind: BusinessFeatureKind;
  category: string;
  count: number;
}

export interface NearestBranch {
  id: string;
  name: string;
  distanceMeters: number;
}

/** Analysis contains aggregates only; customer rows and individual revenue are never represented. */
export interface RadiusAnalysisDTO {
  candidate: Coordinates;
  radiusMeters: number;
  customersCount: number;
  customersRevenueTotal: string;
  competitorsCount: number;
  branchesCount: number;
  locationsCount: number;
  categoryDistribution: CategoryCount[];
  nearestBranch: NearestBranch | null;
}
