/**
 * Phase 7 report types.
 *
 * A report is a projection of one already-stored Phase 6 analysis. The types
 * below describe three layers, in this order:
 *
 *   ReportSnapshot   what was true when the analysis ran, frozen and hashed
 *   ReportViewModel  the same facts, formatted for humans, shared by preview and PDF
 *   ReportSummary    the list/status row the API returns
 *
 * None of them contains customer-level rows. The metric block is an explicit
 * allow-list of the aggregate values PostGIS produced inside the radius; a
 * customer name, phone number, street address, individual revenue or raw import
 * row has no field here and can therefore never reach a report, a preview, a PDF
 * or a map request.
 *
 * A report never reruns anything: no ST_DWithin, no normalization, no ranking,
 * no scoring. Changing the workspace data or the model cannot move a stored
 * report, and regeneration renders the same snapshot again.
 */

import type {
  RawMetrics,
  ScoreContribution,
  ScoringDirection,
  ScoringNormalization,
  ScoringMode,
} from '@/lib/scoring/types';

export type ReportType = 'single_location' | 'comparison';
export type ReportStatus = 'draft' | 'generating' | 'ready' | 'failed';

/** The snapshot format version. A future format change must bump this. */
export const REPORT_SNAPSHOT_VERSION = 1;

/**
 * The aggregate metrics a report may show. This is deliberately narrower than
 * `RawMetrics`: internal identifiers (the nearest branch id) and scorer-only
 * values are dropped, and every remaining field is an aggregate. Money stays
 * exact decimal text.
 */
export interface ReportCandidateMetrics {
  radiusMeters: number;
  areaSqKm: number;
  customersCount: number;
  customersRevenueTotal: string;
  competitorsCount: number;
  branchesCount: number;
  locationsCount: number;
  customersPerSqKm: number;
  competitorsPerSqKm: number;
  revenuePerSqKm: string;
  customerToCompetitorRatio: number;
  branchDistanceScore: number;
  commercialPoiDensity: number;
  nearestBranchName: string | null;
  nearestBranchDistanceMeters: number | null;
  categoryDistribution: Array<{ key: string; count: number }>;
}

export interface ReportSnapshotCandidate {
  id: string;
  /** Presentation label A..E in stored rank order. */
  label: string;
  name: string;
  longitude: number;
  latitude: number;
  rank: number;
  /** Stored final score, on the stored 0..100 scale. */
  finalScore: number;
  metrics: ReportCandidateMetrics;
  normalizedMetrics: Record<string, number>;
  contributions: ScoreContribution[];
}

export interface ReportSnapshotFactor {
  key: string;
  label: string;
  metric: string;
  weight: number;
  direction: ScoringDirection;
  normalization: ScoringNormalization;
  enabled: boolean;
  sortOrder: number;
}

export interface ReportSnapshot {
  version: number;
  report: {
    type: ReportType;
    title: string;
    subtitle: string | null;
    createdAt: string;
  };
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  analysis: {
    id: string;
    mode: ScoringMode;
    radiusMeters: number;
    candidateCount: number;
    modelId: string;
    modelName: string;
    modelVersion: number;
    dataSnapshotAt: string;
    createdAt: string;
    workspaceDataUpdatedAt: string | null;
    mayBeOutdated: boolean;
  };
  model: {
    id: string;
    name: string;
    version: number;
    /** The factor definitions exactly as they were used for this analysis. */
    factors: ReportSnapshotFactor[];
  };
  candidates: ReportSnapshotCandidate[];
  branding: {
    companyName: string | null;
    logo: { path: string; mimeType: string; sizeBytes: number } | null;
  };
  map: {
    include: boolean;
    provider: string;
    /** Required attribution text, always printed in the report. */
    attribution: string;
  };
  /** Deterministic wording fixed at snapshot time, so old reports keep their text. */
  methodology: {
    scoreExplanation: string;
    disclaimer: string;
  };
}

/** One formatted metric row in the view model. */
export interface ReportMetricRow {
  key: string;
  label: string;
  valueText: string;
}

/** One formatted factor row: raw value -> normalized -> weight -> contribution. */
export interface ReportFactorRow {
  key: string;
  label: string;
  metricLabel: string;
  rawText: string;
  normalizedText: string;
  weightText: string;
  contributionText: string;
  direction: ScoringDirection;
  normalizationLabel: string;
  enabled: boolean;
}

export interface ReportCandidateStrengths {
  label: string;
  contributionText: string;
}

/** One configured factor as the methodology page describes it. */
export interface ReportModelFactorView {
  key: string;
  label: string;
  weightText: string;
  directionLabel: string;
  normalizationLabel: string;
  enabled: boolean;
}

export interface ReportCandidateView {
  id: string;
  label: string;
  name: string;
  rank: number;
  scoreText: string;
  band: string;
  coordinatesText: string;
  metrics: ReportMetricRow[];
  factors: ReportFactorRow[];
  strengths: ReportCandidateStrengths[];
  considerations: ReportCandidateStrengths[];
}

export interface ReportComparisonRow {
  rank: number;
  label: string;
  name: string;
  scoreText: string;
  customersText: string;
  revenueText: string;
  competitorsText: string;
  nearestBranchText: string;
  poiText: string;
  densityText: string;
}

export interface ReportViewModel {
  report: {
    id: string | null;
    type: ReportType;
    typeLabel: string;
    title: string;
    subtitle: string | null;
    status: ReportStatus;
    createdAtText: string;
    generatedAtText: string | null;
    snapshotHash: string | null;
  };
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  analysis: {
    id: string;
    radiusMeters: number;
    radiusText: string;
    candidateCount: number;
    modelName: string;
    modelVersion: number;
    analysisDateText: string;
    dataSnapshotText: string;
  };
  model: {
    name: string;
    version: number;
    factors: ReportModelFactorView[];
  };
  summary: {
    headline: string;
    paragraphs: string[];
    keyPoints: string[];
    topCandidate: {
      label: string;
      name: string;
      scoreText: string;
      band: string;
      rank: number;
    } | null;
  };
  ranking: Array<{ label: string; name: string; rank: number; scoreText: string; band: string }>;
  candidates: ReportCandidateView[];
  comparison: { rows: ReportComparisonRow[] } | null;
  methodology: {
    modelName: string;
    modelVersion: number;
    radiusText: string;
    factors: ReportModelFactorView[];
    scoreExplanation: string;
    disclaimer: string;
  };
  freshness: {
    analysisText: string;
    dataSnapshotText: string;
    generatedText: string;
    note: string | null;
  };
  map: {
    available: boolean;
    providerLabel: string;
    attribution: string;
    note: string | null;
  };
  branding: {
    companyName: string | null;
    logoAvailable: boolean;
  };
}

export interface ReportSummary {
  id: string;
  workspaceId: string;
  projectId: string;
  analysisId: string;
  type: ReportType;
  title: string;
  subtitle: string | null;
  companyName: string | null;
  status: ReportStatus;
  snapshotHash: string | null;
  failureCode: string | null;
  hasMap: boolean;
  hasLogo: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
}

/** The metric keys a comparison table shows, in the documented order. */
export const COMPARISON_METRIC_KEYS = [
  'customersCount',
  'customersRevenueTotal',
  'competitorsCount',
  'nearestBranchDistanceMeters',
  'locationsCount',
  'customersPerSqKm',
] as const;

/** The deterministic score explanation that every report carries. */
export const SCORE_EXPLANATION =
  'The score is the sum of the enabled factors, where each factor contributes normalized value × weight ÷ 100. It is expressed on a 0 to 100 scale.';

/** The deterministic disclaimer that every report carries. */
export const REPORT_DISCLAIMER =
  'The score is a decision-support index derived from the configured scoring model and the available workspace data. It is not a probability, prediction, guarantee of revenue, or guarantee of business performance.';

export type { RawMetrics, ScoreContribution };
