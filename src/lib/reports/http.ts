import 'server-only';

import { NextResponse } from 'next/server';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';

import { REPORT_SAFE_MESSAGES } from './messages';
import { ReportValidationError } from './validation';
import { ReportPayloadError } from './parser';
import {
  ReportAccessError,
  ReportGenerationError,
  ReportIntegrityError,
  ReportNotFoundError,
  ReportQueryError,
  ReportRequestError,
  ReportSessionError,
  ReportStorageError,
} from './service';

/**
 * Structured, safe error codes for the report API. Internal diagnostics stay in
 * the server log: no SQL, no policy names, no storage paths, no map token and
 * never a raw database message.
 */
export const REPORT_ERROR_CODES = [
  'invalid_request',
  'project_required',
  'no_project',
  'access_denied',
  'report_not_found',
  'report_not_ready',
  'report_generation_failed',
  'report_integrity_failed',
  'storage_unavailable',
  'session_expired',
  'database_unavailable',
  'internal_error',
] as const;

export type ReportErrorCode = (typeof REPORT_ERROR_CODES)[number];

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function reportErrorResponse(
  status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
  code: ReportErrorCode,
  message: string,
) {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

export function reportJsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/** A binary artifact: never cached, never sniffable as HTML. */
export function reportBinaryResponse(
  bytes: Uint8Array,
  contentType: string,
  filename: string,
) {
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function handleReportRouteError(scope: string, error: unknown) {
  if (error instanceof ReportValidationError) {
    return reportErrorResponse(400, 'invalid_request', error.message);
  }
  if (error instanceof ReportSessionError) {
    return reportErrorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired);
  }
  if (error instanceof ReportAccessError) {
    return reportErrorResponse(403, 'access_denied', error.message);
  }
  if (error instanceof ReportNotFoundError) {
    return reportErrorResponse(404, 'report_not_found', error.message);
  }
  if (error instanceof ReportIntegrityError) {
    console.error(`[reports:${scope}] snapshot integrity failure`, error);
    return reportErrorResponse(409, 'report_integrity_failed', REPORT_SAFE_MESSAGES.report_integrity_failed);
  }
  if (error instanceof ReportStorageError) {
    console.error(`[reports:${scope}] storage failure`, error.cause ?? error);
    return reportErrorResponse(502, 'storage_unavailable', error.message);
  }
  if (error instanceof ReportGenerationError) {
    // The snapshot is untouched and the report is marked failed, so a retry is
    // always possible: this is a 502 with a safe reason, never a stack trace.
    console.error(`[reports:${scope}] generation failure`, error.cause ?? error);
    return reportErrorResponse(502, 'report_generation_failed', error.message);
  }
  if (error instanceof ReportRequestError) {
    const status = error.code === 'project_required' || error.code === 'no_project' ? 400 : 400;
    return reportErrorResponse(
      status,
      (error.code as ReportErrorCode) ?? 'invalid_request',
      error.message,
    );
  }
  if (error instanceof ReportPayloadError) {
    console.error(`[reports:${scope}] payload contract failure`, error);
    return reportErrorResponse(500, 'internal_error', 'The report could not be read.');
  }
  if (error instanceof ReportQueryError) {
    console.error(`[reports:${scope}] database failure`, error.cause ?? error);
    return reportErrorResponse(500, 'database_unavailable', 'The report request could not be completed.');
  }

  console.error(`[reports:${scope}] unexpected failure`, error);
  return reportErrorResponse(500, 'internal_error', 'The request could not be completed.');
}
