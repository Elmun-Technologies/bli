/**
 * Presentation state for the Phase 6 locations section.
 *
 * Everything here is derived from a stored payload or from the user's own
 * selections. No score is computed here: the database wrote the score, the
 * normalized values and the contributions, and this module only chooses labels,
 * order and wording. The qualitative band is presentation only, never a claim
 * about probability or confidence.
 */

import type { MapScoringCandidate } from '@/components/map/map-types';
import {
  candidateLabel,
  formatScore,
  MAX_COMPARISON_CANDIDATES,
  scoreBandLabel,
} from '@/lib/scoring/catalogue';
import type { ScoringAnalysisPayload } from '@/lib/scoring/types';
import { freshnessNote } from '@/lib/scoring/view';

export type ScoringSectionTab = 'analyze' | 'compare' | 'models';

export const SCORING_TABS: readonly ScoringSectionTab[] = ['analyze', 'compare', 'models'];

export function scoringTabLabel(tab: ScoringSectionTab): string {
  if (tab === 'analyze') return 'Analyze a site';
  if (tab === 'compare') return 'Compare sites';
  return 'Scoring models';
}

/** Candidate markers the map draws after a run, labelled A..E in rank order. */
export type ScoringMapCandidate = MapScoringCandidate;

export function mapCandidatesFromPayload(payload: ScoringAnalysisPayload): ScoringMapCandidate[] {
  return payload.results.map((result, index) => ({
    candidateId: result.candidateId,
    label: candidateLabel(index),
    name: result.candidateName,
    coordinates: [result.longitude, result.latitude],
    score: result.finalScore,
  }));
}

/**
 * A comparison selects two to five saved candidates. The cap is enforced here
 * for the interface and again by the database: the sixth candidate can never be
 * scored, and the selection keeps the order the user picked.
 */
export function toggleCandidateSelection(
  current: readonly string[],
  candidateId: string,
): string[] {
  if (current.includes(candidateId)) {
    return current.filter((id) => id !== candidateId);
  }
  if (current.length >= MAX_COMPARISON_CANDIDATES) return [...current];
  return [...current, candidateId];
}

export function selectionMessage(count: number): string {
  if (count === 0) return 'Select two to five saved sites.';
  if (count === 1) return 'Select one more site to compare.';
  return `${count} of ${MAX_COMPARISON_CANDIDATES} sites selected.`;
}

export function comparisonReady(count: number): boolean {
  return count >= 2 && count <= MAX_COMPARISON_CANDIDATES;
}

export interface AnalysisHeadline {
  candidateName: string;
  /** Always `82 / 100`, never a percentage. */
  scoreText: string;
  band: string;
  rank: number;
  candidateCount: number;
  modelName: string;
  modelVersion: number;
  radiusMeters: number;
  mode: 'analysis' | 'comparison';
}

export function analysisHeadline(payload: ScoringAnalysisPayload): AnalysisHeadline | null {
  const best = payload.results[0];
  if (!best) return null;

  return {
    candidateName: best.candidateName,
    scoreText: formatScore(best.finalScore),
    band: scoreBandLabel(best.finalScore),
    rank: best.rank,
    candidateCount: payload.analysis.candidateCount,
    modelName: payload.analysis.modelName,
    modelVersion: payload.analysis.modelVersion,
    radiusMeters: payload.analysis.radiusMeters,
    mode: payload.analysis.mode,
  };
}

/** The advisory `Analysis may be outdated` message, or null when it is current. */
export function analysisFreshnessMessage(payload: ScoringAnalysisPayload): string | null {
  return freshnessNote(payload);
}

export function formatSnapshotTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'unknown';
  return `${parsed.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** One line naming exactly what the stored analysis was run with. */
export function snapshotSummary(payload: ScoringAnalysisPayload): string {
  const { analysis } = payload;
  return [
    analysis.modelName,
    `v${analysis.modelVersion}`,
    `${analysis.radiusMeters} m radius`,
    `${analysis.candidateCount} ${analysis.candidateCount === 1 ? 'candidate' : 'candidates'}`,
    `snapshot ${formatSnapshotTimestamp(analysis.dataSnapshotAt)}`,
  ].join(' · ');
}

/**
 * How the qualitative band is worded. It repeats the documented bands and is
 * used only under the numeric score.
 */
export function bandCaption(): string {
  return 'Band labels (80+ Strong, 60–79 Good, 40–59 Moderate, below 40 Weak) describe the numeric score only. A score is a transparent weighted sum, not a probability or a prediction.';
}
