/**
 * Optional CSV export of a comparison.
 *
 * The export is a straight copy of the stored payload: the same numbers the
 * table shows, with the raw metrics in their exact decimal text. It is generated
 * in the browser from the analysis that is already on screen, so no endpoint can
 * be used to dump another workspace's data and no additional access path exists.
 *
 * This is deliberately not a report generator: no PDF, no charts, no template.
 */

import { metricLabel, scoreBandLabel } from './catalogue';
import type { ComparisonRow } from './view';
import type { ScoringAnalysisPayload } from './types';

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export const COMPARISON_CSV_HEADER = [
  'label',
  'candidate',
  'rank',
  'score_out_of_100',
  'band_label',
  'radius_meters',
  'customers',
  'customer_revenue_total',
  'competitors',
  'nearest_branch',
  'nearest_branch_distance_m',
  'commercial_pois',
  `${metricLabel('customers_per_sq_km')}`,
  'competition_factor_score',
  'opportunity_contribution',
  'model',
  'model_version',
  'analysis_id',
  'data_snapshot_at',
] as const;

export function buildComparisonCsv(
  payload: ScoringAnalysisPayload,
  rows: readonly ComparisonRow[],
): string {
  const lines = [COMPARISON_CSV_HEADER.map(escapeCsvCell).join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.label,
        row.candidateName,
        String(row.rank),
        row.score.toFixed(2),
        scoreBandLabel(row.score),
        String(payload.analysis.radiusMeters),
        String(row.customers),
        row.revenueTotal,
        String(row.competitors),
        row.nearestBranchName ?? 'none',
        row.nearestBranchDistanceMeters === null ? 'none' : row.nearestBranchDistanceMeters.toFixed(2),
        String(row.poiCount),
        row.customerDensity.toFixed(4),
        row.competitionScore === null ? 'not in model' : row.competitionScore.toFixed(2),
        row.opportunityScore.toFixed(2),
        payload.analysis.modelName,
        String(payload.analysis.modelVersion),
        payload.analysis.id,
        payload.analysis.dataSnapshotAt,
      ]
        .map((cell) => escapeCsvCell(String(cell)))
        .join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

export function comparisonCsvFilename(payload: ScoringAnalysisPayload): string {
  const safeModel = payload.analysis.modelName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `location-comparison-${safeModel || 'scoring'}-${payload.analysis.id.slice(0, 8)}.csv`;
}

/** Triggers a client-side download of the comparison exactly as shown. */
export function downloadComparisonCsv(
  payload: ScoringAnalysisPayload,
  rows: readonly ComparisonRow[],
): void {
  const csv = buildComparisonCsv(payload, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = comparisonCsvFilename(payload);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
