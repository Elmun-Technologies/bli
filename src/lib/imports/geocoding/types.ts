/**
 * Geocoding provider abstraction.
 *
 * Everything above this boundary (validation, staging, batching, the UI) is
 * provider-agnostic: the only production provider implemented in Phase 5 is
 * Mapbox Geocoding v6, and the deterministic fake provider exists so the test
 * suite and CI never call the real service. No other provider is implemented on
 * purpose - adding one means adding a file that satisfies this interface.
 */

export interface GeocodingContext {
  /** ISO 3166-1 alpha-2 restriction, when the deployment configures one. */
  countryCode?: string | null;
  /** Country name appended to the query when it is missing (conservative). */
  countryName?: string | null;
  /** "longitude,latitude" to bias results, never to restrict them. */
  proximity?: string | null;
  /** IETF language tag for returned addresses. */
  language?: string | null;
}

export interface GeocodingCandidate {
  longitude: number;
  latitude: number;
  formattedAddress: string | null;
  provider: string;
  providerResultId: string | null;
  /** Provider's own relevance/score, untouched, when it reports one. */
  relevance: number | null;
  /** Normalized 0..1 quality score the decision policy consumes. */
  confidence: number;
  /** Address point accuracy class when the provider reports one. */
  accuracy: string | null;
  featureType: string | null;
  countryCode: string | null;
  /** Provider's own match confidence label, e.g. exact/high/medium/low. */
  matchConfidence: string | null;
}

export type GeocodingProviderResult =
  | { status: 'success'; candidates: GeocodingCandidate[] }
  | { status: 'no_match' }
  | { status: 'rate_limited'; retryAfterMs: number | null }
  | { status: 'provider_error'; message: string; retryable: boolean };

export interface GeocodingProvider {
  readonly name: string;
  /** Forward geocodes one address. Never throws for expected API conditions. */
  geocode(address: string, context: GeocodingContext): Promise<GeocodingProviderResult>;
}

export class GeocodingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodingConfigError';
  }
}
