/**
 * End-to-end smoke test for the Phase 7 executive decision reports.
 *
 * It starts the production build in database mode against a running local
 * Supabase project, signs in as the seeded roles, and drives the *shipped*
 * report API through the *shipped* client and parsers, with the deterministic
 * fake map provider (`REPORT_MAP_PROVIDER=fake`) so CI never needs a Mapbox
 * token and never spends map credits:
 *
 *   stored analysis -> report + immutable snapshot -> PDF bytes in private
 *   storage -> authorized download -> preview view model
 *
 * Everything a caller can see is inspected for the two hard product rules:
 * a report never claims to predict anything, and no customer-level value ever
 * reaches the snapshot, the preview, the PDF or a map provider.
 *
 * Requires SUPABASE_URL and SUPABASE_ANON_KEY plus a database that has been
 * reset and seeded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inflateSync } from 'node:zlib';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import { FAKE_MAP_FIXTURE_BYTES, fakeMapFixturePng } from '@/lib/reports/map/fixture-png';
import {
  createReport,
  generateReport,
  getReport,
  listReports,
  reportArtifactUrl,
  reportDownloadUrl,
  ReportsApiError,
  uploadReportLogo,
} from '@/lib/reports/client';
import { REPORT_DISCLAIMER } from '@/lib/reports/types';
import { formatReportDate } from '@/lib/reports/view-model';
import { formatRadius } from '@/lib/scoring/catalogue';
import {
  getScoringModel,
  listSavedCandidates,
  listScoringModels,
  listStoredAnalyses,
  listWorkspaceProjects,
  runAnalysis,
  saveCandidate,
} from '@/lib/scoring/client';

const PORT = Number(process.env.SMOKE_PORT ?? 3316);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const OWNER_A = { email: 'owner-a@example.test', password: 'phase4-demo-password' };
const ANALYST_A = { email: 'analyst-a@example.test', password: 'phase4-demo-password' };
const VIEWER_A = { email: 'viewer-a@example.test', password: 'phase4-demo-password' };
const OWNER_B = { email: 'owner-b@example.test', password: 'phase4-demo-password' };
const OUTSIDER = { email: 'outsider@example.test', password: 'phase4-demo-password' };
const WORKSPACE_A = '00000000-0000-4000-8000-000000000010';
const WORKSPACE_B = '00000000-0000-4000-8000-000000000011';

/**
 * Values that exist in the workspace data and must never appear in a report:
 * customer identities, customer contact fields, customer attributes, raw import
 * data and per-customer revenue. `Synthetic branch 000` is deliberately *not*
 * here: a branch is a business location, not a person, and the nearest-branch
 * label is part of the aggregate the report is allowed to show.
 */
const PII_MARKERS = [
  'synthetic-customer-',
  'isolation-customer-',
  'synthetic-retail',
  'no_contact_fields',
  'isolation-customer',
  '40000000-0000-4000-8000',
  '50000000-0000-4000-8000',
  'external_id',
  'import_row',
];

/** Phrases that would turn a decision-support score into a claim. */
const FORBIDDEN_CLAIMS = [
  '% chance',
  'chance of success',
  'probability of success',
  'ai recommends',
  'we recommend',
  'will be profitable',
  'expected return',
  'confidence score',
  'predicted revenue',
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let currentScenario = 'startup';

function note(scenario: string) {
  currentScenario = scenario;
  // Plain lines, not ::notice annotations: the job's annotation budget is shared
  // with four other smokes, and it must be free for the failure annotation this
  // script emits below (the CI log itself is not always readable from outside).
  console.log(`\n== ${scenario}`);
}

const FAILURE_FILE =
  process.env.SMOKE_FAILURE_FILE ??
  path.join(process.env.RUNNER_TEMP ?? '/tmp', 'report-smoke-failure.txt');

/**
 * Records a failure where CI can surface it even when the raw log is unreachable:
 * a readable file for the workflow's diagnostics step (which re-emits it as an
 * ::error annotation) plus stderr for the normal log path. Secrets are redacted
 * by the same sanitizer used for the server-log tail.
 */
function recordFailure(detail: string) {
  const safe = sanitizeDiagnostic(detail, 1800);
  try {
    writeFileSync(FAILURE_FILE, `${currentScenario}\n${safe}\n`, 'utf8');
  } catch {
    // Diagnostics must never mask the real failure.
  }
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=report smoke failure::${currentScenario} — ${safe.slice(0, 900)}`);
  }
}

/** A short, sanitized "expected … / got …" context around the first difference. */
function describeDifference(expected: string, actual: string): string {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) {
    index += 1;
  }
  const expectedSlice = sanitizeDiagnostic(expected.slice(index, index + 60), 60);
  const actualSlice = sanitizeDiagnostic(actual.slice(index, index + 60), 60);
  return `first difference at ${index}: expected "${expectedSlice}", got "${actualSlice}" (lengths ${expected.length} vs ${actual.length})`;
}

function sanitizeDiagnostic(text: string, limit = 1200): string {
  return text
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<redacted-jwt>')
    .replace(/\b(?:sb|sk|pk)_[A-Za-z0-9_-]{6,}/g, '<redacted-key>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: Response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(';');
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === '' || value === 'null') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/** The jar every shipped-client call is authenticated with. */
let activeJar: CookieJar | null = null;

/**
 * The shipped clients use same-origin relative URLs and browser cookies. The
 * smoke rewrites `/…` to the smoke server and attaches the current jar's
 * cookies, so the shipped modules run completely unchanged.
 */
function installFetchBridge() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === 'string' && input.startsWith('/') ? `${BASE_URL}${input}` : input;
    const headers = new Headers(init?.headers);
    const cookie = activeJar?.header();
    if (cookie && !headers.has('Cookie')) headers.set('Cookie', cookie);
    return originalFetch(target, { ...init, headers, redirect: 'manual' } as RequestInit);
  }) as typeof fetch;
}

async function request(url: string, init: RequestInit = {}, jar?: CookieJar | null): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar?.header();
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(`${BASE_URL}${url}`, { ...init, headers, redirect: 'manual' });
  jar?.store(response);
  return response;
}

async function readError(response: Response): Promise<{ code?: string; message?: string }> {
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    return payload.error ?? {};
  } catch {
    return {};
  }
}

/** Runs a shipped-client call and returns the safe refusal it produced. */
async function expectRefusal(
  run: () => Promise<unknown>,
  expectedStatus: number,
  expectedCode: string,
  what: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ReportsApiError) {
      assert(
        error.status === expectedStatus,
        `${what} must answer ${expectedStatus}, got ${error.status} (${error.code})`,
      );
      assert(
        error.code === expectedCode,
        `${what} must answer the safe code "${expectedCode}", got "${error.code}"`,
      );
      assert(
        !/postgres|policy|relation|storage|storage_path|analysis_reports|token|stack/i.test(error.message),
        `${what} leaked an internal detail: ${sanitizeDiagnostic(error.message)}`,
      );
      return;
    }
    throw error;
  }
  throw new Error(`${what} was allowed but must be refused`);
}

// ---------------------------------------------------------------- PDF reading

function decodePdfStreams(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const raw = buffer.toString('latin1');
  const streams: string[] = [];
  const marker = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = buffer.indexOf('endstream', start, 'latin1');
    if (end < 0) continue;
    const chunk = buffer.subarray(start, end);
    try {
      streams.push(inflateSync(chunk).toString('latin1'));
    } catch {
      // Image data and unfiltered streams: not text.
    }
  }
  return streams.join('\n');
}

/**
 * The text a reader sees, decoded from the content streams: `@react-pdf` writes
 * Helvetica text as hex strings with kerning numbers between them.
 */
function extractPdfText(bytes: Uint8Array): string {
  const content = decodePdfStreams(bytes);
  const parts: string[] = [];
  const token = /<([0-9a-fA-F\s]+)>|\(((?:\\.|[^\\()])*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(content)) !== null) {
    if (match[1] !== undefined) {
      const hex = match[1].replace(/\s+/g, '');
      if (hex.length % 2 !== 0) continue;
      let text = '';
      for (let index = 0; index < hex.length; index += 2) {
        text += String.fromCharCode(parseInt(hex.slice(index, index + 2), 16));
      }
      parts.push(text);
    } else if (match[2] !== undefined) {
      parts.push(match[2].replace(/\\([()\\])/g, '$1'));
    }
  }
  return parts.join('');
}

function pdfPageCount(bytes: Uint8Array): number {
  const raw = Buffer.from(bytes).toString('latin1');
  const counts = [...raw.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  return counts.length > 0 ? Math.max(...counts) : 0;
}

function assertNoPii(scope: string, text: string): void {
  for (const marker of PII_MARKERS) {
    assert(!text.includes(marker), `${scope} leaked customer-level data (${marker})`);
  }
}

function assertNoClaims(scope: string, text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_CLAIMS) {
    assert(!lower.includes(phrase), `${scope} contains a forbidden claim: "${phrase}"`);
  }
}

function assertNoStoragePath(scope: string, text: string): void {
  for (const marker of ['analysis-reports', 'storage_path', 'storagePath', 'report.pdf']) {
    assert(!text.includes(marker), `${scope} exposed a storage detail (${marker})`);
  }
}

function startServer(): ChildProcess {
  const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) {
    throw new Error(`Next.js CLI not found at ${nextBin}; run this from the repository root`);
  }

  return spawn(process.execPath, [nextBin, 'start', '--hostname', '0.0.0.0', '--port', String(PORT)], {
    env: {
      ...process.env,
      DATA_SOURCE: 'database',
      // Deterministic fixture bytes: no Mapbox token, no network, no credits.
      REPORT_MAP_PROVIDER: 'fake',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

function stopServer(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function waitForServer(child: ChildProcess) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`report smoke server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/sign-in`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await delay(250);
  }
  throw new Error('report smoke server did not become ready in time');
}

async function signIn(credentials: { email: string; password: string }, jar: CookieJar) {
  const response = await request(
    '/api/auth/sign-in',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(credentials),
    },
    jar,
  );
  assert(response.ok, `sign-in for ${credentials.email} failed with ${response.status}`);
  assert(jar.header().length > 0, `sign-in for ${credentials.email} returned no session cookie`);
  return jar;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for the report smoke test');
  }

  const child = startServer();
  const serverLog: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

  try {
    await waitForServer(child);
    installFetchBridge();

    const ownerJar = await signIn(OWNER_A, new CookieJar());
    activeJar = ownerJar;
    const analystJar = await signIn(ANALYST_A, new CookieJar());
    const viewerJar = await signIn(VIEWER_A, new CookieJar());
    const foreignOwnerJar = await signIn(OWNER_B, new CookieJar());
    const outsiderJar = await signIn(OUTSIDER, new CookieJar());

    note('1. Report history is project-scoped and an unnamed project is never guessed.');
    const projects = await listWorkspaceProjects(WORKSPACE_A);
    assert(projects.length >= 1, 'the seeded workspace must hold at least one project');

    let projectId: string | null = null;
    for (const project of projects) {
      const history = await listReports(WORKSPACE_A, project.id);
      assert(
        history.projectId === project.id,
        `the server must answer for the project that was named, got ${history.projectId}`,
      );
      assert(
        history.projects.length === projects.length,
        'the response must list every selectable project of the caller',
      );
      for (const report of history.reports) {
        assert(
          report.projectId === project.id,
          `report ${report.id} of another project leaked into ${project.name}`,
        );
      }
      const candidates = await listSavedCandidates(WORKSPACE_A, project.id);
      if (projectId === null && candidates.candidates.length >= 2) projectId = project.id;
    }
    assert(projectId, 'the seeded workspace must hold a project with at least two saved candidates');

    const projectBId = projects.find((project) => project.id !== projectId)?.id ?? null;
    if (projects.length > 1) {
      await expectRefusal(
        () => listReports(WORKSPACE_A, null),
        // Several projects and no explicit choice: a safe 400, never a guess.
        400,
        'project_required',
        'an unnamed project with several projects',
      );
    }

    const foreignProjectId = '00000000-0000-4000-8000-000000000021';
    assert(foreignProjectId !== projectId, 'the foreign project fixture must not be the seeded project');
    await expectRefusal(
      () => listReports(WORKSPACE_A, foreignProjectId),
      400,
      'project_required',
      'a project the caller cannot select',
    );

    note('2. The owner runs a fresh comparison and keeps its stored analysis.');
    const models = await listScoringModels(WORKSPACE_A);
    const seededModel = models.find((model) => model.name === 'Retail Expansion Model');
    assert(seededModel, 'the seeded scoring model must be listed');

    const savedCandidates = await listSavedCandidates(WORKSPACE_A, projectId);
    let candidateIds = savedCandidates.candidates.slice(0, 3).map((candidate) => candidate.id);
    if (candidateIds.length < 2) {
      const created: string[] = [];
      for (const [index, name] of ['Report smoke site 1', 'Report smoke site 2'].entries()) {
        const candidate = await saveCandidate(WORKSPACE_A, {
          projectId,
          name: `${name} ${process.pid}`,
          longitude: 69.28 + index * 0.01,
          latitude: 41.31 + index * 0.01,
        });
        created.push(candidate.id);
      }
      candidateIds = created;
    }

    const radiusMeters = 1_000;
    const analysis = await runAnalysis(WORKSPACE_A, {
      projectId,
      candidateIds,
      radiusMeters,
      scoringModelId: seededModel.id,
      mode: 'comparison',
    });
    assert(analysis.results.length === candidateIds.length, 'the comparison must store every candidate');
    assert(analysis.analysis.projectId === projectId, 'the stored analysis must belong to the project');

    note('3. A report is created from the stored analysis, with a frozen snapshot and its hash.');
    const created = await createReport(WORKSPACE_A, { projectId, analysisId: analysis.analysis.id });
    assert(created.status === 'draft', `a new report is a draft, got ${created.status}`);
    assert(created.type === 'comparison', `the report type follows the analysis, got ${created.type}`);
    assert(created.projectId === projectId, 'the report must belong to the project that answered');
    assert(created.analysisId === analysis.analysis.id, 'the report must point at the stored analysis');
    assert(
      created.snapshotHash !== null && /^[0-9a-f]{64}$/.test(created.snapshotHash),
      `the report must carry the snapshot SHA-256, got ${created.snapshotHash}`,
    );
    assert(created.generatedAt === null, 'a draft has no generated timestamp yet');

    note('4. The report appears in the history of its own project only.');
    const historyAfterCreate = await listReports(WORKSPACE_A, projectId);
    const listed = historyAfterCreate.reports.find((report) => report.id === created.id);
    assert(listed, 'the new report must be listed');
    assert(listed.snapshotHash === created.snapshotHash, 'the list must report the same snapshot hash');
    if (projectBId) {
      const otherHistory = await listReports(WORKSPACE_A, projectBId);
      assert(
        !otherHistory.reports.some((report) => report.id === created.id),
        'a report must never appear in another project',
      );
    }
    const draftHistory = await listReports(WORKSPACE_A, projectId, { status: 'draft' });
    assert(
      draftHistory.reports.some((report) => report.id === created.id),
      'the status filter must include the draft report',
    );
    await expectRefusal(
      () => listReports(WORKSPACE_A, projectId, { status: 'archived' as never }),
      400,
      'invalid_request',
      'an unknown status filter',
    );

    note('5. Generating the PDF renders the snapshot with the deterministic fake map provider.');
    const ready = await generateReport(WORKSPACE_A, created.id);
    assert(ready.status === 'ready', `a generated report is ready, got ${ready.status}`);
    assert(ready.generatedAt !== null, 'a ready report carries its generated timestamp');
    assert(ready.hasMap, 'the fake map provider must have produced a stored map');
    assert(
      ready.snapshotHash === created.snapshotHash,
      'generating must never rewrite the snapshot hash',
    );

    note('6. The owner downloads the PDF and its content is the stored snapshot.');
    const download = await request(
      reportDownloadUrl(WORKSPACE_A, created.id),
      {},
      ownerJar,
    );
    assert(download.ok, `the owner must download the PDF, got ${download.status}`);
    assert(
      download.headers.get('content-type') === 'application/pdf',
      `the download must be a PDF, got ${download.headers.get('content-type')}`,
    );
    assert(
      (download.headers.get('cache-control') ?? '').includes('no-store'),
      'a report download must never be cached',
    );
    const disposition = download.headers.get('content-disposition') ?? '';
    assert(disposition.includes('attachment') && disposition.includes('.pdf'), 'the download must be an attachment');
    assertNoStoragePath('the download headers', disposition);
    const pdfBytes = new Uint8Array(await download.arrayBuffer());
    assert(
      Buffer.from(pdfBytes.subarray(0, 5)).toString('latin1') === '%PDF-',
      'the download must be a real PDF file',
    );
    assert(pdfBytes.byteLength > 10_000, `a report PDF must not be a stub, got ${pdfBytes.byteLength} bytes`);

    const pdfText = extractPdfText(pdfBytes);
    const pages = pdfPageCount(pdfBytes);
    assert(pages >= analysis.results.length + 1, `expected at least one page per candidate, got ${pages}`);
    assert(pdfText.includes('Page 1 of'), 'the report must be paginated');

    const detail = await getReport(WORKSPACE_A, created.id);
    assert(detail.viewModel, 'a report with a snapshot must produce a view model');
    const viewModel = detail.viewModel;

    assert(pdfText.includes(viewModel.report.title), 'the PDF must carry the report title');
    assert(
      pdfText.includes(viewModel.analysis.modelName) &&
        pdfText.includes(`v${viewModel.analysis.modelVersion}`),
      'the PDF must name the model and its revision',
    );
    assert(
      pdfText.includes(formatRadius(radiusMeters)),
      `the PDF must state the radius, expected ${formatRadius(radiusMeters)}`,
    );
    assert(
      created.snapshotHash !== null && pdfText.includes(created.snapshotHash),
      'the PDF must print the snapshot hash it was generated from',
    );
    assert(pdfText.includes(REPORT_DISCLAIMER.slice(0, 60)), 'the PDF must carry the disclaimer');
    for (const candidate of viewModel.candidates) {
      assert(pdfText.includes(candidate.name), `the PDF must show ${candidate.name}`);
      assert(
        pdfText.includes(candidate.scoreText),
        `the PDF must show the stored score ${candidate.scoreText} for ${candidate.name}`,
      );
      for (const factor of candidate.factors) {
        assert(pdfText.includes(factor.label), `the PDF must show the factor ${factor.label}`);
      }
    }
    if (viewModel.comparison) {
      for (const row of viewModel.comparison.rows) {
        assert(pdfText.includes(row.revenueText), `the PDF must show the stored revenue ${row.revenueText}`);
      }
    }
    assertNoClaims('the PDF', pdfText);
    assertNoPii('the PDF', pdfText);
    assertNoStoragePath('the PDF', pdfText);

    note('7. The stored map artifact is the fake provider image and the preview matches the stored analysis.');
    const mapResponse = await request(reportArtifactUrl(WORKSPACE_A, created.id, 'map'), {}, ownerJar);
    assert(mapResponse.ok, `the stored map must be readable, got ${mapResponse.status}`);
    assert(
      mapResponse.headers.get('content-type')?.startsWith('image/') === true,
      'the stored map must be an image',
    );
    const mapBytes = new Uint8Array(await mapResponse.arrayBuffer());
    assert(
      Buffer.from(mapBytes.subarray(0, 8)).toString('hex') === '89504e470d0a1a0a',
      'the stored map must be a real PNG',
    );
    assert(
      mapBytes.byteLength === FAKE_MAP_FIXTURE_BYTES,
      `the stored map must be the deterministic fixture (${FAKE_MAP_FIXTURE_BYTES} bytes), got ${mapBytes.byteLength}`,
    );

    const previewJson = JSON.stringify(detail);
    assertNoPii('the preview', previewJson);
    assertNoStoragePath('the preview', previewJson);
    assertNoClaims('the preview', previewJson);
    assert(
      !previewJson.includes('"snapshot"'),
      'the preview must not ship the raw snapshot object to the browser',
    );
    for (const result of analysis.results) {
      const candidate = viewModel.candidates.find((entry) => entry.id === result.candidateId);
      assert(candidate, `the preview must show ${result.candidateName}`);
      assert(
        Number(candidate.scoreText.replace(' / 100', '')) === result.finalScore,
        `the preview must show the stored score ${result.finalScore}, got ${candidate.scoreText}`,
      );
      assert(
        candidate.rank === result.rank,
        `the preview must keep the stored rank ${result.rank}, got ${candidate.rank}`,
      );
    }

    note('8. Regenerating the PDF re-renders the same snapshot, never new numbers.');
    const regenerated = await generateReport(WORKSPACE_A, created.id);
    assert(
      regenerated.snapshotHash === created.snapshotHash,
      'regeneration must keep the snapshot hash',
    );
    const secondDownload = await request(reportDownloadUrl(WORKSPACE_A, created.id), {}, ownerJar);
    assert(secondDownload.ok, 'the regenerated PDF must download');
    const secondBytes = new Uint8Array(await secondDownload.arrayBuffer());
    const secondText = extractPdfText(secondBytes);
    // The snapshot is frozen, but the document states *when this PDF was
    // generated*, and regenerating legitimately refreshes that one field. The
    // comparison normalizes exactly that text (formatted the way the view model
    // formats it) and then requires everything else to be identical: not one
    // stored score, rank, metric, contribution or factor label may move.
    assert(ready.generatedAt, 'the first render must carry its report time');
    assert(regenerated.generatedAt, 'the regenerated render must carry its report time');
    const reportTimeText = [formatReportDate(ready.generatedAt), formatReportDate(regenerated.generatedAt)];
    const normalizeReportTime = (text: string) =>
      reportTimeText.reduce(
        (current, stamp) => current.split(stamp).join('<report-time>'),
        text,
      );
    assert(
      normalizeReportTime(secondText) === normalizeReportTime(pdfText),
      `regeneration must render identical content apart from the report time (${describeDifference(
        normalizeReportTime(pdfText),
        normalizeReportTime(secondText),
      )})`,
    );
    assert(
      pdfPageCount(secondBytes) === pages,
      'regeneration must produce the same pagination',
    );
    // Only the deflate of the report-time text and the writer's own creation
    // timestamp may move, and both are fixed-length; the PDF is not
    // byte-deterministic, so the size is bounded rather than equated.
    assert(
      Math.abs(secondBytes.byteLength - pdfBytes.byteLength) <= 128,
      `regeneration must produce the same size apart from the report time, got ${pdfBytes.byteLength} then ${secondBytes.byteLength}`,
    );

    note('9. A newer model revision does not change an existing report.');
    const currentModel = await getScoringModel(WORKSPACE_A, seededModel.id);
    assert(
      viewModel.analysis.modelVersion === analysis.analysis.modelVersion,
      'the report must keep the model revision of the stored analysis',
    );
    assert(
      viewModel.analysis.dataSnapshotText.length > 0 && viewModel.analysis.radiusText.length > 0,
      'the report must state its data snapshot and radius',
    );
    if (currentModel.version > analysis.analysis.modelVersion) {
      assert(
        viewModel.analysis.modelVersion !== currentModel.version,
        'an old report must not silently adopt the current model revision',
      );
      assert(
        pdfText.includes(`v${analysis.analysis.modelVersion}`),
        'the PDF must keep the revision the analysis was run with',
      );
    }
    const storedAnalyses = await listStoredAnalyses(WORKSPACE_A, projectId, { limit: 5 });
    assert(
      storedAnalyses.analyses.some((entry) => entry.analysis.id === analysis.analysis.id),
      'the stored analysis must stay in the project history',
    );

    note('10. Branding is validated by content: a real PNG is accepted, anything else is refused.');
    const logoBytes = fakeMapFixturePng();
    const withLogo = await uploadReportLogo(WORKSPACE_A, created.id, logoBytes, 'image/png');
    assert(withLogo.hasLogo, 'the stored logo must be recorded on the report');
    // The server, not only the client, must refuse a scriptable format, a lying
    // content type and an oversized file.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    for (const [label, body, contentType] of [
      ['an SVG logo', svg, 'image/svg+xml'],
      ['a PNG whose declared type lies', logoBytes, 'image/svg+xml'],
      ['an oversized logo', new Uint8Array(2 * 1024 * 1024 + 1), 'image/png'],
    ] as Array<[string, Uint8Array, string]>) {
      const refused = await request(
        `/api/workspaces/${WORKSPACE_A}/reports/${created.id}/logo`,
        { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(body) },
        ownerJar,
      );
      assert(refused.status === 400, `${label} must be refused, got ${refused.status}`);
      const refusal = await readError(refused);
      assert(
        refusal.code === 'invalid_request',
        `${label} must be refused with invalid_request, got ${refusal.code}`,
      );
    }
    const withBrandedPdf = await generateReport(WORKSPACE_A, created.id);
    assert(withBrandedPdf.status === 'ready', 'a branded report must still generate');
    const brandedDownload = await request(reportDownloadUrl(WORKSPACE_A, created.id), {}, ownerJar);
    const brandedBytes = new Uint8Array(await brandedDownload.arrayBuffer());
    assert(
      Buffer.from(brandedBytes.subarray(0, 5)).toString('latin1') === '%PDF-',
      'a branded report must still be a PDF',
    );
    assert(extractPdfText(brandedBytes).includes(viewModel.summary.headline.slice(0, 30)), 'the branded PDF must keep the summary');

    note('11. Renaming is presentation only and never touches the snapshot.');
    const renamed = await request(
      `/api/workspaces/${WORKSPACE_A}/reports/${created.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `Report smoke ${process.pid}`, subtitle: 'Smoke', companyName: 'Atlas Retail Group' }),
      },
      ownerJar,
    );
    assert(renamed.ok, `an owner must rename a report, got ${renamed.status}`);
    const renamedBody = (await renamed.json()) as { report?: { title?: string; snapshotHash?: string } };
    assert(renamedBody.report?.title === `Report smoke ${process.pid}`, 'the title must be stored');
    assert(
      renamedBody.report?.snapshotHash === created.snapshotHash,
      'renaming must not change the snapshot hash',
    );

    note('12. A viewer reads, previews and downloads, but never creates or generates.');
    activeJar = viewerJar;
    const viewerHistory = await listReports(WORKSPACE_A, projectId);
    assert(
      viewerHistory.reports.some((report) => report.id === created.id),
      'a viewer must see the report history',
    );
    const viewerDetail = await getReport(WORKSPACE_A, created.id);
    assert(viewerDetail.viewModel !== null, 'a viewer must preview a report');
    const viewerDownload = await request(reportDownloadUrl(WORKSPACE_A, created.id), {}, viewerJar);
    assert(viewerDownload.ok, `a viewer must download a ready report, got ${viewerDownload.status}`);
    await expectRefusal(
      () => createReport(WORKSPACE_A, { projectId, analysisId: analysis.analysis.id }),
      403,
      'access_denied',
      'a viewer creating a report',
    );
    await expectRefusal(
      () => generateReport(WORKSPACE_A, created.id),
      403,
      'access_denied',
      'a viewer generating a PDF',
    );
    await expectRefusal(
      () => uploadReportLogo(WORKSPACE_A, created.id, logoBytes, 'image/png'),
      403,
      'access_denied',
      'a viewer uploading a logo',
    );

    note('13. An analyst creates and generates, and the report belongs to the analyst session.');
    activeJar = analystJar;
    const analystReport = await createReport(WORKSPACE_A, {
      projectId,
      analysisId: analysis.analysis.id,
      title: `Analyst report ${process.pid}`,
    });
    assert(analystReport.status === 'draft', 'an analyst-created report starts as a draft');
    const analystReady = await generateReport(WORKSPACE_A, analystReport.id);
    assert(analystReady.status === 'ready', 'an analyst must be able to generate the PDF');

    note('14. A member of another workspace cannot see, read, generate or download the report.');
    activeJar = foreignOwnerJar;
    await expectRefusal(
      () => listReports(WORKSPACE_A, projectId),
      403,
      'access_denied',
      'a foreign workspace owner listing reports',
    );
    await expectRefusal(
      () => getReport(WORKSPACE_A, created.id),
      403,
      'access_denied',
      'a foreign workspace owner reading the report',
    );
    await expectRefusal(
      () => generateReport(WORKSPACE_A, created.id),
      403,
      'access_denied',
      'a foreign workspace owner generating the PDF',
    );
    const foreignDownload = await request(
      `/api/workspaces/${WORKSPACE_A}/reports/${created.id}/download`,
      {},
      foreignOwnerJar,
    );
    assert(
      foreignDownload.status === 403,
      `a foreign workspace owner must not download, got ${foreignDownload.status}`,
    );
    // Through their own workspace the report simply does not exist: no oracle.
    await expectRefusal(
      () => getReport(WORKSPACE_B, created.id),
      404,
      'report_not_found',
      'a foreign report id inside the caller own workspace',
    );
    const foreignArtifact = await request(
      reportArtifactUrl(WORKSPACE_B, created.id, 'map'),
      {},
      foreignOwnerJar,
    );
    assert(
      foreignArtifact.status === 404,
      `a foreign map artifact must not exist, got ${foreignArtifact.status}`,
    );
    assertNoPii('a foreign refusal', JSON.stringify(await readError(foreignArtifact)));

    note('15. A user without membership and an anonymous caller are refused identically.');
    activeJar = outsiderJar;
    await expectRefusal(
      () => listReports(WORKSPACE_A, projectId),
      403,
      'access_denied',
      'an outsider listing reports',
    );
    await expectRefusal(
      () => getReport(WORKSPACE_A, created.id),
      403,
      'access_denied',
      'an outsider reading the report',
    );
    await expectRefusal(
      () => createReport(WORKSPACE_A, { projectId, analysisId: analysis.analysis.id }),
      403,
      'access_denied',
      'an outsider creating a report',
    );

    activeJar = null;
    const anonymousList = await request(
      `/api/workspaces/${WORKSPACE_A}/reports?projectId=${projectId}`,
      {},
      null,
    );
    assert(anonymousList.status === 401, `an anonymous list must be 401, got ${anonymousList.status}`);
    const anonymousBody = await readError(anonymousList);
    assert(
      anonymousBody.message === SAFE_AUTH_MESSAGES.sessionExpired,
      `an anonymous refusal must use the safe message, got ${anonymousBody.message}`,
    );
    assert(
      anonymousBody.code === 'session_expired',
      `an anonymous refusal must use the safe code, got ${anonymousBody.code}`,
    );
    const anonymousDownload = await request(
      `/api/workspaces/${WORKSPACE_A}/reports/${created.id}/download`,
      {},
      null,
    );
    assert(anonymousDownload.status === 401, `an anonymous download must be 401, got ${anonymousDownload.status}`);
    const anonymousGenerate = await request(
      `/api/workspaces/${WORKSPACE_A}/reports/${created.id}/generate`,
      { method: 'POST' },
      null,
    );
    assert(anonymousGenerate.status === 401, `an anonymous generate must be 401, got ${anonymousGenerate.status}`);

    note('16. Tampered identifiers and paths fail safely, without leaking existence.');
    activeJar = ownerJar;
    const missingReport = '00000000-0000-4000-8000-00000000dead';
    await expectRefusal(
      () => getReport(WORKSPACE_A, missingReport),
      404,
      'report_not_found',
      'an unknown report id',
    );
    await expectRefusal(
      () => generateReport(WORKSPACE_A, missingReport),
      404,
      'report_not_found',
      'generating an unknown report',
    );
    const pathSwap = await request(
      `/api/workspaces/${WORKSPACE_A}/reports/${created.id}/download?path=${encodeURIComponent(
        `${WORKSPACE_B}/${projectId}/${created.id}/report.pdf`,
      )}&storagePath=evil`,
      {},
      ownerJar,
    );
    assert(pathSwap.ok || pathSwap.status === 404, `a path query must be ignored, got ${pathSwap.status}`);
    // A report that has not been generated yet must refuse to download, and must
    // say so with the documented code rather than an empty file.
    const notReadyReport = await createReport(WORKSPACE_A, {
      projectId,
      analysisId: analysis.analysis.id,
      title: `Draft only ${process.pid}`,
    });
    const draftDownload = await request(
      reportDownloadUrl(WORKSPACE_A, notReadyReport.id),
      {},
      ownerJar,
    );
    assert(
      draftDownload.status === 400,
      `an ungenerated report must not download, got ${draftDownload.status}`,
    );
    const draftError = await readError(draftDownload);
    assert(
      draftError.code === 'report_not_ready',
      `an ungenerated download must answer report_not_ready, got ${draftError.code}`,
    );
    assert(
      notReadyReport.projectId === projectId && notReadyReport.status === 'draft',
      'the same-project creation control must have produced a draft report',
    );

    note('17. Report creation cannot be re-pointed at another project or another workspace analysis.');
    if (projectBId) {
      await expectRefusal(
        () => createReport(WORKSPACE_A, { projectId: projectBId, analysisId: analysis.analysis.id }),
        400,
        'project_required',
        'an analysis of another project of the same workspace',
      );
    }
    await expectRefusal(
      () => createReport(WORKSPACE_A, { projectId, analysisId: '00000000-0000-4000-8000-00000000beef' }),
      404,
      'report_not_found',
      'an unknown analysis id',
    );
    activeJar = foreignOwnerJar;
    await expectRefusal(
      () => createReport(WORKSPACE_B, { projectId, analysisId: analysis.analysis.id }),
      400,
      'project_required',
      'a project of another workspace',
    );

    const finalHistory = await listReports(WORKSPACE_A, projectId);
    assert(
      finalHistory.reports.some((report) => report.id === created.id),
      'the report must survive every refusal',
    );

    console.log('\nreport smoke: all scenarios passed');
  } catch (error) {
    const message = sanitizeDiagnostic(error instanceof Error ? `${error.message}` : String(error));
    const tail = sanitizeDiagnostic(serverLog.join(''), 2000);
    console.error(`\nreport smoke failed during: ${currentScenario}`);
    console.error(message);
    if (tail) console.error(`\nserver log tail:\n${tail}`);
    recordFailure(`${message}${tail ? ` | server log tail: ${tail}` : ''}`);
    throw error;
  } finally {
    activeJar = null;
    stopServer(child);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
