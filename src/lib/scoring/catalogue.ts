/**
 * The metric catalogue and the presentation vocabulary of the scoring engine.
 *
 * The catalogue is the client-side mirror of the CHECK constraint on
 * `scoring_model_factors.metric`: it describes what each metric means and how it
 * should be formatted. The database remains the authority on what is allowed;
 * this list exists so the model editor can offer exactly the supported metrics
 * and can explain them honestly (no metric is offered that nothing measures).
 *
 * The qualitative score bands are a presentation aid only. A score is a
 * transparent weighted sum, never a probability, a confidence or a prediction.
 */

import type { ScoringDirection, ScoringNormalization } from './types';

export type ScoringMetricKind = 'count' | 'money' | 'distance' | 'density' | 'ratio' | 'score';

export interface ScoringMetricDefinition {
  key: string;
  label: string;
  description: string;
  kind: ScoringMetricKind;
  /** Direction that is meaningful for this metric, used for editor defaults. */
  suggests: ScoringDirection;
  /** Normalization the editor proposes for that direction. */
  suggestsNormalization: ScoringNormalization;
}

export const SCORING_METRICS: readonly ScoringMetricDefinition[] = [
  {
    key: 'customers_count',
    label: 'Customers in radius',
    description: 'How many customer records fall inside the radius. Straight from PostGIS.',
    kind: 'count',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'customers_revenue_total',
    label: 'Customer revenue in radius',
    description: 'Sum of the revenue column of those customers, kept as an exact decimal.',
    kind: 'money',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'competitors_count',
    label: 'Competitors in radius',
    description: 'How many competitor records fall inside the radius.',
    kind: 'count',
    suggests: 'negative',
    suggestsNormalization: 'inverse_min_max',
  },
  {
    key: 'branches_count',
    label: 'Own branches in radius',
    description: 'How many of the workspace branches fall inside the radius.',
    kind: 'count',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'locations_count',
    label: 'Commercial points of interest',
    description: 'How many saved locations of interest fall inside the radius.',
    kind: 'count',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'nearest_branch_distance_meters',
    label: 'Nearest branch distance',
    description: 'Distance to the closest workspace branch, measured with ST_DWithin semantics.',
    kind: 'distance',
    suggests: 'negative',
    suggestsNormalization: 'inverse_min_max',
  },
  {
    key: 'customers_per_sq_km',
    label: 'Customer density',
    description: 'Customers inside the radius divided by the circle area in square kilometres.',
    kind: 'density',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'competitors_per_sq_km',
    label: 'Competitor density',
    description: 'Competitors inside the radius divided by the circle area.',
    kind: 'density',
    suggests: 'negative',
    suggestsNormalization: 'inverse_min_max',
  },
  {
    key: 'revenue_per_sq_km',
    label: 'Revenue density',
    description: 'Customer revenue inside the radius divided by the circle area. Exact decimal text.',
    kind: 'money',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'customer_to_competitor_ratio',
    label: 'Customers per competitor',
    description: 'Customers divided by the competitor count, treated as one when there is none.',
    kind: 'ratio',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
  {
    key: 'branch_distance_score',
    label: 'Branch coverage',
    description: 'Derived 0..100 coverage: 100 at the point, 0 at or beyond the radius and with no branch.',
    kind: 'score',
    suggests: 'positive',
    suggestsNormalization: 'threshold',
  },
  {
    key: 'commercial_poi_density',
    label: 'Commercial POI density',
    description: 'Locations of interest inside the radius divided by the circle area.',
    kind: 'density',
    suggests: 'positive',
    suggestsNormalization: 'min_max',
  },
] as const;

const METRIC_BY_KEY = new Map(SCORING_METRICS.map((metric) => [metric.key, metric]));

export function findMetric(key: string): ScoringMetricDefinition | null {
  return METRIC_BY_KEY.get(key) ?? null;
}

export function metricLabel(key: string): string {
  return METRIC_BY_KEY.get(key)?.label ?? key;
}

export const SCORING_DIRECTIONS: readonly ScoringDirection[] = ['positive', 'negative', 'neutral'];
export const SCORING_NORMALIZATIONS: readonly ScoringNormalization[] = [
  'threshold',
  'min_max',
  'inverse_min_max',
];

export function directionLabel(direction: ScoringDirection): string {
  if (direction === 'positive') return 'More is better';
  if (direction === 'negative') return 'More is worse';
  return 'No monotonic claim';
}

export function normalizationLabel(normalization: ScoringNormalization): string {
  if (normalization === 'threshold') return 'Threshold curve';
  if (normalization === 'min_max') return 'Best/worst of the compared set';
  return 'Worst/best of the compared set (inverted)';
}

export function normalizationExplanation(normalization: ScoringNormalization): string {
  if (normalization === 'threshold') {
    return 'Absolute value/score stops you author. The candidate is scored on its own, so the result does not change when other candidates are added.';
  }
  if (normalization === 'min_max') {
    return 'The best value in the compared set scores 100 and the worst scores 0. Adding or removing a candidate changes the comparison set and therefore this factor.';
  }
  return 'The worst value in the compared set scores 100 and the best scores 0. Adding or removing a candidate changes the comparison set and therefore this factor.';
}

/** Radius presets offered by the interface; a custom radius stays allowed. */
export const RADIUS_PRESETS = [500, 1_000, 3_000, 5_000] as const;
export const MIN_RADIUS_METERS = 100;
export const MAX_RADIUS_METERS = 20_000;

/** A comparison needs two candidates and never accepts more than five. */
export const MIN_COMPARISON_CANDIDATES = 2;
export const MAX_COMPARISON_CANDIDATES = 5;

/** Candidate labels shown on the map and in the comparison table. */
export const CANDIDATE_LABELS = ['A', 'B', 'C', 'D', 'E'] as const;

export function candidateLabel(index: number): string {
  return CANDIDATE_LABELS[index] ?? String(index + 1);
}

export interface ScoreBand {
  minimum: number;
  label: string;
}

/**
 * Presentation bands. They are documented as UI wording only: the engine stores
 * the numeric score and the breakdown, never a band.
 */
export const SCORE_BANDS: readonly ScoreBand[] = [
  { minimum: 80, label: 'Strong' },
  { minimum: 60, label: 'Good' },
  { minimum: 40, label: 'Moderate' },
  { minimum: 0, label: 'Weak' },
] as const;

export function scoreBandLabel(score: number): string {
  const band = SCORE_BANDS.find((candidate) => score >= candidate.minimum);
  return band ? band.label : 'Weak';
}

export function formatScore(score: number): string {
  return `${formatScoreValue(score)} / 100`;
}

export function formatScoreValue(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

export function formatRadius(meters: number): string {
  if (meters >= 1_000) {
    const kilometers = meters / 1_000;
    return `${Number.isInteger(kilometers) ? kilometers : kilometers.toFixed(1)} km`;
  }
  return `${meters} m`;
}

/** Formats a metric for display, using the exact decimal text when present. */
export function formatMetricValue(
  metric: string,
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const definition = findMetric(metric);
  const numeric = typeof value === 'number' ? value : Number(value);

  if (Number.isNaN(numeric)) return String(value);

  if (definition?.kind === 'money') {
    const text = typeof value === 'string' ? value : numeric.toFixed(2);
    const [whole, fraction] = text.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${grouped}${fraction ? `.${fraction}` : ''}`;
  }
  if (definition?.kind === 'distance') {
    if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(2)} km`;
    return `${numeric.toFixed(0)} m`;
  }
  if (definition?.kind === 'count') return String(numeric);
  if (definition?.kind === 'score') return numeric.toFixed(2);
  return numeric.toFixed(2);
}
