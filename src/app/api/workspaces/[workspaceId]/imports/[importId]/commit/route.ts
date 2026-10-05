import type { NextRequest } from 'next/server';

import { handleImportRouteError, importErrorResponse, importJsonResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { commitImportJob } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Promotes validated staged rows into a dataset, in one transaction.
 *
 * The destination is either an existing dataset of this workspace or a new one;
 * both are validated by `commit_import_job`, and a dataset from another
 * workspace fails at the database with a foreign key error. Rows still needing
 * review stay staged, and the response reports the exact counts.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: true });
    if (isDenied(access)) return access.response;

    const body = (await request.json().catch(() => ({}))) as
      | { datasetId?: unknown; newDatasetName?: unknown; newDatasetType?: unknown }
      | null;

    const datasetId = typeof body?.datasetId === 'string' ? body.datasetId.trim() : null;
    if (datasetId && !UUID_PATTERN.test(datasetId)) {
      return importErrorResponse(400, 'invalid_destination', 'The destination dataset is not valid.');
    }

    const summary = await commitImportJob({
      workspaceId,
      importId,
      datasetId,
      newDatasetName: typeof body?.newDatasetName === 'string' ? body.newDatasetName : null,
      newDatasetType: typeof body?.newDatasetType === 'string' ? body.newDatasetType : null,
    });

    return importJsonResponse({ summary });
  } catch (error) {
    return handleImportRouteError('imports/commit', error);
  }
}
