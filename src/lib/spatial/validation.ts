import { validateCoordinates } from '@/lib/domain/coordinates';

import { SPATIAL_FEATURE_KINDS } from './contracts';
import type {
  RadiusAnalysisRequest,
  SpatialFeatureKind,
  ViewportBounds,
} from './contracts';

export const MIN_RADIUS_METERS = 100;
export const MAX_RADIUS_METERS = 20_000;
export const MAX_VIEWPORT_LONGITUDE_SPAN = 40;
export const MAX_VIEWPORT_LATITUDE_SPAN = 20;
export const MAX_VIEWPORT_AREA_DEGREES = 400;

const ALLOWED_VIEWPORT_PARAMS = new Set(['west', 'south', 'east', 'north', 'kinds']);
const ALLOWED_RADIUS_BODY_KEYS = new Set(['candidate', 'radiusMeters']);
const ALLOWED_CANDIDATE_KEYS = new Set(['longitude', 'latitude']);
const ALLOWED_KINDS = new Set<string>(SPATIAL_FEATURE_KINDS);

export class SpatialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpatialValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: Set<string>, label: string) {
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) {
    throw new SpatialValidationError(`${label} contains an unsupported field.`);
  }
}

function parseRequiredFiniteNumber(params: URLSearchParams, name: string): number {
  const values = params.getAll(name);
  if (values.length !== 1 || values[0].trim() === '') {
    throw new SpatialValidationError(`Provide exactly one ${name} value.`);
  }

  const parsed = Number(values[0]);
  if (!Number.isFinite(parsed)) {
    throw new SpatialValidationError(`${name} must be a finite number.`);
  }

  return parsed;
}

export function validateViewportBounds(bounds: ViewportBounds): ViewportBounds {
  validateCoordinates([bounds.west, bounds.south]);
  validateCoordinates([bounds.east, bounds.north]);

  if (bounds.west > bounds.east) {
    throw new SpatialValidationError('Antimeridian-crossing viewports are not supported.');
  }
  if (bounds.south > bounds.north) {
    throw new SpatialValidationError('Viewport south must be at or below north.');
  }

  const longitudeSpan = bounds.east - bounds.west;
  const latitudeSpan = bounds.north - bounds.south;
  if (
    longitudeSpan > MAX_VIEWPORT_LONGITUDE_SPAN ||
    latitudeSpan > MAX_VIEWPORT_LATITUDE_SPAN ||
    longitudeSpan * latitudeSpan > MAX_VIEWPORT_AREA_DEGREES
  ) {
    throw new SpatialValidationError('Viewport exceeds the supported demo area; zoom in and try again.');
  }

  return bounds;
}

export function parseViewportQuery(params: URLSearchParams): {
  bounds: ViewportBounds;
  kinds: SpatialFeatureKind[] | null;
} {
  for (const key of params.keys()) {
    if (!ALLOWED_VIEWPORT_PARAMS.has(key)) {
      throw new SpatialValidationError('Viewport request contains an unsupported field.');
    }
  }

  const bounds = validateViewportBounds({
    west: parseRequiredFiniteNumber(params, 'west'),
    south: parseRequiredFiniteNumber(params, 'south'),
    east: parseRequiredFiniteNumber(params, 'east'),
    north: parseRequiredFiniteNumber(params, 'north'),
  });

  const kindValues = params.getAll('kinds');
  if (kindValues.length === 0) return { bounds, kinds: null };
  if (kindValues.length !== 1) {
    throw new SpatialValidationError('Provide map feature kinds as one comma-separated value.');
  }

  const rawKinds = kindValues[0].split(',').map((kind) => kind.trim());
  if (rawKinds.length === 0 || rawKinds.some((kind) => kind.length === 0)) {
    throw new SpatialValidationError('Map feature kinds cannot be empty.');
  }

  const kinds = [...new Set(rawKinds)];
  if (kinds.some((kind) => !ALLOWED_KINDS.has(kind))) {
    throw new SpatialValidationError('One or more map feature kinds are not permitted.');
  }

  return { bounds, kinds: kinds as SpatialFeatureKind[] };
}

export function parseRadiusAnalysisRequest(value: unknown): RadiusAnalysisRequest {
  if (!isRecord(value)) {
    throw new SpatialValidationError('Request body must be a JSON object.');
  }

  assertOnlyKeys(value, ALLOWED_RADIUS_BODY_KEYS, 'Request body');
  if (!isRecord(value.candidate)) {
    throw new SpatialValidationError('Candidate must contain longitude and latitude.');
  }
  assertOnlyKeys(value.candidate, ALLOWED_CANDIDATE_KEYS, 'Candidate');

  const longitude = value.candidate.longitude;
  const latitude = value.candidate.latitude;
  if (typeof longitude !== 'number' || typeof latitude !== 'number') {
    throw new SpatialValidationError('Candidate longitude and latitude must be numbers.');
  }

  let coordinates: [number, number];
  try {
    coordinates = validateCoordinates([longitude, latitude]);
  } catch {
    throw new SpatialValidationError('Candidate coordinates must be finite and within longitude/latitude bounds.');
  }

  const radiusMeters = value.radiusMeters;
  if (typeof radiusMeters !== 'number' || !Number.isFinite(radiusMeters)) {
    throw new SpatialValidationError('Radius must be a finite number of meters.');
  }
  if (radiusMeters < MIN_RADIUS_METERS || radiusMeters > MAX_RADIUS_METERS) {
    throw new SpatialValidationError('Radius must be between 100 and 20,000 meters.');
  }

  return {
    candidate: {
      longitude: coordinates[0],
      latitude: coordinates[1],
    },
    radiusMeters,
  };
}
