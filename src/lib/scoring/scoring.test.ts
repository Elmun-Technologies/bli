/**
 * Phase 6 scoring unit tests.
 *
 * The authoritative arithmetic lives in Postgres (`run_location_analysis`,
 * `scoring_interpolate`, the weight assertions) and is covered by
 * `supabase/tests/phase6_scoring_engine.sql`. These tests cover the shipped
 * TypeScript half of the contract:
 *
 *  - the editor's mirror of the database rules (weights, thresholds, methods),
 *  - the request validation the API applies before an RPC is called,
 *  - the presentation view over a stored payload (labels, bands, consistency),
 *  - the CSV export of a comparison,
 *  - the parser, exercised against payloads captured verbatim from the shipped
 *    `location_analysis_payload` RPC of a seeded database.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { findMetric, formatMetricValue, formatScore, scoreBandLabel, SCORE_BANDS } from './catalogue';
import { buildComparisonCsv, comparisonCsvFilename } from './export';
import { parseScoringAnalysis, parseScoringModelList } from './payload';
import type { AnalysisCandidateResult, ScoringAnalysisPayload, ScoringFactor } from './types';
import {
  checkFactorSet,
  formatThresholdPoints,
  parseScoringModelRequest,
  parseScoringRunRequest,
  parseThresholdPointsText,
  ScoringValidationError,
  validateScoringFactor,
} from './validation';
import { buildBreakdown, buildComparisonRows, freshnessNote, sortComparisonRows } from './view';

function fixture(name: 'stored-analysis' | 'stored-comparison'): ScoringAnalysisPayload {
  const url = new URL(`./__fixtures__/${name}.payload.json`, import.meta.url);
  return parseScoringAnalysis(JSON.parse(readFileSync(url, 'utf8')));
}

function factor(overrides: Partial<ScoringFactor> = {}): ScoringFactor {
  return {
    key: 'customer_density',
    label: 'Customer density',
    metric: 'customers_count',
    weight: 100,
    direction: 'positive',
    normalization: 'min_max',
    configuration: { missing_score: 0, degenerate_score: 50 },
    enabled: true,
    sortOrder: 0,
    ...overrides,
  };
}

test('the captured single-candidate payload parses into the typed contract', () => {
  const payload = fixture('stored-analysis');

  assert.equal(payload.analysis.mode, 'analysis');
  assert.equal(payload.analysis.candidateCount, 1);
  assert.equal(payload.analysis.radiusMeters, 500);
  assert.equal(payload.analysis.modelVersion, 1);
  assert.equal(payload.analysis.mayBeOutdated, false);
  assert.equal(payload.analysis.modelName, 'Retail Expansion Model');
  assert.equal(payload.model.factors.length, 5);
  assert.equal(payload.results.length, 1);

  const result = payload.results[0];
  assert.equal(result.finalScore, 20.2);
  assert.equal(result.rank, 1);
  assert.equal(result.rawMetrics.customersCount, 2);
  // Revenue stays exact decimal text end to end: never a binary float.
  assert.equal(typeof result.rawMetrics.customersRevenueTotal, 'string');
  assert.equal(result.rawMetrics.customersRevenueTotal, '495.93');
  assert.equal(result.contributions.length, 5);
  assert.equal(
    Number(result.contributions.reduce((total, entry) => total + entry.contribution, 0).toFixed(2)),
    result.finalScore,
  );
});

test('the model summary the API returns parses into the editor contract', () => {
  // The exact envelope `GET /api/workspaces/{id}/scoring-models` returns. The
  // smoke caught an earlier version of the parser reading the database shape
  // here and silently turning every weight total into 0.
  const apiPayload = {
    models: [
      {
        id: '00000000-0000-4000-8000-000000000040',
        workspaceId: '00000000-0000-4000-8000-000000000010',
        name: 'Retail Expansion Model',
        description: null,
        status: 'active',
        version: 1,
        enabledFactorCount: 5,
        enabledWeightTotal: 100,
        updatedAt: '2026-10-05T06:02:31.165+00:00',
      },
    ],
  };

  const summaries = parseScoringModelList(apiPayload);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].enabledFactorCount, 5);
  assert.equal(summaries[0].enabledWeightTotal, 100);
  assert.equal(summaries[0].workspaceId, '00000000-0000-4000-8000-000000000010');
  assert.equal(summaries[0].version, 1);
  assert.equal(summaries[0].updatedAt, '2026-10-05T06:02:31.165+00:00');

  // A database-shaped row keeps working, and a summary without the totals is a
  // hard zero rather than a silent partial.
  const [fromDatabase] = parseScoringModelList({
    models: [
      {
        id: '00000000-0000-4000-8000-000000000041',
        workspace_id: '00000000-0000-4000-8000-000000000010',
        name: 'Draft model',
        status: 'draft',
        version: 1,
        enabled_factor_count: 2,
        enabled_weight_total: 40.5,
        updated_at: '2026-10-05T06:02:31.165+00:00',
      },
    ],
  });
  assert.equal(fromDatabase.enabledFactorCount, 2);
  assert.equal(fromDatabase.enabledWeightTotal, 40.5);
});

test('the captured comparison payload keeps its stored order and decimals', () => {
  const payload = fixture('stored-comparison');

  assert.equal(payload.analysis.mode, 'comparison');
  assert.equal(payload.analysis.candidateCount, 3);
  assert.equal(payload.analysis.radiusMeters, 1_000);
  assert.deepEqual(
    payload.results.map((result) => result.finalScore),
    [34.65, 24.48, 18.45],
  );
  assert.deepEqual(
    payload.results.map((result) => result.rank),
    [1, 2, 3],
  );
  assert.deepEqual(
    payload.results.map((result) => result.rawMetrics.customersRevenueTotal),
    ['2908.59', '2620.74', '2446.76'],
  );
});

test('a stored payload without a final score is refused, never read as zero', () => {
  const raw = JSON.parse(
    readFileSync(new URL('./__fixtures__/stored-analysis.payload.json', import.meta.url), 'utf8'),
  );
  delete raw.results[0].final_score;

  assert.throws(() => parseScoringAnalysis(raw), /final_score/);
});

test('the breakdown adds the stored contributions and reports whether they match', () => {
  const payload = fixture('stored-comparison');
  const breakdown = buildBreakdown(payload.results[0]);

  assert.equal(breakdown.finalScore, 34.65);
  assert.equal(breakdown.contributionTotal, 34.65);
  assert.equal(breakdown.consistent, true);
  assert.equal(breakdown.band, 'Weak');
  assert.equal(breakdown.rows.length, 5);

  const tampered: AnalysisCandidateResult = {
    ...payload.results[0],
    finalScore: 99,
  };
  assert.equal(buildBreakdown(tampered).consistent, false);
});

test('comparison rows are labelled A..E in stored rank order and copy their figures', () => {
  const payload = fixture('stored-comparison');
  const rows = buildComparisonRows(payload);

  assert.deepEqual(
    rows.map((row) => row.label),
    ['A', 'B', 'C'],
  );
  assert.equal(rows[0].candidateName, 'Yunusabad junction (saved candidate)');
  assert.equal(rows[0].score, 34.65);
  assert.equal(rows[0].customers, 14);
  assert.equal(rows[0].revenueTotal, '2908.59');
  assert.equal(rows[0].poiCount > 0, true);
  // The negative-direction competition factor is surfaced with its own score,
  // and the positive contributions are summed into the opportunity column.
  assert.notEqual(rows[0].competitionScore, null);
  assert.ok((rows[0].opportunityScore ?? -1) >= 0);
  assert.ok(rows[0].opportunityScore <= rows[0].score);
});

test('sorting never changes the numbers and a missing value sorts last', () => {
  const payload = fixture('stored-comparison');
  const rows = buildComparisonRows(payload);

  assert.deepEqual(
    sortComparisonRows(rows, 'score').map((row) => row.label),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(
    sortComparisonRows(rows, 'score', 'asc').map((row) => row.label),
    ['C', 'B', 'A'],
  );
  assert.deepEqual(
    sortComparisonRows(rows, 'revenue', 'asc').map((row) => row.label),
    ['C', 'B', 'A'],
  );

  const withoutCompetition = rows.map((row) => ({ ...row, competitionScore: null }));
  assert.deepEqual(
    sortComparisonRows(withoutCompetition, 'competition').map((row) => row.label),
    ['A', 'B', 'C'],
  );
});

test('the freshness flag is advisory and never rewrites the stored score', () => {
  const payload = fixture('stored-analysis');
  assert.equal(freshnessNote(payload), null);

  const outdated: ScoringAnalysisPayload = {
    ...payload,
    analysis: { ...payload.analysis, mayBeOutdated: true },
  };
  assert.match(freshnessNote(outdated) ?? '', /may be outdated/i);
  assert.equal(outdated.results[0].finalScore, 20.2);
});

test('scores are always rendered as a value out of 100, never a percentage', () => {
  assert.equal(formatScore(82), '82 / 100');
  assert.equal(formatScore(66.67), '66.67 / 100');
  assert.equal(formatScore(20.2), '20.20 / 100');
  assert.ok(!formatScore(82).includes('%'));
});

test('the documented bands describe the numeric score only', () => {
  assert.deepEqual(
    SCORE_BANDS.map((band) => band.label),
    ['Strong', 'Good', 'Moderate', 'Weak'],
  );
  assert.equal(scoreBandLabel(80), 'Strong');
  assert.equal(scoreBandLabel(79.99), 'Good');
  assert.equal(scoreBandLabel(60), 'Good');
  assert.equal(scoreBandLabel(59.99), 'Moderate');
  assert.equal(scoreBandLabel(40), 'Moderate');
  assert.equal(scoreBandLabel(39.99), 'Weak');
  assert.equal(scoreBandLabel(0), 'Weak');
});

test('money metrics keep their exact decimal text', () => {
  assert.equal(formatMetricValue('customers_revenue_total', '987654321098.76'), '987 654 321 098.76');
  assert.equal(formatMetricValue('customers_revenue_total', '0'), '0');
  assert.equal(formatMetricValue('nearest_branch_distance_meters', 6577.81), '6.58 km');
  assert.equal(formatMetricValue('customers_count', 14), '14');
  assert.equal(formatMetricValue('customers_count', null), '—');
});

test('every offered metric is a measured one', () => {
  assert.equal(findMetric('customers_count')?.suggests, 'positive');
  assert.equal(findMetric('competitors_count')?.suggests, 'negative');
  assert.equal(findMetric('branch_distance_score')?.suggestsNormalization, 'threshold');
  assert.equal(findMetric('made_up_metric'), null);
});

test('the weight rule requires exactly 100 across the enabled factors', () => {
  const valid = checkFactorSet([
    factor({ key: 'a', weight: 60 }),
    factor({ key: 'b', weight: 40 }),
  ]);
  assert.equal(valid.valid, true);
  assert.equal(valid.enabledTotal, 100);

  const disabledCounts = checkFactorSet([
    factor({ key: 'a', weight: 100 }),
    factor({ key: 'b', weight: 0, enabled: false }),
  ]);
  assert.equal(disabledCounts.valid, true);
  assert.equal(disabledCounts.enabledCount, 1);

  assert.equal(checkFactorSet([factor({ weight: 99.99 })]).valid, false);
  assert.equal(checkFactorSet([factor({ weight: 100.01 })]).valid, false);
  assert.equal(checkFactorSet([factor({ weight: 0 })]).valid, false);
  assert.equal(checkFactorSet([]).valid, false);
  assert.equal(checkFactorSet([factor({ enabled: false, weight: 0 })]).valid, false);
  assert.equal(
    checkFactorSet([
      factor({ key: 'same' }),
      factor({ key: 'same', weight: 0, enabled: false }),
    ]).valid,
    false,
  );
});

test('invalid factors are rejected with an explanation', () => {
  assert.match(validateScoringFactor(factor({ key: 'Bad Key' })).key ?? '', /lowercase key/);
  assert.match(validateScoringFactor(factor({ label: '   ' })).label ?? '', /needs a label/);
  assert.match(validateScoringFactor(factor({ metric: 'nope' })).metric ?? '', /measured metrics/);
  assert.match(validateScoringFactor(factor({ weight: -5 })).weight ?? '', /between 0 and 100/);
  assert.match(validateScoringFactor(factor({ weight: 101 })).weight ?? '', /between 0 and 100/);
  assert.match(validateScoringFactor(factor({ weight: 0 })).weight ?? '', /above 0/);
  assert.match(
    validateScoringFactor(factor({ normalization: 'min_max', direction: 'negative' })).method ?? '',
    /min_max is the positive/,
  );
  assert.match(
    validateScoringFactor(factor({ normalization: 'inverse_min_max', direction: 'positive' })).method ??
      '',
    /inverse_min_max is the negative/,
  );
  assert.equal(validateScoringFactor(factor()).key, undefined);
});

test('threshold stops must ascend, stay in 0..100 and follow the direction', () => {
  assert.equal(
    validateScoringFactor(
      factor({
        normalization: 'threshold',
        configuration: {
          points: [
            { value: 0, score: 0 },
            { value: 500, score: 50 },
            { value: 1000, score: 100 },
          ],
        },
      }),
    ).configuration,
    undefined,
  );

  const invalid = validateScoringFactor(
    factor({
      normalization: 'threshold',
      configuration: {
        points: [
          { value: 500, score: 50 },
          { value: 100, score: 60 },
        ],
      },
    }),
  );
  assert.match(invalid.configuration ?? '', /ascending stops/);

  assert.match(
    validateScoringFactor(
      factor({
        normalization: 'threshold',
        configuration: {
          points: [
            { value: 0, score: 0 },
            { value: 10, score: 120 },
          ],
        },
      }),
    ).configuration ?? '',
    /scores from 0 to 100/,
  );

  // A "more is worse" factor must decrease along its stops.
  assert.match(
    validateScoringFactor(
      factor({
        direction: 'negative',
        normalization: 'threshold',
        configuration: {
          points: [
            { value: 0, score: 0 },
            { value: 10, score: 50 },
          ],
        },
      }),
    ).configuration ?? '',
    /follow the factor direction/,
  );
});

test('threshold text round-trips through the editor format', () => {
  const points = parseThresholdPointsText('0:0, 500:50, 1000:100');
  assert.deepEqual(points, [
    { value: 0, score: 0 },
    { value: 500, score: 50 },
    { value: 1000, score: 100 },
  ]);
  assert.equal(formatThresholdPoints(points), '0:0, 500:50, 1000:100');
  assert.throws(() => parseThresholdPointsText('nonsense'), ScoringValidationError);
});

test('the model request validator refuses the shapes the database would refuse', () => {
  const body = {
    name: 'Retail expansion',
    description: 'Synthetic pilot model',
    status: 'active',
    factors: [
      {
        key: 'customer_density',
        label: 'Customer density',
        metric: 'customers_count',
        weight: 100,
        direction: 'positive',
        normalization: 'min_max',
        configuration: { missing_score: 0, degenerate_score: 50 },
        enabled: true,
      },
    ],
  };

  const input = parseScoringModelRequest(body);
  assert.equal(input.name, 'Retail expansion');
  assert.equal(input.factors[0].key, 'customer_density');
  assert.equal(input.factors[0].sort_order, 0);

  assert.throws(() => parseScoringModelRequest({ ...body, name: '' }), ScoringValidationError);
  assert.throws(
    () => parseScoringModelRequest({ ...body, status: 'published' }),
    ScoringValidationError,
  );
  assert.throws(() => parseScoringModelRequest({ ...body, factors: [] }), ScoringValidationError);
  assert.throws(
    () =>
      parseScoringModelRequest({
        ...body,
        factors: [{ ...body.factors[0], weight: 50 }],
      }),
    /total exactly 100/,
  );
  assert.throws(
    () =>
      parseScoringModelRequest({
        ...body,
        factors: [{ ...body.factors[0], normalization: 'min_max', direction: 'negative' }],
      }),
    ScoringValidationError,
  );
});

test('the run request validator enforces the comparison limits and radius bounds', () => {
  const base = {
    projectId: '00000000-0000-4000-8000-000000000020',
    scoringModelId: '00000000-0000-4000-8000-000000000040',
    radiusMeters: 1_000,
  };
  const ids = [
    '00000000-0000-4000-8000-000000000050',
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000052',
  ];

  assert.equal(
    parseScoringRunRequest({ ...base, candidateIds: [ids[0]] }, 'analysis').candidateIds.length,
    1,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, candidateIds: [ids[0]] }, 'comparison'),
    /at least two/,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, candidateIds: [] }, 'analysis'),
    /at least one/,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, candidateIds: [...ids, ...ids, ...ids] }, 'analysis'),
    /at most 5/,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, candidateIds: [ids[0], ids[0]] }, 'comparison'),
    /only once/,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, radiusMeters: 50, candidateIds: [ids[0]] }, 'analysis'),
    /between 100 and 20000/,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, radiusMeters: 50_000, candidateIds: [ids[0]] }, 'analysis'),
    /between 100 and 20000/,
  );
  assert.throws(
    () => parseScoringRunRequest({ ...base, candidateIds: ['not-a-uuid'] }, 'analysis'),
    /saved candidate/,
  );
});

test('the comparison CSV carries the same numbers as the table', () => {
  const payload = fixture('stored-comparison');
  const rows = buildComparisonRows(payload);
  const csv = buildComparisonCsv(payload, rows);
  const lines = csv.trim().split('\n');

  assert.equal(lines.length, 4);
  assert.match(lines[0], /^label,candidate,rank,score_out_of_100/);
  assert.match(lines[1], /^A,Yunusabad junction \(saved candidate\),1,34\.65/);
  assert.match(lines[1], /2908\.59/);
  assert.match(lines[1], /Retail Expansion Model,1,/);
  assert.match(comparisonCsvFilename(payload), /^location-comparison-retail-expansion-model-[0-9a-f]{8}\.csv$/);
});

test('CSV cells with separators are quoted, not mangled', () => {
  const payload = fixture('stored-analysis');
  const rows = buildComparisonRows(payload).map((row) => ({
    ...row,
    candidateName: 'Site "A", corner shop',
  }));
  const csv = buildComparisonCsv(payload, rows);
  const dataLine = csv.trim().split('\n')[1];

  assert.match(dataLine, /"Site ""A"", corner shop"/);
});
