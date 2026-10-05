/**
 * Browser-side import API client.
 *
 * Only relative URLs, only the caller's own session, and never a workspace id
 * taken from anywhere but the route the page was opened with. The server
 * re-resolves membership on every call; nothing here is a security decision.
 */

export interface ImportApiError {
  code: string;
  message: string;
}

export class ImportRequestFailure extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ImportRequestFailure';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  workspaceId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/imports${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const error = (payload as { error?: ImportApiError } | null)?.error;
    throw new ImportRequestFailure(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'The import request failed.',
    );
  }

  return payload as T;
}

export interface ImportJobPayload {
  id: string;
  workspaceId: string;
  originalFilename: string;
  fileType: 'csv' | 'xlsx';
  status: string;
  targetEntity: 'customers' | 'locations';
  datasetId: string | null;
  sheetName: string | null;
  sheets: Array<{ name: string; index: number; rowCount: number; usable: boolean }>;
  headers: string[];
  warnings: string[];
  mapping: Record<string, string>;
  suggestions: Array<{ header: string; field: string | null; confidence: 'exact' | 'partial' | 'none' }>;
  counters: {
    totalRows: number;
    validRows: number;
    invalidRows: number;
    needsGeocodingRows: number;
    geocodedRows: number;
    failedGeocodingRows: number;
    committedRows: number;
  };
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface PreviewRowPayload {
  rowId: string;
  rowNumber: number;
  validationStatus: string;
  geocodingStatus: string;
  rawData: Record<string, string | null>;
  normalizedData: Record<string, string | null>;
  errors: Array<{ code: string; field: string; message: string }>;
  geocoding: Record<string, unknown> | null;
  manualOverride: boolean;
  longitude: number | null;
  latitude: number | null;
  committedRecordId: string | null;
}

export interface PreviewPagePayload {
  rows: PreviewRowPayload[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function listImports(workspaceId: string) {
  return request<{ imports: ImportJobPayload[] }>(workspaceId, '');
}

export function createImport(
  workspaceId: string,
  body: { filename: string; fileType: 'csv' | 'xlsx'; targetEntity: 'customers' | 'locations' },
) {
  return request<{ import: ImportJobPayload }>(workspaceId, '', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function getImport(workspaceId: string, importId: string) {
  return request<{ import: ImportJobPayload }>(workspaceId, `/${importId}`);
}

export function uploadImportFile(
  workspaceId: string,
  importId: string,
  file: File,
  sheetName?: string | null,
) {
  const formData = new FormData();
  formData.append('file', file);
  if (sheetName) formData.append('sheetName', sheetName);

  // The browser's own MIME guess is not sent as an assertion of anything; the
  // server sniffs the bytes and requires the extension to agree.
  return request<{ job: ImportJobPayload; requiresSheetSelection: boolean; suggestions: ImportJobPayload['suggestions'] }>(
    workspaceId,
    `/${importId}/file`,
    { method: 'POST', body: formData },
  );
}

export function applyMapping(
  workspaceId: string,
  importId: string,
  mapping: Record<string, string>,
) {
  return request<{
    job: ImportJobPayload;
    staged: number;
    valid: number;
    invalid: number;
    needsGeocoding: number;
    warnings: string[];
  }>(workspaceId, `/${importId}/mapping`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mapping }),
  });
}

/**
 * The geocoding batch summary is the JSONB returned by the
 * `apply_import_geocoding_results` RPC, so it keeps the database's snake_case
 * counters. Extra counter fields may appear as the RPC grows.
 */
export interface GeocodeBatchSummaryPayload {
  applied: number;
  skipped: number;
  /** Present when nothing was claimable and the server short-circuits the batch. */
  claimed?: number;
  accepted?: number;
  ambiguous?: number;
  no_match?: number;
  rate_limited?: number;
  provider_error?: number;
  valid_rows?: number;
  invalid_rows?: number;
  needs_geocoding_rows?: number;
  geocoded_rows?: number;
  failed_geocoding_rows?: number;
  committed_rows?: number;
  job_status?: string;
  [key: string]: unknown;
}

export function runGeocodeBatch(workspaceId: string, importId: string, limit = 25) {
  return request<{ summary: GeocodeBatchSummaryPayload }>(workspaceId, `/${importId}/geocode-batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
}

export function setManualPoint(
  workspaceId: string,
  importId: string,
  rowId: string,
  longitude: number,
  latitude: number,
) {
  return request<{ import: ImportJobPayload }>(
    workspaceId,
    `/${importId}/rows/${rowId}/point`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ longitude, latitude }),
    },
  );
}

/**
 * The commit summary mirrors the `commit_import_job` RPC result, serialised by
 * the service with camelCase keys. It is typed (not a loose record) so a route
 * that changed a key would fail type-checking instead of silently reporting
 * "dataset updated" for a newly created dataset.
 */
export interface CommitSummaryPayload {
  jobId: string;
  targetDatasetId: string;
  datasetCreated: boolean;
  insertedRows: number;
  conflictingRows: number;
  previouslyCommittedRows: number;
  jobStatus: string;
}

export function commitImport(
  workspaceId: string,
  importId: string,
  destination: { datasetId?: string | null; newDatasetName?: string | null; newDatasetType?: string | null },
) {
  return request<{ summary: CommitSummaryPayload }>(workspaceId, `/${importId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(destination),
  });
}

export function listImportRows(
  workspaceId: string,
  importId: string,
  options: { status?: string; page?: number; pageSize?: number } = {},
) {
  const search = new URLSearchParams();
  if (options.status) search.set('status', options.status);
  if (options.page) search.set('page', String(options.page));
  if (options.pageSize) search.set('pageSize', String(options.pageSize));
  const query = search.toString();
  return request<PreviewPagePayload>(workspaceId, `/${importId}/rows${query ? `?${query}` : ''}`);
}

export function errorExportUrl(workspaceId: string, importId: string, status?: 'invalid' | 'review') {
  const suffix = status ? `?status=${status}` : '';
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/imports/${encodeURIComponent(importId)}/errors.csv${suffix}`;
}

export function listDatasets(workspaceId: string) {
  return fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/datasets`, {
    credentials: 'same-origin',
    cache: 'no-store',
  }).then(async (response) => {
    const payload = (await response.json().catch(() => null)) as
      | { datasets?: Array<{ id: string; name: string; type: string }>; error?: ImportApiError }
      | null;
    if (!response.ok) {
      throw new ImportRequestFailure(
        response.status,
        payload?.error?.code ?? 'request_failed',
        payload?.error?.message ?? 'Datasets could not be listed.',
      );
    }
    return payload?.datasets ?? [];
  });
}
