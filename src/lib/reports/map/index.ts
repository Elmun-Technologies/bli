/**
 * Provider selection for report maps.
 *
 * Order:
 *   1. `REPORT_MAP_PROVIDER=fake`      -> deterministic fixture provider (tests, CI)
 *   2. `MAPBOX_ACCESS_TOKEN` present   -> Mapbox Static Images (production)
 *   3. otherwise                       -> no provider; the report is generated
 *                                         without a map and says so explicitly
 *
 * A missing provider is not an error: a report without a static map is still a
 * complete, honest report. A *configured* provider that fails is an error the
 * caller may retry, and it never touches the stored snapshot.
 */

import { FakeReportMapProvider } from './fake-provider';
import { MapboxReportMapProvider } from './mapbox-provider';
import type { ReportMapProvider } from './provider';

export * from './provider';
export { FakeReportMapProvider, FAKE_MAP_ATTRIBUTION } from './fake-provider';
export {
  MapboxReportMapProvider,
  MAPBOX_ATTRIBUTION,
  DEFAULT_REPORT_MAP_STYLE,
  buildOverlayPath,
  buildViewport,
  circleRing,
} from './mapbox-provider';
export { fakeMapFixturePng, FAKE_MAP_FIXTURE_SIZE } from './fixture-png';

export interface ResolvedMapProvider {
  provider: ReportMapProvider | null;
  /** The provider name stored in the snapshot even when no provider is configured. */
  name: string;
  attribution: string;
}

export function resolveReportMapProvider(
  env: Record<string, string | undefined> = process.env,
): ResolvedMapProvider {
  if (env.REPORT_MAP_PROVIDER === 'fake') {
    const provider = new FakeReportMapProvider();
    return { provider, name: provider.name, attribution: provider.attribution };
  }

  const token = env.MAPBOX_ACCESS_TOKEN;
  if (token) {
    const provider = new MapboxReportMapProvider({
      accessToken: token,
      style: env.REPORT_MAP_STYLE,
    });
    return { provider, name: provider.name, attribution: provider.attribution };
  }

  return {
    provider: null,
    name: 'none',
    attribution:
      'No static map was included in this report. Every figure comes from the stored analysis.',
  };
}
