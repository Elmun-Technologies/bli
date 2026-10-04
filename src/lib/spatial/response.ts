import { validateCoordinates } from '@/lib/domain/coordinates';

import type {
  BusinessFeatureKind,
  CategoryCount,
  RadiusAnalysisDTO,
  SafeMapFeature,
  SpatialFeatureKind,
  ViewportFeatureCollection,
} from './contracts';
import { MAX_VIEWPORT_FEATURES } from './dto';
import { validateViewportBounds } from './validation';

const ALLOWED_KINDS = new Set<string>(['customers', 'competitors', 'branches', 'places']);
const ALLOWED_BUSINESS_KINDS = new Set<string>(['places', 'competitors', 'branches']);
const ALLOWED_COLLECTION_KEYS = new Set(['type', 'features', 'meta']);
const ALLOWED_META_KEYS = new Set(['returnedCount', 'limit', 'truncated', 'bounds', 'kinds']);
const ALLOWED_CUSTOMER_PROPERTIES = new Set(['id', 'kind', 'category']);
const ALLOWED_BUSINESS_PROPERTIES = new Set(['id', 'kind', 'category', 'name']);
const ALLOWED_ANALYSIS_KEYS = new Set([
  'candidate',
  'radiusMeters',
  'customersCount',
  'customersRevenueTotal',
  'competitorsCount',
  'branchesCount',
  'locationsCount',
  'categoryDistribution',
  'nearestBranch',
]);
const ALLOWED_CATEGORY_KEYS = new Set(['kind', 'category', 'count']);
const ALLOWED_NEAREST_BRANCH_KEYS = new Set(['id', 'name', 'distanceMeters']);
const DATABASE_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function requiredString(value: unknown, label: string, maxLength = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`Map API returned an invalid ${label}.`);
  }
  return value;
}

function requiredSafeCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`API returned an invalid ${label}.`);
  }
  return value;
}

function parseKinds(value: unknown): SpatialFeatureKind[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 4) {
    throw new TypeError('Viewport API returned invalid layer metadata.');
  }

  const kinds = value.map((kind): SpatialFeatureKind => {
    if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) {
      throw new TypeError('Viewport API returned an unsupported map kind.');
    }
    return kind as SpatialFeatureKind;
  });

  return kinds;
}

function parseFeature(value: unknown): SafeMapFeature {
  if (!isRecord(value) || value.type !== 'Feature' || !isRecord(value.geometry)) {
    throw new TypeError('Viewport API returned an invalid GeoJSON feature.');
  }
  if (value.geometry.type !== 'Point' || !Array.isArray(value.geometry.coordinates)) {
    throw new TypeError('Viewport API returned a non-point map feature.');
  }
  if (!isRecord(value.properties)) {
    throw new TypeError('Viewport API returned an invalid feature property object.');
  }

  const properties = value.properties;
  const id = requiredString(properties.id, 'feature id');
  if (!DATABASE_UUID_PATTERN.test(id)) {
    throw new TypeError('Viewport API feature ids must be opaque UUIDs.');
  }
  const category = requiredString(properties.category, 'feature category', 100);
  const kind = requiredString(properties.kind, 'feature kind');
  if (!ALLOWED_KINDS.has(kind)) {
    throw new TypeError('Viewport API returned an unsupported feature kind.');
  }
  const coordinates = validateCoordinates(value.geometry.coordinates);

  if (kind === 'customers') {
    if (!hasOnlyKeys(properties, ALLOWED_CUSTOMER_PROPERTIES)) {
      throw new TypeError('Customer map feature contains a forbidden property.');
    }
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates },
      properties: { id, kind: 'customers', category },
    };
  }

  if (!ALLOWED_BUSINESS_KINDS.has(kind) || !hasOnlyKeys(properties, ALLOWED_BUSINESS_PROPERTIES)) {
    throw new TypeError('Business map feature contains an unsupported property.');
  }

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates },
    properties: {
      id,
      kind: kind as BusinessFeatureKind,
      category,
      name: requiredString(properties.name, 'business display name'),
    },
  };
}

export function parseViewportFeatureCollection(value: unknown): ViewportFeatureCollection {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ALLOWED_COLLECTION_KEYS) ||
    value.type !== 'FeatureCollection' ||
    !Array.isArray(value.features) ||
    !isRecord(value.meta) ||
    !hasOnlyKeys(value.meta, ALLOWED_META_KEYS)
  ) {
    throw new TypeError('Viewport API returned an invalid FeatureCollection.');
  }

  const meta = value.meta;
  const returnedCount = requiredSafeCount(meta.returnedCount, 'returned feature count');
  const limit = requiredSafeCount(meta.limit, 'viewport limit');
  if (limit !== MAX_VIEWPORT_FEATURES || returnedCount !== value.features.length || returnedCount > limit) {
    throw new TypeError('Viewport API returned inconsistent truncation metadata.');
  }
  if (typeof meta.truncated !== 'boolean' || (meta.truncated && returnedCount !== limit)) {
    throw new TypeError('Viewport API returned inconsistent truncation metadata.');
  }
  if (!isRecord(meta.bounds)) {
    throw new TypeError('Viewport API returned invalid viewport bounds.');
  }

  const bounds = validateViewportBounds({
    west: meta.bounds.west as number,
    south: meta.bounds.south as number,
    east: meta.bounds.east as number,
    north: meta.bounds.north as number,
  });

  return {
    type: 'FeatureCollection',
    features: value.features.map(parseFeature),
    meta: {
      returnedCount,
      limit,
      truncated: meta.truncated,
      bounds,
      kinds: parseKinds(meta.kinds),
    },
  };
}

function parseCategoryDistribution(value: unknown): CategoryCount[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError('Radius API returned invalid category aggregates.');
  }

  return value.map((item): CategoryCount => {
    if (!isRecord(item) || !hasOnlyKeys(item, ALLOWED_CATEGORY_KEYS)) {
      throw new TypeError('Radius category aggregate contains unexpected properties.');
    }
    const kind = requiredString(item.kind, 'category kind');
    if (!ALLOWED_BUSINESS_KINDS.has(kind)) {
      throw new TypeError('Radius API returned an unsupported category kind.');
    }
    return {
      kind: kind as BusinessFeatureKind,
      category: requiredString(item.category, 'category label', 100),
      count: requiredSafeCount(item.count, 'category count'),
    };
  });
}

export function parseRadiusAnalysisResponse(value: unknown): RadiusAnalysisDTO {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['analysis'])) || !isRecord(value.analysis)) {
    throw new TypeError('Radius API returned an invalid response.');
  }

  const analysis = value.analysis;
  if (!hasOnlyKeys(analysis, ALLOWED_ANALYSIS_KEYS)) {
    throw new TypeError('Radius API returned an unexpected analysis projection.');
  }
  const candidate = validateCoordinates(analysis.candidate);
  const radiusMeters = analysis.radiusMeters;
  if (typeof radiusMeters !== 'number' || !Number.isFinite(radiusMeters) || radiusMeters < 100 || radiusMeters > 20_000) {
    throw new TypeError('Radius API returned an invalid radius.');
  }

  const customersRevenueTotal = analysis.customersRevenueTotal;
  if (
    typeof customersRevenueTotal !== 'string' ||
    customersRevenueTotal.length > 40 ||
    !/^-?\d{1,30}(?:\.\d{1,2})?$/.test(customersRevenueTotal)
  ) {
    throw new TypeError('Radius API returned an invalid exact revenue aggregate.');
  }

  const categoryDistribution = parseCategoryDistribution(analysis.categoryDistribution);
  const customersCount = requiredSafeCount(analysis.customersCount, 'customer aggregate');
  const competitorsCount = requiredSafeCount(analysis.competitorsCount, 'competitor aggregate');
  const branchesCount = requiredSafeCount(analysis.branchesCount, 'branch aggregate');
  const locationsCount = requiredSafeCount(analysis.locationsCount, 'location aggregate');
  const categoriesTotal = categoryDistribution.reduce((sum, category) => sum + category.count, 0);
  if (!Number.isSafeInteger(categoriesTotal) || categoriesTotal !== competitorsCount + locationsCount) {
    throw new TypeError('Radius category totals do not match the returned aggregate counts.');
  }

  let nearestBranch: RadiusAnalysisDTO['nearestBranch'] = null;
  if (analysis.nearestBranch !== null) {
    const branch = analysis.nearestBranch;
    if (!isRecord(branch) || !hasOnlyKeys(branch, ALLOWED_NEAREST_BRANCH_KEYS)) {
      throw new TypeError('Nearest branch response contains unexpected properties.');
    }
    const id = requiredString(branch.id, 'nearest branch id');
    const distanceMeters = branch.distanceMeters;
    if (
      !DATABASE_UUID_PATTERN.test(id) ||
      typeof distanceMeters !== 'number' ||
      !Number.isFinite(distanceMeters) ||
      distanceMeters < 0
    ) {
      throw new TypeError('Radius API returned an invalid nearest branch.');
    }
    nearestBranch = {
      id,
      name: requiredString(branch.name, 'nearest branch name'),
      distanceMeters,
    };
  }

  return {
    candidate,
    radiusMeters,
    customersCount,
    customersRevenueTotal,
    competitorsCount,
    branchesCount,
    locationsCount,
    categoryDistribution,
    nearestBranch,
  };
}
