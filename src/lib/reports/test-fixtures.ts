/**
 * Shared fixtures for the Phase 7 unit tests.
 *
 * The stored payloads are the same captured payloads the scoring suite uses
 * (`src/lib/scoring/__fixtures__/*.payload.json`), so the reports are tested
 * against real stored shapes instead of a convenient invention. This module
 * contains no `test(...)` calls on purpose: it is imported by several suites and
 * must never register tests of its own.
 */

import { readFileSync } from 'node:fs';

import { parseScoringAnalysis } from '@/lib/scoring/payload';
import type { ScoringAnalysisPayload } from '@/lib/scoring/types';

import { buildReportSnapshot, type ReportSnapshotInput } from './snapshot';

export { buildReportSnapshot };
import type { ReportSnapshot } from './types';

export function loadStoredPayload(
  name: 'stored-analysis' | 'stored-comparison',
): ScoringAnalysisPayload {
  const url = new URL(`../scoring/__fixtures__/${name}.payload.json`, import.meta.url);
  return parseScoringAnalysis(JSON.parse(readFileSync(url, 'utf8')));
}

/** Markers that must never appear anywhere the report can be read. */
export const PII_MARKERS = {
  customerName: 'Zulfiya-PII-MARKER-Karimova',
  phone: '+998-PII-MARKER-900000',
  address: 'PII-MARKER street 12, apartment 7',
  individualRevenue: 'PII-MARKER-INDIVIDUAL-REVENUE-1234.56',
  rawRow: 'PII-MARKER-RAW-IMPORT-ROW-42',
  metadata: 'PII-MARKER-METADATA',
} as const;

export const ALL_PII_MARKERS = Object.values(PII_MARKERS);

/**
 * A stored payload that *does* carry customer-level values in the fields a real
 * import row would use. The report path must project them away: the point of the
 * fixture is that the markers are genuinely present in the input.
 */
export function buildPiiPayload(): ScoringAnalysisPayload {
  const payload = loadStoredPayload('stored-comparison');

  return {
    ...payload,
    results: payload.results.map((result, index) => ({
      ...result,
      rawMetrics: {
        ...result.rawMetrics,
        ...(index === 0
          ? {
              // Not part of the catalogued metric contract: exactly the kind of
              // extra column an import can add.
              customer_name: PII_MARKERS.customerName,
              customer_phone: PII_MARKERS.phone,
              customer_address: PII_MARKERS.address,
              individual_revenue: PII_MARKERS.individualRevenue,
              raw_data: PII_MARKERS.rawRow,
              metadata: PII_MARKERS.metadata,
            }
          : {}),
      } as ScoringAnalysisPayload['results'][number]['rawMetrics'],
    })),
  };
}

export function snapshotInput(
  payload: ScoringAnalysisPayload,
  overrides: Partial<ReportSnapshotInput> = {},
): ReportSnapshotInput {
  return {
    payload,
    workspace: { id: payload.analysis.workspaceId, name: 'Tashkent Retail Pilot' },
    project: { id: payload.analysis.projectId, name: 'Expansion 2026' },
    title: 'Tashkent expansion review',
    subtitle: 'Board pack · Q4',
    companyName: 'Atlas Retail Group',
    logo: null,
    includeMap: true,
    mapProvider: 'fake',
    mapAttribution: 'Synthetic map fixture (no map provider was contacted)',
    createdAt: '2026-10-05T09:40:00.000Z',
    ...overrides,
  };
}

export function buildComparisonSnapshot(
  overrides: Partial<ReportSnapshotInput> = {},
): ReportSnapshot {
  return buildReportSnapshot(snapshotInput(loadStoredPayload('stored-comparison'), overrides));
}

export function buildSingleSnapshot(
  overrides: Partial<ReportSnapshotInput> = {},
): ReportSnapshot {
  return buildReportSnapshot(snapshotInput(loadStoredPayload('stored-analysis'), overrides));
}
