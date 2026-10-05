import type {
  RadiusAnalysisDTO,
  RadiusAnalysisRequest,
  SpatialFeatureKind,
  ViewportBounds,
  ViewportFeatureCollection,
} from './contracts';
import { parseRadiusAnalysisResponse, parseViewportFeatureCollection } from './response';

export class SpatialApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'SpatialApiError';
    this.status = status;
    this.code = code;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: unknown }).error === 'object' &&
      (payload as { error: { message?: unknown } }).error !== null
    ) {
      const message = (payload as { error: { message?: unknown } }).error.message;
      if (typeof message === 'string' && message.length > 0 && message.length <= 300) {
        return message;
      }
    }
  } catch {
    // Fall through to the generic message; response bodies are never trusted.
  }

  return fallback;
}

function readErrorCode(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof (payload as { error?: { code?: unknown } }).error?.code === 'string'
  ) {
    return (payload as { error: { code: string } }).error.code;
  }
  return 'request_failed';
}

export function buildViewportSearchParams(
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
): string {
  const params = new URLSearchParams({
    west: String(bounds.west),
    south: String(bounds.south),
    east: String(bounds.east),
    north: String(bounds.north),
  });

  if (kinds && kinds.length > 0) params.set('kinds', kinds.join(','));
  return params.toString();
}

/**
 * Endpoint builders. The demo endpoints are the fixed public synthetic path;
 * the tenant endpoints carry the workspace id that the server re-validates
 * against the caller's memberships on every request.
 */
export function demoViewportEndpoint(bounds: ViewportBounds, kinds: SpatialFeatureKind[] | null): string {
  return `/api/demo/map/features?${buildViewportSearchParams(bounds, kinds)}`;
}

export function workspaceViewportEndpoint(
  workspaceId: string,
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/map/features?${buildViewportSearchParams(bounds, kinds)}`;
}

export function demoRadiusEndpoint(): string {
  return '/api/demo/analysis/radius';
}

export function workspaceRadiusEndpoint(workspaceId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/analysis/radius`;
}

/** Fetch viewport features for the demo map. Callers own cancellation. */
export async function fetchViewportFeatures(
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
  signal?: AbortSignal,
): Promise<ViewportFeatureCollection> {
  const response = await fetch(demoViewportEndpoint(bounds, kinds), {
    signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'request_failed';
    try {
      code = readErrorCode(await response.clone().json());
    } catch {
      // Keep the generic code.
    }
    throw new SpatialApiError(
      await readErrorMessage(response, 'Map features could not be loaded.'),
      response.status,
      code,
    );
  }

  return parseViewportFeatureCollection(await response.json());
}

/**
 * Viewport features for one workspace the caller is a member of. The browser
 * supplies the workspace id only as a routing hint; the route handler
 * re-validates the session and membership before any spatial query runs.
 */
export async function fetchWorkspaceViewportFeatures(
  workspaceId: string,
  bounds: ViewportBounds,
  kinds: SpatialFeatureKind[] | null,
  signal?: AbortSignal,
): Promise<ViewportFeatureCollection> {
  const response = await fetch(workspaceViewportEndpoint(workspaceId, bounds, kinds), {
    signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'request_failed';
    try {
      code = readErrorCode(await response.clone().json());
    } catch {
      // Keep the generic code.
    }
    throw new SpatialApiError(
      await readErrorMessage(response, 'Map features could not be loaded.'),
      response.status,
      code,
    );
  }

  return parseViewportFeatureCollection(await response.json());
}

/** Run authoritative server-side PostGIS radius analysis. Never uses fixtures. */
export async function requestRadiusAnalysis(
  request: RadiusAnalysisRequest,
  signal?: AbortSignal,
): Promise<RadiusAnalysisDTO> {
  const response = await fetch(demoRadiusEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'request_failed';
    try {
      code = readErrorCode(await response.clone().json());
    } catch {
      // Keep the generic code.
    }
    throw new SpatialApiError(
      await readErrorMessage(response, 'Radius analysis could not be completed.'),
      response.status,
      code,
    );
  }

  return parseRadiusAnalysisResponse(await response.json());
}

/** Radius aggregates for one workspace the caller is a member of. */
export async function requestWorkspaceRadiusAnalysis(
  workspaceId: string,
  request: RadiusAnalysisRequest,
  signal?: AbortSignal,
): Promise<RadiusAnalysisDTO> {
  const response = await fetch(workspaceRadiusEndpoint(workspaceId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    let code = 'request_failed';
    try {
      code = readErrorCode(await response.clone().json());
    } catch {
      // Keep the generic code.
    }
    throw new SpatialApiError(
      await readErrorMessage(response, 'Radius analysis could not be completed.'),
      response.status,
      code,
    );
  }

  return parseRadiusAnalysisResponse(await response.json());
}

