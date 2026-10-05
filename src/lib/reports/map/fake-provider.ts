/**
 * The deterministic CI/test map provider.
 *
 * It returns the committed PNG fixture (no network, no token, no credits) and
 * records every request it received, so a test or the contract smoke can assert
 * exactly what was sent to a provider — including that no customer-level value
 * was ever part of it.
 */

import { fakeMapFixturePng, FAKE_MAP_FIXTURE_SIZE } from './fixture-png';
import {
  ReportMapError,
  type ComparisonMapRequest,
  type ReportMapProvider,
  type ReportMapResult,
  type SingleLocationMapRequest,
} from './provider';

export const FAKE_MAP_ATTRIBUTION = 'Synthetic map fixture (no map provider was contacted)';

export interface FakeProviderCall {
  kind: 'single' | 'comparison';
  request: SingleLocationMapRequest | ComparisonMapRequest;
}

export class FakeReportMapProvider implements ReportMapProvider {
  readonly name = 'fake';
  readonly attribution = FAKE_MAP_ATTRIBUTION;
  readonly available = true;
  readonly calls: FakeProviderCall[] = [];

  /** When set, every render fails with a provider error (failure-path tests). */
  constructor(private readonly failWith: string | null = null) {}

  private render(): Promise<ReportMapResult> {
    if (this.failWith) {
      return Promise.reject(new ReportMapError(this.failWith));
    }

    return Promise.resolve({
      bytes: fakeMapFixturePng(),
      mimeType: 'image/png' as const,
      provider: this.name,
      attribution: this.attribution,
      width: FAKE_MAP_FIXTURE_SIZE.width,
      height: FAKE_MAP_FIXTURE_SIZE.height,
    });
  }

  renderSingleLocationMap(request: SingleLocationMapRequest): Promise<ReportMapResult> {
    this.calls.push({ kind: 'single', request });
    return this.render();
  }

  renderComparisonMap(request: ComparisonMapRequest): Promise<ReportMapResult> {
    this.calls.push({ kind: 'comparison', request });
    return this.render();
  }
}
