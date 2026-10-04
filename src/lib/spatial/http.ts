import 'server-only';

import { NextResponse } from 'next/server';

import { DemoWorkspaceLookupError, DemoWorkspaceNotFoundError } from './demo-workspace';
import { SpatialQueryError } from './service';
import { SpatialValidationError } from './validation';

export const SAFE_ERROR_CODES = [
  'invalid_request',
  'demo_workspace_missing',
  'database_unavailable',
  'database_required',
  'internal_error',
] as const;

export type SafeErrorCode = (typeof SAFE_ERROR_CODES)[number];

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/**
 * Structured client errors only. Internal diagnostics stay in server logs and
 * never include credentials, SQL text or stack traces.
 */
export function errorResponse(
  status: 400 | 404 | 500 | 503,
  code: SafeErrorCode,
  message: string,
) {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

export function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export function handleSpatialRouteError(scope: string, error: unknown) {
  if (error instanceof SpatialValidationError) {
    return errorResponse(400, 'invalid_request', error.message);
  }
  if (error instanceof DemoWorkspaceNotFoundError) {
    return errorResponse(
      404,
      'demo_workspace_missing',
      'The synthetic demo workspace is not available in this environment.',
    );
  }
  if (error instanceof DemoWorkspaceLookupError) {
    return errorResponse(500, 'database_unavailable', 'The demo workspace could not be validated.');
  }
  if (error instanceof SpatialQueryError) {
    console.error(`[spatial:${scope}] spatial query failed`, error.cause ?? error);
    return errorResponse(500, 'database_unavailable', 'The spatial database query failed.');
  }

  console.error(`[spatial:${scope}] unexpected failure`, error);
  return errorResponse(500, 'internal_error', 'The request could not be completed.');
}
