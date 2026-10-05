import type { NextRequest } from 'next/server';

import { handleReportRouteError, reportBinaryResponse } from '@/lib/reports/http';
import { isReportDenied, requireReportAccess } from '@/lib/reports/route-guard';
import { downloadReportPdf } from '@/lib/reports/service';
import { parseReportId } from '@/lib/reports/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The authorized PDF download.
 *
 * The object lives in a private bucket at a path derived from the row itself;
 * this route checks the caller's session, workspace membership and the row's
 * visibility under RLS before reading it under the caller's own session, so a
 * leaked path is worthless on its own. The response is never cached and never
 * exposes the storage path.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'read');
    if (isReportDenied(access)) return access.response;

    const { bytes, filename } = await downloadReportPdf(workspaceId, parseReportId(reportId));
    return reportBinaryResponse(bytes, 'application/pdf', filename);
  } catch (error) {
    return handleReportRouteError('reports/download', error);
  }
}
