import 'server-only';

import type { Database } from '@/lib/database/database.types';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export type WorkspaceRole = Database['public']['Enums']['workspace_member_role'];

export interface AuthorizedWorkspace {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
}

export class WorkspaceAccessQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceAccessQueryError';
  }
}

interface MembershipRow {
  role: WorkspaceRole;
  workspace: { id: string; name: string; slug: string } | null;
}

/**
 * The caller's own memberships, resolved through the cookie-aware client so Row
 * Level Security decides what exists. The selector never lists workspaces the
 * caller cannot read, and the `user_id` filter keeps the roster rows of other
 * members out of the list.
 */
export async function listAuthorizedWorkspaces(userId: string): Promise<AuthorizedWorkspace[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role, workspace:workspaces!workspace_members_workspace_fk(id, name, slug)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new WorkspaceAccessQueryError('Workspace membership lookup failed.', { cause: error });
  }

  return toAuthorizedWorkspaces(data);
}

/**
 * One workspace the caller belongs to, or null when they are not a member (or
 * the workspace does not exist — the two cases are deliberately identical).
 */
export async function resolveWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<AuthorizedWorkspace | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('workspace_members')
    .select('role, workspace:workspaces!workspace_members_workspace_fk(id, name, slug)')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) {
    throw new WorkspaceAccessQueryError('Workspace membership lookup failed.', { cause: error });
  }

  return toAuthorizedWorkspaces(data ? [data] : [])[0] ?? null;
}

function toAuthorizedWorkspaces(rows: unknown): AuthorizedWorkspace[] {
  if (!Array.isArray(rows)) return [];

  const workspaces: AuthorizedWorkspace[] = [];
  for (const row of rows) {
    const membership = row as MembershipRow;
    const workspace = membership.workspace;
    if (!workspace) continue;
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: membership.role,
    });
  }
  return workspaces;
}
