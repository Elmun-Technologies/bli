/**
 * Phase 7 report contract tests: snapshot integrity, the deterministic
 * executive summary, the single formatting path (ReportViewModel), the shipped
 * parsers, and the PII boundary.
 *
 * These run without a database and without a PDF renderer; the SQL/RLS matrix
 * lives in `supabase/tests/phase7_reports_rls.sql` and the rendered PDF in
 * `pdf/pdf.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMetricValue, formatRadius } from '@/lib/scoring/catalogue';
import { formatReportNumber, formatReportScore } from './format';

import {
  parseReportDetailResponse,
  parseReportListResponse,
  parseReportMutationResponse,
  parseReportSnapshot,
  parseReportSummary,
  parseReportViewModel,
  ReportPayloadError,
} from './parser';
import { reportValidationMessage, REPORT_SAFE_MESSAGES } from './messages';
import { canonicalize, hashCanonical, reportTypeForMode, verifySnapshotHash } from './snapshot';
import { buildExecutiveSummary, selectConsiderations, selectStrengths } from './summary';
import {
  ALL_PII_MARKERS,
  buildComparisonSnapshot,
  buildPiiPayload,
  buildReportSnapshot,
  buildSingleSnapshot,
  loadStoredPayload,
  snapshotInput,
} from './test-fixtures';
import { REPORT_DISCLAIMER, SCORE_EXPLANATION, type ReportSummary } from './types';
import { buildReportViewModel } from './view-model';
import { parseReportCreateRequest, parseLogoUpload, parseReportUpdateRequest } from './validation';

const FORBIDDEN_PHRASES = [
  'chance of success',
  'probability of success',
  'predict',
  'prediction',
  'forecast',
  'ai recommends',
  'we recommend',
  'guarantee',
  'will be profitable',
  'revenue will',
  'expected return',
  'roi',
  'confidence',
];

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => collectStrings(entry, out));
  }
  return out;
}

test('the comparison snapshot copies stored scores, ranks and metrics verbatim', async () => {
  const payload = loadStoredPayload('stored-comparison');
  const snapshot = buildReportSnapshot(snapshotInput(payload));

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.report.type, 'comparison');
  assert.equal(snapshot.analysis.mode, 'comparison');
  assert.equal(snapshot.analysis.candidateCount, 3);
  assert.equal(snapshot.analysis.modelVersion, payload.analysis.modelVersion);
  assert.equal(snapshot.analysis.radiusMeters, payload.analysis.radiusMeters);
  assert.equal(snapshot.candidates.length, 3);

  // Ranks are the stored ranks and the labels are A..E in that order.
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.label),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(
    snapshot.candidates.map((candidate) => candidate.rank),
    payload.results.map((result) => result.rank),
  );

  const stored = payload.results[0];
  const copied = snapshot.candidates[0];
  assert.equal(copied.id, stored.candidateId);
  assert.equal(copied.finalScore, stored.finalScore);
  assert.equal(copied.longitude, stored.longitude);
  assert.equal(copied.latitude, stored.latitude);
  assert.deepEqual(copied.normalizedMetrics, stored.normalizedMetrics);
  assert.equal(copied.metrics.customersRevenueTotal, stored.rawMetrics.customersRevenueTotal);
  assert.equal(typeof copied.metrics.customersRevenueTotal, 'string');
  assert.deepEqual(
    copied.contributions.map((entry) => entry.key),
    stored.contributions.map((entry) => entry.key),
  );
  assert.deepEqual(
    copied.contributions.map((entry) => entry.contribution),
    stored.contributions.map((entry) => entry.contribution),
  );

  // The factor definitions are the ones the analysis used, with the same weights.
  assert.deepEqual(
    snapshot.model.factors.map((factor) => [factor.key, factor.weight, factor.enabled]),
    payload.model.factors
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((factor) => [factor.key, factor.weight, factor.enabled]),
  );

  assert.equal(snapshot.methodology.scoreExplanation, SCORE_EXPLANATION);
  assert.equal(snapshot.methodology.disclaimer, REPORT_DISCLAIMER);
  assert.equal(snapshot.report.createdAt, '2026-10-05T09:40:00.000Z');
  assert.equal(snapshot.analysis.createdAt, payload.analysis.createdAt);
  assert.equal(snapshot.analysis.mayBeOutdated, payload.analysis.mayBeOutdated);
});

test('a one-candidate stored analysis becomes a single_location report', () => {
  const payload = loadStoredPayload('stored-analysis');
  const snapshot = buildSingleSnapshot();

  assert.equal(reportTypeForMode(payload), 'single_location');
  assert.equal(snapshot.report.type, 'single_location');
  assert.equal(snapshot.candidates.length, 1);
  assert.equal(snapshot.candidates[0].label, 'A');
  assert.equal(snapshot.analysis.candidateCount, 1);
});

test('canonicalization is stable and order-insensitive while the hash is not', async () => {
  const snapshot = buildComparisonSnapshot();

  assert.equal(canonicalize({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(canonicalize(undefined), 'null');

  const reordered = Object.fromEntries(
    Object.entries(snapshot as unknown as Record<string, unknown>).reverse(),
  );
  assert.equal(canonicalize(reordered), canonicalize(snapshot));

  const hash = await hashCanonical(snapshot);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(await hashCanonical(snapshot), hash);
  assert.equal(await hashCanonical(reordered), hash);
  assert.equal(await verifySnapshotHash(snapshot, hash), true);
  assert.equal(await verifySnapshotHash(snapshot, 'a'.repeat(64)), false);
});

test('a mutated snapshot fails its hash: a moved decimal is detected', async () => {
  const snapshot = buildComparisonSnapshot();
  const hash = await hashCanonical(snapshot);

  const mutated = structuredClone(snapshot);
  mutated.candidates[0].finalScore = Number((mutated.candidates[0].finalScore + 0.01).toFixed(2));
  assert.equal(await verifySnapshotHash(mutated, hash), false);

  const rewritten = structuredClone(snapshot);
  rewritten.model.factors[0].weight = rewritten.model.factors[0].weight + 1;
  assert.equal(await verifySnapshotHash(rewritten, hash), false);

  const reRanked = structuredClone(snapshot);
  reRanked.candidates.reverse();
  assert.equal(await verifySnapshotHash(reRanked, hash), false);
});

test('the executive summary is deterministic, stored-number only and claim-free', () => {
  const snapshot = buildComparisonSnapshot();
  const first = buildExecutiveSummary(snapshot);
  const second = buildExecutiveSummary(structuredClone(snapshot));
  assert.deepEqual(first, second);

  const top = snapshot.candidates[0];
  assert.equal(
    first.headline,
    `${top.name} (${top.label}) ranked first with a score of ${formatReportNumber(top.finalScore)} / 100.`,
  );
  assert.match(
    first.paragraphs[0],
    new RegExp(`^3 candidate locations were compared using ${snapshot.model.name} v${snapshot.model.version}`),
  );
  assert.match(first.paragraphs[0], new RegExp(formatRadius(snapshot.analysis.radiusMeters).replace(/\./g, '\\.')));

  const strengths = selectStrengths(top, snapshot.model.factors);
  const considerations = selectConsiderations(top, snapshot.model.factors);
  assert.ok(strengths.length >= 1 && strengths.length <= 2);
  assert.ok(considerations.length >= 1 && considerations.length <= 2);
  // A contribution is a plain number of points; only a score carries "/ 100".
  assert.match(strengths[0].contributionText, /^\d+(\.\d\d)?$/);
  // The strongest contribution really is the strongest of the enabled factors.
  const enabledKeys = new Set(
    snapshot.model.factors.filter((factor) => factor.enabled).map((factor) => factor.key),
  );
  const contributions = top.contributions
    .filter((contribution) => enabledKeys.has(contribution.key))
    .map((contribution) => contribution.contribution);
  assert.equal(Number(strengths[0].contributionText), Math.max(...contributions));

  const text = collectStrings([first.headline, ...first.paragraphs.slice(0, -1), ...first.keyPoints])
    .join(' ')
    .toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.ok(!text.includes(phrase), `the summary must not contain "${phrase}"`);
  }

  // A single-location summary keeps the same wording rules.
  const single = buildExecutiveSummary(buildSingleSnapshot());
  assert.match(single.headline, /scored \d+\.\d\d \/ 100\.$/);
  const singleText = collectStrings([single.headline, ...single.paragraphs.slice(0, -1), ...single.keyPoints])
    .join(' ')
    .toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.ok(!singleText.includes(phrase), `the summary must not contain "${phrase}"`);
  }
});

test('a disabled factor is never called a strength or a consideration', () => {
  const snapshot = buildComparisonSnapshot();
  const first = snapshot.model.factors[0].key;
  const disabled = structuredClone(snapshot);
  disabled.model.factors = disabled.model.factors.map((factor) => ({
    ...factor,
    enabled: factor.key === first ? false : factor.enabled,
  }));

  const top = disabled.candidates[0];
  const labels = [
    ...selectStrengths(top, disabled.model.factors),
    ...selectConsiderations(top, disabled.model.factors),
  ].map((row) => row.label);
  const disabledLabel = disabled.model.factors.find((factor) => factor.key === first)?.label;
  assert.ok(disabledLabel);
  assert.ok(!labels.includes(disabledLabel), 'a disabled factor must not be presented');
});

test('the view model is the single formatting path for preview and PDF', () => {
  const snapshot = buildComparisonSnapshot();
  const viewModel = buildReportViewModel(snapshot, {
    reportId: '00000000-0000-4000-8000-0000000000a1',
    status: 'ready',
    generatedAt: '2026-10-05T09:45:00.000Z',
    snapshotHash: 'a'.repeat(64),
    mapAvailable: true,
  });

  assert.equal(viewModel.report.typeLabel, 'Comparison report');
  assert.equal(viewModel.report.status, 'ready');
  assert.equal(viewModel.report.generatedAtText, '2026-10-05 09:45 UTC');
  assert.equal(viewModel.report.snapshotHash, 'a'.repeat(64));
  assert.equal(viewModel.analysis.radiusText, formatRadius(snapshot.analysis.radiusMeters));
  assert.equal(viewModel.analysis.dataSnapshotText, '2026-10-05 06:02 UTC');

  const top = snapshot.candidates[0];
  const topView = viewModel.candidates[0];
  assert.equal(topView.scoreText, formatReportScore(top.finalScore));
  assert.deepEqual(
    viewModel.ranking.map((row) => row.scoreText),
    snapshot.candidates.map((candidate) => formatReportScore(candidate.finalScore)),
  );
  assert.deepEqual(viewModel.summary.paragraphs, buildExecutiveSummary(snapshot).paragraphs);

  // Factor rows freeze the formatted contribution text at build time.
  assert.deepEqual(
    topView.factors.map((row) => row.key),
    top.contributions.map((row) => row.key),
  );
  for (const row of topView.factors) {
    const stored = top.contributions.find((entry) => entry.key === row.key);
    assert.ok(stored, `no stored contribution for ${row.key}`);
    assert.equal(row.contributionText, formatReportNumber(stored.contribution));
    assert.equal(row.weightText, `${stored.weight}%`);
    assert.equal(row.normalizedText, formatReportNumber(stored.normalized));
  }
  assert.equal(topView.coordinatesText.includes(','), true);

  const comparison = viewModel.comparison;
  assert.ok(comparison);
  assert.equal(comparison.rows.length, 3);
  const row = comparison.rows[0];
  assert.equal(row.customersText, formatMetricValue('customers_count', top.metrics.customersCount));
  assert.equal(row.revenueText, formatMetricValue('customers_revenue_total', top.metrics.customersRevenueTotal));
  assert.equal(row.densityText, formatMetricValue('customers_per_sq_km', top.metrics.customersPerSqKm));

  // Money is only ever the stored decimal string, never a recomputed float.
  assert.equal(typeof row.revenueText, 'string');

  const single = buildReportViewModel(buildSingleSnapshot(), { mapAvailable: false });
  assert.equal(single.comparison, null);
  assert.equal(single.map.available, false);
  assert.equal(single.map.note !== null, true);

  // No business text of the view model makes a prediction claim.
  const text = collectStrings(viewModel).join(' ').replaceAll(REPORT_DISCLAIMER, '').toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    assert.ok(!text.includes(phrase), `the view model must not contain "${phrase}"`);
  }
});

test('the snapshot and its view model carry no customer-level PII', () => {
  const snapshot = buildReportSnapshot(snapshotInput(buildPiiPayload()));
  const viewModel = buildReportViewModel(snapshot, { mapAvailable: true });
  const serialized = JSON.stringify(snapshot);
  const viewText = collectStrings(viewModel).join(' ');

  // The fixture really does carry the markers before the projection.
  const raw = buildPiiPayload();
  assert.ok(JSON.stringify(raw).includes(ALL_PII_MARKERS[0]));

  for (const marker of ALL_PII_MARKERS) {
    assert.ok(!serialized.includes(marker), `the snapshot leaked ${marker}`);
    assert.ok(!viewText.includes(marker), `the view model leaked ${marker}`);
  }

  // The allowed aggregate metrics are still there.
  assert.ok(snapshot.candidates[0].metrics.customersCount > 0);
  assert.equal(typeof snapshot.candidates[0].metrics.customersRevenueTotal, 'string');
});

test('the shipped parsers accept the API shapes and reject drift loudly', () => {
  const snapshot = buildComparisonSnapshot();
  const summary: ReportSummary = {
    id: '00000000-0000-4000-8000-0000000000a1',
    workspaceId: snapshot.workspace.id,
    projectId: snapshot.project.id,
    analysisId: snapshot.analysis.id,
    type: 'comparison',
    title: snapshot.report.title,
    subtitle: snapshot.report.subtitle,
    companyName: snapshot.branding.companyName,
    status: 'ready',
    snapshotHash: 'b'.repeat(64),
    failureCode: null,
    hasMap: true,
    hasLogo: false,
    createdBy: '00000000-0000-4000-8000-00000000cafe',
    createdAt: snapshot.report.createdAt,
    updatedAt: snapshot.report.createdAt,
    generatedAt: '2026-10-05T09:45:00.000Z',
  };

  // The server writes camelCase; the database shape (snake_case) is accepted too.
  assert.deepEqual(parseReportSummary(summary), summary);
  const snake = {
    id: summary.id,
    workspace_id: summary.workspaceId,
    project_id: summary.projectId,
    analysis_id: summary.analysisId,
    report_type: 'comparison',
    title: summary.title,
    subtitle: null,
    company_name: null,
    status: 'draft',
    snapshot_hash: null,
    failure_code: null,
    has_map: false,
    has_logo: false,
    created_by: summary.createdBy,
    created_at: summary.createdAt,
    updated_at: summary.updatedAt,
    generated_at: null,
  };
  const parsedSnake = parseReportSummary(snake);
  assert.equal(parsedSnake.type, 'comparison');
  assert.equal(parsedSnake.status, 'draft');
  assert.equal(parsedSnake.snapshotHash, null);

  const list = parseReportListResponse({
    projects: [{ id: snapshot.project.id, name: snapshot.project.name, status: 'active' }],
    projectId: snapshot.project.id,
    reports: [summary],
  });
  assert.equal(list.projectId, snapshot.project.id);
  assert.equal(list.reports.length, 1);
  assert.equal(list.projects[0].name, snapshot.project.name);

  const detail = parseReportDetailResponse({
    report: summary,
    viewModel: buildReportViewModel(snapshot, { mapAvailable: true }),
  });
  assert.equal(detail.report.id, summary.id);
  assert.equal(detail.viewModel?.candidates.length, 3);
  assert.deepEqual(parseReportMutationResponse({ report: summary }), summary);

  // Round trip: a snapshot survives canonical serialization and parses back.
  const reparsed = parseReportSnapshot(JSON.parse(canonicalize(snapshot)));
  assert.deepEqual(reparsed, snapshot);
  assert.deepEqual(parseReportViewModel(JSON.parse(JSON.stringify(detail.viewModel))), detail.viewModel);

  assert.throws(() => parseReportSummary({ ...summary, status: 'archived' }), ReportPayloadError);
  assert.throws(() => parseReportSnapshot({ ...snapshot, candidates: [] }), ReportPayloadError);
  assert.throws(() => parseReportSnapshot({ ...snapshot, version: 99 }), ReportPayloadError);
  assert.throws(
    () => parseReportSnapshot({ ...snapshot, candidates: [{ ...snapshot.candidates[0], latitude: '41.3' }] }),
    ReportPayloadError,
  );
  assert.throws(() => parseReportListResponse({ reports: [summary] }), ReportPayloadError);
});

test('request validation refuses unsafe input before any database call', () => {
  const created = parseReportCreateRequest({
    projectId: '00000000-0000-4000-8000-000000000020',
    analysisId: '02dbabb2-886b-4844-9064-fdbb1f7595c8',
    title: '  Tashkent review  ',
    subtitle: '',
    companyName: null,
    includeMap: false,
  });
  assert.equal(created.title, 'Tashkent review');
  assert.equal(created.subtitle, null);
  assert.equal(created.includeMap, false);

  assert.throws(() => parseReportCreateRequest({ analysisId: 'x' }), /project id/);
  assert.throws(() => parseReportCreateRequest(null), /JSON body/);
  assert.throws(
    () => parseReportCreateRequest({ projectId: created.projectId, analysisId: 'not-a-uuid' }),
    /analysis id/,
  );
  assert.throws(() => parseReportUpdateRequest({ title: '   ' }), /title is required/);
  assert.throws(
    () => parseReportUpdateRequest({ title: 'x'.repeat(200) }),
    /160 characters or fewer/,
  );

  // Logos: bytes decide, never the extension or a declared type alone.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(parseLogoUpload(png, 'image/png').mimeType, 'image/png');
  assert.throws(() => parseLogoUpload(new Uint8Array([0x3c, 0x73, 0x76, 0x67]), 'image/svg+xml'), /PNG or JPEG/);
  assert.throws(() => parseLogoUpload(new Uint8Array([0x3c, 0x3f, 0x78, 0x6d]), 'image/png'), /PNG or JPEG/);
  assert.throws(() => parseLogoUpload(new Uint8Array(), 'image/png'), /empty/);

  // A declaration may not lie about the bytes, in either direction.
  assert.throws(() => parseLogoUpload(png, 'image/svg+xml'), /PNG or JPEG/);
  assert.throws(() => parseLogoUpload(png, 'image/jpeg'), /not a JPEG/);
  assert.throws(() => parseLogoUpload(png, 'text/plain'), /PNG or JPEG/);
  // A matching declaration with parameters is still a PNG, and no declaration
  // at all is decided by the bytes.
  assert.equal(parseLogoUpload(png, 'image/png; charset=binary').mimeType, 'image/png');
  assert.equal(parseLogoUpload(png, null).mimeType, 'image/png');
  assert.equal(parseLogoUpload(png, '').mimeType, 'image/png');
});

test('the documented validation messages are the ones the UI shows', () => {
  // A silent copy change in a user-facing message should be a test failure, not
  // a surprise in production.
  assert.equal(
    reportValidationMessage('project_required'),
    'Select a project in this workspace before continuing.',
  );
  assert.equal(reportValidationMessage('report_not_ready'), 'This report has no PDF yet. Generate it first.');
  assert.equal(
    reportValidationMessage('report_integrity_failed'),
    'This report failed its integrity check and was not regenerated.',
  );
  // Unknown codes never echo anything from the database.
  assert.equal(reportValidationMessage('ERROR: relation does not exist'), REPORT_SAFE_MESSAGES.invalid_request);
});
