import { validateCoordinates } from '@/lib/domain/coordinates';

import type {
  BusinessFeatureKind,
  CategoryCount,
  RadiusAnalysisDTO,
  RadiusAnalysisRequest,
  SafeMapFeature,
  SpatialFeatureKind,
  ViewportBounds,
  ViewportFeatureCollection,
} from './contracts';

export const MAX_VIEWPORT_FEATURES = 2_500;
export const VIEWPORT_RPC_FETCH_LIMIT = MAX_VIEWPORT_FEATURES + 1;
const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SPATIAL_KINDS = new Set<string>(['customers', 'competitors', 'branches', 'places']);
const BUSINESS_KINDS = new Set<string>(['places', 'competitors', 'branches']);
const ALLOWED_VIEWPORT_ROW_KEYS = new Set([
  'feature_id',
  'kind',
  'category',
  'display_name',
  'longitude',
  'latitude',
]);
const ALLOWED_ANALYSIS_ROW_KEYS = new Set([
  'customers_count',
  'customers_revenue_total',
  'competitors_count',
  'branches_count',
  'locations_count',
  'category_distribution',
  'nearest_branch_id',
  'nearest_branch_name',
  'nearest_branch_distance_meters',
]);
const ALLOWED_CATEGORY_KEYS = new Set(['kind', 'category', 'count']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function requiredText(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} returned an invalid value.`);
  }
  return value;
}

function requiredCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} returned an unsafe aggregate count.`);
  }
  return value;
}

function mapViewportRow(value: unknown): SafeMapFeature {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_VIEWPORT_ROW_KEYS)) {
    throw new TypeError('Viewport query returned an unexpected database projection.');
  }

  const id = requiredText(value.feature_id, 'Viewport feature id');
  if (!DATABASE_UUID_PATTERN.test(id)) {
    throw new TypeError('Viewport feature id must be an opaque UUID.');
  }

  const kind = requiredText(value.kind, 'Viewport feature kind');
  if (!SPATIAL_KINDS.has(kind)) {
    throw new TypeError('Viewport query returned an unsupported feature kind.');
  }

  const category = requiredText(value.category, 'Viewport feature category', 100);
  if (typeof value.longitude !== 'number' || typeof value.latitude !== 'number') {
    throw new TypeError('Viewport query returned invalid coordinates.');
  }
  const coordinates = validateCoordinates([value.longitude, value.latitude]);

  if (kind === 'customers') {
    if (value.display_name !== null) {
      throw new TypeError('Customer map rows must not contain a display name.');
    }

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates },
      properties: { id, kind: 'customers', category },
    };
  }

  if (!BUSINESS_KINDS.has(kind)) {
    throw new TypeError('Viewport query returned an unsupported business feature kind.');
  }

  const name = requiredText(value.display_name, 'Business feature name');
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      id,
      kind: kind as BusinessFeatureKind,
      category,
      name,
    },
  };
}

export function toViewportFeatureCollection(
  rows: readonly unknown[],
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
): ViewportFeatureCollection {
  if (rows.length > VIEWPORT_RPC_FETCH_LIMIT) {
    throw new TypeError('Viewport RPC exceeded its configured result cap.');
  }

  const truncated = rows.length > MAX_VIEWPORT_FEATURES;
  const features = rows.slice(0, MAX_VIEWPORT_FEATURES).map(mapViewportRow);

  return {
    type: 'FeatureCollection',
    features,
    meta: {
      returnedCount: features.length,
      limit: MAX_VIEWPORT_FEATURES,
      truncated,
      bounds,
      kinds,
    },
  };
}

function mapCategoryDistribution(value: unknown): CategoryCount[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Radius analysis returned an invalid category distribution.');
  }

  return value.map((categoryValue): CategoryCount => {
    if (!isRecord(categoryValue) || !hasOnlyKeys(categoryValue, ALLOWED_CATEGORY_KEYS)) {
      throw new TypeError('Radius category projection contains unexpected fields.');
    }

    const kind = requiredText(categoryValue.kind, 'Category kind');
    if (!BUSINESS_KINDS.has(kind)) {
      throw new TypeError('Radius category projection returned an unsupported kind.');
    }

    return {
      kind: kind as BusinessFeatureKind,
      category: requiredText(categoryValue.category, 'Category label', 100),
      count: requiredCount(categoryValue.count, 'Category count'),
    };
  });
}

function mapNearestBranch(row: Record<string, unknown>): RadiusAnalysisDTO['nearestBranch'] {
  const id = row.nearest_branch_id;
  const name = row.nearest_branch_name;
  const distance = row.nearest_branch_distance_meters;

  if (id === null && name === null && distance === null) return null;
  if (
    typeof id !== 'string' ||
    !DATABASE_UUID_PATTERN.test(id) ||
    typeof distance !== 'number' ||
    !Number.isFinite(distance) ||
    distance < 0
  ) {
    throw new TypeError('Radius analysis returned an invalid nearest-branch result.');
  }

  return {
    id,
    name: requiredText(name, 'Nearest branch name'),
    distanceMeters: distance,
  };
}

function validateRevenueDecimal(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^-?\d{1,30}(?:\.\d{1,2})?$/.test(value)
  ) {
    throw new TypeError('Radius analysis returned an invalid exact decimal aggregate.');
  }
  return value;
}

/** Map one narrow RPC result to a PII-free aggregate DTO; never serialize the row itself. */
export function toRadiusAnalysisDTO(
  value: unknown,
  request: RadiusAnalysisRequest,
): RadiusAnalysisDTO {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_ANALYSIS_ROW_KEYS)) {
    throw new TypeError('Radius RPC returned an unexpected database projection.');
  }

  const customerCount = requiredCount(value.customers_count, 'Customer count');
  const revenueTotal = validateRevenueDecimal(value.customers_revenue_total);
  const competitorCount = requiredCount(value.competitors_count, 'Competitor count');
  const branchCount = requiredCount(value.branches_count, 'Branch count');
  const locationCount = requiredCount(value.locations_count, 'Location count');
  const categoryDistribution = mapCategoryDistribution(value.category_distribution);

  const distributionTotal = categoryDistribution.reduce((total, item) => total + item.count, 0);
  if (distributionTotal !== competitorCount + locationCount) {
    throw new TypeError('Radius category distribution does not reconcile to feature counts.');
  }

  return {
    candidate: validateCoordinates([
      request.candidate.longitude,
      request.candidate.latitude,
    ]),
    radiusMeters: request.radiusMeters,
    customersCount: customerCount,
    customersRevenueTotal: revenueTotal,
    competitorsCount: competitorCount,
    branchesCount: branchCount,
    locationsCount: locationCount,
    categoryDistribution,
    nearestBranch: mapNearestBranch(value),
  };
}
