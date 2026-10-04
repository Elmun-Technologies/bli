import type { NextRequest } from 'next/server';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { getSessionUser } from '@/lib/auth/session';
import { resolveWorkspaceAccess, WorkspaceAccessQueryError } from '@/lib/auth/workspace-access';
import { errorResponse, handleTenantRouteError, jsonResponse } from '@/lib/spatial/http';
import { fetchWorkspaceRadiusAnalysis } from '@/lib/spatial/tenant-service';
import { parseRadiusAnalysisRequest } from '@/lib/spatial/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Authenticated tenant radius analysis. Same trust model as the viewport route:
 * the session is validated, membership is resolved from the database, and the
 * aggregate query runs as the caller so RLS and the RPC's own membership
 * assertion both apply. The elevated service-role client is never used here.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const user = await getSessionUser();
    if (!user) {
      return errorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired);
    }

    const body: unknown = await request.json().catch(() => null);
    const analysisRequest = parseRadiusAnalysisRequest(body);

    const access = await resolveWorkspaceAccess(user.id, workspaceId);
    if (!access) {
      return errorResponse(403, 'workspace_forbidden', SAFE_AUTH_MESSAGES.noWorkspaceAccess);
    }

    // Same response envelope as the public demo route: the shared browser parser
    // requires { analysis } and is what the installed client actually reads.
    const analysis = await fetchWorkspaceRadiusAnalysis(workspaceId, analysisRequest);
    return jsonResponse({ analysis });
  } catch (error) {
    if (error instanceof WorkspaceAccessQueryError) {
      console.error(
        '[spatial:workspaces/analysis/radius] membership lookup failed',
        error.cause ?? error,
      );
      return errorResponse(500, 'database_unavailable', 'The spatial database query failed.');
    }
    return handleTenantRouteError('workspaces/analysis/radius', error);
  }
}
