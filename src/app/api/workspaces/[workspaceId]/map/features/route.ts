import type { NextRequest } from 'next/server';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { getSessionUser } from '@/lib/auth/session';
import { resolveWorkspaceAccess, WorkspaceAccessQueryError } from '@/lib/auth/workspace-access';
import { errorResponse, handleTenantRouteError, jsonResponse } from '@/lib/spatial/http';
import { fetchWorkspaceViewportFeatures } from '@/lib/spatial/tenant-service';
import { parseViewportQuery } from '@/lib/spatial/validation';

// Tenant viewport results depend on live data, the caller's session and RLS.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Authenticated tenant viewport endpoint. The workspace id in the path is
 * untrusted: the session is validated server-side, membership is resolved from
 * the database, and the query then runs under the caller's own authenticated
 * session so Row Level Security applies independently of this check.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const user = await getSessionUser();
    if (!user) {
      return errorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired);
    }

    const { bounds, kinds } = parseViewportQuery(request.nextUrl.searchParams);

    const access = await resolveWorkspaceAccess(user.id, workspaceId);
    if (!access) {
      // Foreign and non-existent workspaces answer identically: no existence
      // oracle, and never a 200 with empty metadata.
      return errorResponse(403, 'workspace_forbidden', SAFE_AUTH_MESSAGES.noWorkspaceAccess);
    }

    return jsonResponse(await fetchWorkspaceViewportFeatures(workspaceId, bounds, kinds));
  } catch (error) {
    if (error instanceof WorkspaceAccessQueryError) {
      console.error('[spatial:workspaces/map/features] membership lookup failed', error.cause ?? error);
      return errorResponse(500, 'database_unavailable', 'The spatial database query failed.');
    }
    return handleTenantRouteError('workspaces/map/features', error);
  }
}
