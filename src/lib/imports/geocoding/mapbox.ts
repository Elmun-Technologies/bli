/**
 * Mapbox Geocoding v6 provider (forward geocoding).
 *
 * The one production provider in Phase 5. Two rules from the brief shape it:
 *
 *   1. results are stored permanently, so every request sends `permanent=true`.
 *      Mapbox's terms allow temporary geocoding results to be used once but not
 *      stored - and this pipeline's whole job is storing a coordinate with a
 *      customer record. A temporary result would be a licensing violation and a
 *      data-integrity bug at the same time.
 *   2. the access token is server-only (`MAPBOX_ACCESS_TOKEN`, never a
 *      `NEXT_PUBLIC_*` variable), lives in the request URL only, and is never
 *      written to logs, errors or the database.
 *
 * Country restriction is a hard filter (ISO code); query augmentation with a
 * country name is opt-in and conservative; nothing about Uzbekistan or Tashkent
 * is hard-coded, so the same provider works for any market.
 */
import { IMPORT_LIMITS } from '../limits';
import {
  GeocodingConfigError,
  type GeocodingCandidate,
  type GeocodingContext,
  type GeocodingProvider,
  type GeocodingProviderResult,
} from './types';

const MAPBOX_FORWARD_URL = 'https://api.mapbox.com/search/geocode/v6/forward';
const DEFAULT_LANGUAGE = 'en';
const REQUEST_TIMEOUT_MS = 12_000;

/** Address-point accuracy classes, best first (Mapbox v6 `coordinates.accuracy`). */
const ACCURACY_SCORES: Record<string, number> = {
  rooftop: 1,
  parcel: 0.95,
  point: 0.9,
  interpolated: 0.6,
  approximate: 0.4,
  intersection: 0.5,
};

/** Smart Address Match confidence labels (address features only). */
const MATCH_CONFIDENCE_SCORES: Record<string, number> = {
  exact: 1,
  high: 0.9,
  medium: 0.65,
  low: 0.35,
};

const FEATURE_TYPE_SCORES: Record<string, number> = {
  address: 1,
  street: 0.7,
  postcode: 0.6,
  place: 0.5,
  locality: 0.45,
  neighborhood: 0.4,
  district: 0.35,
  region: 0.25,
  country: 0.1,
};

export interface MapboxProviderOptions {
  accessToken: string;
  /** Hard country filter, ISO 3166-1 alpha-2. */
  countryCode?: string | null;
  /** Country name appended to the query when the address omits it. */
  countryName?: string | null;
  /** "longitude,latitude" bias. */
  proximity?: string | null;
  language?: string | null;
  /** How many candidates to request (1..10). */
  limit?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface MapboxFeatureProperties {
  mapbox_id?: unknown;
  feature_type?: unknown;
  name?: unknown;
  full_address?: unknown;
  place_formatted?: unknown;
  coordinates?: { longitude?: unknown; latitude?: unknown; accuracy?: unknown } | null;
  context?: { country?: { country_code?: unknown } | null } | null;
  match_code?: { confidence?: unknown } | null;
  relevance?: unknown;
}

export class MapboxGeocodingProvider implements GeocodingProvider {
  readonly name = 'mapbox';

  private readonly accessToken: string;
  private readonly countryCode: string | null;
  private readonly countryName: string | null;
  private readonly proximity: string | null;
  private readonly language: string;
  private readonly limit: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MapboxProviderOptions) {
    if (!options.accessToken || options.accessToken.trim() === '') {
      throw new GeocodingConfigError(
        'MAPBOX_ACCESS_TOKEN is not configured. Geocoding is unavailable until it is set on the server.',
      );
    }
    this.accessToken = options.accessToken.trim();
    this.countryCode = options.countryCode?.trim().toLocaleLowerCase('en') || null;
    this.countryName = options.countryName?.trim() || null;
    this.proximity = options.proximity?.trim() || null;
    this.language = options.language?.trim() || DEFAULT_LANGUAGE;
    this.limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async geocode(address: string, context: GeocodingContext = {}): Promise<GeocodingProviderResult> {
    const query = buildQuery(address, context.countryName ?? this.countryName);
    if (query === '') return { status: 'no_match' };

    const url = new URL(MAPBOX_FORWARD_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('permanent', 'true');
    url.searchParams.set('autocomplete', 'false');
    url.searchParams.set('language', context.language?.trim() || this.language);
    url.searchParams.set('limit', String(this.limit));
    url.searchParams.set('types', 'address,street,place,locality,neighborhood,postcode');

    const countryCode = (context.countryCode ?? this.countryCode)?.toLocaleLowerCase('en') ?? null;
    if (countryCode) url.searchParams.set('country', countryCode);

    const proximity = context.proximity?.trim() || this.proximity;
    if (proximity) url.searchParams.set('proximity', proximity);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      return {
        status: 'provider_error',
        retryable: true,
        message: aborted ? 'The geocoding service timed out.' : 'The geocoding service is unreachable.',
      };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      return { status: 'rate_limited', retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) };
    }

    if (response.status === 401 || response.status === 403) {
      // A credential problem is not the user's data; it is an operator task.
      return {
        status: 'provider_error',
        retryable: false,
        message: 'The geocoding service rejected the server credentials.',
      };
    }

    if (response.status === 422) {
      return { status: 'no_match' };
    }

    if (!response.ok) {
      return {
        status: 'provider_error',
        retryable: response.status >= 500,
        message: 'The geocoding service returned an unexpected response.',
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        status: 'provider_error',
        retryable: true,
        message: 'The geocoding service returned an unreadable response.',
      };
    }

    const candidates = parseMapboxCandidates(payload, this.name);
    return candidates.length === 0 ? { status: 'no_match' } : { status: 'success', candidates };
  }
}

/**
 * Conservative query shaping: collapse whitespace and append the configured
 * country name only when the address does not already mention it.
 */
export function buildQuery(address: string, countryName: string | null): string {
  const base = address.replace(/\s+/g, ' ').trim();
  if (base === '') return '';
  if (!countryName) return base;
  const mentionsCountry = base.toLocaleLowerCase('en').includes(countryName.toLocaleLowerCase('en'));
  return mentionsCountry ? base : `${base}, ${countryName}`;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, IMPORT_LIMITS.geocodingRetryMaxDelayMs * 4);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(Math.min(date - Date.now(), IMPORT_LIMITS.geocodingRetryMaxDelayMs * 4), 0);
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Turns the v6 GeoJSON payload into candidates.
 *
 * v6 marks *results* with `coordinates.accuracy` and *matches* with
 * `match_code.confidence`; where both exist the lower of the two wins, because
 * a confident match to an approximate point is still an approximate point.
 */
export function parseMapboxCandidates(payload: unknown, providerName = 'mapbox'): GeocodingCandidate[] {
  const features =
    payload !== null && typeof payload === 'object' && Array.isArray((payload as { features?: unknown }).features)
      ? ((payload as { features: unknown[] }).features)
      : [];

  const candidates: GeocodingCandidate[] = [];

  for (const feature of features) {
    if (feature === null || typeof feature !== 'object') continue;
    const properties = (feature as { properties?: MapboxFeatureProperties }).properties;
    if (!properties || typeof properties !== 'object') continue;

    const coordinates = properties.coordinates ?? null;
    const longitude = asNumber(coordinates?.longitude);
    const latitude = asNumber(coordinates?.latitude);
    if (longitude === null || latitude === null) continue;
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) continue;

    const featureType = asString(properties.feature_type)?.toLocaleLowerCase('en') ?? null;
    const accuracy = asString(coordinates?.accuracy)?.toLocaleLowerCase('en') ?? null;
    const matchConfidence = asString(properties.match_code?.confidence)?.toLocaleLowerCase('en') ?? null;

    const scores = [FEATURE_TYPE_SCORES[featureType ?? ''] ?? 0.5];
    if (accuracy) scores.push(ACCURACY_SCORES[accuracy] ?? 0.5);
    if (matchConfidence) scores.push(MATCH_CONFIDENCE_SCORES[matchConfidence] ?? 0.5);

    candidates.push({
      longitude: Math.round(longitude * 1e7) / 1e7,
      latitude: Math.round(latitude * 1e7) / 1e7,
      formattedAddress:
        asString(properties.full_address) ?? asString(properties.place_formatted) ?? asString(properties.name),
      provider: providerName,
      providerResultId: asString(properties.mapbox_id),
      relevance: asNumber(properties.relevance),
      confidence: Math.min(...scores),
      accuracy,
      featureType,
      countryCode: asString(properties.context?.country?.country_code)?.toLocaleLowerCase('en') ?? null,
      matchConfidence,
    });
  }

  return candidates.sort((left, right) => right.confidence - left.confidence);
}
