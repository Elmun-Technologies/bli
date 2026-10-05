/**
 * Request validation for the report API and the report UI.
 *
 * The database validates ownership, shape and lifecycle again; this module
 * exists so a user gets a precise, safe message before a round trip and so the
 * interface can disable an impossible action. It is never the authority.
 */

import { REPORT_LOGO_MAX_BYTES, sniffImage } from './pdf/image';
import type { ReportStatus, ReportType } from './types';

export class ReportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportValidationError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly ReportStatus[] = ['draft', 'generating', 'ready', 'failed'];

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new ReportValidationError(`A valid ${field} is required.`);
  return value;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ReportValidationError(`The ${field} must be text.`);
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > maxLength) {
    throw new ReportValidationError(`The ${field} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

export interface ReportCreateInput {
  projectId: string;
  analysisId: string;
  title: string | null;
  subtitle: string | null;
  companyName: string | null;
  includeMap: boolean;
}

/**
 * The create request. `workspaceId` is never taken from the body: it comes from
 * the verified route path and the caller's own membership. The project and the
 * analysis are both explicit, and both are verified again server-side.
 */
export function parseReportCreateRequest(body: unknown): ReportCreateInput {
  if (typeof body !== 'object' || body === null) {
    throw new ReportValidationError('A JSON body is required.');
  }
  const raw = body as Record<string, unknown>;
  const includeMap = raw.includeMap === undefined ? true : raw.includeMap === true;
  const title = optionalText(raw.title, 'report title', 160);

  return {
    projectId: requireUuid(raw.projectId, 'project id'),
    analysisId: requireUuid(raw.analysisId, 'analysis id'),
    title,
    subtitle: optionalText(raw.subtitle, 'subtitle', 200),
    companyName: optionalText(raw.companyName, 'company name', 160),
    includeMap,
  };
}

export interface ReportUpdateInput {
  title: string;
  subtitle: string | null;
  companyName: string | null;
}

/**
 * Presentation-only update. Nothing analytical is editable: the database trigger
 * refuses to rewrite the snapshot even if a caller tries.
 */
export function parseReportUpdateRequest(body: unknown): ReportUpdateInput {
  if (typeof body !== 'object' || body === null) {
    throw new ReportValidationError('A JSON body is required.');
  }
  const raw = body as Record<string, unknown>;
  const title = optionalText(raw.title, 'report title', 160);
  if (!title) throw new ReportValidationError('A report title is required.');

  return {
    title,
    subtitle: optionalText(raw.subtitle, 'subtitle', 200),
    companyName: optionalText(raw.companyName, 'company name', 160),
  };
}

export function parseReportId(value: unknown): string {
  return requireUuid(value, 'report id');
}

export function parseStatusFilter(value: unknown): ReportStatus | null {
  if (value === null || value === undefined || value === '') return null;
  if (!STATUSES.includes(value as ReportStatus)) {
    throw new ReportValidationError('The status filter must be draft, generating, ready or failed.');
  }
  return value as ReportStatus;
}

export function parseLimit(value: unknown): number {
  const limit = Number(value ?? '25');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ReportValidationError('The limit must be a whole number between 1 and 100.');
  }
  return limit;
}

export interface LogoUpload {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

/**
 * A logo must be a real PNG or JPEG under 2 MB. The declared content type is
 * only a hint: the bytes decide, and SVG (or any other scriptable format) is
 * refused outright.
 */
export function parseLogoUpload(bytes: Uint8Array, declaredType: string | null): LogoUpload {
  if (bytes.byteLength === 0) throw new ReportValidationError('The logo file is empty.');
  if (bytes.byteLength > REPORT_LOGO_MAX_BYTES) {
    throw new ReportValidationError('The logo must be 2 MB or smaller.');
  }

  const sniffed = sniffImage(bytes);
  if (!sniffed) {
    throw new ReportValidationError('The logo must be a PNG or JPEG image.');
  }
  if (declaredType && !declaredType.startsWith('image/')) {
    throw new ReportValidationError('The logo must be a PNG or JPEG image.');
  }
  if (declaredType === 'image/png' && sniffed.format !== 'image/png') {
    throw new ReportValidationError('The logo bytes are not a PNG image.');
  }
  if (declaredType === 'image/jpeg' && sniffed.format !== 'image/jpeg') {
    throw new ReportValidationError('The logo bytes are not a JPEG image.');
  }

  return { bytes, mimeType: sniffed.format };
}

export function isReportType(value: unknown): value is ReportType {
  return value === 'single_location' || value === 'comparison';
}
