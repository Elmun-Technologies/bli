import type { NextRequest } from 'next/server';

import { handleImportRouteError, importJsonResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { runImportGeocodingBatch } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Runs one bounded geocoding batch and returns the recomputed summary.
 *
 * There is no fake background worker: the browser drives the batches, each call
 * claims a small set of rows with `FOR UPDATE SKIP LOCKED`, resolves them and
 * applies the results atomically. An interrupted batch is requeued by the next
 * call, and rows that are already resolved are never claimed again.
 *
 * The provider call itself happens here, on the server, because the access token
 * must never reach the browser.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: true });
    if (isDenied(access)) return access.response;

    const body = (await request.json().catch(() => ({}))) as { limit?: unknown } | null;
    const limit =
      typeof body?.limit === 'number' && Number.isFinite(body.limit) ? Math.trunc(body.limit) : undefined;

    const { summary } = await runImportGeocodingBatch({ workspaceId, importId, limit });
    return importJsonResponse({ summary });
  } catch (error) {
    return handleImportRouteError('imports/geocode-batch', error);
  }
}
