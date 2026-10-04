import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';

import type {
  RadiusAnalysisDTO,
  RadiusAnalysisRequest,
  SpatialFeatureKind,
  ViewportBounds,
  ViewportFeatureCollection,
} from './contracts';
import { toRadiusAnalysisDTO, toViewportFeatureCollection, VIEWPORT_RPC_FETCH_LIMIT } from './dto';

/** No server-validated session: the caller must sign in again. */
export class TenantSessionError extends Error {
  constructor() {
    super('Session expired.');
    this.name = 'TenantSessionError';
  }
}

/**
 * The caller is authenticated but not authorized for this workspace, or the
 * workspace does not exist. Both cases throw the same error on purpose: the
 * response must not reveal whether a private workspace exists.
 */
export class TenantWorkspaceAccessError extends Error {
  constructor() {
    super('Workspace access denied.');
    this.name = 'TenantWorkspaceAccessError';
  }
}

export class TenantQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantQueryError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executes a tenant query under the caller's own authenticated session. The
 * cookie-aware client carries the user JWT, so both layers of Phase 4 protect
 * the query: the RPC asserts membership explicitly, and Row Level Security
 * filters every table it touches. The elevated service-role client is never
 * used here, before or after a membership lookup.
 */
async function withAuthenticatedClient<T>(
  scope: string,
  run: (client: Awaited<ReturnType<typeof createSupabaseServerClient>>) => Promise<T>,
): Promise<T> {
  let client;
  try {
    client = await createSupabaseServerClient();
  } catch (error) {
    throw new TenantQueryError('Server-side database configuration is unavailable.', {
      cause: error,
    });
  }

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new TenantSessionError();

  return run(client);
}

function throwForPostgrestError(scope: string, error: { code?: string; message?: string } | null): never {
  const code = error?.code ?? '';
  // 42501 is the membership assertion inside the tenant RPCs.
  if (code === '42501') throw new TenantWorkspaceAccessError();
  // PostgREST reports a missing/expired JWT as PGRST301/PGRST302.
  if (code === 'PGRST301' || code === 'PGRST302') throw new TenantSessionError();
  throw new TenantQueryError(`${scope} failed.`, { cause: error });
}

/** Viewport features for one workspace, resolved from the URL workspace id. */
export async function fetchWorkspaceViewportFeatures(
  workspaceId: string,
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
): Promise<ViewportFeatureCollection> {
  if (!UUID_PATTERN.test(workspaceId)) throw new TenantWorkspaceAccessError();

  return withAuthenticatedClient('Workspace viewport query', async (client) => {
    const { data, error } = await client.rpc('workspace_viewport_features', {
      p_workspace_id: workspaceId,
      p_west: bounds.west,
      p_south: bounds.south,
      p_east: bounds.east,
      p_north: bounds.north,
      p_kinds: kinds ?? undefined,
      p_limit: VIEWPORT_RPC_FETCH_LIMIT,
    });

    if (error) throwForPostgrestError('Workspace viewport query', error);
    if (!Array.isArray(data)) {
      throw new TenantQueryError('Workspace viewport query returned an unexpected payload.');
    }

    return toViewportFeatureCollection(data, bounds, kinds);
  });
}

/** Radius aggregates for one workspace; never returns customer rows. */
export async function fetchWorkspaceRadiusAnalysis(
  workspaceId: string,
  request: RadiusAnalysisRequest,
): Promise<RadiusAnalysisDTO> {
  if (!UUID_PATTERN.test(workspaceId)) throw new TenantWorkspaceAccessError();

  return withAuthenticatedClient('Workspace radius query', async (client) => {
    const { data, error } = await client.rpc('workspace_radius_analysis', {
      p_workspace_id: workspaceId,
      p_longitude: request.candidate.longitude,
      p_latitude: request.candidate.latitude,
      p_radius_meters: request.radiusMeters,
    });

    if (error) throwForPostgrestError('Workspace radius query', error);

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      throw new TenantQueryError('Workspace radius query returned no aggregate row.');
    }

    return toRadiusAnalysisDTO(row, request);
  });
}
