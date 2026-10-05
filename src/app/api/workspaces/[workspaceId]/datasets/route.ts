import type { NextRequest } from 'next/server';

import { handleImportRouteError, importJsonResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { listWorkspaceDatasets } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The datasets this workspace can import into. Membership is required, so the
 * list can never become a cross-workspace enumeration endpoint.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireImportAccess(workspaceId, { write: false });
    if (isDenied(access)) return access.response;

    return importJsonResponse({ datasets: await listWorkspaceDatasets(workspaceId) });
  } catch (error) {
    return handleImportRouteError('imports/datasets', error);
  }
}
