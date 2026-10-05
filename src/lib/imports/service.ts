import 'server-only';

import { createSupabaseServerClient } from '@/lib/supabase/server';

import {
  IMPORT_LIMITS,
  IMPORT_STORAGE_BUCKET,
  type ImportFileType,
  type ImportTargetEntity,
} from './limits';
import {
  rawValueFor,
  suggestColumnMapping,
  validateColumnMapping,
  type ColumnMapping,
  type ColumnSuggestion,
} from './column-mapping';
import {
  previewFieldsFor,
  validateImportRows,
  type RowValidationError,
} from './validation';
import { ImportParseError, inspectImportSource, listImportSheets, type ImportSheet } from './parse';
import { runGeocodingBatch, type ClaimedRow, type RowGeocodingResult } from './geocoding/batch';
import { readGeocodingThresholds } from './geocoding/decision';
import { resolveGeocodingProvider } from './geocoding';
import { buildErrorCsv, buildErrorExportFilename, type ExportRow } from './export';

type ServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** No server-validated session: the caller must sign in again. */
export class ImportSessionError extends Error {
  constructor() {
    super('Session expired.');
    this.name = 'ImportSessionError';
  }
}

/**
 * The caller is authenticated but not permitted, or the import does not exist in
 * this workspace. Both cases throw the same error so a response can never be
 * used to probe another tenant's imports.
 */
export class ImportAccessError extends Error {
  constructor(message = 'You do not have access to this import.') {
    super(message);
    this.name = 'ImportAccessError';
  }
}

/** A client mistake: bad mapping, unsupported value, limit exceeded. */
export class ImportRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportRequestError';
    this.code = code;
  }
}

export class ImportNotFoundError extends Error {
  constructor(message = 'Import not found.') {
    super(message);
    this.name = 'ImportNotFoundError';
  }
}

export class ImportStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportStorageError';
  }
}

export class ImportQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportQueryError';
  }
}

export class ImportGeocodingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportGeocodingUnavailableError';
  }
}

const JOB_COLUMNS = [
  'id',
  'workspace_id',
  'created_by',
  'original_filename',
  'storage_path',
  'file_type',
  'status',
  'target_entity',
  'dataset_id',
  'sheet_name',
  'column_mapping',
  'metadata',
  'total_rows',
  'valid_rows',
  'invalid_rows',
  'needs_geocoding_rows',
  'geocoded_rows',
  'failed_geocoding_rows',
  'committed_rows',
  'created_at',
  'updated_at',
  'committed_at',
].join(', ');

const ROW_COLUMNS = [
  'id',
  'row_number',
  'validation_status',
  'geocoding_status',
  'raw_data',
  'normalized_data',
  'validation_errors',
  'geocoding_result',
  'manual_override',
  'longitude',
  'latitude',
  'committed_record_id',
].join(', ');

export interface ImportJobView {
  id: string;
  workspaceId: string;
  originalFilename: string;
  fileType: ImportFileType;
  status: string;
  targetEntity: ImportTargetEntity;
  datasetId: string | null;
  sheetName: string | null;
  sheets: ImportSheet[];
  headers: string[];
  warnings: string[];
  mapping: ColumnMapping;
  suggestions: ColumnSuggestion[];
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

export interface PreviewRowView {
  rowId: string;
  rowNumber: number;
  validationStatus: string;
  geocodingStatus: string;
  rawData: Record<string, string | null>;
  normalizedData: Record<string, string | null>;
  errors: RowValidationError[];
  geocoding: Record<string, unknown> | null;
  manualOverride: boolean;
  longitude: number | null;
  latitude: number | null;
  committedRecordId: string | null;
}

export interface PreviewPage {
  rows: PreviewRowView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface CommitSummary {
  jobId: string;
  targetDatasetId: string;
  datasetCreated: boolean;
  insertedRows: number;
  conflictingRows: number;
  previouslyCommittedRows: number;
  jobStatus: string;
  job: ImportJobView;
}

async function withAuthenticatedClient<T>(
  scope: string,
  run: (client: ServerClient) => Promise<T>,
): Promise<T> {
  let client: ServerClient;
  try {
    client = await createSupabaseServerClient();
  } catch (error) {
    throw new ImportQueryError('Server-side database configuration is unavailable.', { cause: error });
  }

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) throw new ImportSessionError();

  try {
    return await run(client);
  } catch (error) {
    if (error instanceof ImportParseError) {
      throw new ImportRequestError(error.code, error.message);
    }
    const code = (error as { code?: string } | null)?.code;
    if (code === '42501') throw new ImportAccessError();
    console.error(`[imports:${scope}] failed`, error instanceof Error ? error.message : error);
    throw error;
  }
}

function stripControlCharacters(text: string): string {
  let result = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl = codePoint === 0x7f || (codePoint < 0x20 && codePoint !== 0x09);
    result += isControl ? '' : character;
  }
  return result;
}

function safeFilename(filename: string): string {
  const bare = filename.split(/[\\/]/).pop() ?? 'upload';
  return (
    stripControlCharacters(bare).replace(/\s+/g, ' ').trim().slice(0, IMPORT_LIMITS.maxFilenameLength) ||
    'upload'
  );
}

/**
 * Storage path: `{workspace_id}/{import_id}/source.{ext}`. The workspace prefix
 * comes from the resolved workspace id in the URL, which the storage policies
 * re-check against membership - the browser never supplies this string.
 */
function storagePathFor(workspaceId: string, importId: string, fileType: ImportFileType): string {
  return `${workspaceId}/${importId}/source.${fileType}`;
}

function metadataOf(job: Record<string, unknown>): Record<string, unknown> {
  const metadata = job.metadata;
  return metadata !== null && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function sheetsOf(value: unknown): ImportSheet[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ImportSheet =>
      entry !== null &&
      typeof entry === 'object' &&
      typeof (entry as ImportSheet).name === 'string' &&
      typeof (entry as ImportSheet).index === 'number',
  );
}

function suggestionsOf(value: unknown): ColumnSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ColumnSuggestion =>
      entry !== null && typeof entry === 'object' && typeof (entry as ColumnSuggestion).header === 'string',
  );
}

/**
 * The job's column mapping. It lives in `import_jobs.column_mapping` (the
 * metadata RPC routes a `mapping` patch there), so the job row keeps exactly one
 * authoritative copy - the same object the wizard uploaded and the preview and
 * error export read back.
 */
function mappingOf(job: Record<string, unknown>): ColumnMapping {
  const mapping = job.column_mapping;
  return mapping !== null && typeof mapping === 'object' ? (mapping as ColumnMapping) : {};
}

export function toJobView(job: Record<string, unknown>): ImportJobView {
  const metadata = metadataOf(job);
  return {
    id: String(job.id),
    workspaceId: String(job.workspace_id),
    originalFilename: String(job.original_filename),
    fileType: job.file_type as ImportFileType,
    status: String(job.status),
    targetEntity: job.target_entity as ImportTargetEntity,
    datasetId: (job.dataset_id as string | null) ?? null,
    sheetName: (job.sheet_name as string | null) ?? null,
    sheets: sheetsOf(metadata.sheets),
    headers: stringArray(metadata.headers),
    warnings: stringArray(metadata.warnings),
    mapping: mappingOf(job),
    suggestions: suggestionsOf(metadata.suggestions),
    counters: {
      totalRows: Number(job.total_rows ?? 0),
      validRows: Number(job.valid_rows ?? 0),
      invalidRows: Number(job.invalid_rows ?? 0),
      needsGeocodingRows: Number(job.needs_geocoding_rows ?? 0),
      geocodedRows: Number(job.geocoded_rows ?? 0),
      failedGeocodingRows: Number(job.failed_geocoding_rows ?? 0),
      committedRows: Number(job.committed_rows ?? 0),
    },
    createdAt: String(job.created_at),
    updatedAt: String(job.updated_at),
    committedAt: (job.committed_at as string | null) ?? null,
  };
}

async function readJob(
  client: ServerClient,
  workspaceId: string,
  importId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client
    .from('import_jobs')
    .select(JOB_COLUMNS)
    .eq('id', importId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw new ImportQueryError('The import could not be read.', { cause: error });
  if (!data) throw new ImportNotFoundError();
  return data as unknown as Record<string, unknown>;
}

async function updateJobMetadata(
  client: ServerClient,
  importId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.rpc('update_import_job_metadata', {
    p_import_job_id: importId,
    p_patch: patch,
  });
  if (error) throw new ImportQueryError('The import metadata could not be updated.', { cause: error });
}

async function refreshCounters(client: ServerClient, importId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await client.rpc('refresh_import_job_counters', { p_import_job_id: importId });
  if (error) throw new ImportQueryError('Import counters could not be refreshed.', { cause: error });
  const rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
  return rows[0] ?? null;
}

async function downloadStoredFile(
  client: ServerClient,
  workspaceId: string,
  importId: string,
  fileType: ImportFileType,
): Promise<Uint8Array> {
  const path = storagePathFor(workspaceId, importId, fileType);
  const { data, error } = await client.storage.from(IMPORT_STORAGE_BUCKET).download(path);
  if (error || !data) {
    throw new ImportStorageError('The stored file could not be read. Upload the file again to continue.', {
      cause: error,
    });
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** Creates the import job row. The client never supplies the storage path. */
export async function createImportJob(input: {
  workspaceId: string;
  originalFilename: string;
  fileType: ImportFileType;
  targetEntity: ImportTargetEntity;
}): Promise<ImportJobView> {
  return withAuthenticatedClient('imports/create', async (client) => {
    const { data: userData } = await client.auth.getUser();
    const filename = safeFilename(input.originalFilename);

    const { data, error } = await client
      .from('import_jobs')
      .insert({
        workspace_id: input.workspaceId,
        created_by: userData.user!.id,
        original_filename: filename,
        file_type: input.fileType,
        target_entity: input.targetEntity,
        status: 'uploaded',
        metadata: { headers: [], sheets: [], warnings: [], mapping: {}, parser: input.fileType },
      })
      .select(JOB_COLUMNS)
      .single();

    if (error) {
      if (error.code === '42501') {
        throw new ImportAccessError('You do not have permission to import into this workspace.');
      }
      if (error.code === '23503') {
        throw new ImportRequestError('unknown_workspace', 'The workspace does not exist.');
      }
      throw new ImportQueryError('The import could not be created.', { cause: error });
    }

    return toJobView(data as unknown as Record<string, unknown>);
  });
}

export async function listImportJobs(workspaceId: string, limit = 25): Promise<ImportJobView[]> {
  return withAuthenticatedClient('imports/list', async (client) => {
    const { data, error } = await client
      .from('import_jobs')
      .select(JOB_COLUMNS)
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100));

    if (error) throw new ImportQueryError('Imports could not be listed.', { cause: error });
    return (data ?? []).map((job) => toJobView(job as unknown as Record<string, unknown>));
  });
}

export async function getImportJob(workspaceId: string, importId: string): Promise<ImportJobView> {
  return withAuthenticatedClient('imports/get', async (client) =>
    toJobView(await readJob(client, workspaceId, importId)),
  );
}

export interface UploadResult {
  job: ImportJobView;
  requiresSheetSelection: boolean;
  suggestions: ColumnSuggestion[];
}

/**
 * Upload + inspect in one step: bytes are validated, stored privately, parsed,
 * and the detected columns plus a *suggested* mapping are returned. A workbook
 * with several usable sheets and no explicit choice returns its sheet list and
 * stages nothing until the caller picks one.
 */
export async function uploadImportFile(input: {
  workspaceId: string;
  importId: string;
  bytes: Uint8Array;
  sheetName?: string | null;
}): Promise<UploadResult> {
  return withAuthenticatedClient('imports/upload', async (client) => {
    const job = await readJob(client, input.workspaceId, input.importId);
    const fileType = job.file_type as ImportFileType;
    const filename = String(job.original_filename);
    const path = storagePathFor(input.workspaceId, input.importId, fileType);

    const { error: uploadError } = await client.storage.from(IMPORT_STORAGE_BUCKET).upload(path, input.bytes, {
      contentType:
        fileType === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv',
      upsert: true,
    });
    if (uploadError) throw new ImportStorageError('The file could not be stored.', { cause: uploadError });

    let parsed;
    try {
      parsed = await inspectImportSource(input.bytes, filename, { sheetName: input.sheetName ?? null });
    } catch (error) {
      if (error instanceof ImportParseError && error.code === 'sheet_selection_required') {
        const workbookSheets = await listImportSheets(input.bytes, filename);
        await updateJobMetadata(client, input.importId, { sheets: workbookSheets });
        return {
          job: toJobView(await readJob(client, input.workspaceId, input.importId)),
          requiresSheetSelection: true,
          suggestions: [],
        };
      }
      throw error;
    }

    const headers = parsed.headers;
    const selectedSheet = parsed.sheetName;
    const suggestions = suggestColumnMapping(
      headers,
      job.target_entity as ImportTargetEntity,
    ).suggestions;

    await updateJobMetadata(client, input.importId, {
      headers,
      sheets: parsed.sheets,
      warnings: parsed.warnings,
      parser: fileType,
      selectedSheet,
      suggestions,
    });

    const { error: updateError } = await client
      .from('import_jobs')
      .update({ storage_path: path, sheet_name: selectedSheet, status: 'mapping_required' })
      .eq('id', input.importId)
      .eq('workspace_id', input.workspaceId);
    if (updateError) throw new ImportQueryError('The import could not be updated.', { cause: updateError });

    return {
      job: toJobView(await readJob(client, input.workspaceId, input.importId)),
      requiresSheetSelection: false,
      suggestions,
    };
  });
}

export interface ValidationSummary {
  job: ImportJobView;
  staged: number;
  invalid: number;
  needsGeocoding: number;
  valid: number;
  warnings: string[];
  counters: Record<string, unknown> | null;
}

/**
 * Applies the mapping and stages every row: this is the validation step.
 *
 * The source file is read back from private storage under the caller's own
 * session, so the storage policy is exercised on every import, not only on
 * upload. Staged rows are *upserted* per row number - the tables deliberately
 * grant no DELETE - so re-validating with the same mapping replaces rows instead
 * of duplicating them, and a committed import is never re-staged.
 */
export async function applyImportMapping(input: {
  workspaceId: string;
  importId: string;
  mapping: ColumnMapping;
}): Promise<ValidationSummary> {
  return withAuthenticatedClient('imports/mapping', async (client) => {
    const job = await readJob(client, input.workspaceId, input.importId);
    const target = job.target_entity as ImportTargetEntity;

    if (Number(job.committed_rows ?? 0) > 0) {
      throw new ImportRequestError(
        'already_committed',
        'This import already promoted rows. Its mapping can no longer be changed.',
      );
    }

    const mappingValidation = validateColumnMapping(input.mapping, target);
    if (!mappingValidation.ok) {
      throw new ImportRequestError('invalid_mapping', mappingValidation.errors.join(' '));
    }

    const bytes = await downloadStoredFile(
      client,
      input.workspaceId,
      input.importId,
      job.file_type as ImportFileType,
    );
    const parsed = await inspectImportSource(bytes, String(job.original_filename), {
      sheetName: (job.sheet_name as string | null) ?? null,
    });

    const stagedInputs = parsed.rows.map((row, index) => ({
      rowNumber: parsed.rowNumbers[index],
      rawData: Object.fromEntries(parsed.headers.map((header, column) => [header, row[column] ?? ''])),
    }));

    const { results, mappingErrors } = validateImportRows(stagedInputs, input.mapping, target);
    if (mappingErrors.length > 0) {
      throw new ImportRequestError('invalid_mapping', mappingErrors.join(' '));
    }

    const { count: existing, error: countError } = await client
      .from('import_rows')
      .select('id', { count: 'exact', head: true })
      .eq('import_job_id', input.importId);
    if (countError) throw new ImportQueryError('Staged rows could not be counted.', { cause: countError });

    if ((existing ?? 0) > results.length) {
      throw new ImportRequestError(
        'staging_conflict',
        `This import already staged ${existing} rows but the file now yields ${results.length}. ` +
          'Start a new import for a different sheet or file; staged rows cannot be deleted by design.',
      );
    }

    for (let offset = 0; offset < results.length; offset += IMPORT_LIMITS.stagingBatchSize) {
      const batch = results.slice(offset, offset + IMPORT_LIMITS.stagingBatchSize);
      const payload = batch.map((result, index) => ({
        import_job_id: input.importId,
        workspace_id: input.workspaceId,
        row_number: result.rowNumber,
        raw_data: stagedInputs[offset + index].rawData,
        normalized_data: result.normalized,
        validation_status: result.status,
        validation_errors: result.errors,
        geocoding_status: result.status === 'needs_geocoding' ? 'pending' : 'not_required',
        longitude: result.longitude,
        latitude: result.latitude,
      }));

      const { error } = await client
        .from('import_rows')
        .upsert(payload, { onConflict: 'import_job_id,row_number' });
      if (error) throw new ImportQueryError('Staged rows could not be written.', { cause: error });
    }

    await updateJobMetadata(client, input.importId, {
      mapping: input.mapping,
      headers: parsed.headers,
      sheets: parsed.sheets,
      warnings: parsed.warnings,
      selectedSheet: parsed.sheetName,
      validatedAt: new Date().toISOString(),
    });

    const counters = await refreshCounters(client, input.importId);

    return {
      job: toJobView(await readJob(client, input.workspaceId, input.importId)),
      staged: results.length,
      valid: results.filter((result) => result.status === 'valid').length,
      invalid: results.filter((result) => result.status === 'invalid').length,
      needsGeocoding: results.filter((result) => result.status === 'needs_geocoding').length,
      warnings: parsed.warnings,
      counters,
    };
  });
}

/** One bounded, resumable geocoding batch, driven by the UI. */
export async function runImportGeocodingBatch(input: {
  workspaceId: string;
  importId: string;
  limit?: number;
}): Promise<{ summary: Record<string, unknown>; rows: RowGeocodingResult[] }> {
  const limit = Math.min(
    Math.max(input.limit ?? IMPORT_LIMITS.defaultGeocodeBatchSize, 1),
    IMPORT_LIMITS.maxGeocodeBatchSize,
  );

  return withAuthenticatedClient('imports/geocode', async (client) => {
    await readJob(client, input.workspaceId, input.importId);

    const { data: claimed, error: claimError } = await client.rpc('claim_import_geocoding_rows', {
      p_import_job_id: input.importId,
      p_limit: limit,
      p_max_attempts: IMPORT_LIMITS.maxGeocodeAttempts,
    });
    if (claimError) throw new ImportQueryError('Geocoding work could not be claimed.', { cause: claimError });

    const rows: ClaimedRow[] = ((claimed ?? []) as Array<Record<string, unknown>>).map((row) => ({
      rowId: String(row.row_id),
      rowNumber: Number(row.row_number),
      address: String(row.address ?? ''),
      attempts: Number(row.attempts ?? 0),
    }));

    if (rows.length === 0) {
      // Nothing claimable: report the same summary shape the RPC returns, so a
      // caller never has to distinguish "nothing to do" from "the RPC ran".
      return {
        summary: {
          applied: 0,
          skipped: 0,
          claimed: 0,
          counters: await refreshCounters(client, input.importId),
        },
        rows: [],
      };
    }

    let provider;
    let context;
    try {
      ({ provider, context } = resolveGeocodingProvider());
    } catch (error) {
      throw new ImportGeocodingUnavailableError(
        error instanceof Error ? error.message : 'Geocoding is not configured on this server.',
      );
    }

    const results = await runGeocodingBatch({
      provider,
      rows,
      context,
      thresholds: readGeocodingThresholds(),
    });

    const payload = results.map((result) => ({
      row_id: result.rowId,
      status: result.status,
      longitude: result.candidate?.longitude ?? null,
      latitude: result.candidate?.latitude ?? null,
      confidence: result.candidate?.confidence ?? null,
      relevance: result.candidate?.relevance ?? null,
      formatted_address: result.candidate?.formattedAddress ?? null,
      accuracy: result.candidate?.accuracy ?? null,
      feature_type: result.candidate?.featureType ?? null,
      country_code: result.candidate?.countryCode ?? null,
      match_confidence: result.candidate?.matchConfidence ?? null,
      provider_result_id: result.candidate?.providerResultId ?? null,
      provider: result.candidate?.provider ?? provider.name,
      decision: result.decision,
      reason: result.reason,
      retry_after_ms: result.retryAfterMs,
      message: result.message,
      alternatives: result.alternatives,
    }));

    const { data: summary, error: applyError } = await client.rpc('apply_import_geocoding_results', {
      p_import_job_id: input.importId,
      p_results: payload,
    });
    if (applyError) throw new ImportQueryError('Geocoding results could not be stored.', { cause: applyError });

    return { summary: summary as Record<string, unknown>, rows: results };
  });
}

/** Manual map placement: authoritative, validated server-side by the RPC. */
export async function setImportRowPoint(input: {
  workspaceId: string;
  importId: string;
  rowId: string;
  longitude: number;
  latitude: number;
}): Promise<ImportJobView> {
  if (!Number.isFinite(input.longitude) || !Number.isFinite(input.latitude)) {
    throw new ImportRequestError('invalid_coordinates', 'Coordinates must be finite numbers.');
  }
  if (input.longitude < -180 || input.longitude > 180 || input.latitude < -90 || input.latitude > 90) {
    throw new ImportRequestError('invalid_coordinates', 'Coordinates are outside the valid range.');
  }

  return withAuthenticatedClient('imports/manual-point', async (client) => {
    await readJob(client, input.workspaceId, input.importId);

    const { data: row, error: rowError } = await client
      .from('import_rows')
      .select('id')
      .eq('id', input.rowId)
      .eq('import_job_id', input.importId)
      .maybeSingle();
    if (rowError) throw new ImportQueryError('The row could not be read.', { cause: rowError });
    if (!row) throw new ImportNotFoundError('Import row not found.');

    const { error } = await client.rpc('set_import_row_manual_point', {
      p_import_row_id: input.rowId,
      p_longitude: input.longitude,
      p_latitude: input.latitude,
    });
    if (error) {
      if (error.code === '22023') {
        throw new ImportRequestError('invalid_coordinates', 'Coordinates are outside the valid range.');
      }
      throw new ImportQueryError('The manual point could not be recorded.', { cause: error });
    }

    await refreshCounters(client, input.importId);
    return toJobView(await readJob(client, input.workspaceId, input.importId));
  });
}

/** Commits validated rows into a new or explicitly selected dataset. */
export async function commitImportJob(input: {
  workspaceId: string;
  importId: string;
  datasetId?: string | null;
  newDatasetName?: string | null;
  newDatasetType?: string | null;
}): Promise<CommitSummary> {
  return withAuthenticatedClient('imports/commit', async (client) => {
    await readJob(client, input.workspaceId, input.importId);

    if (input.datasetId && (input.newDatasetName || input.newDatasetType)) {
      throw new ImportRequestError(
        'ambiguous_destination',
        'Choose an existing dataset or create a new one, not both.',
      );
    }

    const { data, error } = await client.rpc('commit_import_job', {
      p_import_job_id: input.importId,
      p_dataset_id: input.datasetId ?? null,
      p_new_dataset_name: input.newDatasetName?.trim() || null,
      p_new_dataset_type: input.newDatasetType?.trim() || 'imported',
    });

    if (error) {
      if (error.code === '22023') {
        // The commit function refuses re-pointing a committed import at another
        // dataset; that is a replay, not a bad destination, and says so.
        if (/already committed/i.test(error.message ?? '')) {
          throw new ImportRequestError(
            'already_committed',
            'This import is already committed. Reuse the dataset it created.',
          );
        }
        throw new ImportRequestError('invalid_destination', 'The destination dataset is not valid.');
      }
      if (error.code === '23503') {
        throw new ImportRequestError('cross_workspace_dataset', 'That dataset belongs to another workspace.');
      }
      throw new ImportQueryError('The import could not be committed.', { cause: error });
    }

    const row = Array.isArray(data) ? (data[0] as Record<string, unknown>) : (data as Record<string, unknown>);
    return {
      jobId: String(row.job_id),
      targetDatasetId: String(row.target_dataset_id),
      datasetCreated: row.dataset_created === true,
      insertedRows: Number(row.inserted_rows ?? 0),
      conflictingRows: Number(row.conflicting_rows ?? 0),
      previouslyCommittedRows: Number(row.previously_committed_rows ?? 0),
      jobStatus: String(row.job_status),
      job: toJobView(await readJob(client, input.workspaceId, input.importId)),
    };
  });
}

/** Paginated preview, filterable by the status the user cares about. */
export async function listImportRows(input: {
  workspaceId: string;
  importId: string;
  status?: 'valid' | 'invalid' | 'needs_geocoding' | 'committed' | 'all';
  page?: number;
  pageSize?: number;
}): Promise<PreviewPage> {
  const page = Math.max(input.page ?? 1, 1);
  const pageSize = Math.min(Math.max(input.pageSize ?? IMPORT_LIMITS.previewPageSize, 1), 100);

  return withAuthenticatedClient('imports/rows', async (client) => {
    const job = await readJob(client, input.workspaceId, input.importId);
    const fields = previewFieldsFor(job.target_entity as ImportTargetEntity);
    const mapping = mappingOf(job);

    let query = client
      .from('import_rows')
      .select(ROW_COLUMNS, { count: 'exact' })
      .eq('import_job_id', input.importId)
      .order('row_number', { ascending: true })
      .range((page - 1) * pageSize, page * pageSize - 1);

    if (input.status === 'valid') query = query.eq('validation_status', 'valid');
    else if (input.status === 'invalid') query = query.eq('validation_status', 'invalid');
    else if (input.status === 'needs_geocoding') query = query.eq('validation_status', 'needs_geocoding');
    else if (input.status === 'committed') query = query.not('committed_record_id', 'is', null);

    const { data, error, count } = await query;
    if (error) throw new ImportQueryError('Import rows could not be read.', { cause: error });

    const rows: PreviewRowView[] = (data ?? []).map((raw) => {
      const record = raw as unknown as Record<string, unknown>;
      const rawData = (record.raw_data ?? {}) as Record<string, unknown>;
      const normalizedData = (record.normalized_data ?? {}) as Record<string, unknown>;
      return {
        rowId: String(record.id),
        rowNumber: Number(record.row_number),
        validationStatus: String(record.validation_status),
        geocodingStatus: String(record.geocoding_status),
        // Only the mapped fields are returned, so a preview can never be used to
        // read arbitrary spreadsheet columns back out of the database.
        rawData: Object.fromEntries(fields.map((field) => [field, rawValueFor(mapping, rawData, field)])),
        normalizedData: Object.fromEntries(
          fields.map((field) => [
            field,
            normalizedData[field] === undefined || normalizedData[field] === null
              ? null
              : String(normalizedData[field]),
          ]),
        ),
        errors: Array.isArray(record.validation_errors) ? (record.validation_errors as RowValidationError[]) : [],
        geocoding: (record.geocoding_result as Record<string, unknown> | null) ?? null,
        manualOverride: record.manual_override === true,
        longitude: (record.longitude as number | null) ?? null,
        latitude: (record.latitude as number | null) ?? null,
        committedRecordId: (record.committed_record_id as string | null) ?? null,
      };
    });

    const total = count ?? rows.length;
    return { rows, page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) };
  });
}

/** Error export: every staged row that was not promoted, with its reasons. */
export async function exportImportErrors(input: {
  workspaceId: string;
  importId: string;
  status?: 'invalid' | 'review' | 'all';
}): Promise<{ filename: string; csv: string; rows: number }> {
  return withAuthenticatedClient('imports/export', async (client) => {
    const job = await readJob(client, input.workspaceId, input.importId);
    const fields = previewFieldsFor(job.target_entity as ImportTargetEntity);
    const mapping = mappingOf(job);

    let query = client
      .from('import_rows')
      .select('row_number, validation_status, geocoding_status, raw_data, validation_errors, geocoding_result')
      .eq('import_job_id', input.importId)
      .is('committed_record_id', null)
      .order('row_number', { ascending: true })
      .limit(IMPORT_LIMITS.maxRows);

    // The export is for rows that still need attention: invalid rows plus rows
    // whose geocoding has not resolved (pending, ambiguous, no match, rate
    // limited or a provider outage). Rows that are simply waiting for the commit
    // are not "errors" and stay out of the file.
    const reviewFilter = [
      'geocoding_status.eq.pending',
      'geocoding_status.eq.geocoding',
      'geocoding_status.eq.ambiguous',
      'geocoding_status.eq.no_match',
      'geocoding_status.eq.rate_limited',
      'geocoding_status.eq.provider_error',
    ].join(',');
    if (input.status === 'invalid') query = query.eq('validation_status', 'invalid');
    else if (input.status === 'review') query = query.or(reviewFilter);
    else query = query.or(`validation_status.eq.invalid,${reviewFilter}`);

    const { data, error } = await query;
    if (error) throw new ImportQueryError('Import rows could not be read for export.', { cause: error });

    const exportRows: ExportRow[] = [];
    for (const raw of data ?? []) {
      const row = raw as unknown as Record<string, unknown>;
      const rawData = (row.raw_data ?? {}) as Record<string, unknown>;
      const rowFields = Object.fromEntries(
        fields.map((field) => [field, rawValueFor(mapping, rawData, field)]),
      );
      const errors = Array.isArray(row.validation_errors)
        ? (row.validation_errors as RowValidationError[])
        : [];
      const geocoding = (row.geocoding_result as Record<string, unknown> | null) ?? null;

      if (errors.length === 0) {
        exportRows.push({
          rowNumber: Number(row.row_number),
          fields: rowFields,
          errorCode: `geocoding_${String(row.geocoding_status)}`,
          errorField: 'address',
          errorMessage:
            typeof geocoding?.reason === 'string'
              ? `Needs review: ${geocoding.reason}${geocoding.message ? ` - ${String(geocoding.message)}` : ''}`
              : 'Needs review before it can be imported.',
        });
        continue;
      }

      for (const rowError of errors) {
        exportRows.push({
          rowNumber: Number(row.row_number),
          fields: rowFields,
          errorCode: rowError.code,
          errorField: rowError.field,
          errorMessage: rowError.message,
        });
      }
    }

    return {
      filename: buildErrorExportFilename(String(job.original_filename)),
      csv: buildErrorCsv(exportRows, fields),
      rows: exportRows.length,
    };
  });
}

/** Datasets the wizard can commit into (id, name, type only). */
export async function listWorkspaceDatasets(
  workspaceId: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  return withAuthenticatedClient('imports/datasets', async (client) => {
    const { data, error } = await client
      .from('datasets')
      .select('id, name, dataset_type')
      .eq('workspace_id', workspaceId)
      .order('name', { ascending: true })
      .limit(100);
    if (error) throw new ImportQueryError('Datasets could not be listed.', { cause: error });
    return (data ?? []).map((raw) => {
      const record = raw as unknown as Record<string, unknown>;
      return { id: String(record.id), name: String(record.name), type: String(record.dataset_type) };
    });
  });
}
