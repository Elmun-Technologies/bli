/**
 * Presentation views over a stored analysis.
 *
 * Every value here comes from the stored payload: the raw metric, the normalized
 * value, the weight and the contribution are what the database wrote, and the
 * interface only adds labels, ordering and the qualitative band wording.
 */

import { candidateLabel, formatMetricValue, metricLabel, scoreBandLabel } from './catalogue';
import type {
  AnalysisCandidateResult,
  ScoreContribution,
  ScoringAnalysisPayload,
  ScoringDirection,
  ScoringNormalization,
} from './types';

export interface BreakdownRow {
  key: string;
  label: string;
  metric: string;
  metricLabel: string;
  direction: ScoringDirection;
  normalization: ScoringNormalization;
  weight: number;
  rawText: string | null;
  rawDisplay: string;
  normalized: number;
  contribution: number;
  /** How this number was produced, in the model's own terms. */
  explanation: string;
}

export interface BreakdownView {
  candidateId: string;
  candidateName: string;
  rank: number;
  finalScore: number;
  band: string;
  rows: BreakdownRow[];
  /** Sum of the stored contributions, which must equal the stored score. */
  contributionTotal: number;
  consistent: boolean;
}

function contributionExplanation(
  contribution: ScoreContribution,
  rawDisplay: string,
): string {
  if (contribution.normalization === 'threshold') {
    return `${rawDisplay} falls on the threshold curve, which scores it ${contribution.normalized} before the ${contribution.weight} percent weight.`;
  }
  const directionWord = contribution.normalization === 'min_max' ? 'best value' : 'worst value';
  return `The compared set scores this ${contribution.normalized}: the ${directionWord} scores 100 and the other end scores 0, before the ${contribution.weight} percent weight.`;
}

export function buildBreakdown(result: AnalysisCandidateResult): BreakdownView {
  const rows: BreakdownRow[] = result.contributions.map((contribution) => {
    const rawDisplay =
      contribution.rawText !== null && contribution.rawText !== ''
        ? formatMetricValue(contribution.metric, contribution.rawText)
        : formatMetricValue(contribution.metric, contribution.rawValue);

    return {
      key: contribution.key,
      label: contribution.label,
      metric: contribution.metric,
      metricLabel: metricLabel(contribution.metric),
      direction: contribution.direction,
      normalization: contribution.normalization,
      weight: contribution.weight,
      rawText: contribution.rawText,
      rawDisplay,
      normalized: contribution.normalized,
      contribution: contribution.contribution,
      explanation: contributionExplanation(contribution, rawDisplay),
    };
  });

  const contributionTotal = Number(
    rows.reduce((total, row) => total + row.contribution, 0).toFixed(2),
  );

  return {
    candidateId: result.candidateId,
    candidateName: result.candidateName,
    rank: result.rank,
    finalScore: result.finalScore,
    band: scoreBandLabel(result.finalScore),
    rows,
    contributionTotal,
    consistent: contributionTotal === result.finalScore,
  };
}

export interface ComparisonRow {
  label: string;
  candidateId: string;
  candidateName: string;
  rank: number;
  score: number;
  band: string;
  customers: number;
  revenueTotal: string;
  competitors: number;
  nearestBranchName: string | null;
  nearestBranchDistanceMeters: number | null;
  poiCount: number;
  customerDensity: number;
  /** The model's own competition factor, when it has one. Otherwise null. */
  competitionScore: number | null;
  competitionFactorLabel: string | null;
  /** Sum of the positive-direction contributions: the demand side of the model. */
  opportunityScore: number;
  topContributionLabel: string | null;
  topContribution: number | null;
}

/**
 * One row per candidate, labelled A..E in stored rank order. Every figure is
 * copied out of the stored payload: the comparison never recomputes a score.
 */
export function buildComparisonRows(payload: ScoringAnalysisPayload): ComparisonRow[] {
  return payload.results.map((result, index) => {
    const competition = result.contributions.find(
      (contribution) => contribution.direction === 'negative' && contribution.metric.includes('competitor'),
    );
    const opportunityScore = Number(
      result.contributions
        .filter((contribution) => contribution.direction === 'positive')
        .reduce((total, contribution) => total + contribution.contribution, 0)
        .toFixed(2),
    );
    const strongest = [...result.contributions].sort(
      (left, right) => right.contribution - left.contribution,
    )[0];

    return {
      label: candidateLabel(index),
      candidateId: result.candidateId,
      candidateName: result.candidateName,
      rank: result.rank,
      score: result.finalScore,
      band: scoreBandLabel(result.finalScore),
      customers: result.rawMetrics.customersCount,
      revenueTotal: result.rawMetrics.customersRevenueTotal,
      competitors: result.rawMetrics.competitorsCount,
      nearestBranchName: result.rawMetrics.nearestBranchName,
      nearestBranchDistanceMeters: result.rawMetrics.nearestBranchDistanceMeters,
      poiCount: result.rawMetrics.locationsCount,
      customerDensity: result.rawMetrics.customersPerSqKm,
      competitionScore: competition ? competition.normalized : null,
      competitionFactorLabel: competition ? competition.label : null,
      opportunityScore,
      topContributionLabel: strongest ? strongest.label : null,
      topContribution: strongest ? strongest.contribution : null,
    };
  });
}

export type ComparisonSortKey = 'score' | 'customers' | 'competition' | 'revenue';

export const COMPARISON_SORT_KEYS: readonly ComparisonSortKey[] = [
  'score',
  'customers',
  'competition',
  'revenue',
];

export function comparisonSortLabel(key: ComparisonSortKey): string {
  if (key === 'score') return 'Overall score';
  if (key === 'customers') return 'Customer potential';
  if (key === 'competition') return 'Competition';
  return 'Revenue';
}

/**
 * Sorting never changes what the table says, only the order of the rows. A
 * missing value (no competition factor in the model) sorts last.
 */
export function sortComparisonRows(
  rows: readonly ComparisonRow[],
  key: ComparisonSortKey,
  direction: 'asc' | 'desc' = 'desc',
): ComparisonRow[] {
  const valueOf = (row: ComparisonRow): number | null => {
    if (key === 'score') return row.score;
    if (key === 'customers') return row.customers;
    if (key === 'revenue') return Number(row.revenueTotal);
    return row.competitionScore;
  };

  return [...rows].sort((left, right) => {
    const leftValue = valueOf(left);
    const rightValue = valueOf(right);
    if (leftValue === null && rightValue === null) return left.rank - right.rank;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (leftValue === rightValue) return left.rank - right.rank;
    return direction === 'desc' ? rightValue - leftValue : leftValue - rightValue;
  });
}

/**
 * The freshness note. A stored analysis is flagged when the workspace spatial
 * data changed after the snapshot; the flag is advisory and never rewrites the
 * stored result.
 */
export function freshnessNote(payload: ScoringAnalysisPayload): string | null {
  if (!payload.analysis.mayBeOutdated) return null;
  return 'Workspace data changed after this analysis ran, so the stored metrics may be outdated. Run the analysis again to refresh them.';
}
