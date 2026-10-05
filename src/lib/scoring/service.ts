import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';

import {
  parseSavedCandidateList,
  parseScoringAnalysis,
  parseScoringModel,
  parseStoredAnalysisList,
  type CandidateListResponse,
} from './payload';
import type {
  SavedCandidate,
  ScoringAnalysisPayload,
  ScoringMode,
  ScoringModel,
  ScoringModelInput,
  ScoringModelSummary,
  ScoringRunRequest,
} from './types';

/**
 * The caller has no valid session.
 */
export class ScoringSessionError extends Error {
  constructor() {
    super('Session expired.');
    this.name = 'ScoringSessionError';
  }
}

/**
 * The caller is authenticated but not allowed to do this, or the resource is not
 * visible to them. Both cases use one error so a response never reveals whether
 * a foreign model, candidate or analysis exists.
 */
export class ScoringAccessError extends Error {
  constructor(message = 'You do not have access to this scoring resource.') {
    super(message);
    this.name = 'ScoringAccessError';
  }
}

export class ScoringNotFoundError extends Error {
  constructor(message = 'The requested scoring resource was not found.') {
    super(message);
    this.name = 'ScoringNotFoundError';
  }
}

/** A client mistake the database refused: bad definition, duplicate name, limits. */
export class ScoringRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScoringRequestError';
    this.code = code;
  }
}

export class ScoringQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScoringQueryError';
  }
}

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Every scoring query runs under the caller's own authenticated session: the
 * cookie-aware client carries the user JWT, RLS filters every table, and the
 * scoring functions assert membership again. The elevated service-role client is
 * never used on this path, before or after any lookup.
 */
async function withAuthenticatedClient<T>(
  scope: string,
  run: (client: ServerClient) => Promise<T>,
): Promise<T> {
  let client: ServerClient;
  try {
    client = await createSupabaseServerClient();
  } catch (error) {
    throw new ScoringQueryError('Server-side database configuration is unavailable.', {
      cause: error,
    });
  }

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new ScoringSessionError();

  return run(client);
}

function throwForPostgrestError(
  scope: string,
  operation: 'manage' | 'run' | 'read',
  error: { code?: string; message?: string } | null,
): never {
  const code = error?.code ?? '';

  if (code === '42501') {
    if (operation === 'manage') {
      throw new ScoringAccessError('Your role in this workspace cannot manage scoring models.');
    }
    if (operation === 'run') {
      throw new ScoringAccessError('Your role in this workspace cannot run location analyses.');
    }
    throw new ScoringAccessError();
  }
  if (code === 'P0002') throw new ScoringNotFoundError();
  if (code === 'PGRST301' || code === 'PGRST302') throw new ScoringSessionError();
  if (code === '23505') {
    throw new ScoringRequestError('duplicate_model', 'A scoring model with this name already exists.');
  }
  if (code === '23514') {
    throw new ScoringRequestError(
      'invalid_model',
      'The scoring model definition violates a database rule. Check the weights and threshold stops.',
    );
  }
  if (code === '22023' || code === '22P02' || code === '23503') {
    throw new ScoringRequestError('invalid_request', 'The scoring request is not valid.');
  }

  throw new ScoringQueryError(`${scope} failed.`, { cause: error });
}

interface ModelRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface FactorRow {
  model_id: string;
  key: string;
  label: string;
  metric: string;
  weight: number;
  direction: string;
  normalization: string;
  configuration: unknown;
  enabled: boolean;
  sort_order: number;
}

const MODEL_COLUMNS = 'id, workspace_id, name, description, status, version, created_at, updated_at';
const FACTOR_COLUMNS =
  'model_id, key, label, metric, weight, direction, normalization, configuration, enabled, sort_order';

/** Lists the workspace models with their enabled factor count and weight total. */
export async function listScoringModels(workspaceId: string): Promise<ScoringModelSummary[]> {
  return withAuthenticatedClient('scoring.models.list', async (client) => {
    const { data: models, error } = await client
      .from('scoring_models')
      .select(MODEL_COLUMNS)
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false });

    if (error) throwForPostgrestError('scoring.models.list', 'read', error);
    const rows = (models ?? []) as unknown as ModelRow[];
    if (rows.length === 0) return [];

    const { data: factors, error: factorError } = await client
      .from('scoring_model_factors')
      .select(FACTOR_COLUMNS)
      .in(
        'model_id',
        rows.map((row) => row.id),
      );

    if (factorError) throwForPostgrestError('scoring.models.list', 'read', factorError);
    const factorRows = (factors ?? []) as unknown as FactorRow[];

    return rows.map((row) => {
      const own = factorRows.filter((factor) => factor.model_id === row.id);
      const enabled = own.filter((factor) => factor.enabled);
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.name,
        description: row.description,
        status: modelStatus(row.status),
        version: row.version,
        enabledFactorCount: enabled.length,
        enabledWeightTotal: Number(
          enabled.reduce((total, factor) => total + Number(factor.weight), 0).toFixed(2),
        ),
        updatedAt: row.updated_at,
      };
    });
  });
}

function modelStatus(value: string): ScoringModel['status'] {
  return value === 'active' || value === 'archived' ? value : 'draft';
}

/** One model with all of its factors, enabled or not. */
export async function getScoringModel(
  workspaceId: string,
  modelId: string,
): Promise<ScoringModel> {
  return withAuthenticatedClient('scoring.models.get', async (client) => {
    const { data: model, error } = await client
      .from('scoring_models')
      .select(MODEL_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('id', modelId)
      .maybeSingle();

    if (error) throwForPostgrestError('scoring.models.get', 'read', error);
    if (!model) throw new ScoringNotFoundError('Scoring model not found.');

    const { data: factors, error: factorError } = await client
      .from('scoring_model_factors')
      .select(FACTOR_COLUMNS)
      .eq('model_id', modelId)
      .order('sort_order', { ascending: true });

    if (factorError) throwForPostgrestError('scoring.models.get', 'read', factorError);

    return parseScoringModel({
      ...(model as unknown as ModelRow),
      factors: (factors ?? []) as unknown as FactorRow[],
    });
  });
}

export async function createScoringModel(
  workspaceId: string,
  input: ScoringModelInput,
): Promise<ScoringModel> {
  return withAuthenticatedClient('scoring.models.create', async (client) => {
    const { data, error } = await client.rpc('create_scoring_model', {
      p_workspace_id: workspaceId,
      p_name: input.name,
      p_description: input.description,
      p_status: input.status,
      p_factors: input.factors,
    });

    if (error) throwForPostgrestError('scoring.models.create', 'manage', error);
    if (typeof data !== 'string') {
      throw new ScoringQueryError('scoring.models.create returned no model id.');
    }

    return readModelWithClient(client, workspaceId, data, 'scoring.models.create');
  });
}

export async function updateScoringModel(
  workspaceId: string,
  modelId: string,
  input: ScoringModelInput,
): Promise<{ model: ScoringModel; revision: number }> {
  return withAuthenticatedClient('scoring.models.update', async (client) => {
    const { data, error } = await client.rpc('update_scoring_model', {
      p_model_id: modelId,
      p_name: input.name,
      p_description: input.description,
      p_status: input.status,
      p_factors: input.factors,
    });

    if (error) throwForPostgrestError('scoring.models.update', 'manage', error);
    const revision = typeof data === 'number' ? data : Number(data);

    const model = await readModelWithClient(client, workspaceId, modelId, 'scoring.models.update');
    return { model, revision: Number.isFinite(revision) ? revision : model.version };
  });
}

async function readModelWithClient(
  client: ServerClient,
  workspaceId: string,
  modelId: string,
  scope: string,
): Promise<ScoringModel> {
  const { data: model, error } = await client
    .from('scoring_models')
    .select(MODEL_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('id', modelId)
    .maybeSingle();

  if (error) throwForPostgrestError(scope, 'read', error);
  if (!model) throw new ScoringNotFoundError('Scoring model not found.');

  const { data: factors, error: factorError } = await client
    .from('scoring_model_factors')
    .select(FACTOR_COLUMNS)
    .eq('model_id', modelId)
    .order('sort_order', { ascending: true });

  if (factorError) throwForPostgrestError(scope, 'read', factorError);

  return parseScoringModel({
    ...(model as unknown as ModelRow),
    factors: (factors ?? []) as unknown as FactorRow[],
  });
}

/**
 * The workspace project that holds saved candidate locations. A workspace can
 * hold several projects; the interface works with the oldest one, and the
 * workspace id is always taken from the caller's resolved membership.
 */
async function resolveWorkspaceProjectId(
  client: ServerClient,
  workspaceId: string,
  scope: string,
): Promise<string> {
  const { data, error } = await client
    .from('projects')
    .select('id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throwForPostgrestError(scope, 'read', error);
  if (!data) {
    throw new ScoringNotFoundError('This workspace has no project for saved locations yet.');
  }
  return data.id;
}

export async function listSavedCandidates(
  workspaceId: string,
  projectId?: string | null,
): Promise<CandidateListResponse> {
  return withAuthenticatedClient('scoring.candidates.list', async (client) => {
    const resolvedProjectId =
      projectId ?? (await resolveWorkspaceProjectId(client, workspaceId, 'scoring.candidates.list'));

    const { data, error } = await client.rpc('list_analysis_locations', {
      p_workspace_id: workspaceId,
      p_project_id: resolvedProjectId,
    });

    if (error) throwForPostgrestError('scoring.candidates.list', 'read', error);
    return {
      projectId: resolvedProjectId,
      candidates: parseSavedCandidateList({ candidates: data ?? [] }),
    };
  });
}

export async function saveCandidate(
  workspaceId: string,
  input: { projectId: string; name: string; longitude: number; latitude: number },
): Promise<SavedCandidate> {
  return withAuthenticatedClient('scoring.candidates.save', async (client) => {
    const { data, error } = await client.rpc('save_analysis_location', {
      p_workspace_id: workspaceId,
      p_project_id: input.projectId,
      p_name: input.name,
      p_longitude: input.longitude,
      p_latitude: input.latitude,
    });

    if (error) throwForPostgrestError('scoring.candidates.save', 'run', error);

    // `save_analysis_location` is a set-returning function, so PostgREST hands
    // back a one-row array; the route returns the single stored candidate.
    const [saved] = parseSavedCandidateList({ candidates: data ?? [] });
    if (!saved) throw new ScoringQueryError('scoring.candidates.save returned no candidate.');

    return saved;
  });
}

/** Runs and stores one authoritative analysis or comparison. */
export async function runScoringAnalysis(
  workspaceId: string,
  request: ScoringRunRequest,
): Promise<ScoringAnalysisPayload> {
  return withAuthenticatedClient('scoring.analyses.run', async (client) => {
    const { data, error } = await client.rpc('run_location_analysis', {
      p_workspace_id: workspaceId,
      p_project_id: request.projectId,
      p_candidate_ids: request.candidateIds,
      p_radius_meters: request.radiusMeters,
      p_scoring_model_id: request.scoringModelId,
      p_mode: request.mode,
    });

    if (error) throwForPostgrestError('scoring.analyses.run', 'run', error);
    if (!data) throw new ScoringQueryError('scoring.analyses.run returned no payload.');

    return parseScoringAnalysis(data);
  });
}

/** Reads one stored analysis exactly as it was written. */
export async function getStoredAnalysis(
  workspaceId: string,
  analysisId: string,
): Promise<ScoringAnalysisPayload> {
  return withAuthenticatedClient('scoring.analyses.get', async (client) => {
    const { data, error } = await client.rpc('get_location_analysis', {
      p_workspace_id: workspaceId,
      p_analysis_id: analysisId,
    });

    if (error) throwForPostgrestError('scoring.analyses.get', 'read', error);
    if (!data) throw new ScoringNotFoundError('Location analysis not found.');

    return parseScoringAnalysis(data);
  });
}

/**
 * Stored analyses of one project, newest first, each with the payload exactly as
 * it was written when it was run. Optionally filtered to the analysis or the
 * comparison mode.
 */
export async function listStoredAnalyses(
  workspaceId: string,
  projectId?: string | null,
  mode: ScoringMode | null = null,
  limit = 20,
): Promise<{ projectId: string; analyses: ScoringAnalysisPayload[] }> {
  return withAuthenticatedClient('scoring.analyses.list', async (client) => {
    const resolvedProjectId =
      projectId ?? (await resolveWorkspaceProjectId(client, workspaceId, 'scoring.analyses.list'));

    const { data, error } = await client.rpc('list_location_analyses', {
      p_workspace_id: workspaceId,
      p_project_id: resolvedProjectId,
      p_mode: mode,
      p_limit: limit,
    });

    if (error) throwForPostgrestError('scoring.analyses.list', 'read', error);

    return {
      projectId: resolvedProjectId,
      analyses: parseStoredAnalysisList({ analyses: data ?? [] }),
    };
  });
}
