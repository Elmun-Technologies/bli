import 'server-only';

import { NextResponse } from 'next/server';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';

import {
  ScoringAccessError,
  ScoringNotFoundError,
  ScoringQueryError,
  ScoringRequestError,
  ScoringSessionError,
} from './service';
import { ScoringPayloadError } from './payload';
import { ScoringValidationError } from './validation';

/**
 * Structured, safe error codes for the scoring API. Internal diagnostics stay in
 * the server log: no SQL, no policy names, no schema names and never a raw
 * database message.
 */
export const SCORING_ERROR_CODES = [
  'invalid_request',
  'invalid_model',
  'duplicate_model',
  'invalid_candidate',
  'invalid_selection',
  'not_found',
  'session_expired',
  'workspace_forbidden',
  'database_unavailable',
  'internal_error',
] as const;

export type ScoringErrorCode = (typeof SCORING_ERROR_CODES)[number];

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function scoringErrorResponse(
  status: 400 | 401 | 403 | 404 | 409 | 500,
  code: ScoringErrorCode,
  message: string,
) {
  return NextResponse.json({ error: { code, message } }, { status, headers: NO_STORE_HEADERS });
}

export function scoringJsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function mapRequestCode(code: string): ScoringErrorCode {
  switch (code) {
    case 'duplicate_model':
      return 'duplicate_model';
    case 'invalid_model':
      return 'invalid_model';
    default:
      return 'invalid_request';
  }
}

export function handleScoringRouteError(scope: string, error: unknown) {
  if (error instanceof ScoringValidationError) {
    return scoringErrorResponse(400, 'invalid_request', error.message);
  }
  if (error instanceof ScoringSessionError) {
    return scoringErrorResponse(401, 'session_expired', SAFE_AUTH_MESSAGES.sessionExpired);
  }
  if (error instanceof ScoringAccessError) {
    return scoringErrorResponse(403, 'workspace_forbidden', error.message);
  }
  if (error instanceof ScoringNotFoundError) {
    return scoringErrorResponse(404, 'not_found', error.message);
  }
  if (error instanceof ScoringRequestError) {
    const status = error.code === 'duplicate_model' ? 409 : 400;
    return scoringErrorResponse(status, mapRequestCode(error.code), error.message);
  }
  if (error instanceof ScoringPayloadError) {
    console.error(`[scoring:${scope}] payload contract failure`, error);
    return scoringErrorResponse(500, 'internal_error', 'The analysis could not be read.');
  }
  if (error instanceof ScoringQueryError) {
    console.error(`[scoring:${scope}] database failure`, error.cause ?? error);
    return scoringErrorResponse(500, 'database_unavailable', 'The scoring request could not be completed.');
  }

  console.error(`[scoring:${scope}] unexpected failure`, error);
  return scoringErrorResponse(500, 'internal_error', 'The request could not be completed.');
}
