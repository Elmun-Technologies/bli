import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';

import {
  parseSavedCandidateList,
  parseScoringAnalysis,
  parseScoringModel,
  parseStoredAnalysisList,
  parseWorkspaceProject,
  type CandidateListResponse,
} from './payload';
import {
  NO_PROJECT_MESSAGE,
  PROJECT_REQUIRED_MESSAGE,
  resolveProjectContext,
  type WorkspaceProjectSummary,
} from './projects';
import type {
  SavedCandidate,
  ScoringMode,
  ScoringModel,
  ScoringModelInput,
  ScoringModelSummary,
  ScoringRunRequest,
  ScoringWirePayload,
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
 * The active projects of the caller's own workspace, ordered for display only.
 * RLS filters the rows to the caller's memberships; the order is never used to
 * pick a project, because Phase 6.5 has no implicit project selection at all.
 */
async function readWorkspaceProjects(
  client: ServerClient,
  workspaceId: string,
  scope: string,
): Promise<WorkspaceProjectSummary[]> {
  const { data, error } = await client
    .from('projects')
    .select('id, name, status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throwForPostgrestError(scope, 'read', error);
  return (data ?? []) as WorkspaceProjectSummary[];
}

/**
 * Project context of a read. One project resolves on its own; several projects
 * require the caller to name one; a named project that is not one of the
 * caller's own projects fails exactly like a missing one (safe 400, no
 * resource-existence oracle). The zero-project state is the only empty answer.
 */
async function resolveProjectForRead(
  client: ServerClient,
  workspaceId: string,
  requestedProjectId: string | null,
  scope: string,
): Promise<{ projects: WorkspaceProjectSummary[]; projectId: string | null }> {
  const projects = await readWorkspaceProjects(client, workspaceId, scope);
  const resolution = resolveProjectContext(projects, requestedProjectId);

  if (resolution.status === 'resolved') return { projects, projectId: resolution.projectId };
  if (resolution.status === 'empty') return { projects, projectId: null };

  throw new ScoringRequestError('project_required', PROJECT_REQUIRED_MESSAGE);
}

/**
 * Project context of a mutation or a project-scoped write: the project is always
 * named (or unambiguously resolved) and always verified against the caller's own
 * workspace before the database is asked to do anything.
 */
async function requireProjectForWrite(
  client: ServerClient,
  workspaceId: string,
  requestedProjectId: string | null,
  scope: string,
): Promise<string> {
  const projects = await readWorkspaceProjects(client, workspaceId, scope);
  const resolution = resolveProjectContext(projects, requestedProjectId);

  if (resolution.status === 'resolved') return resolution.projectId;
  if (resolution.status === 'empty') throw new ScoringRequestError('no_project', NO_PROJECT_MESSAGE);

  throw new ScoringRequestError('project_required', PROJECT_REQUIRED_MESSAGE);
}

/** The caller's own projects, for the explicit project selector. */
export async function listWorkspaceProjects(
  workspaceId: string,
): Promise<WorkspaceProjectSummary[]> {
  return withAuthenticatedClient('scoring.projects.list', (client) =>
    readWorkspaceProjects(client, workspaceId, 'scoring.projects.list'),
  );
}

/**
 * Creates one project explicitly. Nothing in the server ever creates a project
 * on its own: this runs only for a request that named it, under the caller's own
 * session, and the database policy keeps it to owners and admins.
 */
export async function createWorkspaceProject(
  workspaceId: string,
  input: { name: string; description: string | null },
): Promise<WorkspaceProjectSummary> {
  return withAuthenticatedClient('scoring.projects.create', async (client) => {
    const { data, error } = await client
      .from('projects')
      .insert({
        workspace_id: workspaceId,
        name: input.name,
        description: input.description,
        status: 'active',
      })
      .select('id, name, status')
      .single();

    if (error) {
      // The route guard and the policy both keep this to owners/admins; keep the
      // refusal message truthful for projects rather than reusing the model one.
      if (error.code === '42501') {
        throw new ScoringAccessError('Your role in this workspace cannot create a project.');
      }
      if (error.code === '23514') {
        throw new ScoringRequestError('invalid_project', 'The project name is not valid.');
      }
      throwForPostgrestError('scoring.projects.create', 'manage', error);
    }
    try {
      return parseWorkspaceProject(data);
    } catch (cause) {
      throw new ScoringQueryError('scoring.projects.create returned an unreadable project.', {
        cause,
      });
    }
  });
}

/**
 * Saved candidates of one project, read by the caller's own session. The
 * response names the projects the caller may choose from and the project that
 * answered, so the interface never has to invent an identifier.
 */
export async function listSavedCandidates(
  workspaceId: string,
  projectId: string | null,
): Promise<CandidateListResponse> {
  return withAuthenticatedClient('scoring.candidates.list', async (client) => {
    const { projects, projectId: resolvedProjectId } = await resolveProjectForRead(
      client,
      workspaceId,
      projectId,
      'scoring.candidates.list',
    );

    if (resolvedProjectId === null) {
      return { projects, projectId: null, candidates: [] };
    }

    const { data, error } = await client.rpc('list_analysis_locations', {
      p_workspace_id: workspaceId,
      p_project_id: resolvedProjectId,
    });

    if (error) throwForPostgrestError('scoring.candidates.list', 'read', error);
    return {
      projects,
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
    await requireProjectForWrite(client, workspaceId, input.projectId, 'scoring.candidates.save');

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

/**
 * The server ships the database payload verbatim, and the browser reads it with
 * the same shipped parser. Validating it here as well turns a payload the client
 * could not read into a loud server error instead of a broken response.
 */
function assertScoringWirePayload(value: unknown, scope: string): void {
  try {
    parseScoringAnalysis(value);
  } catch (error) {
    throw new ScoringQueryError(`${scope} returned a payload the shipped parser rejects.`, {
      cause: error,
    });
  }
}

function assertStoredAnalysisRows(rows: unknown, scope: string): void {
  try {
    parseStoredAnalysisList({ analyses: rows });
  } catch (error) {
    throw new ScoringQueryError(`${scope} returned stored analyses the parser rejects.`, {
      cause: error,
    });
  }
}

/** Runs and stores one authoritative analysis or comparison. */
export async function runScoringAnalysis(
  workspaceId: string,
  request: ScoringRunRequest,
): Promise<ScoringWirePayload> {
  return withAuthenticatedClient('scoring.analyses.run', async (client) => {
    // The project is verified as the caller's own before the engine runs; the
    // engine then refuses any candidate that does not belong to that project, so
    // a mixed-project comparison can never be stored.
    await requireProjectForWrite(client, workspaceId, request.projectId, 'scoring.analyses.run');

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
    assertScoringWirePayload(data, 'scoring.analyses.run');

    return data as ScoringWirePayload;
  });
}

/** Reads one stored analysis exactly as it was written. */
export async function getStoredAnalysis(
  workspaceId: string,
  analysisId: string,
): Promise<ScoringWirePayload> {
  return withAuthenticatedClient('scoring.analyses.get', async (client) => {
    const { data, error } = await client.rpc('get_location_analysis', {
      p_workspace_id: workspaceId,
      p_analysis_id: analysisId,
    });

    if (error) throwForPostgrestError('scoring.analyses.get', 'read', error);
    if (!data) throw new ScoringNotFoundError('Location analysis not found.');
    assertScoringWirePayload(data, 'scoring.analyses.get');

    return data as ScoringWirePayload;
  });
}

/**
 * Stored analyses of one project, newest first, each with the payload exactly as
 * it was written when it was run. Optionally filtered to the analysis or the
 * comparison mode.
 */
export async function listStoredAnalyses(
  workspaceId: string,
  projectId: string | null,
  mode: ScoringMode | null = null,
  limit = 20,
): Promise<{ projectId: string | null; analyses: ScoringWirePayload[] }> {
  return withAuthenticatedClient('scoring.analyses.list', async (client) => {
    const { projectId: resolvedProjectId } = await resolveProjectForRead(
      client,
      workspaceId,
      projectId,
      'scoring.analyses.list',
    );

    if (resolvedProjectId === null) return { projectId: null, analyses: [] };

    const { data, error } = await client.rpc('list_location_analyses', {
      p_workspace_id: workspaceId,
      p_project_id: resolvedProjectId,
      p_mode: mode,
      p_limit: limit,
    });

    if (error) throwForPostgrestError('scoring.analyses.list', 'read', error);

    const rows = (data ?? []) as ScoringWirePayload[];
    assertStoredAnalysisRows(rows, 'scoring.analyses.list');

    // Each row is `{ analysis: <stored payload> }` exactly as the database table
    // RPC returns it; the client parser unwraps it.
    return { projectId: resolvedProjectId, analyses: rows };
  });
}
