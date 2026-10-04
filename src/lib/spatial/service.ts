import 'server-only';

import { getAdminSupabaseClient } from '@/lib/supabase/admin';

import type {
  RadiusAnalysisRequest,
  SpatialFeatureKind,
  ViewportBounds,
} from './contracts';
import {
  DemoWorkspaceLookupError,
  DemoWorkspaceNotFoundError,
  resolveWorkspaceContext,
  type DemoWorkspaceContext,
} from './demo-workspace';
import {
  toRadiusAnalysisDTO,
  toViewportFeatureCollection,
  VIEWPORT_RPC_FETCH_LIMIT,
} from './dto';
import type { RadiusAnalysisDTO, ViewportFeatureCollection } from './contracts';

export class SpatialQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SpatialQueryError';
  }
}

function isMissingDemoWorkspace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 'P0002' ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes('Synthetic demo workspace not found'))
  );
}

async function requireWorkspaceContext(): Promise<DemoWorkspaceContext> {
  const context = await resolveWorkspaceContext();
  if (!context.workspaceId) throw new DemoWorkspaceNotFoundError();
  return context;
}

/**
 * Viewport features for the fixed synthetic demo workspace. The RPC owns the
 * workspace binding and the PII-safe projection; this layer only validates the
 * returned shape and reports truncation metadata.
 */
export async function fetchDemoViewportFeatures(
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
): Promise<ViewportFeatureCollection> {
  await requireWorkspaceContext();
  const admin = getAdminSupabaseClient();

  const { data, error } = await admin.rpc('demo_viewport_features', {
    p_west: bounds.west,
    p_south: bounds.south,
    p_east: bounds.east,
    p_north: bounds.north,
    p_kinds: kinds,
    p_limit: VIEWPORT_RPC_FETCH_LIMIT,
  });

  if (error) {
    if (isMissingDemoWorkspace(error)) throw new DemoWorkspaceNotFoundError();
    throw new SpatialQueryError('Viewport feature query failed.', { cause: error });
  }
  if (!Array.isArray(data)) {
    throw new SpatialQueryError('Viewport feature query returned an unexpected payload.');
  }

  return toViewportFeatureCollection(data, bounds, kinds);
}

/** Radius analysis runs only against PostGIS aggregates in the demo workspace. */
export async function fetchDemoRadiusAnalysis(
  request: RadiusAnalysisRequest,
): Promise<RadiusAnalysisDTO> {
  await requireWorkspaceContext();
  const admin = getAdminSupabaseClient();

  const { data, error } = await admin.rpc('demo_radius_analysis', {
    p_longitude: request.candidate.longitude,
    p_latitude: request.candidate.latitude,
    p_radius_meters: request.radiusMeters,
  });

  if (error) {
    if (isMissingDemoWorkspace(error)) throw new DemoWorkspaceNotFoundError();
    throw new SpatialQueryError('Radius analysis query failed.', { cause: error });
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    throw new SpatialQueryError('Radius analysis query returned no aggregate row.');
  }

  return toRadiusAnalysisDTO(row, request);
}

export { DemoWorkspaceLookupError, DemoWorkspaceNotFoundError };
