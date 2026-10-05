import type { NextRequest } from 'next/server';

import { handleReportRouteError, reportJsonResponse } from '@/lib/reports/http';
import { isReportDenied, requireReportAccess } from '@/lib/reports/route-guard';
import { generateReport } from '@/lib/reports/service';
import { parseReportId } from '@/lib/reports/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

/**
 * Generates the PDF of one report, synchronously, inside this request: no
 * background job, no unawaited promise. The stored snapshot is hash-verified
 * before anything is rendered, the artifacts are uploaded to private storage and
 * only then is the report marked `ready`.
 *
 * Calling this again means "regenerate the same snapshot"; it never reruns the
 * analysis and never picks up a new model revision. Owner/admin/analyst only.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'run');
    if (isReportDenied(access)) return access.response;

    const result = await generateReport(workspaceId, parseReportId(reportId));
    return reportJsonResponse(result);
  } catch (error) {
    return handleReportRouteError('reports/generate', error);
  }
}
