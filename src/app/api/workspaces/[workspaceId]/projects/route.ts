import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringJsonResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { createWorkspaceProject, listWorkspaceProjects } from '@/lib/scoring/service';
import { parseProjectRequest } from '@/lib/scoring/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The projects of the caller's own workspace, for the explicit project selector.
 *
 * Phase 6.5: a project is never chosen for the caller. This read only lists what
 * the caller may select, under their own session, so RLS decides visibility.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireScoringAccess(workspaceId, 'read');
    if (isScoringDenied(access)) return access.response;

    const projects = await listWorkspaceProjects(workspaceId);
    return scoringJsonResponse({ projects });
  } catch (error) {
    return handleScoringRouteError('projects/list', error);
  }
}

/**
 * Creates one project, explicitly, for a workspace the caller owns or admins.
 *
 * The server never creates a project on its own: the empty state asks the person
 * to create one, and the database policy (`projects_insert_owner_admin`) is the
 * authority. No elevated client is used here.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireScoringAccess(workspaceId, 'manage');
    if (isScoringDenied(access)) return access.response;

    const body: unknown = await request.json().catch(() => null);
    const input = parseProjectRequest(body);

    const project = await createWorkspaceProject(workspaceId, input);
    return scoringJsonResponse({ project }, 201);
  } catch (error) {
    return handleScoringRouteError('projects/create', error);
  }
}
