/**
 * Request validation for the scoring API and the model editor.
 *
 * The database validates everything again (constraints, the deferred weight
 * rule and the RPC assertions), so this module exists for two honest reasons:
 * a precise, safe message before a round trip, and identical rules in the editor
 * so a user is never surprised by a save. It is never the authority.
 */

import { MAX_COMPARISON_CANDIDATES, MAX_RADIUS_METERS, MIN_RADIUS_METERS } from './catalogue';
import { findMetric } from './catalogue';
import type {
  ScoringDirection,
  ScoringFactor,
  ScoringFactorConfiguration,
  ScoringModelInput,
  ScoringModelStatus,
  ScoringMode,
  ScoringNormalization,
  ScoringRunRequest,
  ScoringThresholdPoint,
} from './types';

export class ScoringValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringValidationError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FACTOR_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const STATUSES: readonly ScoringModelStatus[] = ['draft', 'active', 'archived'];
const DIRECTIONS: readonly ScoringDirection[] = ['positive', 'negative', 'neutral'];
const NORMALIZATIONS: readonly ScoringNormalization[] = ['threshold', 'min_max', 'inverse_min_max'];

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new ScoringValidationError(`A valid ${field} is required.`);
  }
  return value;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ScoringValidationError(`A ${field} is required.`);
  if (text.length > maxLength) {
    throw new ScoringValidationError(`The ${field} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

/**
 * Threshold stops as authored text: `0:0, 500:50, 1000:100`. Kept as plain text
 * so the editor never needs a nested form, while the database still receives a
 * validated array.
 */
export function parseThresholdPointsText(text: string): ScoringThresholdPoint[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const points: ScoringThresholdPoint[] = [];
  for (const rawEntry of trimmed.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = entry.includes(':') ? ':' : entry.includes('=') ? '=' : null;
    if (!separator) {
      throw new ScoringValidationError(
        `Threshold stop "${entry}" must look like value:score, for example 500:50.`,
      );
    }
    const [valueText, scoreText] = entry.split(separator);
    const value = Number(valueText);
    const score = Number(scoreText);
    if (!Number.isFinite(value) || !Number.isFinite(score)) {
      throw new ScoringValidationError(`Threshold stop "${entry}" must use numbers on both sides.`);
    }
    points.push({ value, score });
  }
  return points;
}

export function formatThresholdPoints(points: readonly ScoringThresholdPoint[]): string {
  return points
    .map((point) => `${trimNumber(point.value)}:${trimNumber(point.score)}`)
    .join(', ');
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

export function thresholdPointsValid(
  points: readonly ScoringThresholdPoint[] | undefined,
  direction: ScoringDirection,
): boolean {
  if (!points || points.length < 2) return false;

  let previousValue: number | null = null;
  let previousScore: number | null = null;
  for (const point of points) {
    if (!Number.isFinite(point.value) || !Number.isFinite(point.score)) return false;
    if (point.score < 0 || point.score > 100) return false;
    if (previousValue !== null && point.value <= previousValue) return false;
    if (previousScore !== null) {
      if (direction === 'positive' && point.score < previousScore) return false;
      if (direction === 'negative' && point.score > previousScore) return false;
    }
    previousValue = point.value;
    previousScore = point.score;
  }
  return true;
}

export interface FactorErrors {
  key?: string;
  label?: string;
  metric?: string;
  weight?: string;
  method?: string;
  configuration?: string;
}

/**
 * Mirrors the database rules for one factor so the editor can explain a problem
 * before a save. The order the messages appear in follows the form.
 */
export function validateScoringFactor(factor: ScoringFactor): FactorErrors {
  const errors: FactorErrors = {};

  if (!FACTOR_KEY_PATTERN.test(factor.key)) {
    errors.key = 'Use a lowercase key of 2 to 40 characters: letters, digits and underscores.';
  }
  if (!factor.label.trim()) {
    errors.label = 'Every factor needs a label.';
  }
  if (!findMetric(factor.metric)) {
    errors.metric = 'Choose one of the measured metrics.';
  }
  if (!Number.isFinite(factor.weight) || factor.weight < 0 || factor.weight > 100) {
    errors.weight = 'A weight is a percentage between 0 and 100.';
  } else if (factor.enabled && factor.weight <= 0) {
    errors.weight = 'An enabled factor needs a weight above 0.';
  } else if (Math.round(factor.weight * 100) !== factor.weight * 100) {
    errors.weight = 'Weights use at most two decimals.';
  }
  if (factor.normalization === 'min_max' && factor.direction !== 'positive') {
    errors.method = 'min_max is the positive comparison method; use inverse_min_max for a negative factor.';
  }
  if (factor.normalization === 'inverse_min_max' && factor.direction !== 'negative') {
    errors.method = 'inverse_min_max is the negative comparison method; use min_max for a positive factor.';
  }
  if (factor.normalization === 'threshold') {
    if (!thresholdPointsValid(factor.configuration.points, factor.direction)) {
      errors.configuration =
        'A threshold curve needs at least two ascending stops with scores from 0 to 100 that follow the factor direction.';
    }
  }

  const missing = factor.configuration.missing_score;
  if (missing !== undefined && (missing < 0 || missing > 100)) {
    errors.configuration = 'The missing-data score must be between 0 and 100.';
  }
  const degenerate = factor.configuration.degenerate_score;
  if (degenerate !== undefined && (degenerate < 0 || degenerate > 100)) {
    errors.configuration = 'The all-equal score must be between 0 and 100.';
  }

  return errors;
}

export function factorErrorsEmpty(errors: FactorErrors): boolean {
  return Object.keys(errors).length === 0;
}

export interface FactorSetCheck {
  valid: boolean;
  enabledCount: number;
  enabledTotal: number;
  problems: string[];
}

/** The 100 percent rule, as a check the editor can render live. */
export function checkFactorSet(factors: readonly ScoringFactor[]): FactorSetCheck {
  const problems: string[] = [];
  const enabled = factors.filter((factor) => factor.enabled);
  const enabledTotal = Number(
    enabled.reduce((total, factor) => total + factor.weight, 0).toFixed(2),
  );

  if (factors.length === 0) problems.push('A scoring model needs at least one factor.');
  if (enabled.length === 0) problems.push('At least one factor must stay enabled.');
  if (enabled.length > 0 && enabledTotal !== 100) {
    problems.push(`Enabled weights must total exactly 100 (currently ${enabledTotal}).`);
  }
  const seen = new Set<string>();
  for (const factor of factors) {
    if (seen.has(factor.key)) problems.push(`Duplicate factor key: ${factor.key}.`);
    seen.add(factor.key);
  }

  return { valid: problems.length === 0, enabledCount: enabled.length, enabledTotal, problems };
}

export function toFactorPayload(factors: readonly ScoringFactor[]) {
  return factors.map((factor, index) => ({
    key: factor.key,
    label: factor.label.trim(),
    metric: factor.metric,
    weight: factor.weight,
    direction: factor.direction,
    normalization: factor.normalization,
    configuration: factor.configuration as ScoringFactorConfiguration,
    enabled: factor.enabled,
    sort_order: index,
  }));
}

interface RawFactorBody {
  key?: unknown;
  label?: unknown;
  metric?: unknown;
  weight?: unknown;
  direction?: unknown;
  normalization?: unknown;
  configuration?: unknown;
  enabled?: unknown;
}

function parseFactorBody(value: unknown, index: number): ScoringFactor {
  if (typeof value !== 'object' || value === null) {
    throw new ScoringValidationError(`Factor ${index + 1} is not an object.`);
  }
  const raw = value as RawFactorBody;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  const metric = typeof raw.metric === 'string' ? raw.metric.trim() : '';
  const weight = typeof raw.weight === 'number' ? raw.weight : Number(raw.weight);
  const direction = raw.direction;
  const normalization = raw.normalization;

  const configuration: ScoringFactorConfiguration = {};
  if (typeof raw.configuration === 'object' && raw.configuration !== null) {
    const source = raw.configuration as Record<string, unknown>;
    if (Array.isArray(source.points)) {
      configuration.points = source.points.flatMap((point): ScoringThresholdPoint[] => {
        const entry = point as { value?: unknown; score?: unknown };
        const pointValue = typeof entry?.value === 'number' ? entry.value : Number(entry?.value);
        const pointScore = typeof entry?.score === 'number' ? entry.score : Number(entry?.score);
        return Number.isFinite(pointValue) && Number.isFinite(pointScore)
          ? [{ value: pointValue, score: pointScore }]
          : [];
      });
    }
    const missing = source.missing_score;
    if (typeof missing === 'number') configuration.missing_score = missing;
    const degenerate = source.degenerate_score;
    if (typeof degenerate === 'number') configuration.degenerate_score = degenerate;
  }

  const factor: ScoringFactor = {
    key,
    label,
    metric,
    weight: Number.isFinite(weight) ? weight : Number.NaN,
    direction: DIRECTIONS.includes(direction as ScoringDirection)
      ? (direction as ScoringDirection)
      : 'positive',
    normalization: NORMALIZATIONS.includes(normalization as ScoringNormalization)
      ? (normalization as ScoringNormalization)
      : 'threshold',
    configuration,
    enabled: raw.enabled === undefined ? true : raw.enabled !== false,
    sortOrder: index,
  };

  const errors = validateScoringFactor(factor);
  if (!factorErrorsEmpty(errors)) {
    const first = Object.values(errors)[0];
    throw new ScoringValidationError(first ?? `Factor ${factor.key || index + 1} is invalid.`);
  }

  return factor;
}

export function parseScoringModelRequest(body: unknown): ScoringModelInput {
  if (typeof body !== 'object' || body === null) {
    throw new ScoringValidationError('A JSON body is required.');
  }
  const raw = body as Record<string, unknown>;
  const name = requireText(raw.name, 'model name', 120);
  const description =
    typeof raw.description === 'string' && raw.description.trim()
      ? (raw.description.trim().slice(0, 500) as string)
      : null;
  if (raw.status !== undefined && !STATUSES.includes(raw.status as ScoringModelStatus)) {
    throw new ScoringValidationError('A model status is draft, active or archived.');
  }
  const status = STATUSES.includes(raw.status as ScoringModelStatus)
    ? (raw.status as ScoringModelStatus)
    : 'draft';
  const factorsInput = Array.isArray(raw.factors) ? raw.factors : [];
  if (factorsInput.length === 0) {
    throw new ScoringValidationError('A scoring model needs at least one factor.');
  }
  if (factorsInput.length > 12) {
    throw new ScoringValidationError('A scoring model may have at most 12 factors.');
  }

  const factors = factorsInput.map((factor, index) => parseFactorBody(factor, index));
  const check = checkFactorSet(factors);
  if (!check.valid) {
    throw new ScoringValidationError(check.problems[0]);
  }

  return {
    name,
    description,
    status,
    factors: toFactorPayload(factors),
  };
}

export interface CandidateInput {
  projectId: string;
  name: string;
  longitude: number;
  latitude: number;
}

export interface ProjectInput {
  name: string;
  description: string | null;
}

/**
 * Explicit project creation. The browser never gets a workspace id of its own
 * choosing and the server never creates a project on its own: this parses a name
 * a person typed, and the database policies decide whether they may create it.
 */
export function parseProjectRequest(body: unknown): ProjectInput {
  if (typeof body !== 'object' || body === null) {
    throw new ScoringValidationError('A JSON body is required.');
  }
  const raw = body as Record<string, unknown>;
  const name = requireText(raw.name, 'project name', 120);
  const description =
    typeof raw.description === 'string' && raw.description.trim()
      ? raw.description.trim().slice(0, 500)
      : null;

  return { name, description };
}

export function parseCandidateRequest(body: unknown): CandidateInput {
  if (typeof body !== 'object' || body === null) {
    throw new ScoringValidationError('A JSON body is required.');
  }
  const raw = body as Record<string, unknown>;
  const projectId = requireUuid(raw.projectId, 'project id');
  const name = requireText(raw.name, 'candidate name', 120);
  const longitude = Number(raw.longitude);
  const latitude = Number(raw.latitude);

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new ScoringValidationError('A longitude between -180 and 180 is required.');
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new ScoringValidationError('A latitude between -90 and 90 is required.');
  }

  return { projectId, name, longitude, latitude };
}

export function parseScoringRunRequest(body: unknown, mode: ScoringMode): ScoringRunRequest {
  if (typeof body !== 'object' || body === null) {
    throw new ScoringValidationError('A JSON body is required.');
  }
  const raw = body as Record<string, unknown>;
  const projectId = requireUuid(raw.projectId, 'project id');
  const scoringModelId = requireUuid(raw.scoringModelId, 'scoring model id');
  const radiusMeters = Number(raw.radiusMeters);
  const candidateIds = Array.isArray(raw.candidateIds) ? raw.candidateIds : [];

  if (!Number.isInteger(radiusMeters) || radiusMeters < MIN_RADIUS_METERS || radiusMeters > MAX_RADIUS_METERS) {
    throw new ScoringValidationError(
      `A radius between ${MIN_RADIUS_METERS} and ${MAX_RADIUS_METERS} meters is required.`,
    );
  }
  if (!candidateIds.every(isUuid)) {
    throw new ScoringValidationError('Every candidate must be a saved candidate location.');
  }
  if (candidateIds.length === 0) {
    throw new ScoringValidationError('Choose at least one saved candidate location.');
  }
  if (candidateIds.length > MAX_COMPARISON_CANDIDATES) {
    throw new ScoringValidationError(
      `A comparison accepts at most ${MAX_COMPARISON_CANDIDATES} candidate locations.`,
    );
  }
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new ScoringValidationError('Every candidate may appear only once.');
  }
  if (mode === 'comparison' && candidateIds.length < 2) {
    throw new ScoringValidationError('A comparison needs at least two candidate locations.');
  }

  return { projectId, candidateIds, radiusMeters, scoringModelId, mode };
}

export function parseAnalysisId(value: unknown): string {
  return requireUuid(value, 'analysis id');
}

export function parseModelId(value: unknown): string {
  return requireUuid(value, 'scoring model id');
}
