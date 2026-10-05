import type { NextRequest } from 'next/server';

import { handleReportRouteError, reportBinaryResponse, reportJsonResponse } from '@/lib/reports/http';
import { isReportDenied, requireReportAccess } from '@/lib/reports/route-guard';
import { clearReportLogo, downloadReportArtifact, setReportLogo } from '@/lib/reports/service';
import { parseLogoUpload, parseReportId } from '@/lib/reports/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** The stored logo, for the preview. Members only, like every report read. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'read');
    if (isReportDenied(access)) return access.response;

    const { bytes, mimeType } = await downloadReportArtifact(
      workspaceId,
      parseReportId(reportId),
      'logo',
    );
    return reportBinaryResponse(bytes, mimeType, 'logo');
  } catch (error) {
    return handleReportRouteError('reports/logo.get', error);
  }
}

/**
 * Uploads a report logo. Owner/admin only.
 *
 * The bytes are the authority: a PNG or JPEG signature must be present and the
 * file must be 2 MB or smaller. SVG and every other format are refused. The
 * object goes to the private bucket under the report's own prefix.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'manage');
    if (isReportDenied(access)) return access.response;

    const bytes = new Uint8Array(await request.arrayBuffer());
    const upload = parseLogoUpload(bytes, request.headers.get('content-type'));

    const report = await setReportLogo(workspaceId, parseReportId(reportId), upload);
    return reportJsonResponse({ report });
  } catch (error) {
    return handleReportRouteError('reports/logo.put', error);
  }
}

/** Removes the logo reference (the stored object stays for the audit trail). */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; reportId: string }> },
) {
  try {
    const { workspaceId, reportId } = await params;
    const access = await requireReportAccess(workspaceId, 'manage');
    if (isReportDenied(access)) return access.response;

    const report = await clearReportLogo(workspaceId, parseReportId(reportId));
    return reportJsonResponse({ report });
  } catch (error) {
    return handleReportRouteError('reports/logo.delete', error);
  }
}
