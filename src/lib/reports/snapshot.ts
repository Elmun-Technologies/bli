/**
 * Building, canonicalizing and hashing the immutable report snapshot.
 *
 * The snapshot is built once, when the report is created, from the stored
 * analysis payload the caller can see (`get_location_analysis`). It is then
 * frozen in the database (trigger) and its SHA-256 is stored next to it, so a
 * later regeneration can prove it renders exactly the same snapshot.
 *
 * Canonicalization: keys are sorted recursively, arrays keep their order, and
 * the result is serialized with JSON.stringify. The same snapshot therefore
 * always hashes to the same digest, while an accidental edit (a moved decimal, a
 * re-ordered factor, an added key) changes it.
 *
 * The hash is an integrity check, not a signature: it detects mutation, it does
 * not prove authorship.
 */

import { candidateLabel } from '@/lib/scoring/catalogue';
import type { ScoringAnalysisPayload } from '@/lib/scoring/types';

import {
  REPORT_DISCLAIMER,
  REPORT_SNAPSHOT_VERSION,
  SCORE_EXPLANATION,
  type ReportCandidateMetrics,
  type ReportSnapshot,
  type ReportType,
} from './types';

/** A deterministic, recursively key-sorted JSON form used for hashing. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** SHA-256 of the canonical form, lowercase hex. Never a signature. */
export async function hashCanonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The stored snapshot hash must equal the hash of the stored snapshot. Any
 * difference means the row was edited outside the application: generation is
 * refused instead of rendering numbers nobody can vouch for.
 */
export async function verifySnapshotHash(
  snapshot: unknown,
  expectedHash: string,
): Promise<boolean> {
  return (await hashCanonical(snapshot)) === expectedHash;
}

/**
 * The explicit aggregate projection. Every field is listed on purpose: a new
 * column in `raw_metrics` cannot leak into a report by accident, and no
 * customer-level value has a place to land.
 */
export function toReportMetrics(raw: ScoringAnalysisPayload['results'][number]['rawMetrics']): ReportCandidateMetrics {
  return {
    radiusMeters: raw.radiusMeters,
    areaSqKm: raw.areaSqKm,
    customersCount: raw.customersCount,
    customersRevenueTotal: raw.customersRevenueTotal,
    competitorsCount: raw.competitorsCount,
    branchesCount: raw.branchesCount,
    locationsCount: raw.locationsCount,
    customersPerSqKm: raw.customersPerSqKm,
    competitorsPerSqKm: raw.competitorsPerSqKm,
    revenuePerSqKm: raw.revenuePerSqKm,
    customerToCompetitorRatio: raw.customerToCompetitorRatio,
    branchDistanceScore: raw.branchDistanceScore,
    commercialPoiDensity: raw.commercialPoiDensity,
    nearestBranchName: raw.nearestBranchName,
    nearestBranchDistanceMeters: raw.nearestBranchDistanceMeters,
    categoryDistribution: raw.categoryDistribution.map((entry) => ({
      key: entry.key,
      count: entry.count,
    })),
  };
}

export interface ReportSnapshotInput {
  payload: ScoringAnalysisPayload;
  workspace: { id: string; name: string };
  project: { id: string; name: string };
  title: string;
  subtitle: string | null;
  companyName: string | null;
  logo: { path: string; mimeType: string; sizeBytes: number } | null;
  includeMap: boolean;
  mapProvider: string;
  mapAttribution: string;
  createdAt: string;
}

/** Report type of a stored analysis: one candidate is a site, two to five a comparison. */
export function reportTypeForMode(payload: ScoringAnalysisPayload): ReportType {
  return payload.analysis.mode === 'comparison' ? 'comparison' : 'single_location';
}

/**
 * Builds the immutable snapshot from a stored analysis payload. Nothing is
 * recomputed: the scores, ranks, metrics, contributions and factor definitions
 * are copied out of the payload exactly as the database stored them.
 */
export function buildReportSnapshot(input: ReportSnapshotInput): ReportSnapshot {
  const { payload } = input;
  const candidates = payload.results
    .slice()
    .sort((left, right) => left.rank - right.rank)
    .map((result, index) => ({
      id: result.candidateId,
      label: candidateLabel(index),
      name: result.candidateName,
      longitude: result.longitude,
      latitude: result.latitude,
      rank: result.rank,
      finalScore: result.finalScore,
      metrics: toReportMetrics(result.rawMetrics),
      normalizedMetrics: { ...result.normalizedMetrics },
      contributions: result.contributions.map((contribution) => ({ ...contribution })),
    }));

  return {
    version: REPORT_SNAPSHOT_VERSION,
    report: {
      type: reportTypeForMode(payload),
      title: input.title,
      subtitle: input.subtitle,
      createdAt: input.createdAt,
    },
    workspace: { id: input.workspace.id, name: input.workspace.name },
    project: { id: input.project.id, name: input.project.name },
    analysis: {
      id: payload.analysis.id,
      mode: payload.analysis.mode,
      radiusMeters: payload.analysis.radiusMeters,
      candidateCount: payload.analysis.candidateCount,
      modelId: payload.analysis.scoringModelId,
      modelName: payload.analysis.modelName,
      modelVersion: payload.analysis.modelVersion,
      dataSnapshotAt: payload.analysis.dataSnapshotAt,
      createdAt: payload.analysis.createdAt,
      workspaceDataUpdatedAt: payload.analysis.workspaceDataUpdatedAt,
      mayBeOutdated: payload.analysis.mayBeOutdated,
    },
    model: {
      id: payload.model.model.id,
      name: payload.model.model.name,
      version: payload.model.model.version,
      factors: payload.model.factors
        .slice()
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((factor) => ({
          key: factor.key,
          label: factor.label,
          metric: factor.metric,
          weight: factor.weight,
          direction: factor.direction,
          normalization: factor.normalization,
          enabled: factor.enabled,
          sortOrder: factor.sortOrder,
        })),
    },
    candidates,
    branding: {
      companyName: input.companyName,
      logo: input.logo,
    },
    map: {
      include: input.includeMap,
      provider: input.mapProvider,
      attribution: input.mapAttribution,
    },
    methodology: {
      scoreExplanation: SCORE_EXPLANATION,
      disclaimer: REPORT_DISCLAIMER,
    },
  };
}
