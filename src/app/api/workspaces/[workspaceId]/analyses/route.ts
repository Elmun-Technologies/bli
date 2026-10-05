import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringErrorResponse, scoringJsonResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { listStoredAnalyses, runScoringAnalysis } from '@/lib/scoring/service';
import { isUuid, parseScoringRunRequest } from '@/lib/scoring/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Stored analyses of one project, newest first (membership required). */
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

    const limit = Number(request.nextUrl.searchParams.get('limit') ?? '20');
    const mode = request.nextUrl.searchParams.get('mode');
    if (mode !== null && mode !== 'analysis' && mode !== 'comparison') {
      return scoringErrorResponse(400, 'invalid_request', 'The mode filter must be "analysis" or "comparison".');
    }

    const result = await listStoredAnalyses(
      workspaceId,
      projectId,
      mode,
      Number.isInteger(limit) ? limit : 20,
    );
    return scoringJsonResponse(result);
  } catch (error) {
    return handleScoringRouteError('analyses/list', error);
  }
}

/**
 * Runs and stores one analysis of a single candidate location. The user chooses
 * the candidate, the radius and the model explicitly; nothing is scored
 * automatically. Owner, admin or analyst only.
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
    const runRequest = parseScoringRunRequest(body, 'analysis');
    if (runRequest.candidateIds.length !== 1) {
      return scoringErrorResponse(
        400,
        'invalid_selection',
        'An analysis scores one candidate location; use the comparison endpoint for two to five.',
      );
    }

    const analysis = await runScoringAnalysis(workspaceId, runRequest);
    return scoringJsonResponse(analysis, 201);
  } catch (error) {
    return handleScoringRouteError('analyses/run', error);
  }
}
