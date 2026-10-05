/**
 * Confidence policy: turns provider candidates into a decision the import
 * workflow can act on.
 *
 *   accepted          - the row may take the candidate's coordinates
 *   review_required   - a human picks a candidate or places the point manually
 *   no_match          - nothing usable came back; the row stays staged
 *
 * Thresholds are environment-configurable (documented in docs/geocoding.md) and
 * have conservative defaults. Two candidates that score almost the same are
 * ambiguous even when the top score is high, because "almost right" is exactly
 * where an import silently goes wrong.
 */
import type { GeocodingCandidate } from './types';

export interface GeocodingThresholds {
  /** Minimum confidence for automatic acceptance. */
  accept: number;
  /** Minimum confidence for a candidate to be worth showing a human. */
  review: number;
  /** Two candidates within this distance are treated as ambiguous. */
  ambiguityDelta: number;
}

export const DEFAULT_GEOCODING_THRESHOLDS: GeocodingThresholds = {
  accept: 0.85,
  review: 0.45,
  ambiguityDelta: 0.1,
};

export function readGeocodingThresholds(
  env: Partial<Record<string, string | undefined>> = process.env,
): GeocodingThresholds {
  const parse = (value: string | undefined, fallback: number) => {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
    return parsed;
  };
  const thresholds = {
    accept: parse(env.GEOCODING_ACCEPT_THRESHOLD, DEFAULT_GEOCODING_THRESHOLDS.accept),
    review: parse(env.GEOCODING_REVIEW_THRESHOLD, DEFAULT_GEOCODING_THRESHOLDS.review),
    ambiguityDelta: parse(env.GEOCODING_AMBIGUITY_DELTA, DEFAULT_GEOCODING_THRESHOLDS.ambiguityDelta),
  };
  if (thresholds.review > thresholds.accept) thresholds.review = thresholds.accept;
  return thresholds;
}

export interface GeocodingDecision {
  decision: 'accepted' | 'review_required' | 'no_match';
  /** The candidate to store when accepted. */
  candidate: GeocodingCandidate | null;
  /** Candidates worth showing a human, best first (max 3). */
  alternatives: GeocodingCandidate[];
  /** Machine-readable reason, safe to show and to log. */
  reason: string;
}

function countryConflicts(candidate: GeocodingCandidate, expected: string | null | undefined): boolean {
  if (!expected) return false;
  if (!candidate.countryCode) return false; // unknown country is not proof of conflict
  return candidate.countryCode.toLocaleLowerCase('en') !== expected.toLocaleLowerCase('en');
}

export function decideGeocodingOutcome(
  candidates: GeocodingCandidate[],
  options: { thresholds?: GeocodingThresholds; expectedCountryCode?: string | null } = {},
): GeocodingDecision {
  const thresholds = options.thresholds ?? DEFAULT_GEOCODING_THRESHOLDS;
  const ranked = [...candidates].sort((left, right) => right.confidence - left.confidence);

  if (ranked.length === 0) {
    return { decision: 'no_match', candidate: null, alternatives: [], reason: 'no_candidates' };
  }

  const best = ranked[0];
  const alternatives = ranked.slice(0, 3);

  if (best.confidence < thresholds.review) {
    return {
      decision: 'no_match',
      candidate: null,
      alternatives,
      reason: 'below_review_threshold',
    };
  }

  // Several equally good answers: a human decides, no matter how good the top
  // score looks.
  const runnerUp = ranked[1];
  if (
    runnerUp &&
    runnerUp.confidence >= thresholds.review &&
    best.confidence - runnerUp.confidence <= thresholds.ambiguityDelta
  ) {
    return { decision: 'review_required', candidate: null, alternatives, reason: 'ambiguous_candidates' };
  }

  if (countryConflicts(best, options.expectedCountryCode)) {
    return {
      decision: 'review_required',
      candidate: null,
      alternatives,
      reason: 'country_mismatch',
    };
  }

  if (best.confidence < thresholds.accept) {
    return {
      decision: 'review_required',
      candidate: null,
      alternatives,
      reason: 'below_accept_threshold',
    };
  }

  return { decision: 'accepted', candidate: best, alternatives, reason: 'accepted' };
}
