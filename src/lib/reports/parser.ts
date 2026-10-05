/**
 * The shipped parser for the Phase 7 report API.
 *
 * Same discipline as Phases 3-6: the server ships database-shaped JSON, this
 * module is the single place that turns it into typed objects, and it is strict
 * about the fields a report cannot do without (a missing score must never become
 * a silent zero) while tolerating additive fields so an installed client keeps
 * working.
 *
 * The contract smoke (`scripts/smoke-report-mode.ts`) feeds real HTTP responses
 * through exactly these functions.
 */

import type {
  ReportCandidateView,
  ReportComparisonRow,
  ReportFactorRow,
  ReportModelFactorView,
  ReportMetricRow,
  ReportSnapshot,
  ReportSnapshotFactor,
  ReportStatus,
  ReportSummary,
  ReportType,
  ReportViewModel,
} from './types';
import type { ScoringDirection, ScoringNormalization } from '@/lib/scoring/types';
import type { WorkspaceProjectSummary } from '@/lib/scoring/projects';

import { REPORT_SNAPSHOT_VERSION } from './types';

export class ReportPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportPayloadError';
  }
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReportPayloadError(`The server payload is missing "${field}".`);
  }
  return value as JsonObject;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ReportPayloadError(`The server payload is missing "${field}".`);
  }
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ReportPayloadError(`The server payload has an invalid "${field}".`);
  }
  return value;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return asString(value, field);
}

function asNumber(value: unknown, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ReportPayloadError(`The server payload has an invalid "${field}".`);
  }
  return numeric;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ReportPayloadError(`The server payload has an invalid "${field}".`);
  }
  return value;
}

const REPORT_TYPES: readonly ReportType[] = ['single_location', 'comparison'];
const REPORT_STATUSES: readonly ReportStatus[] = ['draft', 'generating', 'ready', 'failed'];

export function parseReportType(value: unknown): ReportType {
  if (!REPORT_TYPES.includes(value as ReportType)) {
    throw new ReportPayloadError(`The server payload has an invalid "report type".`);
  }
  return value as ReportType;
}

export function parseReportStatus(value: unknown): ReportStatus {
  if (!REPORT_STATUSES.includes(value as ReportStatus)) {
    throw new ReportPayloadError(`The server payload has an invalid "report status".`);
  }
  return value as ReportStatus;
}

/**
 * Whether a stored artifact exists. The API answers with a boolean
 * (`hasMap`/`hasLogo`); the database row carries only the path, so both shapes
 * are read and the path is never returned to a client.
 */
function parseArtifactPresence(declared: unknown, storagePath: unknown): boolean {
  if (typeof declared === 'boolean') return declared;
  return typeof storagePath === 'string' && storagePath.length > 0;
}

export function parseReportSummary(value: unknown): ReportSummary {
  const report = asObject(value, 'report');
  return {
    id: asString(report.id, 'report.id'),
    workspaceId: asString(report.workspace_id ?? report.workspaceId, 'report.workspace_id'),
    projectId: asString(report.project_id ?? report.projectId, 'report.project_id'),
    analysisId: asString(report.analysis_id ?? report.analysisId, 'report.analysis_id'),
    type: parseReportType(report.report_type ?? report.type),
    title: asString(report.title, 'report.title'),
    subtitle: asNullableString(report.subtitle, 'report.subtitle'),
    companyName: asNullableString(report.company_name ?? report.companyName, 'report.company_name'),
    status: parseReportStatus(report.status),
    snapshotHash: asNullableString(report.snapshot_hash ?? report.snapshotHash, 'report.snapshot_hash'),
    failureCode: asNullableString(report.failure_code ?? report.failureCode, 'report.failure_code'),
    hasMap: parseArtifactPresence(report.has_map ?? report.hasMap, report.map_storage_path),
    hasLogo: parseArtifactPresence(report.has_logo ?? report.hasLogo, report.logo_storage_path),
    createdBy: asString(report.created_by ?? report.createdBy, 'report.created_by'),
    createdAt: asString(report.created_at ?? report.createdAt, 'report.created_at'),
    updatedAt: asString(report.updated_at ?? report.updatedAt, 'report.updated_at'),
    generatedAt: asNullableString(report.generated_at ?? report.generatedAt, 'report.generated_at'),
  };
}

function parseDirection(value: unknown, field: string): ScoringDirection {
  if (value !== 'positive' && value !== 'negative' && value !== 'neutral') {
    throw new ReportPayloadError(`The server payload has an invalid "${field}".`);
  }
  return value;
}

function parseNormalization(value: unknown, field: string): ScoringNormalization {
  if (value !== 'threshold' && value !== 'min_max' && value !== 'inverse_min_max') {
    throw new ReportPayloadError(`The server payload has an invalid "${field}".`);
  }
  return value;
}

function parseNumberMap(value: unknown, field: string): Record<string, number> {
  const record = asObject(value, field);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = asNumber(entry, `${field}.${key}`);
  }
  return result;
}

/**
 * The immutable snapshot as stored in the database (snake_case columns). The
 * server returns it unchanged, so an unexpected key is simply ignored while a
 * missing required field fails loudly.
 */
export function parseReportSnapshot(value: unknown): ReportSnapshot {
  const snapshot = asObject(value, 'snapshot');
  const report = asObject(snapshot.report, 'snapshot.report');
  const workspace = asObject(snapshot.workspace, 'snapshot.workspace');
  const project = asObject(snapshot.project, 'snapshot.project');
  const analysis = asObject(snapshot.analysis, 'snapshot.analysis');
  const model = asObject(snapshot.model, 'snapshot.model');
  const branding = asObject(snapshot.branding ?? {}, 'snapshot.branding');
  const map = asObject(snapshot.map ?? {}, 'snapshot.map');
  const methodology = asObject(snapshot.methodology ?? {}, 'snapshot.methodology');

  const candidates = asArray(snapshot.candidates, 'snapshot.candidates').map((entry, index) => {
    const candidate = asObject(entry, `snapshot.candidates[${index}]`);
    const metrics = asObject(candidate.metrics, `snapshot.candidates[${index}].metrics`);
    const nearest = metrics.nearest_branch_distance_meters ?? metrics.nearestBranchDistanceMeters;

    return {
      id: asString(candidate.id, 'candidate.id'),
      label: asString(candidate.label, 'candidate.label'),
      name: asString(candidate.name, 'candidate.name'),
      longitude: asNumber(candidate.longitude, 'candidate.longitude'),
      latitude: asNumber(candidate.latitude, 'candidate.latitude'),
      rank: asNumber(candidate.rank, 'candidate.rank'),
      finalScore: asNumber(candidate.final_score ?? candidate.finalScore, 'candidate.final_score'),
      metrics: {
        radiusMeters: asNumber(metrics.radius_meters ?? metrics.radiusMeters, 'metrics.radius_meters'),
        areaSqKm: asNumber(metrics.area_sq_km ?? metrics.areaSqKm, 'metrics.area_sq_km'),
        customersCount: asNumber(metrics.customers_count ?? metrics.customersCount, 'metrics.customers_count'),
        customersRevenueTotal: asString(
          metrics.customers_revenue_total ?? metrics.customersRevenueTotal,
          'metrics.customers_revenue_total',
        ),
        competitorsCount: asNumber(metrics.competitors_count ?? metrics.competitorsCount, 'metrics.competitors_count'),
        branchesCount: asNumber(metrics.branches_count ?? metrics.branchesCount, 'metrics.branches_count'),
        locationsCount: asNumber(metrics.locations_count ?? metrics.locationsCount, 'metrics.locations_count'),
        customersPerSqKm: asNumber(metrics.customers_per_sq_km ?? metrics.customersPerSqKm, 'metrics.customers_per_sq_km'),
        competitorsPerSqKm: asNumber(metrics.competitors_per_sq_km ?? metrics.competitorsPerSqKm, 'metrics.competitors_per_sq_km'),
        revenuePerSqKm: asString(metrics.revenue_per_sq_km ?? metrics.revenuePerSqKm, 'metrics.revenue_per_sq_km'),
        customerToCompetitorRatio: asNumber(
          metrics.customer_to_competitor_ratio ?? metrics.customerToCompetitorRatio,
          'metrics.customer_to_competitor_ratio',
        ),
        branchDistanceScore: asNumber(
          metrics.branch_distance_score ?? metrics.branchDistanceScore,
          'metrics.branch_distance_score',
        ),
        commercialPoiDensity: asNumber(
          metrics.commercial_poi_density ?? metrics.commercialPoiDensity,
          'metrics.commercial_poi_density',
        ),
        nearestBranchName: asNullableString(
          metrics.nearest_branch_name ?? metrics.nearestBranchName,
          'metrics.nearest_branch_name',
        ),
        nearestBranchDistanceMeters:
          nearest === null || nearest === undefined
            ? null
            : asNumber(nearest, 'metrics.nearest_branch_distance_meters'),
        categoryDistribution: asArray(
          metrics.category_distribution ?? metrics.categoryDistribution ?? [],
          'metrics.category_distribution',
        ).map((category, categoryIndex) => {
          const record = asObject(category, `category[${categoryIndex}]`);
          return {
            key: asString(record.key, 'category.key'),
            count: asNumber(record.count, 'category.count'),
          };
        }),
      },
      normalizedMetrics: parseNumberMap(
        candidate.normalized_metrics ?? candidate.normalizedMetrics ?? {},
        'candidate.normalized_metrics',
      ),
      contributions: asArray(
        candidate.factor_contributions ?? candidate.contributions,
        'candidate.factor_contributions',
      ).map((entry, factorIndex) => {
        const contribution = asObject(entry, `contribution[${factorIndex}]`);
        const rawValue = contribution.raw_value ?? contribution.rawValue;
        return {
          key: asString(contribution.key, 'contribution.key'),
          label: asString(contribution.label, 'contribution.label'),
          metric: asString(contribution.metric, 'contribution.metric'),
          direction: parseDirection(contribution.direction, 'contribution.direction'),
          normalization: parseNormalization(contribution.normalization, 'contribution.normalization'),
          weight: asNumber(contribution.weight, 'contribution.weight'),
          rawValue: rawValue === null || rawValue === undefined ? null : asNumber(rawValue, 'contribution.raw_value'),
          rawText: asNullableString(contribution.raw_text ?? contribution.rawText, 'contribution.raw_text'),
          normalized: asNumber(contribution.normalized, 'contribution.normalized'),
          contribution: asNumber(contribution.contribution, 'contribution.contribution'),
        };
      }),
    };
  });

  const reportType = parseReportType(report.type);
  const version = asNumber(snapshot.version, 'snapshot.version');
  if (version !== REPORT_SNAPSHOT_VERSION) {
    // A snapshot of an unknown revision may mean something this renderer does
    // not understand; refuse it instead of printing numbers nobody can vouch for.
    throw new ReportPayloadError(`Unsupported report snapshot version: ${version}.`);
  }

  // A report never mixes analyses, and its type fixes how many candidates it may
  // carry: one for a single-location report, two to five for a comparison. A
  // stored snapshot that violates this is refused instead of being rendered.
  if (reportType === 'single_location' && candidates.length !== 1) {
    throw new ReportPayloadError('A single-location report must carry exactly one candidate.');
  }
  if (reportType === 'comparison' && (candidates.length < 2 || candidates.length > 5)) {
    throw new ReportPayloadError('A comparison report must carry between two and five candidates.');
  }

  return {
    version,
    report: {
      type: reportType,
      title: asString(report.title, 'snapshot.report.title'),
      subtitle: asNullableString(report.subtitle, 'snapshot.report.subtitle'),
      createdAt: asString(report.created_at ?? report.createdAt, 'snapshot.report.created_at'),
    },
    workspace: { id: asString(workspace.id, 'workspace.id'), name: asString(workspace.name, 'workspace.name') },
    project: { id: asString(project.id, 'project.id'), name: asString(project.name, 'project.name') },
    analysis: {
      id: asString(analysis.id, 'analysis.id'),
      mode: analysis.mode === 'comparison' ? 'comparison' : 'analysis',
      radiusMeters: asNumber(analysis.radius_meters ?? analysis.radiusMeters, 'analysis.radius_meters'),
      candidateCount: asNumber(analysis.candidate_count ?? analysis.candidateCount, 'analysis.candidate_count'),
      modelId: asString(analysis.model_id ?? analysis.modelId, 'analysis.model_id'),
      modelName: asString(analysis.model_name ?? analysis.modelName, 'analysis.model_name'),
      modelVersion: asNumber(analysis.model_version ?? analysis.modelVersion, 'analysis.model_version'),
      dataSnapshotAt: asString(analysis.data_snapshot_at ?? analysis.dataSnapshotAt, 'analysis.data_snapshot_at'),
      createdAt: asString(analysis.created_at ?? analysis.createdAt, 'analysis.created_at'),
      workspaceDataUpdatedAt: asNullableString(
        analysis.workspace_data_updated_at ?? analysis.workspaceDataUpdatedAt,
        'analysis.workspace_data_updated_at',
      ),
      mayBeOutdated:
        (analysis.may_be_outdated ?? analysis.mayBeOutdated) === true,
    },
    model: {
      id: asString(model.id, 'model.id'),
      name: asString(model.name, 'model.name'),
      version: asNumber(model.version, 'model.version'),
      factors: asArray(model.factors, 'model.factors').map((entry, index) => {
        const factor = asObject(entry, `model.factors[${index}]`);
        const parsed: ReportSnapshotFactor = {
          key: asString(factor.key, 'factor.key'),
          label: asString(factor.label, 'factor.label'),
          metric: asString(factor.metric, 'factor.metric'),
          weight: asNumber(factor.weight, 'factor.weight'),
          direction: parseDirection(factor.direction, 'factor.direction'),
          normalization: parseNormalization(factor.normalization, 'factor.normalization'),
          enabled: factor.enabled !== false,
          sortOrder: asNumber(factor.sort_order ?? factor.sortOrder ?? index, 'factor.sort_order'),
        };
        return parsed;
      }),
    },
    candidates,
    branding: {
      companyName: asNullableString(branding.company_name ?? branding.companyName, 'branding.company_name'),
      logo:
        branding.logo === null || branding.logo === undefined
          ? null
          : (() => {
              const logo = asObject(branding.logo, 'branding.logo');
              return {
                path: asString(logo.path, 'branding.logo.path'),
                mimeType: asString(logo.mime_type ?? logo.mimeType, 'branding.logo.mime_type'),
                sizeBytes: asNumber(logo.size_bytes ?? logo.sizeBytes, 'branding.logo.size_bytes'),
              };
            })(),
    },
    map: {
      include: map.include !== false,
      provider: asString(map.provider ?? 'none', 'map.provider'),
      attribution: asString(map.attribution ?? '', 'map.attribution'),
    },
    methodology: {
      scoreExplanation: asString(methodology.score_explanation ?? methodology.scoreExplanation, 'methodology.score_explanation'),
      disclaimer: asString(methodology.disclaimer, 'methodology.disclaimer'),
    },
  };
}

function parseMetricRow(value: unknown, field: string): ReportMetricRow {
  const row = asObject(value, field);
  return {
    key: asString(row.key, `${field}.key`),
    label: asString(row.label, `${field}.label`),
    valueText: asString(row.valueText, `${field}.valueText`),
  };
}

function parseFactorRow(value: unknown, field: string): ReportFactorRow {
  const row = asObject(value, field);
  return {
    key: asString(row.key, `${field}.key`),
    label: asString(row.label, `${field}.label`),
    metricLabel: asString(row.metricLabel, `${field}.metricLabel`),
    rawText: asString(row.rawText, `${field}.rawText`),
    normalizedText: asString(row.normalizedText, `${field}.normalizedText`),
    weightText: asString(row.weightText, `${field}.weightText`),
    contributionText: asString(row.contributionText, `${field}.contributionText`),
    direction: parseDirection(row.direction, `${field}.direction`),
    normalizationLabel: asString(row.normalizationLabel, `${field}.normalizationLabel`),
    enabled: row.enabled !== false,
  };
}

function parseModelFactorView(value: unknown, field: string): ReportModelFactorView {
  const row = asObject(value, field);
  return {
    key: asString(row.key ?? row.label, `${field}.key`),
    label: asString(row.label, `${field}.label`),
    weightText: asString(row.weightText, `${field}.weightText`),
    directionLabel: asString(row.directionLabel, `${field}.directionLabel`),
    normalizationLabel: asString(row.normalizationLabel, `${field}.normalizationLabel`),
    enabled: row.enabled !== false,
  };
}

function parseCandidateView(value: unknown, index: number): ReportCandidateView {
  const candidate = asObject(value, `candidates[${index}]`);
  const strengthRows = (entry: unknown, field: string) =>
    asArray(entry ?? [], field).map((row, rowIndex) => {
      const record = asObject(row, `${field}[${rowIndex}]`);
      return {
        label: asString(record.label, `${field}.label`),
        contributionText: asString(record.contributionText, `${field}.contributionText`),
      };
    });

  return {
    id: asString(candidate.id, 'candidate.id'),
    label: asString(candidate.label, 'candidate.label'),
    name: asString(candidate.name, 'candidate.name'),
    rank: asNumber(candidate.rank, 'candidate.rank'),
    scoreText: asString(candidate.scoreText, 'candidate.scoreText'),
    band: asString(candidate.band, 'candidate.band'),
    coordinatesText: asString(candidate.coordinatesText, 'candidate.coordinatesText'),
    metrics: asArray(candidate.metrics ?? [], 'candidate.metrics').map((row, rowIndex) =>
      parseMetricRow(row, `candidate.metrics[${rowIndex}]`),
    ),
    factors: asArray(candidate.factors ?? [], 'candidate.factors').map((row, rowIndex) =>
      parseFactorRow(row, `candidate.factors[${rowIndex}]`),
    ),
    strengths: strengthRows(candidate.strengths, 'candidate.strengths'),
    considerations: strengthRows(candidate.considerations, 'candidate.considerations'),
  };
}

function parseComparisonRow(value: unknown, index: number): ReportComparisonRow {
  const row = asObject(value, `comparison.rows[${index}]`);
  return {
    rank: asNumber(row.rank, 'comparison.rank'),
    label: asString(row.label, 'comparison.label'),
    name: asString(row.name, 'comparison.name'),
    scoreText: asString(row.scoreText, 'comparison.scoreText'),
    customersText: asString(row.customersText, 'comparison.customersText'),
    revenueText: asString(row.revenueText, 'comparison.revenueText'),
    competitorsText: asString(row.competitorsText, 'comparison.competitorsText'),
    nearestBranchText: asString(row.nearestBranchText, 'comparison.nearestBranchText'),
    poiText: asString(row.poiText, 'comparison.poiText'),
    densityText: asString(row.densityText, 'comparison.densityText'),
  };
}

export function parseReportViewModel(value: unknown): ReportViewModel {
  const body = asObject(value, 'viewModel');
  const report = asObject(body.report, 'viewModel.report');
  const workspace = asObject(body.workspace, 'viewModel.workspace');
  const project = asObject(body.project, 'viewModel.project');
  const analysis = asObject(body.analysis, 'viewModel.analysis');
  const model = asObject(body.model, 'viewModel.model');
  const summary = asObject(body.summary, 'viewModel.summary');
  const freshness = asObject(body.freshness, 'viewModel.freshness');
  const map = asObject(body.map, 'viewModel.map');
  const branding = asObject(body.branding, 'viewModel.branding');
  const methodology = asObject(body.methodology, 'viewModel.methodology');
  const top = summary.topCandidate === null || summary.topCandidate === undefined
    ? null
    : asObject(summary.topCandidate, 'viewModel.summary.topCandidate');

  return {
    report: {
      id: asNullableString(report.id, 'viewModel.report.id'),
      type: parseReportType(report.type),
      typeLabel: asString(report.typeLabel, 'viewModel.report.typeLabel'),
      title: asString(report.title, 'viewModel.report.title'),
      subtitle: asNullableString(report.subtitle, 'viewModel.report.subtitle'),
      status: parseReportStatus(report.status),
      createdAtText: asString(report.createdAtText, 'viewModel.report.createdAtText'),
      generatedAtText: asNullableString(report.generatedAtText, 'viewModel.report.generatedAtText'),
      snapshotHash: asNullableString(report.snapshotHash, 'viewModel.report.snapshotHash'),
    },
    workspace: { id: asString(workspace.id, 'viewModel.workspace.id'), name: asString(workspace.name, 'viewModel.workspace.name') },
    project: { id: asString(project.id, 'viewModel.project.id'), name: asString(project.name, 'viewModel.project.name') },
    analysis: {
      id: asString(analysis.id, 'viewModel.analysis.id'),
      radiusMeters: asNumber(analysis.radiusMeters, 'viewModel.analysis.radiusMeters'),
      radiusText: asString(analysis.radiusText, 'viewModel.analysis.radiusText'),
      candidateCount: asNumber(analysis.candidateCount, 'viewModel.analysis.candidateCount'),
      modelName: asString(analysis.modelName, 'viewModel.analysis.modelName'),
      modelVersion: asNumber(analysis.modelVersion, 'viewModel.analysis.modelVersion'),
      analysisDateText: asString(analysis.analysisDateText, 'viewModel.analysis.analysisDateText'),
      dataSnapshotText: asString(analysis.dataSnapshotText, 'viewModel.analysis.dataSnapshotText'),
    },
    model: {
      name: asString(model.name, 'viewModel.model.name'),
      version: asNumber(model.version, 'viewModel.model.version'),
      factors: asArray(model.factors ?? [], 'viewModel.model.factors').map((row, index) =>
        parseModelFactorView(row, `viewModel.model.factors[${index}]`),
      ),
    },
    summary: {
      headline: asString(summary.headline, 'viewModel.summary.headline'),
      paragraphs: asArray(summary.paragraphs ?? [], 'viewModel.summary.paragraphs').map((entry, index) =>
        asString(entry, `viewModel.summary.paragraphs[${index}]`),
      ),
      keyPoints: asArray(summary.keyPoints ?? [], 'viewModel.summary.keyPoints').map((entry, index) =>
        asString(entry, `viewModel.summary.keyPoints[${index}]`),
      ),
      topCandidate: top
        ? {
            label: asString(top.label, 'topCandidate.label'),
            name: asString(top.name, 'topCandidate.name'),
            scoreText: asString(top.scoreText, 'topCandidate.scoreText'),
            band: asString(top.band, 'topCandidate.band'),
            rank: asNumber(top.rank, 'topCandidate.rank'),
          }
        : null,
    },
    ranking: asArray(body.ranking ?? [], 'viewModel.ranking').map((entry, index) => {
      const row = asObject(entry, `viewModel.ranking[${index}]`);
      return {
        label: asString(row.label, 'ranking.label'),
        name: asString(row.name, 'ranking.name'),
        rank: asNumber(row.rank, 'ranking.rank'),
        scoreText: asString(row.scoreText, 'ranking.scoreText'),
        band: asString(row.band, 'ranking.band'),
      };
    }),
    candidates: asArray(body.candidates, 'viewModel.candidates').map(parseCandidateView),
    comparison:
      body.comparison === null || body.comparison === undefined
        ? null
        : {
            rows: asArray(
              asObject(body.comparison, 'viewModel.comparison').rows,
              'viewModel.comparison.rows',
            ).map(parseComparisonRow),
          },
    methodology: {
      modelName: asString(methodology.modelName, 'viewModel.methodology.modelName'),
      modelVersion: asNumber(methodology.modelVersion, 'viewModel.methodology.modelVersion'),
      radiusText: asString(methodology.radiusText, 'viewModel.methodology.radiusText'),
      factors: asArray(methodology.factors ?? [], 'viewModel.methodology.factors').map((entry, index) =>
        parseModelFactorView(entry, `viewModel.methodology.factors[${index}]`),
      ),
      scoreExplanation: asString(methodology.scoreExplanation, 'viewModel.methodology.scoreExplanation'),
      disclaimer: asString(methodology.disclaimer, 'viewModel.methodology.disclaimer'),
    },
    freshness: {
      analysisText: asString(freshness.analysisText, 'viewModel.freshness.analysisText'),
      dataSnapshotText: asString(freshness.dataSnapshotText, 'viewModel.freshness.dataSnapshotText'),
      generatedText: asString(freshness.generatedText, 'viewModel.freshness.generatedText'),
      note: asNullableString(freshness.note, 'viewModel.freshness.note'),
    },
    map: {
      available: asBoolean(map.available, 'viewModel.map.available'),
      providerLabel: asString(map.providerLabel, 'viewModel.map.providerLabel'),
      attribution: asString(map.attribution, 'viewModel.map.attribution'),
      note: asNullableString(map.note, 'viewModel.map.note'),
    },
    branding: {
      companyName: asNullableString(branding.companyName, 'viewModel.branding.companyName'),
      logoAvailable: asBoolean(branding.logoAvailable, 'viewModel.branding.logoAvailable'),
    },
  };
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

export interface ReportListResponse {
  projects: WorkspaceProjectSummary[];
  projectId: string | null;
  reports: ReportSummary[];
}

export function parseReportListResponse(value: unknown): ReportListResponse {
  const body = asObject(value, 'reports');
  const projectId = body.projectId;
  return {
    projects: parseWorkspaceProjectList(body.projects),
    projectId: projectId === null || projectId === undefined ? null : asString(projectId, 'reports.projectId'),
    reports: asArray(body.reports, 'reports.reports').map(parseReportSummary),
  };
}

export interface ReportDetailResponse {
  report: ReportSummary;
  viewModel: ReportViewModel | null;
}

export function parseReportDetailResponse(value: unknown): ReportDetailResponse {
  const body = asObject(value, 'report');
  return {
    report: parseReportSummary(body.report),
    viewModel:
      body.viewModel === null || body.viewModel === undefined
        ? null
        : parseReportViewModel(body.viewModel),
  };
}

export function parseReportMutationResponse(value: unknown): ReportSummary {
  const body = asObject(value, 'report');
  return parseReportSummary(body.report);
}
