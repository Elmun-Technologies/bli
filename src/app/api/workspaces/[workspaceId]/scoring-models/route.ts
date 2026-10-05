import type { NextRequest } from 'next/server';

import { handleScoringRouteError, scoringJsonResponse } from '@/lib/scoring/http';
import { isScoringDenied, requireScoringAccess } from '@/lib/scoring/route-guard';
import { createScoringModel, listScoringModels } from '@/lib/scoring/service';
import { parseScoringModelRequest } from '@/lib/scoring/validation';

// Scoring models are live workspace configuration and the caller's own session.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Lists this workspace's scoring models (membership required, RLS-scoped). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireScoringAccess(workspaceId, 'read');
    if (isScoringDenied(access)) return access.response;

    return scoringJsonResponse({ models: await listScoringModels(workspaceId) });
  } catch (error) {
    return handleScoringRouteError('scoring-models/list', error);
  }
}

/**
 * Creates a scoring model with its factors in one transaction. Owner or admin
 * only, enforced here and independently by the RPC and the insert policies.
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
    const input = parseScoringModelRequest(body);

    const model = await createScoringModel(workspaceId, input);
    return scoringJsonResponse({ model }, 201);
  } catch (error) {
    return handleScoringRouteError('scoring-models/create', error);
  }
}
