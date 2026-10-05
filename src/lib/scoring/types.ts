/**
 * Phase 6 scoring wire and domain types.
 *
 * The database is authoritative: `run_location_analysis` computes the metrics,
 * the normalization, the weights and the final score, and this module only
 * describes the payload it returns. Nothing here re-derives a score.
 *
 * Scores are always integers or two-decimal numbers on a 0..100 scale and are
 * presented as `82 / 100`. They are never a probability, a confidence or a
 * prediction, and the qualitative band label is presentation only.
 */

export type ScoringModelStatus = 'draft' | 'active' | 'archived';
export type ScoringDirection = 'positive' | 'negative' | 'neutral';
export type ScoringNormalization = 'threshold' | 'min_max' | 'inverse_min_max';
export type ScoringMode = 'analysis' | 'comparison';

export interface ScoringThresholdPoint {
  value: number;
  score: number;
}

export interface ScoringFactorConfiguration {
  points?: ScoringThresholdPoint[];
  missing_score?: number;
  degenerate_score?: number;
}

export interface ScoringFactor {
  key: string;
  label: string;
  metric: string;
  weight: number;
  direction: ScoringDirection;
  normalization: ScoringNormalization;
  configuration: ScoringFactorConfiguration;
  enabled: boolean;
  sortOrder: number;
}

export interface ScoringModel {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: ScoringModelStatus;
  version: number;
  factors: ScoringFactor[];
  createdAt: string;
  updatedAt: string;
}

export interface ScoringModelSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  status: ScoringModelStatus;
  version: number;
  enabledFactorCount: number;
  enabledWeightTotal: number;
  updatedAt: string;
}

/** The authoritative raw metrics produced inside the radius by PostGIS. */
export interface RawMetrics {
  radiusMeters: number;
  areaSqKm: number;
  customersCount: number;
  /** Exact decimal text: never converted through a binary float. */
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
  nearestBranchId: string | null;
  nearestBranchName: string | null;
  nearestBranchDistanceMeters: number | null;
  categoryDistribution: Array<{ key: string; count: number }>;
}

export interface ScoreContribution {
  key: string;
  label: string;
  metric: string;
  direction: ScoringDirection;
  normalization: ScoringNormalization;
  weight: number;
  rawValue: number | null;
  rawText: string | null;
  normalized: number;
  contribution: number;
}

export interface AnalysisCandidateResult {
  candidateId: string;
  candidateName: string;
  longitude: number;
  latitude: number;
  rank: number;
  finalScore: number;
  rawMetrics: RawMetrics;
  normalizedMetrics: Record<string, number>;
  contributions: ScoreContribution[];
}

export interface AnalysisModelSnapshot {
  model: {
    id: string;
    name: string;
    description: string | null;
    status: ScoringModelStatus;
    version: number;
  };
  factors: ScoringFactor[];
}

export interface StoredAnalysis {
  id: string;
  workspaceId: string;
  projectId: string;
  mode: ScoringMode;
  radiusMeters: number;
  candidateCount: number;
  scoringModelId: string;
  modelName: string;
  modelVersion: number;
  dataSnapshotAt: string;
  createdAt: string;
  workspaceDataUpdatedAt: string | null;
  mayBeOutdated: boolean;
}

export interface ScoringAnalysisPayload {
  analysis: StoredAnalysis;
  model: AnalysisModelSnapshot;
  results: AnalysisCandidateResult[];
}

/**
 * A saved candidate location as the API returns it: a user-authored site name
 * and its coordinates. No customer data and no address ever travel with it.
 */
export interface SavedCandidate {
  id: string;
  name: string;
  longitude: number;
  latitude: number;
  createdAt: string;
}

export interface ScoringModelInput {
  name: string;
  description: string | null;
  status: ScoringModelStatus;
  factors: Array<{
    key: string;
    label: string;
    metric: string;
    weight: number;
    direction: ScoringDirection;
    normalization: ScoringNormalization;
    configuration: ScoringFactorConfiguration;
    enabled: boolean;
    sort_order: number;
  }>;
}

export interface ScoringRunRequest {
  projectId: string;
  candidateIds: string[];
  radiusMeters: number;
  scoringModelId: string;
  mode: ScoringMode;
}
