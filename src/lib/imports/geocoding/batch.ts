/**
 * Provider-agnostic geocoding batch runner.
 *
 * Runs one bounded batch per API invocation (the UI drives batches; there is no
 * fake background worker). Within a batch:
 *   * concurrency is capped so a provider is never hammered;
 *   * transient failures retry with exponential backoff and jitter, capped;
 *   * `Retry-After` from a 429 is respected, up to the configured ceiling;
 *   * the result for every claimed row is returned, whatever happened, so the
 *     database write is a single idempotent step and no row is left in flight.
 */
import { IMPORT_LIMITS } from '../limits';
import { decideGeocodingOutcome, type GeocodingThresholds } from './decision';
import type { GeocodingCandidate, GeocodingContext, GeocodingProvider } from './types';

export interface ClaimedRow {
  rowId: string;
  rowNumber: number;
  address: string;
  attempts: number;
}

export type RowGeocodingStatus =
  | 'success'
  | 'ambiguous'
  | 'no_match'
  | 'rate_limited'
  | 'provider_error';

/** The compact shape stored in `import_rows.geocoding_result`. */
export interface StoredCandidate {
  longitude: number;
  latitude: number;
  confidence: number;
  relevance: number | null;
  formatted_address: string | null;
  accuracy: string | null;
  feature_type: string | null;
  country_code: string | null;
  match_confidence: string | null;
  provider_result_id: string | null;
}

export interface RowGeocodingResult {
  rowId: string;
  rowNumber: number;
  status: RowGeocodingStatus;
  decision: 'accepted' | 'review_required' | 'no_match';
  reason: string;
  candidate: GeocodingCandidate | null;
  alternatives: StoredCandidate[];
  retryAfterMs: number | null;
  message: string | null;
}

export interface BatchRunnerOptions {
  provider: GeocodingProvider;
  rows: ClaimedRow[];
  context?: GeocodingContext;
  thresholds: GeocodingThresholds;
  concurrency?: number;
  transientRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests so no test ever waits on a real clock. */
  sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * Provider messages are shown to users, so they are treated as untrusted text:
 * truncated, collapsed, and replaced when they look like an infrastructure
 * detail (a stack frame, a network error code, SQL or a credential).
 */
const UNSAFE_MESSAGE_PATTERN =
  /(\bat\s+\S+\s*\(|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|SQLSTATE|\bSELECT\b|\bINSERT\b|access_token|bearer\s)/i;

function sanitizeProviderMessage(message: string | null, fallback: string): string {
  if (!message) return fallback;
  const trimmed = message.replace(/\s+/g, ' ').trim();
  if (trimmed === '' || trimmed.length > 200 || UNSAFE_MESSAGE_PATTERN.test(trimmed)) return fallback;
  return trimmed;
}

function jitter(milliseconds: number): number {
  // Full jitter, so parallel retries do not synchronize into a thundering herd.
  return Math.round(milliseconds * (0.5 + Math.random() * 0.5));
}

/**
 * Reduces candidate objects to the fields the database stores. The raw provider
 * payload is never persisted: only the address, the coordinates and the
 * provenance of the result.
 */
export function toStoredCandidate(candidate: GeocodingCandidate): StoredCandidate {
  return {
    longitude: candidate.longitude,
    latitude: candidate.latitude,
    confidence: candidate.confidence,
    relevance: candidate.relevance,
    formatted_address: candidate.formattedAddress,
    accuracy: candidate.accuracy,
    feature_type: candidate.featureType,
    country_code: candidate.countryCode,
    match_confidence: candidate.matchConfidence,
    provider_result_id: candidate.providerResultId,
  };
}

async function geocodeOne(
  options: BatchRunnerOptions,
  row: ClaimedRow,
): Promise<RowGeocodingResult> {
  const sleep = options.sleep ?? defaultSleep;
  const transientRetries = options.transientRetries ?? IMPORT_LIMITS.geocodingTransientRetries;
  const baseDelay = options.baseDelayMs ?? IMPORT_LIMITS.geocodingRetryBaseDelayMs;
  const maxDelay = options.maxDelayMs ?? IMPORT_LIMITS.geocodingRetryMaxDelayMs;

  let attempt = 0;
  let lastError: string | null = null;

  while (attempt <= transientRetries) {
    const outcome = await options.provider.geocode(row.address, options.context ?? {});

    if (outcome.status === 'success') {
      const decision = decideGeocodingOutcome(outcome.candidates, {
        thresholds: options.thresholds,
        expectedCountryCode: options.context?.countryCode ?? null,
      });

      if (decision.decision === 'accepted') {
        return {
          rowId: row.rowId,
          rowNumber: row.rowNumber,
          status: 'success',
          decision: 'accepted',
          reason: decision.reason,
          candidate: decision.candidate,
          alternatives: decision.alternatives.map(toStoredCandidate),
          retryAfterMs: null,
          message: null,
        };
      }

      if (decision.decision === 'review_required') {
        return {
          rowId: row.rowId,
          rowNumber: row.rowNumber,
          status: 'ambiguous',
          decision: 'review_required',
          reason: decision.reason,
          candidate: null,
          alternatives: decision.alternatives.map(toStoredCandidate),
          retryAfterMs: null,
          message: null,
        };
      }

      return {
        rowId: row.rowId,
        rowNumber: row.rowNumber,
        status: 'no_match',
        decision: 'no_match',
        reason: decision.reason,
        candidate: null,
        alternatives: decision.alternatives.map(toStoredCandidate),
        retryAfterMs: null,
        message: null,
      };
    }

    if (outcome.status === 'no_match') {
      return {
        rowId: row.rowId,
        rowNumber: row.rowNumber,
        status: 'no_match',
        decision: 'no_match',
        reason: 'provider_no_match',
        candidate: null,
        alternatives: [],
        retryAfterMs: null,
        message: null,
      };
    }

    if (outcome.status === 'rate_limited') {
      attempt += 1;
      if (attempt <= transientRetries) {
        const wait = Math.min(outcome.retryAfterMs ?? baseDelay * 2 ** attempt, maxDelay);
        await sleep(jitter(wait));
        continue;
      }
      return {
        rowId: row.rowId,
        rowNumber: row.rowNumber,
        status: 'rate_limited',
        decision: 'review_required',
        reason: 'provider_rate_limited',
        candidate: null,
        alternatives: [],
        retryAfterMs: outcome.retryAfterMs,
        message: 'The geocoding service is rate limiting requests; this row can be retried.',
      };
    }

    // provider_error
    lastError = outcome.message;
    attempt += 1;
    if (outcome.retryable && attempt <= transientRetries) {
      await sleep(jitter(Math.min(baseDelay * 2 ** attempt, maxDelay)));
      continue;
    }
    return {
      rowId: row.rowId,
      rowNumber: row.rowNumber,
      status: 'provider_error',
      decision: 'review_required',
      reason: outcome.retryable ? 'provider_unavailable' : 'provider_rejected',
      candidate: null,
      alternatives: [],
      retryAfterMs: null,
      message: sanitizeProviderMessage(
        outcome.message,
        'The geocoding service is unavailable; this row can be retried.',
      ),
    };
  }

  return {
    rowId: row.rowId,
    rowNumber: row.rowNumber,
    status: 'provider_error',
    decision: 'review_required',
    reason: 'provider_unavailable',
    candidate: null,
    alternatives: [],
    retryAfterMs: null,
    message: sanitizeProviderMessage(
      lastError,
      'The geocoding service did not answer; this row can be retried.',
    ),
  };
}

/** Runs every claimed row with bounded concurrency, preserving claim order. */
export async function runGeocodingBatch(options: BatchRunnerOptions): Promise<RowGeocodingResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? IMPORT_LIMITS.geocodingConcurrency, options.rows.length || 1),
  );

  const results: RowGeocodingResult[] = new Array(options.rows.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= options.rows.length) return;
      results[index] = await geocodeOne(options, options.rows[index]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
