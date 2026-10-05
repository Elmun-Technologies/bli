/**
 * ReportSnapshot -> ReportViewModel.
 *
 * This is the single place where stored numbers become human text. The HTML
 * preview and the PDF document both render *this* object; neither re-derives a
 * business number, and neither reads the database. If a value is wrong here it
 * is wrong everywhere, on purpose: there is one formatting path.
 *
 * Like every Phase 3-6 contract, the view model is built on the server and read
 * through a strict parser on the client, so a drifted field is a loud failure
 * instead of a blank cell in a PDF.
 */

import {
  candidateLabel,
  findMetric,
  formatMetricValue,
  formatRadius,
  formatScoreValue,
  scoreBandLabel,
} from '@/lib/scoring/catalogue';

import { formatReportNumber, formatReportScore } from './format';

import { buildExecutiveSummary, selectConsiderations, selectStrengths } from './summary';
import type {
  ReportCandidateView,
  ReportComparisonRow,
  ReportFactorRow,
  ReportMetricRow,
  ReportSnapshot,
  ReportStatus,
  ReportViewModel,
} from './types';

const TYPE_LABELS: Record<ReportViewModel['report']['type'], string> = {
  single_location: 'Single-location report',
  comparison: 'Comparison report',
};

const DIRECTION_LABELS: Record<string, string> = {
  positive: 'Higher is better',
  negative: 'Lower is better',
  neutral: 'Model-authored curve',
};

const NORMALIZATION_LABELS: Record<string, string> = {
  threshold: 'Threshold curve',
  min_max: 'Min–max across the compared sites',
  inverse_min_max: 'Inverse min–max across the compared sites',
};

export function formatReportDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function directionLabel(direction: string): string {
  return DIRECTION_LABELS[direction] ?? direction;
}

export function normalizationLabel(normalization: string): string {
  return NORMALIZATION_LABELS[normalization] ?? normalization;
}

/** The stored metric value as text; money stays the exact stored decimal. */
export function metricText(metric: string, value: number | string | null): string {
  return formatMetricValue(metric, value);
}

/**
 * The seven metrics the comparison table shows. Only stored values appear; a
 * metric the model does not use is still shown, because it was still measured.
 */
export function buildComparisonRow(
  candidate: ReportCandidateView,
  snapshotCandidate: ReportSnapshot['candidates'][number],
): ReportComparisonRow {
  const metrics = snapshotCandidate.metrics;
  return {
    rank: candidate.rank,
    label: candidate.label,
    name: candidate.name,
    scoreText: candidate.scoreText,
    customersText: metricText('customers_count', metrics.customersCount),
    revenueText: metricText('customers_revenue_total', metrics.customersRevenueTotal),
    competitorsText: metricText('competitors_count', metrics.competitorsCount),
    nearestBranchText:
      metrics.nearestBranchDistanceMeters === null
        ? 'No branch in range'
        : metricText('nearest_branch_distance_meters', metrics.nearestBranchDistanceMeters),
    poiText: metricText('locations_count', metrics.locationsCount),
    densityText: metricText('customers_per_sq_km', metrics.customersPerSqKm),
  };
}

export interface BuildReportViewModelOptions {
  reportId?: string | null;
  status?: ReportStatus;
  generatedAt?: string | null;
  snapshotHash?: string | null;
  /** True when a stored static map image exists for this report. */
  mapAvailable?: boolean;
}

/**
 * Builds the safe, formatted report view model from an immutable snapshot.
 * Pure and synchronous: the same snapshot and options always give the same
 * object (only `generatedAt`/`status` come from the row, never from the
 * analysis).
 */
export function buildReportViewModel(
  snapshot: ReportSnapshot,
  options: BuildReportViewModelOptions = {},
): ReportViewModel {
  const status = options.status ?? 'ready';
  const { analysis, model } = snapshot;

  const candidates: ReportCandidateView[] = snapshot.candidates.map((candidate) => {
    const factorRows: ReportFactorRow[] = candidate.contributions.map((contribution) => ({
      key: contribution.key,
      label: contribution.label,
      metricLabel: findMetric(contribution.metric)?.label ?? contribution.metric,
      rawText:
        contribution.rawText ??
        (contribution.rawValue === null
          ? 'not measured'
          : metricText(contribution.metric, contribution.rawValue)),
      normalizedText: formatReportNumber(contribution.normalized),
      weightText: `${formatScoreValue(contribution.weight)}%`,
      contributionText: formatReportNumber(contribution.contribution),
      direction: contribution.direction,
      normalizationLabel: normalizationLabel(contribution.normalization),
      enabled: true,
    }));

    const metrics: ReportMetricRow[] = [
      { key: 'customers_count', label: 'Customers in radius', valueText: metricText('customers_count', candidate.metrics.customersCount) },
      { key: 'customers_revenue_total', label: 'Customer revenue in radius', valueText: metricText('customers_revenue_total', candidate.metrics.customersRevenueTotal) },
      { key: 'competitors_count', label: 'Competitors in radius', valueText: metricText('competitors_count', candidate.metrics.competitorsCount) },
      { key: 'branches_count', label: 'Own branches in radius', valueText: metricText('branches_count', candidate.metrics.branchesCount) },
      { key: 'locations_count', label: 'Commercial points of interest', valueText: metricText('locations_count', candidate.metrics.locationsCount) },
      {
        key: 'nearest_branch_distance_meters',
        label: 'Nearest branch',
        valueText:
          candidate.metrics.nearestBranchDistanceMeters === null
            ? 'No branch in range'
            : `${candidate.metrics.nearestBranchName ?? 'Branch'} · ${metricText(
                'nearest_branch_distance_meters',
                candidate.metrics.nearestBranchDistanceMeters,
              )}`,
      },
      { key: 'customers_per_sq_km', label: 'Customer density', valueText: `${metricText('customers_per_sq_km', candidate.metrics.customersPerSqKm)} per km²` },
      { key: 'competitors_per_sq_km', label: 'Competitor density', valueText: `${metricText('competitors_per_sq_km', candidate.metrics.competitorsPerSqKm)} per km²` },
      { key: 'customers_revenue_per_sq_km', label: 'Revenue density', valueText: metricText('revenue_per_sq_km', candidate.metrics.revenuePerSqKm) },
      { key: 'area_sq_km', label: 'Circle area', valueText: `${metricText('area_sq_km', candidate.metrics.areaSqKm)} km²` },
    ];

    return {
      id: candidate.id,
      label: candidate.label,
      name: candidate.name,
      rank: candidate.rank,
      scoreText: formatReportScore(candidate.finalScore),
      band: scoreBandLabel(candidate.finalScore),
      coordinatesText: `${candidate.latitude.toFixed(5)}, ${candidate.longitude.toFixed(5)}`,
      metrics,
      factors: factorRows,
      strengths: selectStrengths(candidate, model.factors),
      considerations: selectConsiderations(candidate, model.factors),
    };
  });

  const summary = buildExecutiveSummary(snapshot);
  const top = snapshot.candidates[0] ?? null;

  const generatedAtText = options.generatedAt ? formatReportDate(options.generatedAt) : null;

  return {
    report: {
      id: options.reportId ?? null,
      type: snapshot.report.type,
      typeLabel: TYPE_LABELS[snapshot.report.type],
      title: snapshot.report.title,
      subtitle: snapshot.report.subtitle,
      status,
      createdAtText: formatReportDate(snapshot.report.createdAt),
      generatedAtText,
      snapshotHash: options.snapshotHash ?? null,
    },
    workspace: { id: snapshot.workspace.id, name: snapshot.workspace.name },
    project: { id: snapshot.project.id, name: snapshot.project.name },
    analysis: {
      id: analysis.id,
      radiusMeters: analysis.radiusMeters,
      radiusText: formatRadius(analysis.radiusMeters),
      candidateCount: analysis.candidateCount,
      modelName: analysis.modelName,
      modelVersion: analysis.modelVersion,
      analysisDateText: formatReportDate(analysis.createdAt),
      dataSnapshotText: formatReportDate(analysis.dataSnapshotAt),
    },
    model: {
      name: model.name,
      version: model.version,
      factors: model.factors.map((factor) => ({
        key: factor.key,
        label: factor.label,
        weightText: `${formatScoreValue(factor.weight)}%`,
        directionLabel: directionLabel(factor.direction),
        normalizationLabel: normalizationLabel(factor.normalization),
        enabled: factor.enabled,
      })),
    },
    summary: {
      headline: summary.headline,
      paragraphs: summary.paragraphs,
      keyPoints: summary.keyPoints,
      topCandidate: top
        ? {
            label: top.label,
            name: top.name,
            scoreText: formatReportScore(top.finalScore),
            band: scoreBandLabel(top.finalScore),
            rank: top.rank,
          }
        : null,
    },
    ranking: snapshot.candidates.map((candidate, index) => ({
      label: candidate.label || candidateLabel(index),
      name: candidate.name,
      rank: candidate.rank,
      scoreText: formatReportScore(candidate.finalScore),
      band: scoreBandLabel(candidate.finalScore),
    })),
    candidates,
    comparison:
      snapshot.report.type === 'comparison'
        ? {
            rows: candidates.map((candidate, index) =>
              buildComparisonRow(candidate, snapshot.candidates[index]),
            ),
          }
        : null,
    methodology: {
      modelName: model.name,
      modelVersion: model.version,
      radiusText: formatRadius(analysis.radiusMeters),
      factors: model.factors.map((factor) => ({
        key: factor.key,
        label: factor.label,
        weightText: `${formatScoreValue(factor.weight)}%`,
        directionLabel: directionLabel(factor.direction),
        normalizationLabel: normalizationLabel(factor.normalization),
        enabled: factor.enabled,
      })),
      scoreExplanation: snapshot.methodology.scoreExplanation,
      disclaimer: snapshot.methodology.disclaimer,
    },
    freshness: {
      analysisText: formatReportDate(analysis.createdAt),
      dataSnapshotText: formatReportDate(analysis.dataSnapshotAt),
      generatedText: generatedAtText ?? 'not generated yet',
      note: analysis.mayBeOutdated
        ? 'The underlying workspace data has changed since this analysis was created. This report keeps the numbers of the stored analysis.'
        : null,
    },
    map: {
      available: options.mapAvailable ?? false,
      providerLabel: snapshot.map.provider,
      attribution: snapshot.map.attribution,
      note:
        options.mapAvailable === false
          ? snapshot.map.include
            ? 'The static map image could not be included. Every number in this report still comes from the stored analysis.'
            : 'No static map was requested for this report.'
          : null,
    },
    branding: {
      companyName: snapshot.branding.companyName,
      logoAvailable: snapshot.branding.logo !== null,
    },
  };
}
