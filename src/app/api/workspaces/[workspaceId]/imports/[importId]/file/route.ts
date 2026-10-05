import type { NextRequest } from 'next/server';

import { handleImportRouteError, importErrorResponse, importJsonResponse } from '@/lib/imports/http';
import { IMPORT_LIMITS } from '@/lib/imports/limits';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { uploadImportFile } from '@/lib/imports/service';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Uploads the source file into the private workspace bucket and inspects it.
 *
 * The declared MIME type is ignored: the bytes decide what the file is, the
 * extension has to agree, and oversized uploads are refused before anything is
 * stored. The storage path is built on the server from the workspace and import
 * ids, so a crafted filename cannot escape the workspace prefix.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; importId: string }> },
) {
  try {
    const { workspaceId, importId } = await params;
    const access = await requireImportAccess(workspaceId, { write: true });
    if (isDenied(access)) return access.response;

    const declaredLength = Number.parseInt(request.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > IMPORT_LIMITS.maxFileBytes * 2) {
      return importErrorResponse(413, 'file_too_large', 'Files must be 5 MB or smaller.');
    }

    const formData = await request.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) {
      return importErrorResponse(400, 'invalid_request', 'Attach one CSV or XLSX file.');
    }

    const sheetName = formData?.get('sheetName');
    const bytes = new Uint8Array(await file.arrayBuffer());

    const result = await uploadImportFile({
      workspaceId,
      importId,
      bytes,
      sheetName: typeof sheetName === 'string' && sheetName.trim() !== '' ? sheetName.trim() : null,
    });

    return importJsonResponse(result);
  } catch (error) {
    return handleImportRouteError('imports/upload', error);
  }
}
