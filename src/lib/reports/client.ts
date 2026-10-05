/**
 * Browser-side report API client.
 *
 * Only relative URLs, only the caller's own session, and never a workspace id
 * taken from anywhere but the route the page was opened with. Every call is
 * validated again on the server; nothing here is a security decision.
 */

import {
  parseReportDetailResponse,
  parseReportListResponse,
  parseReportMutationResponse,
  type ReportDetailResponse,
  type ReportListResponse,
} from './parser';
import type { ReportStatus, ReportSummary } from './types';

export interface ReportsApiErrorBody {
  code: string;
  message: string;
}

export class ReportsApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ReportsApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  workspaceId: string,
  path: string,
  parse: (payload: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}${path}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const error = (payload as { error?: ReportsApiErrorBody } | null)?.error;
    throw new ReportsApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'The report request failed.',
    );
  }

  return parse(payload);
}

/**
 * Project-scoped report history. With several projects an unnamed project is
 * refused by the server instead of being guessed; `projectId` is null only for
 * the zero-project empty state.
 */
export function listReports(
  workspaceId: string,
  projectId: string | null,
  options: { status?: ReportStatus | null; limit?: number } = {},
): Promise<ReportListResponse> {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (options.status) params.set('status', options.status);
  params.set('limit', String(options.limit ?? 25));

  return request(workspaceId, `/reports?${params.toString()}`, parseReportListResponse);
}

export function getReport(workspaceId: string, reportId: string): Promise<ReportDetailResponse> {
  return request(
    workspaceId,
    `/reports/${encodeURIComponent(reportId)}`,
    parseReportDetailResponse,
  );
}

export function createReport(
  workspaceId: string,
  input: {
    projectId: string;
    analysisId: string;
    title?: string | null;
    subtitle?: string | null;
    companyName?: string | null;
    includeMap?: boolean;
  },
): Promise<ReportSummary> {
  return request(workspaceId, '/reports', parseReportMutationResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: input.projectId,
      analysisId: input.analysisId,
      title: input.title ?? null,
      subtitle: input.subtitle ?? null,
      companyName: input.companyName ?? null,
      includeMap: input.includeMap ?? true,
    }),
  });
}

export function updateReport(
  workspaceId: string,
  reportId: string,
  input: { title: string; subtitle?: string | null; companyName?: string | null },
): Promise<ReportSummary> {
  return request(workspaceId, `/reports/${encodeURIComponent(reportId)}`, parseReportMutationResponse, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      subtitle: input.subtitle ?? null,
      companyName: input.companyName ?? null,
    }),
  });
}

/** Generates the PDF, or regenerates it from the same immutable snapshot. */
export function generateReport(workspaceId: string, reportId: string): Promise<ReportSummary> {
  return request(
    workspaceId,
    `/reports/${encodeURIComponent(reportId)}/generate`,
    parseReportMutationResponse,
    { method: 'POST' },
  );
}

/** Uploads a logo (owner/admin). The bytes are validated again on the server. */
export function uploadReportLogo(
  workspaceId: string,
  reportId: string,
  bytes: Uint8Array,
  mimeType: 'image/png' | 'image/jpeg',
): Promise<ReportSummary> {
  return request(
    workspaceId,
    `/reports/${encodeURIComponent(reportId)}/logo`,
    parseReportMutationResponse,
    {
      method: 'PUT',
      headers: { 'content-type': mimeType },
      body: new Uint8Array(bytes),
    },
  );
}

export function clearReportLogo(workspaceId: string, reportId: string): Promise<ReportSummary> {
  return request(
    workspaceId,
    `/reports/${encodeURIComponent(reportId)}/logo`,
    parseReportMutationResponse,
    { method: 'DELETE' },
  );
}

/** The authenticated artifact URLs the preview embeds. Relative, never public. */
export function reportArtifactUrl(workspaceId: string, reportId: string, kind: 'map' | 'logo'): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/${kind}`;
}

export function reportDownloadUrl(workspaceId: string, reportId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(reportId)}/download`;
}
