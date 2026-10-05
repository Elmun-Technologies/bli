import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringJsonResponse, scoringErrorResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { listSavedCandidates, saveCandidate } from '@/lib/scoring/service';
import { isUuid, parseCandidateRequest } from '@/lib/scoring/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Saved candidate locations of one project, read as coordinate pairs. Map clicks
 * stay transient in the browser until the user saves them here.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireScoringAccess(workspaceId, 'read');
    if (isScoringDenied(access)) return access.response;

    const projectId = request.nextUrl.searchParams.get('projectId');
    if (projectId !== null && !isUuid(projectId)) {
      return scoringErrorResponse(400, 'invalid_request', 'A valid project id is required.');
    }

    const result = await listSavedCandidates(workspaceId, projectId);
    return scoringJsonResponse(result);
  } catch (error) {
    return handleScoringRouteError('candidates/list', error);
  }
}

/**
 * Saves one candidate location. Owner, admin or analyst only; the project must
 * belong to the workspace, which the RPC verifies through its composite key.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireScoringAccess(workspaceId, 'run');
    if (isScoringDenied(access)) return access.response;

    const body: unknown = await request.json().catch(() => null);
    const input = parseCandidateRequest(body);

    const candidate = await saveCandidate(workspaceId, input);
    return scoringJsonResponse({ candidate }, 201);
  } catch (error) {
    return handleScoringRouteError('candidates/save', error);
  }
}
