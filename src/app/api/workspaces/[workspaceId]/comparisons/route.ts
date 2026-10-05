import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringJsonResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { runScoringAnalysis } from '@/lib/scoring/service';
import { parseScoringRunRequest } from '@/lib/scoring/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Runs and stores one comparison of two to five saved candidate locations. One
 * radius and one model apply to the whole comparison, so the rows are directly
 * comparable; the stored payload records both. Owner, admin or analyst only.
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
    const runRequest = parseScoringRunRequest(body, 'comparison');

    const comparison = await runScoringAnalysis(workspaceId, runRequest);
    return scoringJsonResponse(comparison, 201);
  } catch (error) {
    return handleScoringRouteError('comparisons/run', error);
  }
}
