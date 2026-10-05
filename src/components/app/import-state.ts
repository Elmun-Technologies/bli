/**
 * The import wizard's pure state: steps, transitions and summary math.
 *
 * Kept free of React and of the network so the workflow rules can be unit
 * tested, and so the component only renders what this module decides. The order
 * is the one the brief fixes: upload, columns, mapping, validation, geocoding,
 * review and commit.
 */

export const IMPORT_STEPS = ['upload', 'columns', 'mapping', 'validation', 'geocoding', 'commit'] as const;

export type ImportStep = (typeof IMPORT_STEPS)[number];

export const IMPORT_STEP_LABELS: Record<ImportStep, string> = {
  upload: 'Upload',
  columns: 'Columns',
  mapping: 'Mapping',
  validation: 'Validation',
  geocoding: 'Geocoding',
  commit: 'Review & commit',
};

export interface ImportCounters {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  needsGeocodingRows: number;
  geocodedRows: number;
  failedGeocodingRows: number;
  committedRows: number;
}

export const EMPTY_COUNTERS: ImportCounters = {
  totalRows: 0,
  validRows: 0,
  invalidRows: 0,
  needsGeocodingRows: 0,
  geocodedRows: 0,
  failedGeocodingRows: 0,
  committedRows: 0,
};

export function stepIndex(step: ImportStep): number {
  return IMPORT_STEPS.indexOf(step);
}

export function nextStep(step: ImportStep): ImportStep {
  const index = stepIndex(step);
  return IMPORT_STEPS[Math.min(index + 1, IMPORT_STEPS.length - 1)];
}

export function previousStep(step: ImportStep): ImportStep {
  const index = stepIndex(step);
  return IMPORT_STEPS[Math.max(index - 1, 0)];
}

/** Whether the user may move forward from this step, given what is known. */
export function canAdvance(
  step: ImportStep,
  state: {
    hasFile: boolean;
    hasHeaders: boolean;
    awaitingSheet: boolean;
    mappingApplied: boolean;
    validated: boolean;
  },
): boolean {
  switch (step) {
    case 'upload':
      return state.hasFile;
    case 'columns':
      return state.hasHeaders && !state.awaitingSheet;
    case 'mapping':
      return state.mappingApplied;
    case 'validation':
      return state.validated;
    case 'geocoding':
      return true;
    case 'commit':
      return false;
  }
}

/**
 * How many rows still need an address resolved before a geocoding batch makes
 * sense. Only rows that are awaiting a coordinate count; invalid rows are the
 * user's to fix or export, and resolved rows are never revisited.
 */
export function pendingGeocodingRows(counters: ImportCounters): number {
  return Math.max(counters.needsGeocodingRows, 0);
}

/** Rows that can be promoted right now. */
export function committableRows(counters: ImportCounters): number {
  return Math.max(counters.validRows - counters.committedRows, 0);
}

/**
 * True when the job has finished the geocoding stage: nothing is waiting and
 * nothing failed, or every failure has been replaced by a manual point.
 */
export function geocodingComplete(counters: ImportCounters): boolean {
  return pendingGeocodingRows(counters) === 0;
}

export interface ImportSummary {
  imported: number;
  needsReview: number;
  failed: number;
  geocoded: number;
  coordinatesSupplied: number;
  committed: number;
  datasetCreated: boolean;
  destination: string;
}

export function buildSummary(input: {
  counters: ImportCounters;
  geocodedRows: number;
  coordinatesSupplied: number;
  datasetCreated: boolean;
  destination: string;
}): ImportSummary {
  const { counters } = input;
  return {
    imported: counters.committedRows,
    needsReview: pendingGeocodingRows(counters) + counters.invalidRows,
    failed: counters.failedGeocodingRows,
    geocoded: input.geocodedRows,
    coordinatesSupplied: input.coordinatesSupplied,
    committed: counters.committedRows,
    datasetCreated: input.datasetCreated,
    destination: input.destination,
  };
}

/** Short, human-readable job status for the header badge. */
export function jobStatusLabel(status: string): string {
  switch (status) {
    case 'uploaded':
      return 'File uploaded';
    case 'mapping_required':
      return 'Mapping needed';
    case 'ready':
      return 'Ready to import';
    case 'review_required':
      return 'Needs review';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default:
      return status;
  }
}

/** The step to open when resuming an import that is already part-way through. */
export function stepForJobStatus(status: string, hasStagedRows: boolean): ImportStep {
  switch (status) {
    case 'uploaded':
      return 'columns';
    case 'mapping_required':
      return hasStagedRows ? 'validation' : 'mapping';
    case 'ready':
      return 'commit';
    case 'review_required':
      return hasStagedRows ? 'validation' : 'mapping';
    case 'completed':
      return 'commit';
    default:
      return 'upload';
  }
}
