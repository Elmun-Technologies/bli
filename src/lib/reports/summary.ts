/**
 * Deterministic executive summary, strengths and considerations.
 *
 * Everything here is derived from the stored factor contributions. There is no
 * language model, no template engine and no subjective consulting language: the
 * sentences are assembled from the stored labels, weights and contribution
 * values, in the stored order, so the same snapshot always produces the same
 * text. The wording never claims causality and never calls a score a
 * probability, a forecast or a recommendation.
 */

import { formatRadius, scoreBandLabel } from '@/lib/scoring/catalogue';
import { formatReportNumber } from './format';
import type { ReportSnapshot, ReportSnapshotCandidate } from './types';

export interface ReportSummaryText {
  headline: string;
  paragraphs: string[];
  keyPoints: string[];
}

export interface ReportStrengthRow {
  label: string;
  contributionText: string;
}

/**
 * The enabled contributions of a candidate, strongest first. Ties keep the
 * model's own factor order (`sortOrder` through the stored contribution order),
 * so the text is stable.
 */
function rankedContributions(
  candidate: ReportSnapshotCandidate,
  factors: ReportSnapshot['model']['factors'],
): Array<{ label: string; contribution: number; weight: number; normalized: number }> {
  const enabled = new Map(
    factors.filter((factor) => factor.enabled).map((factor) => [factor.key, factor]),
  );

  return candidate.contributions
    .filter((contribution) => enabled.has(contribution.key))
    .map((contribution) => ({
      label: contribution.label,
      contribution: contribution.contribution,
      weight: contribution.weight,
      normalized: contribution.normalized,
    }))
    .sort((left, right) => {
      if (right.contribution !== left.contribution) return right.contribution - left.contribution;
      return left.label.localeCompare(right.label);
    });
}

/** The contribution rows a reader should see first: the strongest 1-2 factors. */
export function selectStrengths(
  candidate: ReportSnapshotCandidate,
  factors: ReportSnapshot['model']['factors'],
  limit = 2,
): ReportStrengthRow[] {
  return rankedContributions(candidate, factors)
    .slice(0, Math.max(1, limit))
    .map((row) => ({ label: row.label, contributionText: formatReportNumber(row.contribution) }));
}

/**
 * The considerations: the enabled factors with the smallest contribution, read
 * as "this factor contributed least". They are never phrased as a
 * recommendation to act, and never invent a cause.
 */
export function selectConsiderations(
  candidate: ReportSnapshotCandidate,
  factors: ReportSnapshot['model']['factors'],
  limit = 2,
): ReportStrengthRow[] {
  const ranked = rankedContributions(candidate, factors);
  if (ranked.length <= 1) return [];

  return ranked
    .slice()
    .reverse()
    .slice(0, Math.max(1, limit))
    .map((row) => ({ label: row.label, contributionText: formatReportNumber(row.contribution) }));
}

function joinLabels(labels: string[]): string {
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function contributionSentence(row: ReportStrengthRow): string {
  return `${row.label} contributed ${row.contributionText} points.`;
}

/**
 * The executive summary of the snapshot.
 *
 * Comparison, for example:
 *   "3 candidate locations were compared using Retail Expansion Model v2 within
 *    a 1.00 km radius." / "Location B ranked first with a score of 82.40 / 100
 *    (Strong)." / "Its strongest weighted contributions were Customer Density and
 *    Revenue Potential. Its weakest contribution was Competition."
 *
 * Single location:
 *   "Location A was scored with Retail Expansion Model v1 within a 1.00 km
 *    radius." / "It scored 64.20 / 100 (Good)."
 *
 * Every number is the stored number.
 */
export function buildExecutiveSummary(snapshot: ReportSnapshot): ReportSummaryText {
  const { analysis, model, candidates } = snapshot;
  const radiusText = formatRadius(analysis.radiusMeters);
  const top = candidates[0] ?? null;
  const paragraphs: string[] = [];
  const keyPoints: string[] = [];

  if (!top) {
    return {
      headline: 'This report has no stored candidate result.',
      paragraphs: ['The stored analysis carries no candidate result, so no summary can be derived.'],
      keyPoints: [],
    };
  }

  const scoreText = formatReportNumber(top.finalScore);
  const band = scoreBandLabel(top.finalScore);

  const headline =
    snapshot.report.type === 'comparison'
      ? `${top.name} (${top.label}) ranked first with a score of ${scoreText} / 100.`
      : `${top.name} scored ${scoreText} / 100.`;

  if (snapshot.report.type === 'comparison') {
    paragraphs.push(
      `${analysis.candidateCount} candidate locations were compared using ${model.name} v${model.version} within a ${radiusText} radius.`,
    );
    paragraphs.push(`${top.name} (${top.label}) ranked first with a score of ${scoreText} / 100 (${band}).`);
  } else {
    paragraphs.push(
      `${top.name} was scored with ${model.name} v${model.version} within a ${radiusText} radius, using the stored analysis of this workspace data.`,
    );
    paragraphs.push(`It scored ${scoreText} / 100 (${band}).`);
  }

  const strengths = selectStrengths(top, model.factors);
  const considerations = selectConsiderations(top, model.factors);

  if (strengths.length > 0) {
    paragraphs.push(
      `Its strongest weighted contributions were ${joinLabels(
        strengths.map((row) => row.label),
      )}.`,
    );
    keyPoints.push(...strengths.map(contributionSentence));
  }
  if (considerations.length > 0) {
    paragraphs.push(
      `Its weakest enabled ${considerations.length === 1 ? 'contribution was' : 'contributions were'} ${joinLabels(
        considerations.map((row) => row.label),
      )}.`,
    );
    keyPoints.push(
      ...considerations.map(
        (row) => `${row.label} contributed the least of the enabled factors (${row.contributionText} points).`,
      ),
    );
  }

  paragraphs.push(
    `${snapshot.methodology.disclaimer}`,
  );

  return { headline, paragraphs, keyPoints };
}
