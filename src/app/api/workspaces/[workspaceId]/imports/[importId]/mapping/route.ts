import type { NextRequest } from 'next/server';

import type { ColumnMapping } from '@/lib/imports/column-mapping';
import { handleImportRouteError, importErrorResponse, importJsonResponse } from '@/lib/imports/http';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { applyImportMapping } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Applies the column mapping and validates the whole file, staging every row
 * with its outcome. Nothing is promoted here: valid rows wait for the commit,
 * invalid rows keep their errors.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: true });
    if (isDenied(access)) return access.response;

    const body = (await request.json().catch(() => null)) as { mapping?: unknown } | null;
    if (body?.mapping === null || typeof body?.mapping !== 'object' || Array.isArray(body?.mapping)) {
      return importErrorResponse(400, 'invalid_mapping', 'A column mapping object is required.');
    }

    const mapping: ColumnMapping = {};
    for (const [header, field] of Object.entries(body.mapping as Record<string, unknown>)) {
      if (typeof field !== 'string' || field.trim() === '') continue;
      mapping[header] = field as ColumnMapping[string];
    }

    return importJsonResponse(await applyImportMapping({ workspaceId, importId, mapping }));
  } catch (error) {
    return handleImportRouteError('imports/mapping', error);
  }
}
