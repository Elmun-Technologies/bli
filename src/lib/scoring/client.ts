/**
 * Browser-side scoring API client.
 *
 * Only relative URLs, only the caller's own session, and never a workspace id
 * taken from anywhere but the route the page was opened with. Every call is
 * validated again on the server; nothing here is a security decision.
 */

import {
  parseCandidateListResponse,
  parseSavedCandidate,
  parseScoringAnalysis,
  parseScoringModel,
  parseScoringModelList,
  parseStoredAnalysisListResponse,
  parseWorkspaceProject,
  parseWorkspaceProjectList,
  type CandidateListResponse,
  type StoredAnalysisListResponse,
} from './payload';
import type { WorkspaceProjectSummary } from './projects';
import type {
  SavedCandidate,
  ScoringAnalysisPayload,
  ScoringMode,
  ScoringModel,
  ScoringModelInput,
  ScoringModelSummary,
  ScoringRunRequest,
} from './types';

export interface ScoringApiErrorBody {
  code: string;
  message: string;
}

export class ScoringApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ScoringApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  workspaceId: string,
  path: string,
  parse: (payload: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const error = (payload as { error?: ScoringApiErrorBody } | null)?.error;
    throw new ScoringApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'The scoring request failed.',
    );
  }

  return parse(payload);
}

export function listScoringModels(workspaceId: string): Promise<ScoringModelSummary[]> {
  return request(workspaceId, '/scoring-models', parseScoringModelList);
}

export function getScoringModel(workspaceId: string, modelId: string): Promise<ScoringModel> {
  return request(workspaceId, `/scoring-models/${encodeURIComponent(modelId)}`, (payload) =>
    parseScoringModel((payload as { model: unknown }).model),
  );
}

export function createScoringModel(
  workspaceId: string,
  input: ScoringModelInput,
): Promise<ScoringModel> {
  return request(
    workspaceId,
    '/scoring-models',
    (payload) => parseScoringModel((payload as { model: unknown }).model),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export function updateScoringModel(
  workspaceId: string,
  modelId: string,
  input: ScoringModelInput,
): Promise<{ model: ScoringModel; revision: number }> {
  return request(
    workspaceId,
    `/scoring-models/${encodeURIComponent(modelId)}`,
    (payload) => {
      const body = payload as { model: unknown; revision?: unknown };
      return {
        model: parseScoringModel(body.model),
        revision: typeof body.revision === 'number' ? body.revision : 0,
      };
    },
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

/**
 * Projects of the caller's own workspace. Used by the explicit project selector;
 * the server lists only what the caller's membership may see.
 */
export function listWorkspaceProjects(workspaceId: string): Promise<WorkspaceProjectSummary[]> {
  return request(workspaceId, '/projects', parseWorkspaceProjectList);
}

/** Creates a project explicitly. Owner or admin only, enforced by the server. */
export function createWorkspaceProject(
  workspaceId: string,
  input: { name: string; description?: string | null },
): Promise<WorkspaceProjectSummary> {
  return request(
    workspaceId,
    '/projects',
    (payload) => parseWorkspaceProject((payload as { project: unknown }).project),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: input.name, description: input.description ?? null }),
    },
  );
}

/**
 * Saved candidate locations of one explicitly selected project. The response
 * also names the projects the caller may select, plus the project that answered,
 * so the interface never guesses an identifier and can never name a foreign
 * project. With several projects the server refuses an unnamed project instead
 * of picking one; `projectId` is null only for the zero-project empty state.
 */
export function listSavedCandidates(
  workspaceId: string,
  projectId: string | null,
): Promise<CandidateListResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return request(workspaceId, `/candidates${query}`, parseCandidateListResponse);
}

export function saveCandidate(
  workspaceId: string,
  input: { projectId: string; name: string; longitude: number; latitude: number },
): Promise<SavedCandidate> {
  return request(workspaceId, '/candidates', (payload) =>
    parseSavedCandidate((payload as { candidate: unknown }).candidate),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export function runAnalysis(
  workspaceId: string,
  requestBody: ScoringRunRequest,
): Promise<ScoringAnalysisPayload> {
  const path = requestBody.mode === 'comparison' ? '/comparisons' : '/analyses';
  return request(
    workspaceId,
    path,
    parseScoringAnalysis,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: requestBody.projectId,
        candidateIds: requestBody.candidateIds,
        radiusMeters: requestBody.radiusMeters,
        scoringModelId: requestBody.scoringModelId,
      }),
    },
  );
}

export function getStoredAnalysis(
  workspaceId: string,
  analysisId: string,
): Promise<ScoringAnalysisPayload> {
  return request(
    workspaceId,
    `/analyses/${encodeURIComponent(analysisId)}`,
    parseScoringAnalysis,
  );
}

export function listStoredAnalyses(
  workspaceId: string,
  projectId: string | null,
  options: { mode?: ScoringMode | null; limit?: number } = {},
): Promise<StoredAnalysisListResponse> {
  const limit = options.limit ?? 20;
  const mode = options.mode ? `&mode=${encodeURIComponent(options.mode)}` : '';
  const project = projectId ? `projectId=${encodeURIComponent(projectId)}&` : '';
  return request(
    workspaceId,
    `/analyses?${project}limit=${limit}${mode}`,
    parseStoredAnalysisListResponse,
  );
}
