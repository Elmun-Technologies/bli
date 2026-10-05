import type { NextRequest } from 'next/server';

import { handleImportRouteError, importCsvResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { exportImportErrors } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Downloads the rows that were not promoted, with the error code and message for
 * each. Values that could be read as a spreadsheet formula are neutralized, so
 * opening the export is safe even though the content came from an upload.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: false });
    if (isDenied(access)) return access.response;

    const requested = request.nextUrl.searchParams.get('status');
    const status = requested === 'invalid' ? 'invalid' : requested === 'review' ? 'review' : 'all';
    const { filename, csv } = await exportImportErrors({ workspaceId, importId, status });
    return importCsvResponse(filename, csv);
  } catch (error) {
    return handleImportRouteError('imports/export', error);
  }
}
