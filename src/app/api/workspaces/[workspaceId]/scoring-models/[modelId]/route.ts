import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringJsonResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { getScoringModel, updateScoringModel } from '@/lib/scoring/service';
import { parseModelId, parseScoringModelRequest } from '@/lib/scoring/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** One model with all of its factors (membership required). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; modelId: string }> },
) {
  try {
    const { workspaceId, modelId } = await params;
    const access = await requireScoringAccess(workspaceId, 'read');
    if (isScoringDenied(access)) return access.response;

    const model = await getScoringModel(workspaceId, parseModelId(modelId));
    return scoringJsonResponse({ model });
  } catch (error) {
    return handleScoringRouteError('scoring-models/get', error);
  }
}

/**
 * Replaces a model definition. The whole factor set travels with a save, so the
 * 100 percent weight rule is evaluated on one complete definition and a stored
 * analysis is never recalculated: it keeps the revision it scored with.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; modelId: string }> },
) {
  try {
    const { workspaceId, modelId } = await params;
    const access = await requireScoringAccess(workspaceId, 'manage');
    if (isScoringDenied(access)) return access.response;

    const body: unknown = await request.json().catch(() => null);
    const input = parseScoringModelRequest(body);

    const { model, revision } = await updateScoringModel(
      workspaceId,
      parseModelId(modelId),
      input,
    );
    return scoringJsonResponse({ model, revision });
  } catch (error) {
    return handleScoringRouteError('scoring-models/update', error);
  }
}
