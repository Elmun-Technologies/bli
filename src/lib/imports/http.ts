import 'server-only';

import { NextResponse } from 'next/server';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';

import {
  ImportAccessError,
  ImportGeocodingUnavailableError,
  ImportNotFoundError,
  ImportQueryError,
  ImportRequestError,
  ImportSessionError,
  ImportStorageError,
} from './service';

/**
 * Structured, safe error codes for the import API. Internal diagnostics stay in
 * the server log: no SQL, no policy names, no storage paths, no stack traces and
 * never the Mapbox token.
 */
export const IMPORT_ERROR_CODES = [
  'invalid_request',
  'invalid_file',
  'file_too_large',
  'unsupported_type',
  'sheet_required',
  'invalid_mapping',
  'invalid_destination',
  'cross_workspace_dataset',
  'not_found',
  'session_expired',
  'workspace_forbidden',
  'geocoding_unavailable',
  'storage_unavailable',
  'database_unavailable',
  'internal_error',
] as const;

export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function importErrorResponse(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503,
  code: ImportErrorCode,
  message: string,
) {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

export function importJsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export function importCsvResponse(filename: string, csv: string) {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      // The filename is sanitized in buildErrorExportFilename before it is used.
      'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}

/**
 * Maps service errors onto HTTP status codes. Import parse failures become 400
 * with the parser's own safe message; forbidden and not-found stay deliberately
 * indistinguishable from the outside for foreign tenants.
 */
export function handleImportRouteError(scope: string, error: unknown) {
  if (error instanceof ImportRequestError) {
    const status = error.code === 'file_too_large' ? 413 : 400;
    return importErrorResponse(status, mapRequestCode(error.code), error.message);
  }
  if (error instanceof ImportSessionError) {
    return importErrorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired);
  }
  if (error instanceof ImportAccessError) {
    return importErrorResponse(403, 'workspace_forbidden', SAFE_AUTH_MESSAGES.noWorkspaceAccess);
  }
  if (error instanceof ImportNotFoundError) {
    return importErrorResponse(404, 'not_found', error.message);
  }
  if (error instanceof ImportGeocodingUnavailableError) {
    return importErrorResponse(503, 'geocoding_unavailable', error.message);
  }
  if (error instanceof ImportStorageError) {
    console.error(`[imports:${scope}] storage failure`, error.cause ?? error);
    return importErrorResponse(502, 'storage_unavailable', error.message);
  }
  if (error instanceof ImportQueryError) {
    console.error(`[imports:${scope}] database failure`, error.cause ?? error);
    return importErrorResponse(500, 'database_unavailable', 'The import could not be completed.');
  }

  console.error(`[imports:${scope}] unexpected failure`, error);
  return importErrorResponse(500, 'internal_error', 'The request could not be completed.');
}

function mapRequestCode(code: string): ImportErrorCode {
  switch (code) {
    case 'file_too_large':
      return 'file_too_large';
    case 'unsupported_type':
    case 'file_type_mismatch':
    case 'corrupt_file':
    case 'unreadable_file':
    case 'empty_file':
    case 'duplicate_header':
    case 'missing_header':
    case 'no_data_rows':
    case 'too_many_rows':
    case 'too_many_columns':
    case 'invalid_filename':
      return 'invalid_file';
    case 'sheet_selection_required':
    case 'unknown_sheet':
      return 'sheet_required';
    case 'invalid_mapping':
      return 'invalid_mapping';
    case 'invalid_destination':
      return 'invalid_destination';
    case 'cross_workspace_dataset':
      return 'cross_workspace_dataset';
    case 'unknown_workspace':
    case 'already_committed':
    case 'staging_conflict':
    case 'invalid_coordinates':
    case 'ambiguous_destination':
    default:
      return 'invalid_request';
  }
}
