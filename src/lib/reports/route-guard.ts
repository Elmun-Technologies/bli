import 'server-only';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { getSessionUser } from '@/lib/auth/session';
import {
  resolveWorkspaceAccess,
  WorkspaceAccessQueryError,
  type AuthorizedWorkspace,
} from '@/lib/auth/workspace-access';

import { reportErrorResponse } from './http';

/**
 * Two levels, matching the database policies exactly:
 *
 *   read   - any member: report history, preview, download
 *   run    - owner, admin, analyst: create a report, generate/regenerate a PDF
 *   manage - owner, admin: report branding (logo, company name)
 */
export type ReportAccessLevel = 'read' | 'run' | 'manage';

const RUN_ROLES = new Set(['owner', 'admin', 'analyst']);
const MANAGE_ROLES = new Set(['owner', 'admin']);

export interface ReportRouteAccess {
  userId: string;
  workspace: AuthorizedWorkspace;
}

export interface ReportRouteDenied {
  response: ReturnType<typeof reportErrorResponse>;
}

export function isReportDenied(
  value: ReportRouteAccess | ReportRouteDenied,
): value is ReportRouteDenied {
  return (value as ReportRouteDenied).response !== undefined;
}

/**
 * Session plus membership for every report route. The workspace id in the path
 * is untrusted input: it only resolves the caller's own membership, and a
 * non-existent workspace answers exactly like a foreign one. Roles are read from
 * the database, never from the request; the database policies enforce the same
 * matrix independently.
 */
export async function requireReportAccess(
  workspaceId: string,
  level: ReportAccessLevel,
): Promise<ReportRouteAccess | ReportRouteDenied> {
  const user = await getSessionUser();
  if (!user) {
    return {
      response: reportErrorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired),
    };
  }

  let workspace: AuthorizedWorkspace | null;
  try {
    workspace = await resolveWorkspaceAccess(user.id, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessQueryError) {
      console.error('[reports:guard] membership lookup failed', error.cause ?? error);
      return {
        response: reportErrorResponse(
          500,
          'database_unavailable',
          'The workspace could not be validated.',
        ),
      };
    }
    throw error;
  }

  if (!workspace) {
    return {
      response: reportErrorResponse(403, 'access_denied', SAFE_AUTH_MESSAGES.noWorkspaceAccess),
    };
  }

  if (level === 'manage' && !MANAGE_ROLES.has(workspace.role)) {
    return {
      response: reportErrorResponse(
        403,
        'access_denied',
        'Report branding requires an owner or admin role in this workspace.',
      ),
    };
  }

  if (level === 'run' && !RUN_ROLES.has(workspace.role)) {
    return {
      response: reportErrorResponse(
        403,
        'access_denied',
        'Generating reports requires an owner, admin or analyst role in this workspace.',
      ),
    };
  }

  return { userId: user.id, workspace };
}
