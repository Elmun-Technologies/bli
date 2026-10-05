import 'server-only';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { getSessionUser } from '@/lib/auth/session';
import {
  resolveWorkspaceAccess,
  WorkspaceAccessQueryError,
  type AuthorizedWorkspace,
} from '@/lib/auth/workspace-access';

import { importErrorResponse } from './http';

/** Roles allowed to change anything about an import. A viewer never writes. */
const IMPORT_WRITE_ROLES = new Set(['owner', 'admin', 'analyst']);

export interface ImportRouteAccess {
  userId: string;
  workspace: AuthorizedWorkspace;
}

export interface ImportRouteDenied {
  response: ReturnType<typeof importErrorResponse>;
}

export function isDenied(value: ImportRouteAccess | ImportRouteDenied): value is ImportRouteDenied {
  return (value as ImportRouteDenied).response !== undefined;
}

/**
 * Session + workspace membership for every import route. The workspace id in the
 * path is untrusted input: it is only used to look up the caller's own
 * membership, and a non-existent workspace answers exactly like a foreign one.
 * Write operations additionally require owner, admin or analyst; the database
 * policies enforce the same thing independently.
 */
export async function requireImportAccess(
  workspaceId: string,
  options: { write: boolean },
): Promise<ImportRouteAccess | ImportRouteDenied> {
  const user = await getSessionUser();
  if (!user) {
    return { response: importErrorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired) };
  }

  let workspace: AuthorizedWorkspace | null;
  try {
    workspace = await resolveWorkspaceAccess(user.id, workspaceId);
  } catch (error) {
    if (error instanceof WorkspaceAccessQueryError) {
      console.error('[imports:guard] membership lookup failed', error.cause ?? error);
      return {
        response: importErrorResponse(500, 'database_unavailable', 'The workspace could not be validated.'),
      };
    }
    throw error;
  }

  if (!workspace) {
    return {
      response: importErrorResponse(403, 'workspace_forbidden', SAFE_AUTH_MESSAGES.noWorkspaceAccess),
    };
  }

  if (options.write && !IMPORT_WRITE_ROLES.has(workspace.role)) {
    return {
      response: importErrorResponse(
        403,
        'workspace_forbidden',
        'Your role in this workspace is read-only for imports.',
      ),
    };
  }

  return { userId: user.id, workspace };
}
