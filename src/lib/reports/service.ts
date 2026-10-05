import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { parseScoringAnalysis } from '@/lib/scoring/payload';
import type { ScoringAnalysisPayload } from '@/lib/scoring/types';
import {
  NO_PROJECT_MESSAGE,
  PROJECT_REQUIRED_MESSAGE,
  resolveProjectContext,
  type WorkspaceProjectSummary,
} from '@/lib/scoring/projects';

import { REPORT_SAFE_MESSAGES } from './messages';
import { parseReportSnapshot, parseReportSummary } from './parser';
import { buildReportSnapshot, hashCanonical, verifySnapshotHash } from './snapshot';
import { resolveReportMapProvider, type ReportMapProvider } from './map';
import { renderReportPdf } from './pdf/render';
import { buildReportViewModel } from './view-model';
import type { ReportStatus, ReportSummary, ReportType, ReportViewModel } from './types';

export const REPORT_STORAGE_BUCKET = 'analysis-reports';
const MAP_WIDTH = 1200;
const MAP_HEIGHT = 700;

/** The caller has no valid session. */
export class ReportSessionError extends Error {
  constructor() {
    super('Session expired.');
    this.name = 'ReportSessionError';
  }
}

/** Authenticated, but not allowed to see or change this report. */
export class ReportAccessError extends Error {
  constructor(message: string = REPORT_SAFE_MESSAGES.access_denied) {
    super(message);
    this.name = 'ReportAccessError';
  }
}

export class ReportNotFoundError extends Error {
  constructor(message: string = REPORT_SAFE_MESSAGES.report_not_found) {
    super(message);
    this.name = 'ReportNotFoundError';
  }
}

/** A client mistake the database refused: bad project context, bad status, etc. */
export class ReportRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReportRequestError';
    this.code = code;
  }
}

/** The stored snapshot does not match its stored hash: refuse to render it. */
export class ReportIntegrityError extends Error {
  constructor(message: string = REPORT_SAFE_MESSAGES.report_integrity_failed) {
    super(message);
    this.name = 'ReportIntegrityError';
  }
}

/** PDF rendering failed. The snapshot is untouched and a retry is allowed. */
export class ReportGenerationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReportGenerationError';
  }
}

/** Storage (upload/download) failed. */
export class ReportStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReportStorageError';
  }
}

export class ReportQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReportQueryError';
  }
}

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * Every report query runs under the caller's own authenticated session: the
 * cookie-aware client carries the user JWT, RLS filters every row, and the
 * storage policies cover the private artifacts. `service_role` is never used on
 * this path.
 */
async function withAuthenticatedClient<T>(
  scope: string,
  run: (client: ServerClient) => Promise<T>,
): Promise<T> {
  const client = await createSupabaseServerClient();
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new ReportSessionError();
  try {
    return await run(client);
  } catch (error) {
    if (
      error instanceof ReportAccessError ||
      error instanceof ReportNotFoundError ||
      error instanceof ReportRequestError ||
      error instanceof ReportIntegrityError ||
      error instanceof ReportGenerationError ||
      error instanceof ReportStorageError ||
      error instanceof ReportQueryError ||
      error instanceof ReportSessionError
    ) {
      throw error;
    }
    throw new ReportQueryError(`${scope} failed.`, { cause: error });
  }
}

function throwForPostgrestError(
  scope: string,
  error: { code?: string; message?: string } | null,
): never {
  const code = error?.code ?? '';

  if (code === '42501') throw new ReportAccessError('Your role in this workspace cannot do that with reports.');
  if (code === 'P0002') throw new ReportNotFoundError();
  if (code === 'PGRST301' || code === 'PGRST302') throw new ReportSessionError();
  if (code === '23514' || code === '22023' || code === '23503' || code === '22P02') {
    throw new ReportRequestError('invalid_request', 'The report request is not valid.');
  }

  throw new ReportQueryError(`${scope} failed.`, { cause: error });
}

interface ReportRow {
  id: string;
  workspace_id: string;
  project_id: string;
  analysis_id: string;
  report_type: ReportType;
  title: string;
  subtitle: string | null;
  company_name: string | null;
  status: ReportStatus;
  snapshot: unknown;
  snapshot_hash: string | null;
  storage_path: string | null;
  map_storage_path: string | null;
  logo_storage_path: string | null;
  logo_mime_type: string | null;
  logo_size_bytes: number | null;
  failure_code: string | null;
  generated_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const REPORT_COLUMNS =
  'id, workspace_id, project_id, analysis_id, report_type, title, subtitle, company_name, status, ' +
  'snapshot, snapshot_hash, storage_path, map_storage_path, logo_storage_path, logo_mime_type, ' +
  'logo_size_bytes, failure_code, generated_at, created_by, created_at, updated_at';

function toSummary(row: ReportRow): ReportSummary {
  return parseReportSummary({
    id: row.id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    analysis_id: row.analysis_id,
    report_type: row.report_type,
    title: row.title,
    subtitle: row.subtitle,
    company_name: row.company_name,
    status: row.status,
    snapshot_hash: row.snapshot_hash,
    failure_code: row.failure_code,
    has_map: row.map_storage_path !== null,
    has_logo: row.logo_storage_path !== null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    generated_at: row.generated_at,
  });
}

/** The active projects of the caller's own workspace (RLS-filtered). */
async function readWorkspaceProjects(
  client: ServerClient,
  workspaceId: string,
  scope: string,
): Promise<WorkspaceProjectSummary[]> {
  const { data, error } = await client
    .from('projects')
    .select('id, name, status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  if (error) throwForPostgrestError(scope, error);
  return (data ?? []) as WorkspaceProjectSummary[];
}

/**
 * Phase 6.5 project context, reused unchanged: a report is always tied to one
 * explicit project. Several projects and no explicit choice is a safe 400; a
 * project that is not the caller's own fails exactly like a missing one; zero
 * projects is the only empty answer.
 */
async function resolveProjectForRead(
  client: ServerClient,
  workspaceId: string,
  requestedProjectId: string | null,
  scope: string,
): Promise<{ projects: WorkspaceProjectSummary[]; projectId: string | null }> {
  const projects = await readWorkspaceProjects(client, workspaceId, scope);
  const resolution = resolveProjectContext(projects, requestedProjectId);

  if (resolution.status === 'resolved') return { projects, projectId: resolution.projectId };
  if (resolution.status === 'empty') return { projects, projectId: null };

  throw new ReportRequestError('project_required', PROJECT_REQUIRED_MESSAGE);
}

async function requireProjectForWrite(
  client: ServerClient,
  workspaceId: string,
  requestedProjectId: string,
  scope: string,
): Promise<string> {
  const projects = await readWorkspaceProjects(client, workspaceId, scope);
  const resolution = resolveProjectContext(projects, requestedProjectId);

  if (resolution.status === 'resolved') return resolution.projectId;
  if (resolution.status === 'empty') throw new ReportRequestError('no_project', NO_PROJECT_MESSAGE);

  throw new ReportRequestError('project_required', PROJECT_REQUIRED_MESSAGE);
}

/** Project-scoped report history, newest first. Never mixes projects. */
export async function listReports(
  workspaceId: string,
  projectId: string | null,
  options: { status?: ReportStatus | null; limit?: number } = {},
): Promise<{ projects: WorkspaceProjectSummary[]; projectId: string | null; reports: ReportSummary[] }> {
  return withAuthenticatedClient('reports.list', async (client) => {
    const { projects, projectId: resolvedProjectId } = await resolveProjectForRead(
      client,
      workspaceId,
      projectId,
      'reports.list',
    );

    if (resolvedProjectId === null) return { projects, projectId: null, reports: [] };

    let query = client
      .from('analysis_reports')
      .select(REPORT_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('project_id', resolvedProjectId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(options.limit ?? 25);

    if (options.status) query = query.eq('status', options.status);

    const { data, error } = await query;
    if (error) throwForPostgrestError('reports.list', error);

    return {
      projects,
      projectId: resolvedProjectId,
      reports: ((data ?? []) as unknown as ReportRow[]).map(toSummary),
    };
  });
}

/** One report plus its view model, built from the stored snapshot. */
export async function getReport(
  workspaceId: string,
  reportId: string,
): Promise<{ report: ReportSummary; viewModel: ReportViewModel | null }> {
  return withAuthenticatedClient('reports.get', async (client) => {
    const row = await readReportRow(client, workspaceId, reportId);

    let viewModel: ReportViewModel | null = null;
    if (row.snapshot && row.snapshot_hash) {
      const snapshot = parseReportSnapshot(row.snapshot);
      viewModel = buildReportViewModel(snapshot, {
        reportId: row.id,
        status: row.status,
        generatedAt: row.generated_at,
        snapshotHash: row.snapshot_hash,
        mapAvailable: row.map_storage_path !== null,
      });
    }

    return { report: toSummary(row), viewModel };
  });
}

async function readReportRow(
  client: ServerClient,
  workspaceId: string,
  reportId: string,
): Promise<ReportRow> {
  const { data, error } = await client
    .from('analysis_reports')
    .select(REPORT_COLUMNS)
    .eq('id', reportId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throwForPostgrestError('reports.read', error);
  if (!data) throw new ReportNotFoundError();
  return data as unknown as ReportRow;
}

export interface CreateReportInput {
  projectId: string;
  analysisId: string;
  title: string | null;
  subtitle: string | null;
  companyName: string | null;
  includeMap: boolean;
}

/**
 * Creates the immutable report: it reads the stored analysis the caller may see,
 * builds the snapshot from it, hashes the canonical form and writes one row.
 *
 * Nothing is recomputed here — the analysis was already scored by Phase 6 — and
 * nothing about the workspace's *current* data is read, so the report is bound
 * to the snapshot from the first moment.
 */
export async function createReport(
  workspaceId: string,
  input: CreateReportInput,
): Promise<ReportSummary> {
  return withAuthenticatedClient('reports.create', async (client) => {
    const projectId = await requireProjectForWrite(
      client,
      workspaceId,
      input.projectId,
      'reports.create',
    );

    const { data: payloadData, error: payloadError } = await client.rpc('get_location_analysis', {
      p_workspace_id: workspaceId,
      p_analysis_id: input.analysisId,
    });
    if (payloadError) throwForPostgrestError('reports.create', payloadError);
    if (!payloadData) throw new ReportNotFoundError('Location analysis not found.');

    let payload: ScoringAnalysisPayload;
    try {
      payload = parseScoringAnalysis(payloadData);
    } catch (cause) {
      throw new ReportQueryError('reports.create could not read the stored analysis.', { cause });
    }

    if (payload.analysis.projectId !== projectId) {
      // A stored analysis of another project is never silently accepted: it fails
      // exactly like a missing one, so the endpoint cannot be used as an oracle.
      throw new ReportRequestError('project_required', PROJECT_REQUIRED_MESSAGE);
    }

    const { data: project, error: projectError } = await client
      .from('projects')
      .select('id, name')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (projectError) throwForPostgrestError('reports.create', projectError);
    if (!project) throw new ReportRequestError('project_required', PROJECT_REQUIRED_MESSAGE);

    const { data: workspace, error: workspaceError } = await client
      .from('workspaces')
      .select('id, name')
      .eq('id', workspaceId)
      .maybeSingle();
    if (workspaceError) throwForPostgrestError('reports.create', workspaceError);
    if (!workspace) throw new ReportRequestError('project_required', PROJECT_REQUIRED_MESSAGE);

    const mapProvider = resolveReportMapProvider();
    const createdAt = new Date().toISOString();
    const type: ReportType =
      payload.analysis.mode === 'comparison' ? 'comparison' : 'single_location';
    const fallbackTitle =
      type === 'comparison'
        ? `${payload.analysis.candidateCount}-site comparison · ${project.name}`
        : `${payload.results[0]?.candidateName ?? 'Site'} · ${project.name}`;

    const snapshot = buildReportSnapshot({
      payload,
      workspace: { id: workspace.id as string, name: workspace.name as string },
      project: { id: project.id as string, name: project.name as string },
      title: input.title ?? fallbackTitle,
      subtitle: input.subtitle,
      companyName: input.companyName,
      logo: null,
      includeMap: input.includeMap,
      mapProvider: mapProvider.name,
      mapAttribution: mapProvider.attribution,
      createdAt,
    });
    const snapshotHash = await hashCanonical(snapshot);

    const insert = {
      workspace_id: workspaceId,
      project_id: projectId,
      analysis_id: input.analysisId,
      report_type: type,
      title: snapshot.report.title,
      subtitle: input.subtitle,
      company_name: input.companyName,
      status: 'draft' as const,
      configuration: { include_map: input.includeMap, map_provider: mapProvider.name },
      snapshot,
      snapshot_hash: snapshotHash,
      created_by: (await client.auth.getUser()).data.user?.id ?? null,
    };

    const { data, error } = await client
      .from('analysis_reports')
      .insert(insert)
      .select(REPORT_COLUMNS)
      .single();

    if (error) throwForPostgrestError('reports.create', error);
    return toSummary(data as unknown as ReportRow);
  });
}

/** Presentation-only fields. The snapshot stays exactly as it was. */
export async function updateReportPresentation(
  workspaceId: string,
  reportId: string,
  input: { title: string; subtitle: string | null; companyName: string | null },
): Promise<ReportSummary> {
  return withAuthenticatedClient('reports.update', async (client) => {
    const { data, error } = await client
      .from('analysis_reports')
      .update({
        title: input.title,
        subtitle: input.subtitle,
        company_name: input.companyName,
      })
      .eq('id', reportId)
      .eq('workspace_id', workspaceId)
      .select(REPORT_COLUMNS)
      .maybeSingle();

    if (error) throwForPostgrestError('reports.update', error);
    if (!data) throw new ReportNotFoundError();
    return toSummary(data as unknown as ReportRow);
  });
}

export interface GenerateReportResult {
  report: ReportSummary;
}

/**
 * Generates (or regenerates) the PDF of one report, synchronously.
 *
 *   1. load the row and its immutable snapshot (RLS-filtered)
 *   2. verify SHA-256(snapshot) == snapshot_hash — refuse on mismatch
 *   3. build the view model (the same one the preview uses)
 *   4. render the static map, if a provider is configured
 *   5. render the PDF with @react-pdf/renderer
 *   6. upload the artifacts to the private bucket
 *   7. mark the row ready with generated_at and the artifact paths
 *
 * Every step before the final update runs *before* anything is written, and a
 * failure marks the report `failed` without touching the snapshot, so a retry
 * always starts from the same immutable data.
 */
export async function generateReport(
  workspaceId: string,
  reportId: string,
): Promise<GenerateReportResult> {
  return withAuthenticatedClient('reports.generate', async (client) => {
    const row = await readReportRow(client, workspaceId, reportId);

    if (!row.snapshot || !row.snapshot_hash) {
      throw new ReportIntegrityError('The report has no stored snapshot to render.');
    }
    if (!(await verifySnapshotHash(row.snapshot, row.snapshot_hash))) {
      await client
        .from('analysis_reports')
        .update({ status: 'failed', failure_code: 'pdf_render_failed' })
        .eq('id', reportId)
        .eq('workspace_id', workspaceId);
      throw new ReportIntegrityError();
    }

    const snapshot = parseReportSnapshot(row.snapshot);
    // The document prints when *this* PDF was generated. The timestamp is
    // computed once, rendered into the document and then persisted with the ready
    // update, so a freshly generated report states its own report time instead of
    // "not generated yet", and a failed generation claims none.
    const generatedAt = new Date().toISOString();
    const viewModel = buildReportViewModel(snapshot, {
      reportId: row.id,
      status: 'generating',
      generatedAt,
      snapshotHash: row.snapshot_hash,
      mapAvailable: false,
    });

    // --- generating (visible while this request runs) -----------------------
    const { error: generatingError } = await client
      .from('analysis_reports')
      .update({ status: 'generating', failure_code: null })
      .eq('id', reportId)
      .eq('workspace_id', workspaceId);
    if (generatingError) throwForPostgrestError('reports.generate', generatingError);

    const failWith = async (code: string, error: Error): Promise<never> => {
      await client
        .from('analysis_reports')
        .update({ status: 'failed', failure_code: code })
        .eq('id', reportId)
        .eq('workspace_id', workspaceId);
      throw error;
    };

    let mapBytes: Uint8Array | null = null;
    let mapStoragePath: string | null = null;
    const provider: ReportMapProvider | null = resolveReportMapProvider().provider;

    if (snapshot.map.include && provider) {
      try {
        const markers = snapshot.candidates.map((candidate) => ({
          label: candidate.label,
          longitude: candidate.longitude,
          latitude: candidate.latitude,
        }));
        const result =
          snapshot.report.type === 'comparison'
            ? await provider.renderComparisonMap({
                markers,
                radiusMeters: snapshot.analysis.radiusMeters,
                width: MAP_WIDTH,
                height: MAP_HEIGHT,
              })
            : await provider.renderSingleLocationMap({
                markers,
                radiusMeters: snapshot.analysis.radiusMeters,
                width: MAP_WIDTH,
                height: MAP_HEIGHT,
              });

        mapBytes = result.bytes;
        mapStoragePath = `${workspaceId}/${row.project_id}/${row.id}/map.${result.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`;

        const { error: mapUploadError } = await client.storage
          .from(REPORT_STORAGE_BUCKET)
          .upload(mapStoragePath, result.bytes, {
            contentType: result.mimeType,
            upsert: true,
          });
        if (mapUploadError) {
          throw new ReportStorageError('The report map could not be stored.', { cause: mapUploadError });
        }
      } catch (error) {
        if (error instanceof ReportStorageError) {
          return failWith('storage_unavailable', error);
        }
        return failWith(
          'map_provider_unavailable',
          new ReportGenerationError(
            'The static map could not be produced. The report was not generated; retry is available.',
            { cause: error },
          ),
        );
      }
    }

    let logoBytes: Uint8Array | null = null;
    if (row.logo_storage_path) {
      const { data: logoData, error: logoError } = await client.storage
        .from(REPORT_STORAGE_BUCKET)
        .download(row.logo_storage_path);
      if (logoError) {
        return failWith(
          'storage_unavailable',
          new ReportStorageError('The stored logo could not be read.', { cause: logoError }),
        );
      }
      if (logoData) {
        logoBytes = new Uint8Array(await logoData.arrayBuffer());
      }
    }

    let pdfBytes: Uint8Array;
    try {
      const rendered = await renderReportPdf({
        viewModel,
        mapImage: mapBytes,
        logoImage: logoBytes,
      });
      pdfBytes = rendered.bytes;
    } catch (error) {
      return failWith(
        'pdf_render_failed',
        new ReportGenerationError(REPORT_SAFE_MESSAGES.report_generation_failed, {
          cause: error,
        }),
      );
    }

    const storagePath = `${workspaceId}/${row.project_id}/${row.id}/report.pdf`;
    const { error: uploadError } = await client.storage
      .from(REPORT_STORAGE_BUCKET)
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (uploadError) {
      return failWith(
        'storage_unavailable',
        new ReportStorageError('The report PDF could not be stored.', { cause: uploadError }),
      );
    }

    const { data, error } = await client
      .from('analysis_reports')
      .update({
        status: 'ready',
        storage_path: storagePath,
        map_storage_path: mapStoragePath,
        failure_code: null,
        generated_at: generatedAt,
      })
      .eq('id', reportId)
      .eq('workspace_id', workspaceId)
      .select(REPORT_COLUMNS)
      .maybeSingle();

    if (error) throwForPostgrestError('reports.generate', error);
    if (!data) throw new ReportNotFoundError();

    return { report: toSummary(data as unknown as ReportRow) };
  });
}

/** The stored PDF (authorized download), or null when it is not ready. */
export async function downloadReportPdf(
  workspaceId: string,
  reportId: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  return withAuthenticatedClient('reports.download', async (client) => {
    const row = await readReportRow(client, workspaceId, reportId);
    if (row.status !== 'ready' || !row.storage_path) {
      throw new ReportRequestError('report_not_ready', REPORT_SAFE_MESSAGES.report_not_ready);
    }

    const { data, error } = await client.storage
      .from(REPORT_STORAGE_BUCKET)
      .download(row.storage_path);
    if (error) throw new ReportStorageError('The report PDF could not be read.', { cause: error });
    if (!data) throw new ReportStorageError('The report PDF is missing from storage.');

    const slug = row.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    return {
      bytes: new Uint8Array(await data.arrayBuffer()),
      filename: `${slug || 'report'}-${row.id.slice(0, 8)}.pdf`,
    };
  });
}

/** A stored report artifact (map or logo), membership-checked like the PDF. */
export async function downloadReportArtifact(
  workspaceId: string,
  reportId: string,
  kind: 'map' | 'logo',
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  return withAuthenticatedClient('reports.artifact', async (client) => {
    const row = await readReportRow(client, workspaceId, reportId);
    const path = kind === 'map' ? row.map_storage_path : row.logo_storage_path;
    if (!path) throw new ReportNotFoundError();

    const { data, error } = await client.storage.from(REPORT_STORAGE_BUCKET).download(path);
    if (error) throw new ReportStorageError('The report image could not be read.', { cause: error });
    if (!data) throw new ReportStorageError('The report image is missing from storage.');

    const mimeType =
      kind === 'logo'
        ? (row.logo_mime_type ?? 'image/png')
        : path.endsWith('.jpg')
          ? 'image/jpeg'
          : 'image/png';

    return { bytes: new Uint8Array(await data.arrayBuffer()), mimeType };
  });
}

/** Stores a validated logo and points the report at it (owner/admin only). */
export async function setReportLogo(
  workspaceId: string,
  reportId: string,
  upload: { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' },
): Promise<ReportSummary> {
  return withAuthenticatedClient('reports.logo', async (client) => {
    const row = await readReportRow(client, workspaceId, reportId);
    const extension = upload.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const path = `${workspaceId}/${row.project_id}/${row.id}/logo.${extension}`;

    const { error: uploadError } = await client.storage
      .from(REPORT_STORAGE_BUCKET)
      .upload(path, upload.bytes, { contentType: upload.mimeType, upsert: true });
    if (uploadError) {
      throw new ReportStorageError('The logo could not be stored.', { cause: uploadError });
    }

    const { data, error } = await client
      .from('analysis_reports')
      .update({
        logo_storage_path: path,
        logo_mime_type: upload.mimeType,
        logo_size_bytes: upload.bytes.byteLength,
      })
      .eq('id', reportId)
      .eq('workspace_id', workspaceId)
      .select(REPORT_COLUMNS)
      .maybeSingle();

    if (error) throwForPostgrestError('reports.logo', error);
    if (!data) throw new ReportNotFoundError();
    return toSummary(data as unknown as ReportRow);
  });
}

/** Removes the logo reference. The object stays for the report's audit trail. */
export async function clearReportLogo(
  workspaceId: string,
  reportId: string,
): Promise<ReportSummary> {
  return withAuthenticatedClient('reports.logo.clear', async (client) => {
    const { data, error } = await client
      .from('analysis_reports')
      .update({ logo_storage_path: null, logo_mime_type: null, logo_size_bytes: null })
      .eq('id', reportId)
      .eq('workspace_id', workspaceId)
      .select(REPORT_COLUMNS)
      .maybeSingle();

    if (error) throwForPostgrestError('reports.logo.clear', error);
    if (!data) throw new ReportNotFoundError();
    return toSummary(data as unknown as ReportRow);
  });
}
