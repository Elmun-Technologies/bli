import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringJsonResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { getStoredAnalysis } from '@/lib/scoring/service';
import { parseAnalysisId } from '@/lib/scoring/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * One stored analysis exactly as it was written: the model snapshot, the raw
 * metrics, the normalized values, the contributions and the final score. A
 * foreign or missing analysis answers identically, so the route cannot be used
 * to probe another workspace.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; analysisId: string }> },
) {
  try {
    const { workspaceId, analysisId } = await params;
    const access = await requireScoringAccess(workspaceId, 'read');
    if (isScoringDenied(access)) return access.response;

    const analysis = await getStoredAnalysis(workspaceId, parseAnalysisId(analysisId));
    return scoringJsonResponse(analysis);
  } catch (error) {
    return handleScoringRouteError('analyses/get', error);
  }
}
