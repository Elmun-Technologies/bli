/**
 * Phase 5 limits, in one place so the API, the UI and the documentation cannot
 * drift apart. Every limit is a product decision: exceeding one is reported to
 * the user, never silently truncated.
 */
export const IMPORT_LIMITS = {
  /** Largest accepted upload. Larger files need the future resumable path. */
  maxFileBytes: 5 * 1024 * 1024,
  /** Largest accepted worksheet/CSV row count. */
  maxRows: 10_000,
  /** Largest accepted column count in the selected sheet. */
  maxColumns: 100,
  /** Rows validated/persisted per database round trip. */
  stagingBatchSize: 500,
  /** Maximum rows one geocoding batch request may claim. */
  maxGeocodeBatchSize: 50,
  /** Default rows per geocoding batch. */
  defaultGeocodeBatchSize: 25,
  /** Geocoding attempts per row before it stops being retried automatically. */
  maxGeocodeAttempts: 5,
  /** Concurrent provider calls inside one batch (provider rate-limit safety). */
  geocodingConcurrency: 4,
  /** Base delay for exponential backoff between transient retries (ms). */
  geocodingRetryBaseDelayMs: 400,
  /** Cap for exponential backoff (ms). */
  geocodingRetryMaxDelayMs: 4_000,
  /** Transient retries inside a single batch call. */
  geocodingTransientRetries: 2,
  /** Rows returned to the preview table per page. */
  previewPageSize: 25,
  /** Longest accepted cell value, in characters. */
  maxCellLength: 4_000,
  /** Longest original filename recorded as metadata. */
  maxFilenameLength: 200,
} as const;

export const IMPORT_FILE_TYPES = ['csv', 'xlsx'] as const;
export type ImportFileType = (typeof IMPORT_FILE_TYPES)[number];

export const IMPORT_TARGET_ENTITIES = ['customers', 'locations'] as const;
export type ImportTargetEntity = (typeof IMPORT_TARGET_ENTITIES)[number];

export const IMPORT_MAX_SHEET_NAME_LENGTH = 120;

/** Storage bucket that holds private import source files. */
export const IMPORT_STORAGE_BUCKET = 'workspace-imports';
