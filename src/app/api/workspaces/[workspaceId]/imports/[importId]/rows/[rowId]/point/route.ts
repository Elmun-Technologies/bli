import type { NextRequest } from 'next/server';

import { handleImportRouteError, importErrorResponse, importJsonResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { setImportRowPoint } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Records a manual map placement for one staged row.
 *
 * Manual placement is authoritative: the coordinates are validated here and
 * again inside the database function, the original address is left untouched,
 * and the row is flagged as a manual override so the summary can say where the
 * point came from.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string; rowId: string }> },
) {
  try {
    const { workspaceId, importId, rowId } = await params;
    const access = await requireImportAccess(workspaceId, { write: true });
    if (isDenied(access)) return access.response;

    const body = (await request.json().catch(() => null)) as
      | { longitude?: unknown; latitude?: unknown }
      | null;

    if (typeof body?.longitude !== 'number' || typeof body?.latitude !== 'number') {
      return importErrorResponse(400, 'invalid_request', 'Longitude and latitude are required.');
    }

    const job = await setImportRowPoint({
      workspaceId,
      importId,
      rowId,
      longitude: body.longitude,
      latitude: body.latitude,
    });

    return importJsonResponse({ import: job });
  } catch (error) {
    return handleImportRouteError('imports/manual-point', error);
  }
}
