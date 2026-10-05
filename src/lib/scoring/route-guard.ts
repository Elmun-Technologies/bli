import 'server-only';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { getSessionUser } from '@/lib/auth/session';
import {
  resolveWorkspaceAccess,
  WorkspaceAccessQueryError,
  type AuthorizedWorkspace,
} from '@/lib/auth/workspace-access';

import { scoringErrorResponse } from './http';

/**
 * Three levels of access, matching the database policies exactly:
 *
 *   read   - any member: models, saved candidates, stored analyses
 *   run    - owner, admin, analyst: run analyses, save candidates
 *   manage - owner, admin: create and edit scoring models
 */
export type ScoringAccessLevel = 'read' | 'run' | 'manage';

const RUN_ROLES = new Set(['owner', 'admin', 'analyst']);
const MANAGE_ROLES = new Set(['owner', 'admin']);

export interface ScoringRouteAccess {
  userId: string;
  workspace: AuthorizedWorkspace;
}

export interface ScoringRouteDenied {
  response: ReturnType<typeof scoringErrorResponse>;
}

export function isScoringDenied(
  value: ScoringRouteAccess | ScoringRouteDenied,
): value is ScoringRouteDenied {
  return (value as ScoringRouteDenied).response !== undefined;
}

/**
 * Session plus membership for every scoring route. The workspace id in the path
 * is untrusted input: it only resolves the caller's own membership, and a
 * non-existent workspace answers exactly like a foreign one. Roles are read from
 * the database, never from the request; the database policies enforce the same
 * matrix independently.
 */
export async function requireScoringAccess(
  workspaceId: string,
  level: ScoringAccessLevel,
): Promise<ScoringRouteAccess | ScoringRouteDenied> {
  const user = await getSessionUser();
  if (!user) {
    return {
      response: scoringErrorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired),
    };
  }

  let workspace: AuthorizedWorkspace | null;
  try {
    workspace = await resolveWorkspaceAccess(user.id, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessQueryError) {
      console.error('[scoring:guard] membership lookup failed', error.cause ?? error);
      return {
        response: scoringErrorResponse(
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
      response: scoringErrorResponse(403, 'workspace_forbidden', SAFE_AUTH_MESSAGES.noWorkspaceAccess),
    };
  }

  if (level === 'manage' && !MANAGE_ROLES.has(workspace.role)) {
    return {
      response: scoringErrorResponse(
        403,
        'workspace_forbidden',
        'Managing scoring models requires an owner or admin role in this workspace.',
      ),
    };
  }

  if (level === 'run' && !RUN_ROLES.has(workspace.role)) {
    return {
      response: scoringErrorResponse(
        403,
        'workspace_forbidden',
        'Running a location analysis requires an owner, admin or analyst role in this workspace.',
      ),
    };
  }

  return { userId: user.id, workspace };
}
