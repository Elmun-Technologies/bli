/**
 * The shipped parser for the scoring API payloads.
 *
 * This module is the single place that turns the snake_case JSON the database
 * returns into the typed objects the interface uses. It is deliberately strict
 * about the fields a score needs (a missing `final_score` must never become a
 * silent zero) and tolerant about additive fields, so the server can grow
 * without breaking an installed client.
 *
 * The contract smoke in `scripts/smoke-scoring-mode.ts` feeds a real server
 * response through exactly this parser.
 */

import type {
  AnalysisCandidateResult,
  AnalysisModelSnapshot,
  RawMetrics,
  SavedCandidate,
  ScoreContribution,
  ScoringAnalysisPayload,
  ScoringDirection,
  ScoringFactor,
  ScoringFactorConfiguration,
  ScoringModel,
  ScoringModelStatus,
  ScoringModelSummary,
  ScoringMode,
  ScoringNormalization,
  ScoringThresholdPoint,
  StoredAnalysis,
} from './types';
import type { WorkspaceProjectSummary } from './projects';

export class ScoringPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringPayloadError';
  }
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScoringPayloadError(`The server payload is missing "${field}".`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ScoringPayloadError(`The server payload is missing "${field}".`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ScoringPayloadError(`The server payload has an invalid "${field}".`);
  }
  return value;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown, field: string): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new ScoringPayloadError(`The server payload has an invalid "${field}".`);
  }
  return numeric;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ScoringPayloadError(`The server payload has an invalid "${field}".`);
  }
  return value;
}

const STATUSES: readonly ScoringModelStatus[] = ['draft', 'active', 'archived'];
const DIRECTIONS: readonly ScoringDirection[] = ['positive', 'negative', 'neutral'];
const NORMALIZATIONS: readonly ScoringNormalization[] = ['threshold', 'min_max', 'inverse_min_max'];
const MODES: readonly ScoringMode[] = ['analysis', 'comparison'];

function asStatus(value: unknown): ScoringModelStatus {
  return STATUSES.includes(value as ScoringModelStatus) ? (value as ScoringModelStatus) : 'draft';
}

function asDirection(value: unknown): ScoringDirection {
  if (!DIRECTIONS.includes(value as ScoringDirection)) {
    throw new ScoringPayloadError('The server payload has an unsupported factor direction.');
  }
  return value as ScoringDirection;
}

function asNormalization(value: unknown): ScoringNormalization {
  if (!NORMALIZATIONS.includes(value as ScoringNormalization)) {
    throw new ScoringPayloadError('The server payload has an unsupported normalization method.');
  }
  return value as ScoringNormalization;
}

function parseConfig(value: unknown): ScoringFactorConfiguration {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as JsonObject;
  const configuration: ScoringFactorConfiguration = {};
  if (Array.isArray(raw.points)) {
    configuration.points = raw.points.flatMap((point): ScoringThresholdPoint[] => {
      const entry = point as JsonObject;
      const numericValue = asNullableNumber(entry?.value);
      const numericScore = asNullableNumber(entry?.score);
      return numericValue === null || numericScore === null
        ? []
        : [{ value: numericValue, score: numericScore }];
    });
  }
  const missing = asNullableNumber(raw.missing_score);
  if (missing !== null) configuration.missing_score = missing;
  const degenerate = asNullableNumber(raw.degenerate_score);
  if (degenerate !== null) configuration.degenerate_score = degenerate;
  return configuration;
}

export function parseScoringFactor(value: unknown): ScoringFactor {
  const factor = asObject(value, 'factors[].key');
  return {
    key: asString(factor.key, 'factors[].key'),
    label: asString(factor.label, 'factors[].label'),
    metric: asString(factor.metric, 'factors[].metric'),
    weight: asNumber(factor.weight, 'factors[].weight'),
    direction: asDirection(factor.direction),
    normalization: asNormalization(factor.normalization),
    configuration: parseConfig(factor.configuration),
    enabled: factor.enabled === undefined ? true : asBoolean(factor.enabled, 'factors[].enabled'),
    sortOrder: asNumber(factor.sort_order ?? factor.sortOrder ?? 0, 'factors[].sort_order'),
  };
}

export function parseScoringModel(value: unknown): ScoringModel {
  const model = asObject(value, 'model');
  return {
    id: asString(model.id, 'model.id'),
    workspaceId: asString(model.workspace_id ?? model.workspaceId, 'model.workspace_id'),
    name: asString(model.name, 'model.name'),
    description: asNullableString(model.description),
    status: asStatus(model.status),
    version: asNumber(model.version, 'model.version'),
    factors: asArray(model.factors ?? [], 'model.factors').map(parseScoringFactor),
    createdAt: asString(model.created_at ?? model.createdAt, 'model.created_at'),
    updatedAt: asString(model.updated_at ?? model.updatedAt, 'model.updated_at'),
  };
}

function parseSummary(value: unknown): ScoringModelSummary {
  const model = asObject(value, 'models[]');
  return {
    id: asString(model.id, 'models[].id'),
    workspaceId: asString(model.workspace_id ?? model.workspaceId, 'models[].workspace_id'),
    name: asString(model.name, 'models[].name'),
    description: asNullableString(model.description),
    status: asStatus(model.status),
    version: asNumber(model.version, 'models[].version'),
    // The API returns camelCase summaries; the database shape is accepted too so
    // the same parser can read either side of the wire.
    enabledFactorCount: asNumber(
      model.enabledFactorCount ?? model.enabled_factor_count ?? 0,
      'models[].enabled_factor_count',
    ),
    enabledWeightTotal: asNumber(
      model.enabledWeightTotal ?? model.enabled_weight_total ?? 0,
      'models[].enabled_weight_total',
    ),
    updatedAt: asString(model.updated_at ?? model.updatedAt, 'models[].updated_at'),
  };
}

export function parseScoringModelList(value: unknown): ScoringModelSummary[] {
  const body = asObject(value, 'models');
  return asArray(body.models, 'models').map(parseSummary);
}

export function parseRawMetrics(value: unknown): RawMetrics {
  const raw = asObject(value, 'raw_metrics');
  const distribution = Array.isArray(raw.category_distribution) ? raw.category_distribution : [];
  return {
    radiusMeters: asNumber(raw.radius_meters, 'raw_metrics.radius_meters'),
    areaSqKm: asNumber(raw.area_sq_km, 'raw_metrics.area_sq_km'),
    customersCount: asNumber(raw.customers_count, 'raw_metrics.customers_count'),
    customersRevenueTotal: String(raw.customers_revenue_total ?? '0'),
    competitorsCount: asNumber(raw.competitors_count, 'raw_metrics.competitors_count'),
    branchesCount: asNumber(raw.branches_count ?? 0, 'raw_metrics.branches_count'),
    locationsCount: asNumber(raw.locations_count, 'raw_metrics.locations_count'),
    customersPerSqKm: asNumber(raw.customers_per_sq_km ?? 0, 'raw_metrics.customers_per_sq_km'),
    competitorsPerSqKm: asNumber(raw.competitors_per_sq_km ?? 0, 'raw_metrics.competitors_per_sq_km'),
    revenuePerSqKm: String(raw.revenue_per_sq_km ?? '0'),
    customerToCompetitorRatio: asNumber(
      raw.customer_to_competitor_ratio ?? 0,
      'raw_metrics.customer_to_competitor_ratio',
    ),
    branchDistanceScore: asNumber(raw.branch_distance_score ?? 0, 'raw_metrics.branch_distance_score'),
    commercialPoiDensity: asNumber(raw.commercial_poi_density ?? 0, 'raw_metrics.commercial_poi_density'),
    nearestBranchId: asNullableString(raw.nearest_branch_id),
    nearestBranchName: asNullableString(raw.nearest_branch_name),
    nearestBranchDistanceMeters: asNullableNumber(raw.nearest_branch_distance_meters),
    categoryDistribution: distribution.flatMap((entry) => {
      const record = entry as JsonObject;
      const key = asNullableString(record?.key ?? record?.category);
      const count = asNullableNumber(record?.count);
      return key === null || count === null ? [] : [{ key, count }];
    }),
  };
}

function parseContribution(value: unknown): ScoreContribution {
  const contribution = asObject(value, 'factor_contributions[]');
  return {
    key: asString(contribution.key, 'factor_contributions[].key'),
    label: asString(contribution.label, 'factor_contributions[].label'),
    metric: asString(contribution.metric, 'factor_contributions[].metric'),
    direction: asDirection(contribution.direction),
    normalization: asNormalization(contribution.normalization),
    weight: asNumber(contribution.weight, 'factor_contributions[].weight'),
    rawValue: asNullableNumber(contribution.raw_value),
    rawText: asNullableString(contribution.raw_text),
    normalized: asNumber(contribution.normalized, 'factor_contributions[].normalized'),
    contribution: asNumber(contribution.contribution, 'factor_contributions[].contribution'),
  };
}

export function parseAnalysisResult(value: unknown): AnalysisCandidateResult {
  const result = asObject(value, 'results[]');
  const normalized = asObject(result.normalized_metrics ?? {}, 'results[].normalized_metrics');
  return {
    candidateId: asString(result.candidate_id, 'results[].candidate_id'),
    candidateName: asString(result.candidate_name, 'results[].candidate_name'),
    longitude: asNumber(result.longitude, 'results[].longitude'),
    latitude: asNumber(result.latitude, 'results[].latitude'),
    rank: asNumber(result.rank, 'results[].rank'),
    finalScore: asNumber(result.final_score, 'results[].final_score'),
    rawMetrics: parseRawMetrics(result.raw_metrics),
    normalizedMetrics: Object.fromEntries(
      Object.entries(normalized).map(([key, entry]) => [key, asNumber(entry, `normalized_metrics.${key}`)]),
    ),
    contributions: asArray(result.factor_contributions, 'results[].factor_contributions').map(
      parseContribution,
    ),
  };
}

function parseModelSnapshot(value: unknown): AnalysisModelSnapshot {
  const snapshot = asObject(value, 'model');
  const model = asObject(snapshot.model, 'model.model');
  return {
    model: {
      id: asString(model.id, 'model.model.id'),
      name: asString(model.name, 'model.model.name'),
      description: asNullableString(model.description),
      status: asStatus(model.status),
      version: asNumber(model.version, 'model.model.version'),
    },
    factors: asArray(snapshot.factors ?? [], 'model.factors').map(parseScoringFactor),
  };
}

export function parseScoringAnalysis(value: unknown): ScoringAnalysisPayload {
  const body = asObject(value, 'analysis');
  const analysis = asObject(body.analysis, 'analysis.analysis');
  const storedAnalysis: StoredAnalysis = {
    id: asString(analysis.id, 'analysis.id'),
    workspaceId: asString(analysis.workspace_id, 'analysis.workspace_id'),
    projectId: asString(analysis.project_id, 'analysis.project_id'),
    mode: MODES.includes(analysis.mode as ScoringMode) ? (analysis.mode as ScoringMode) : 'analysis',
    radiusMeters: asNumber(analysis.radius_meters, 'analysis.radius_meters'),
    candidateCount: asNumber(analysis.candidate_count, 'analysis.candidate_count'),
    scoringModelId: asString(analysis.scoring_model_id, 'analysis.scoring_model_id'),
    modelName: asString(analysis.model_name, 'analysis.model_name'),
    modelVersion: asNumber(analysis.model_version, 'analysis.model_version'),
    dataSnapshotAt: asString(analysis.data_snapshot_at, 'analysis.data_snapshot_at'),
    createdAt: asString(analysis.created_at, 'analysis.created_at'),
    workspaceDataUpdatedAt: asNullableString(analysis.workspace_data_updated_at),
    mayBeOutdated: analysis.may_be_outdated === true,
  };

  return {
    analysis: storedAnalysis,
    model: parseModelSnapshot(body.model),
    results: asArray(body.results ?? [], 'analysis.results').map(parseAnalysisResult),
  };
}

export function parseSavedCandidate(value: unknown): SavedCandidate {
  const candidate = asObject(value, 'candidate');
  return {
    id: asString(candidate.id, 'candidate.id'),
    name: asString(candidate.name, 'candidate.name'),
    longitude: asNumber(candidate.longitude, 'candidate.longitude'),
    latitude: asNumber(candidate.latitude, 'candidate.latitude'),
    createdAt: asString(candidate.created_at ?? candidate.createdAt, 'candidate.created_at'),
  };
}

export function parseSavedCandidateList(value: unknown): SavedCandidate[] {
  const rows = Array.isArray(value) ? value : asArray(asObject(value, 'candidates').candidates, 'candidates');
  return rows.map((row) => {
    const record = row as JsonObject;
    return parseSavedCandidate(record?.candidate ?? record);
  });
}

export function parseWorkspaceProject(value: unknown): WorkspaceProjectSummary {
  const project = asObject(value, 'project');
  return {
    id: asString(project.id, 'project.id'),
    name: asString(project.name, 'project.name'),
    status: asString(project.status ?? 'active', 'project.status'),
  };
}

export function parseWorkspaceProjectList(value: unknown): WorkspaceProjectSummary[] {
  const rows = Array.isArray(value) ? value : asArray(asObject(value, 'projects').projects, 'projects');
  return rows.map(parseWorkspaceProject);
}

/**
 * A project id is either an explicit selection or `null` for the zero-project
 * state; the server never invents one, and the interface never guesses one.
 */
function asProjectIdOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

/**
 * The candidates read carries the workspace's selectable projects plus the
 * project that answered, so the interface can render the project selector and
 * the project-scoped list from one response. `projectId` is null only when the
 * workspace has no project at all.
 */
export interface CandidateListResponse {
  projects: WorkspaceProjectSummary[];
  projectId: string | null;
  candidates: SavedCandidate[];
}

export function parseCandidateListResponse(value: unknown): CandidateListResponse {
  const body = asObject(value, 'candidates');
  return {
    projects: parseWorkspaceProjectList(body.projects),
    projectId: asProjectIdOrNull(body.projectId, 'candidates.projectId'),
    candidates: parseSavedCandidateList(body),
  };
}

/**
 * The stored-analysis list returns one row per analysis, each holding the same
 * payload shape as a single read, so both go through the same parser.
 */
export interface StoredAnalysisListResponse {
  projectId: string | null;
  analyses: ScoringAnalysisPayload[];
}

export function parseStoredAnalysisListResponse(value: unknown): StoredAnalysisListResponse {
  const body = asObject(value, 'analyses');
  return {
    projectId: asProjectIdOrNull(body.projectId, 'analyses.projectId'),
    analyses: parseStoredAnalysisList(body),
  };
}

export function parseStoredAnalysisList(value: unknown): ScoringAnalysisPayload[] {
  const rows = Array.isArray(value) ? value : asArray(asObject(value, 'analyses').analyses, 'analyses');
  return rows.map((row) => {
    const record = row as JsonObject;
    return parseScoringAnalysis(record?.analysis ?? record);
  });
}
