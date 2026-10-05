import type { NextRequest } from 'next/server';

import { handleReportRouteError, reportJsonResponse } from '@/lib/reports/http';
import { isReportDenied, requireReportAccess } from '@/lib/reports/route-guard';
import { createReport, listReports } from '@/lib/reports/service';
import {
  isUuid,
  parseLimit,
  parseReportCreateRequest,
  parseStatusFilter,
  ReportValidationError,
} from '@/lib/reports/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Project-scoped report history (membership required).
 *
 * Phase 6.5 project context applies unchanged: with several projects an unnamed
 * request is refused instead of being answered from the oldest project, and a
 * project the caller may not use fails exactly like a missing one.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireReportAccess(workspaceId, 'read');
    if (isReportDenied(access)) return access.response;

    const projectId = request.nextUrl.searchParams.get('projectId');
    if (projectId !== null && !isUuid(projectId)) {
      // A malformed id is a client mistake, never a 500 and never a hint about
      // resources that may or may not exist.
      throw new ReportValidationError('A valid project id is required.');
    }

    const result = await listReports(workspaceId, projectId, {
      status: parseStatusFilter(request.nextUrl.searchParams.get('status')),
      limit: parseLimit(request.nextUrl.searchParams.get('limit')),
    });

    return reportJsonResponse(result);
  } catch (error) {
    return handleReportRouteError('reports/list', error);
  }
}

/**
 * Creates one report from one stored analysis. Owner/admin/analyst only.
 *
 * The snapshot is built here, once, from the stored analysis payload; the
 * analysis is never rerun, and nothing about the workspace's current data is
 * read.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireReportAccess(workspaceId, 'run');
    if (isReportDenied(access)) return access.response;

    const body: unknown = await request.json().catch(() => null);
    const input = parseReportCreateRequest(body);

    const report = await createReport(workspaceId, input);
    return reportJsonResponse({ report }, 201);
  } catch (error) {
    return handleReportRouteError('reports/create', error);
  }
}
