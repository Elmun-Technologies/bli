import 'server-only';

import { getAdminSupabaseClient } from '@/lib/supabase/admin';

export const DEMO_ORGANIZATION_SLUG = 'atlas-demo';
export const DEMO_WORKSPACE_SLUG = 'tashkent-demo';

export interface DemoWorkspaceContext {
  organizationId: string;
  workspaceId: string;
  organizationSlug: typeof DEMO_ORGANIZATION_SLUG;
  workspaceSlug: typeof DEMO_WORKSPACE_SLUG;
}

export class DemoWorkspaceNotFoundError extends Error {
  constructor() {
    super('The fixed synthetic Tashkent demo workspace is not configured.');
    this.name = 'DemoWorkspaceNotFoundError';
  }
}

export class DemoWorkspaceLookupError extends Error {
  constructor() {
    super('The fixed synthetic Tashkent demo workspace could not be validated.');
    this.name = 'DemoWorkspaceLookupError';
  }
}

/**
 * Resolve and validate only the known synthetic workspace. The browser never
 * supplies either slug or UUID; future authentication can be added behind
 * this narrow context boundary.
 */
export async function resolveWorkspaceContext(): Promise<DemoWorkspaceContext> {
  let admin;
  try {
    // Missing elevated credentials are a database availability problem, not an
    // internal error, and the raw error is never surfaced to clients.
    admin = getAdminSupabaseClient();
  } catch (error) {
    console.error('[spatial:demo-workspace] server database configuration unavailable', error);
    throw new DemoWorkspaceLookupError();
  }

  const { data: organization, error: organizationError } = await admin
    .from('organizations')
    .select('id, slug')
    .eq('slug', DEMO_ORGANIZATION_SLUG)
    .maybeSingle();

  if (organizationError) throw new DemoWorkspaceLookupError();
  if (!organization || organization.slug !== DEMO_ORGANIZATION_SLUG) {
    throw new DemoWorkspaceNotFoundError();
  }

  const { data: workspace, error: workspaceError } = await admin
    .from('workspaces')
    .select('id, organization_id, slug')
    .eq('organization_id', organization.id)
    .eq('slug', DEMO_WORKSPACE_SLUG)
    .maybeSingle();

  if (workspaceError) throw new DemoWorkspaceLookupError();
  if (
    !workspace ||
    workspace.slug !== DEMO_WORKSPACE_SLUG ||
    workspace.organization_id !== organization.id
  ) {
    throw new DemoWorkspaceNotFoundError();
  }

  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    organizationSlug: DEMO_ORGANIZATION_SLUG,
    workspaceSlug: DEMO_WORKSPACE_SLUG,
  };
}
