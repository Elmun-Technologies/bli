import type { NextRequest } from 'next/server';

import { handleImportRouteError, importJsonResponse } from '@/lib/imports/http';
import { IMPORT_LIMITS } from '@/lib/imports/limits';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { listImportRows } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUSES = ['valid', 'invalid', 'needs_geocoding', 'committed', 'all'] as const;
type PreviewStatus = (typeof STATUSES)[number];

/**
 * Paginated, filterable row preview. The table only ever holds one page, so a
 * 10,000-row import never becomes 10,000 DOM nodes, and only mapped fields are
 * projected (a preview is not a way to read other columns back out).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: false });
    if (isDenied(access)) return access.response;

    const search = request.nextUrl.searchParams;
    const requested = search.get('status');
    const status: PreviewStatus = (STATUSES as readonly string[]).includes(requested ?? '')
      ? (requested as PreviewStatus)
      : 'all';
    const page = Number.parseInt(search.get('page') ?? '1', 10);
    const pageSize = Number.parseInt(search.get('pageSize') ?? String(IMPORT_LIMITS.previewPageSize), 10);

    return importJsonResponse(
      await listImportRows({
        workspaceId,
        importId,
        status,
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : IMPORT_LIMITS.previewPageSize,
      }),
    );
  } catch (error) {
    return handleImportRouteError('imports/rows', error);
  }
}
