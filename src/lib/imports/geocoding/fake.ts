/**
 * Deterministic fake geocoding provider.
 *
 * Every geocoding test - including the CI suite - runs against this provider, so
 * no build ever depends on a real Mapbox call, a real token or network access.
 * Responses are derived from the address text only, which makes scenarios
 * reproducible and keeps the assertions about *our* behaviour, not Mapbox's.
 *
 * Recognized address keywords (case-insensitive):
 *   "ok" / anything else  -> one high-confidence address candidate
 *   "ambiguous"           -> two near-identical candidates
 *   "none" / "unknown"    -> no match
 *   "rate"                -> 429 for the first N calls, then OK
 *   "flaky"               -> transient provider error for the first N calls
 *   "permanent"           -> non-retryable provider error
 *   "country:xx"          -> a candidate whose country differs from `xx`
 * Coordinates are stable functions of the query, so repeated batches are
 * byte-identical and idempotency can be asserted.
 */
import type {
  GeocodingCandidate,
  GeocodingContext,
  GeocodingProvider,
  GeocodingProviderResult,
} from './types';

export interface FakeProviderOptions {
  /** Failures injected before a "rate" or "flaky" address succeeds. */
  failuresBeforeSuccess?: number;
  countryCode?: string | null;
}

function stableCoordinate(seed: string): { longitude: number; latitude: number } {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_000;
  }
  return {
    longitude: Math.round((-180 + (hash % 36_000) / 100) * 1e7) / 1e7,
    latitude: Math.round((-90 + (hash % 18_000) / 100) * 1e7) / 1e7,
  };
}

function candidate(
  address: string,
  overrides: Partial<GeocodingCandidate> = {},
): GeocodingCandidate {
  const point = stableCoordinate(address);
  return {
    longitude: point.longitude,
    latitude: point.latitude,
    formattedAddress: address,
    provider: 'fake',
    providerResultId: `fake:${Buffer.from(address).toString('base64url').slice(0, 24)}`,
    relevance: 0.95,
    confidence: 0.95,
    accuracy: 'rooftop',
    featureType: 'address',
    countryCode: 'uz',
    matchConfidence: 'exact',
    ...overrides,
  };
}

export class FakeGeocodingProvider implements GeocodingProvider {
  readonly name = 'fake';

  private readonly failuresBeforeSuccess: number;
  private readonly countryCode: string | null;
  private readonly attempts = new Map<string, number>();

  constructor(options: FakeProviderOptions = {}) {
    this.failuresBeforeSuccess = options.failuresBeforeSuccess ?? 0;
    this.countryCode = options.countryCode ?? null;
  }

  /** Number of provider calls made for one address - used by idempotency tests. */
  callsFor(address: string): number {
    return this.attempts.get(address.toLocaleLowerCase('en')) ?? 0;
  }

  async geocode(address: string, context: GeocodingContext = {}): Promise<GeocodingProviderResult> {
    const key = address.toLocaleLowerCase('en');
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);

    if (key.includes('rate') && attempt <= this.failuresBeforeSuccess) {
      return { status: 'rate_limited', retryAfterMs: 1_000 };
    }
    if (key.includes('flaky') && attempt <= this.failuresBeforeSuccess) {
      return { status: 'provider_error', message: 'Simulated transient provider failure.', retryable: true };
    }
    if (key.includes('permanent')) {
      return { status: 'provider_error', message: 'Simulated permanent provider failure.', retryable: false };
    }
    if (key.includes('none') || key.includes('unknown')) {
      return { status: 'no_match' };
    }
    if (key.includes('ambiguous')) {
      return {
        status: 'success',
        candidates: [
          candidate(address, { confidence: 0.9, relevance: 0.9, providerResultId: 'fake:ambiguous:a' }),
          candidate(`${address} (second)`, { confidence: 0.88, relevance: 0.88, providerResultId: 'fake:ambiguous:b' }),
        ],
      };
    }

    const countryMatch = /country:([a-z]{2})/.exec(key);
    if (countryMatch) {
      return {
        status: 'success',
        candidates: [candidate(address, { countryCode: countryMatch[1], confidence: 0.95 })],
      };
    }

    // The deployed context decides the country of the fake result, exactly as a
    // real provider's hard country filter would.
    return {
      status: 'success',
      candidates: [
        candidate(address, {
          // The country filter is reflected so the concurrency/idempotency tests
          // exercise the same decision path as production.
          countryCode: context.countryCode ?? this.countryCode ?? 'uz',
        }),
      ],
    };
  }
}
