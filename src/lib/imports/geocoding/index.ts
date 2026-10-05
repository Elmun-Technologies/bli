/**
 * Provider selection.
 *
 *   GEOCODING_PROVIDER=mapbox  (default) -> Mapbox Geocoding v6, needs
 *                                          MAPBOX_ACCESS_TOKEN on the server
 *   GEOCODING_PROVIDER=fake              -> deterministic in-process provider for
 *                                          tests and CI; never a production choice
 *
 * There is deliberately no Google implementation and no provider auto-detection:
 * a deployment decides, and an unconfigured deployment reports geocoding as
 * unavailable instead of silently guessing.
 */
import { MapboxGeocodingProvider } from './mapbox';
import { FakeGeocodingProvider } from './fake';
import { GeocodingConfigError, type GeocodingContext, type GeocodingProvider } from './types';

export type GeocodingProviderName = 'mapbox' | 'fake';

export function readGeocodingContext(
  env: Partial<Record<string, string | undefined>> = process.env,
): GeocodingContext {
  return {
    countryCode: env.GEOCODING_COUNTRY_CODE?.trim() || null,
    countryName: env.GEOCODING_COUNTRY_NAME?.trim() || null,
    proximity: env.GEOCODING_PROXIMITY?.trim() || null,
    language: env.GEOCODING_LANGUAGE?.trim() || null,
  };
}

export function resolveGeocodingProviderName(
  env: Partial<Record<string, string | undefined>> = process.env,
): GeocodingProviderName {
  const configured = env.GEOCODING_PROVIDER?.trim().toLocaleLowerCase('en');
  if (configured === 'fake') return 'fake';
  return 'mapbox';
}

export interface ResolvedGeocodingProvider {
  provider: GeocodingProvider;
  context: GeocodingContext;
}

export function resolveGeocodingProvider(
  env: Partial<Record<string, string | undefined>> = process.env,
): ResolvedGeocodingProvider {
  const name = resolveGeocodingProviderName(env);
  const context = readGeocodingContext(env);

  if (name === 'fake') {
    return { provider: new FakeGeocodingProvider(), context: { ...context, countryCode: context.countryCode ?? null } };
  }

  const accessToken = env.MAPBOX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new GeocodingConfigError(
      'Geocoding is not configured on this server. Set MAPBOX_ACCESS_TOKEN (and optionally GEOCODING_COUNTRY_CODE) to enable it.',
    );
  }

  return {
    provider: new MapboxGeocodingProvider({
      accessToken,
      countryCode: context.countryCode,
      countryName: context.countryName,
      proximity: context.proximity,
      language: context.language,
    }),
    context,
  };
}

export { GeocodingConfigError } from './types';
export type { GeocodingCandidate, GeocodingContext, GeocodingProvider } from './types';
