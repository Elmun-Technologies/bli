import type { NextRequest } from 'next/server';

import { handleImportRouteError, importJsonResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { getImportJob } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** One import with its counters, columns, mapping and workflow status. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: false });
    if (isDenied(access)) return access.response;

    return importJsonResponse({ import: await getImportJob(workspaceId, importId) });
  } catch (error) {
    return handleImportRouteError('imports/get', error);
  }
}
