import type { NextRequest } from 'next/server';

import { handleReportRouteError, reportJsonResponse } from '@/lib/reports/http';
import { isReportDenied, requireReportAccess } from '@/lib/reports/route-guard';
import { getReport, updateReportPresentation } from '@/lib/reports/service';
import { parseReportId, parseReportUpdateRequest } from '@/lib/reports/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * One report and its view model. The view model is built on the server from the
 * stored snapshot, so the preview the browser shows and the PDF the server
 * renders are the same object.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'read');
    if (isReportDenied(access)) return access.response;

    const result = await getReport(workspaceId, parseReportId(reportId));
    return reportJsonResponse(result);
  } catch (error) {
    return handleReportRouteError('reports/get', error);
  }
}

/**
 * Renames a report. Only presentation fields are touched; the database trigger
 * freezes the analytical snapshot even if a caller tries to send one.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'run');
    if (isReportDenied(access)) return access.response;

    const body: unknown = await request.json().catch(() => null);
    const input = parseReportUpdateRequest(body);

    const report = await updateReportPresentation(workspaceId, parseReportId(reportId), input);
    return reportJsonResponse({ report });
  } catch (error) {
    return handleReportRouteError('reports/update', error);
  }
}
