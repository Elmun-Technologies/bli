import type { NextRequest } from 'next/server';

import { importErrorResponse, handleImportRouteError, importJsonResponse } from '@/lib/imports/http';
import { IMPORT_FILE_TYPES, IMPORT_TARGET_ENTITIES, type ImportFileType, type ImportTargetEntity } from '@/lib/imports/limits';
import { isDenied, requireImportAccess } from '@/lib/imports/route-guard';
import { createImportJob, listImportJobs } from '@/lib/imports/service';

// Imports reflect live staging state and the caller's own session.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Lists this workspace's imports (membership required, RLS-scoped). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireImportAccess(workspaceId, { write: false });
    if (isDenied(access)) return access.response;

    return importJsonResponse({ imports: await listImportJobs(workspaceId) });
  } catch (error) {
    return handleImportRouteError('imports/list', error);
  }
}

/**
 * Starts an import: creates the job that owns the upload, the staged rows and
 * the audit trail. The workspace comes from the path and is re-checked here and
 * by the insert policy; a body or query workspace id is never consulted.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const { workspaceId } = await params;
    const access = await requireImportAccess(workspaceId, { write: true });
    if (isDenied(access)) return access.response;

    const body = (await request.json().catch(() => null)) as
      | { filename?: unknown; fileType?: unknown; targetEntity?: unknown }
      | null;

    const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
    const fileType = body?.fileType;
    const targetEntity = body?.targetEntity;

    if (!filename) {
      return importErrorResponse(400, 'invalid_request', 'A file name is required.');
    }
    if (!IMPORT_FILE_TYPES.includes(fileType as ImportFileType)) {
      return importErrorResponse(400, 'invalid_request', 'Only CSV and XLSX imports are supported.');
    }
    if (!IMPORT_TARGET_ENTITIES.includes(targetEntity as ImportTargetEntity)) {
      return importErrorResponse(400, 'invalid_request', 'Choose whether customer or location data is imported.');
    }

    const job = await createImportJob({
      workspaceId,
      originalFilename: filename,
      fileType: fileType as ImportFileType,
      targetEntity: targetEntity as ImportTargetEntity,
    });

    return importJsonResponse({ import: job }, 201);
  } catch (error) {
    return handleImportRouteError('imports/create', error);
  }
}
