import type { NextRequest } from 'next/server';

import { handleReportRouteError } from '@/lib/reports/http';
import { isReportDenied, requireReportAccess } from '@/lib/reports/route-guard';
import { downloadReportArtifact } from '@/lib/reports/service';
import { parseReportId } from '@/lib/reports/validation';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The stored static map image of a report, for the HTML preview.
 *
 * Same authorization as the PDF: membership plus the row's own visibility, and
 * the object is read under the caller's session so the private storage policy is
 * exercised on every preview. A report without a map answers 404 and the preview
 * shows the documented explanation instead.
 */
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
      'map',
    );

    // Inline (not an attachment): the preview embeds it as an <img>.
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return handleReportRouteError('reports/map', error);
  }
}
