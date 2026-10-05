/**
 * End-to-end smoke test for the Phase 6 scoring engine.
 *
 * It starts the production build in database mode against a running local
 * Supabase project, signs in as the seeded roles, and drives the *shipped*
 * scoring API: models, saved candidates, a single analysis, a comparison, the
 * stored read, the CSV export and the refusal paths. Every response is read by
 * the *shipped* parser (`src/lib/scoring/payload.ts`) and by the *shipped* view
 * layer, so client/server drift, a broken snapshot, a lost decimal or an
 * authorization hole fails here rather than in the browser.
 *
 * The smoke is written to be independent of the exact arithmetic: the seeded
 * database changes when the import smoke commits its rows, so it asserts the
 * contracts that must always hold (the stored snapshot, the stored breakdown
 * adding up to the stored score, ranks following scores, determinism, snapshot
 * survival across a model edit) instead of hard-coding scores that belong to
 * the SQL suite (`supabase/tests/phase6_scoring_engine.sql`).
 *
 * Requires SUPABASE_URL and SUPABASE_ANON_KEY plus a database that has been
 * reset and seeded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import {
  createWorkspaceProject,
  getScoringModel,
  getStoredAnalysis,
  listSavedCandidates,
  listScoringModels,
  listStoredAnalyses,
  listWorkspaceProjects,
  runAnalysis,
  saveCandidate,
  ScoringApiError,
  updateScoringModel,
} from '@/lib/scoring/client';
import { PROJECT_REQUIRED_MESSAGE } from '@/lib/scoring/projects';
import { findMetric } from '@/lib/scoring/catalogue';
import { buildComparisonCsv, comparisonCsvFilename } from '@/lib/scoring/export';
import { parseScoringAnalysis } from '@/lib/scoring/payload';
import { toFactorPayload } from '@/lib/scoring/validation';
import { buildBreakdown, buildComparisonRows } from '@/lib/scoring/view';
import type { ScoringAnalysisPayload } from '@/lib/scoring/types';

const PORT = Number(process.env.SMOKE_PORT ?? 3314);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const OWNER_A = { email: 'owner-a@example.test', password: 'phase4-demo-password' };
const ANALYST_A = { email: 'analyst-a@example.test', password: 'phase4-demo-password' };
const VIEWER_A = { email: 'viewer-a@example.test', password: 'phase4-demo-password' };
const OWNER_B = { email: 'owner-b@example.test', password: 'phase4-demo-password' };
const OUTSIDER = { email: 'outsider@example.test', password: 'phase4-demo-password' };
const WORKSPACE_A = '00000000-0000-4000-8000-000000000010';
const WORKSPACE_B = '00000000-0000-4000-8000-000000000011';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let currentScenario = 'startup';

function note(scenario: string) {
  currentScenario = scenario;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=scoring smoke::${scenario}`);
  }
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
 * The shipped client uses same-origin relative URLs and browser cookies. The
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

function startServer(): ChildProcess {
  const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) {
    throw new Error(`Next.js CLI not found at ${nextBin}; run this from the repository root`);
  }

  return spawn(process.execPath, [nextBin, 'start', '--hostname', '0.0.0.0', '--port', String(PORT)], {
    env: { ...process.env, DATA_SOURCE: 'database' },
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`scoring smoke server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/sign-in`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await delay(250);
  }
  throw new Error('scoring smoke server did not become ready in time');
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

function scoreOf(payload: ScoringAnalysisPayload): number {
  return payload.results[0]?.finalScore ?? Number.NaN;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for the scoring smoke test');
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

    note('1. An owner can list the workspace scoring models.');
    const models = await listScoringModels(WORKSPACE_A);
    const seeded = models.find((model) => model.name === 'Retail Expansion Model');
    assert(seeded, `the seeded model must be listed, got ${models.map((model) => model.name).join(', ')}`);
    assert(seeded.status === 'active', `the seeded model must be active, got ${seeded.status}`);
    assert(
      seeded.enabledWeightTotal === 100,
      `enabled weights must total 100, got ${seeded.enabledWeightTotal}`,
    );
    const model = await getScoringModel(WORKSPACE_A, seeded.id);
    assert(model.factors.length >= 2, 'the seeded model must keep its factors');
    assert(
      model.factors.every((factor) => findMetric(factor.metric)),
      'every factor must measure a catalogued metric',
    );
    assert(model.version >= 1, `a saved model has a revision, got ${model.version}`);

    note('2. Saved candidate locations are listed for one explicitly named project.');
    // Phase 6.5: the projects are read first and every request names one. The
    // seeded candidates belong to the seeded project; on a repeated run the
    // smoke's own extra project also exists, so the project is identified by
    // asking each one explicitly through the shipped, project-scoped endpoint.
    const projectsAtStart = await listWorkspaceProjects(WORKSPACE_A);
    assert(projectsAtStart.length >= 1, 'the seeded workspace must hold at least one project');

    const projectLists: Awaited<ReturnType<typeof listSavedCandidates>>[] = [];
    for (const project of projectsAtStart) {
      const list = await listSavedCandidates(WORKSPACE_A, project.id);
      assert(
        list.projectId === project.id,
        `the server must answer for the project that was named, got ${list.projectId}`,
      );
      assert(
        list.projects.length === projectsAtStart.length,
        'the response must list every selectable project',
      );
      projectLists.push(list);
    }

    const candidatesResponse = projectLists.find((list) => list.candidates.length >= 3);
    assert(
      candidatesResponse,
      `expected the seeded saved candidates in one of the workspace projects, got ${projectLists
        .map((list) => list.candidates.length)
        .join(', ')}`,
    );
    const projectAId = candidatesResponse.projectId;
    assert(
      projectAId !== null && projectAId.length === 36,
      'the server must echo the project that answered',
    );

    if (projectsAtStart.length === 1) {
      // The convenience path is only unambiguous while one project exists; it
      // still reports the project it used, so nothing is chosen invisibly.
      const convenience = await listSavedCandidates(WORKSPACE_A, null);
      assert(
        convenience.projectId === projectsAtStart[0].id,
        'a single project is selected automatically and named in the response',
      );
    }

    assert(
      candidatesResponse.candidates.every(
        (candidate) =>
          Number.isFinite(candidate.longitude) &&
          Number.isFinite(candidate.latitude) &&
          candidate.name.length > 0,
      ),
      'every saved candidate needs a name and a coordinate pair',
    );

    const ordered = [...candidatesResponse.candidates].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const [firstCandidate, secondCandidate, thirdCandidate] = ordered;

    note('2b. An analyst saves a new candidate location through the shipped client.');
    const saveName = `Smoke site ${process.pid}`;
    activeJar = analystJar;
    const savedCandidate = await saveCandidate(WORKSPACE_A, {
      projectId: projectAId,
      name: saveName,
      longitude: 69.2797,
      latitude: 41.3111,
    });
    assert(savedCandidate.id.length === 36, 'saving a candidate must return its id');
    assert(savedCandidate.name === saveName, `expected the saved name, got ${savedCandidate.name}`);
    assert(
      Math.abs(savedCandidate.longitude - 69.2797) < 1e-9 &&
        Math.abs(savedCandidate.latitude - 41.3111) < 1e-9,
      'the stored coordinate pair must be the one that was sent',
    );
    const afterSave = await listSavedCandidates(WORKSPACE_A, projectAId);
    assert(
      afterSave.candidates.some((candidate) => candidate.id === savedCandidate.id),
      'the saved candidate must appear in the project list',
    );
    activeJar = ownerJar;

    note('3. A single analysis runs through the shipped endpoint and the shipped parser.');
    const analysis = await runAnalysis(WORKSPACE_A, {
      projectId: projectAId,
      candidateIds: [firstCandidate.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'analysis',
    });
    assert(analysis.analysis.mode === 'analysis', 'the analysis endpoint must store an analysis');
    assert(analysis.analysis.candidateCount === 1, 'one candidate was requested');
    assert(analysis.analysis.radiusMeters === 500, 'the stored radius must be the requested one');
    assert(analysis.analysis.modelName === model.name, 'the snapshot must name the model used');
    assert(analysis.results.length === 1, 'an analysis returns exactly its candidate');
    assert(
      analysis.results[0].candidateName === firstCandidate.name,
      'the result must name the saved candidate',
    );
    assert(
      Number.isFinite(scoreOf(analysis)) && scoreOf(analysis) >= 0 && scoreOf(analysis) <= 100,
      `a stored score must be between 0 and 100, got ${scoreOf(analysis)}`,
    );

    note('3b. The raw HTTP body of that run is parsed by the shipped parser itself.');
    const rawResponse = await request(
      `/api/workspaces/${WORKSPACE_A}/analyses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          candidateIds: [firstCandidate.id],
          radiusMeters: 500,
          scoringModelId: model.id,
        }),
      },
      ownerJar,
    );
    assert(rawResponse.ok, `the raw analysis request failed with ${rawResponse.status}`);
    const rawBody: unknown = await rawResponse.json();
    const rawObject = rawBody as { analysis?: Record<string, unknown>; results?: unknown[] };
    assert(
      typeof rawObject.analysis?.workspace_id === 'string' &&
        typeof rawObject.analysis?.data_snapshot_at === 'string',
      'the server must ship the database payload shape, not a renamed copy of it',
    );
    assert(
      !('workspaceId' in (rawObject.analysis ?? {})),
      'the wire payload keeps the database field names the shipped parser reads',
    );
    const parsedRaw = parseScoringAnalysis(rawBody);
    assert(
      parsedRaw.results.length === 1 && Number.isFinite(scoreOf(parsedRaw)),
      'the shipped parser must read the real server payload',
    );
    assert(
      scoreOf(parsedRaw) === scoreOf(analysis),
      'the same inputs must produce the same score over raw HTTP',
    );
    assert(
      Object.keys(parsedRaw.results[0].rawMetrics).length ===
        Object.keys(analysis.results[0].rawMetrics).length,
      'the parsed metric shape must match the client-visible one',
    );

    note('4. The stored metrics are aggregates only: no customer-level data.');
    const raw = analysis.results[0].rawMetrics;
    const forbidden = ['phone', 'address', 'customers', 'customer_name', 'external_id', 'raw_data'];
    const rawKeys = Object.keys(raw);
    for (const key of forbidden) {
      assert(!rawKeys.includes(key), `the payload must not carry "${key}"`);
    }
    const serialized = JSON.stringify(analysis);
    assert(!serialized.includes('+998'), 'no phone number may reach the scoring payload');
    assert(
      !/Amir Temur|Chilonzor 9|Yunusabad 4/.test(serialized),
      'no free-text address may reach the scoring payload',
    );
    assert(!serialized.includes('"raw_data"'), 'no staged row data may reach the scoring payload');

    note('5. The stored breakdown adds up to the stored score.');
    for (const result of analysis.results) {
      const breakdown = buildBreakdown(result);
      assert(
        breakdown.consistent,
        `contributions ${breakdown.contributionTotal} must equal the stored score ${breakdown.finalScore}`,
      );
      assert(breakdown.rows.length === model.factors.filter((factor) => factor.enabled).length,
        'every enabled factor must appear exactly once in the breakdown');
    }

    note('6. Normalized values and contributions stay inside their documented bounds.');
    for (const result of analysis.results) {
      for (const contribution of result.contributions) {
        assert(
          contribution.normalized >= 0 && contribution.normalized <= 100,
          `normalized ${contribution.normalized} must stay between 0 and 100`,
        );
        assert(
          contribution.contribution >= 0 && contribution.contribution <= contribution.weight + 0.005,
          `contribution ${contribution.contribution} must stay within its weight ${contribution.weight}`,
        );
      }
    }

    note('7. Repeating the same analysis returns the identical numbers.');
    const repeated = await runAnalysis(WORKSPACE_A, {
      projectId: projectAId,
      candidateIds: [firstCandidate.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'analysis',
    });
    assert(repeated.analysis.id !== analysis.analysis.id, 'each run is stored as its own analysis');
    assert(
      scoreOf(repeated) === scoreOf(analysis),
      `a deterministic engine must repeat ${scoreOf(analysis)}, got ${scoreOf(repeated)}`,
    );

    note('8. A comparison of three saved sites is stored and labelled A..E in rank order.');
    const comparison = await runAnalysis(WORKSPACE_A, {
      projectId: projectAId,
      candidateIds: [firstCandidate.id, secondCandidate.id, thirdCandidate.id],
      radiusMeters: 1_000,
      scoringModelId: model.id,
      mode: 'comparison',
    });
    assert(comparison.analysis.mode === 'comparison', 'the comparison endpoint must store a comparison');
    assert(comparison.analysis.candidateCount === 3, 'three candidates were requested');
    assert(comparison.analysis.radiusMeters === 1_000, 'the comparison shares one radius');
    assert(comparison.results.length === 3, 'a comparison returns every candidate');
    const rows = buildComparisonRows(comparison);
    assert(
      rows.map((row) => row.label).join(',') === 'A,B,C',
      `comparison rows must be labelled A..C, got ${rows.map((row) => row.label).join(',')}`,
    );

    note('9. Ranks follow the stored scores and every candidate appears once.');
    const candidateIds = comparison.results.map((result) => result.candidateId);
    assert(new Set(candidateIds).size === candidateIds.length, 'a candidate may appear only once');
    assert(
      comparison.results.every((result, index) => result.rank === index + 1),
      'ranks must be 1..n in the stored order',
    );
    for (let index = 1; index < comparison.results.length; index += 1) {
      assert(
        comparison.results[index - 1].finalScore >= comparison.results[index].finalScore,
        'the stored order must be sorted by descending score',
      );
    }

    note('10. The stored snapshot carries the exact model revision and factor list.');
    const snapshotFactors = comparison.model.factors;
    assert(snapshotFactors.length === model.factors.length, 'the snapshot keeps every factor');
    for (const [index, factor] of snapshotFactors.entries()) {
      const current = model.factors[index];
      assert(current, `the model must still have factor ${index}`);
      assert(
        factor.key === current.key &&
          factor.label === current.label &&
          factor.metric === current.metric &&
          factor.weight === current.weight &&
          factor.direction === current.direction &&
          factor.normalization === current.normalization,
        `snapshot factor ${index} must match the definition it was run with`,
      );
    }

    note('11. A stored analysis is returned by id exactly as it was written.');
    const stored = await getStoredAnalysis(WORKSPACE_A, analysis.analysis.id);
    assert(stored.analysis.id === analysis.analysis.id, 'the read RPC must return the same analysis');
    assert(scoreOf(stored) === scoreOf(analysis), 'reading an analysis must never change its score');
    assert(
      stored.model.factors[0].weight === analysis.model.factors[0].weight,
      'the stored revision must survive a read',
    );

    note('12. The comparison limits are enforced by the endpoint, not only by the interface.');
    const six = [
      firstCandidate.id,
      secondCandidate.id,
      thirdCandidate.id,
      '00000000-0000-4000-8000-000000000099',
      '00000000-0000-4000-8000-000000000098',
      '00000000-0000-4000-8000-000000000097',
    ];
    const tooMany = await request(
      `/api/workspaces/${WORKSPACE_A}/comparisons`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          candidateIds: six,
          radiusMeters: 1_000,
          scoringModelId: model.id,
        }),
      },
      ownerJar,
    );
    assert(tooMany.status === 400, `six candidates must be refused with 400, got ${tooMany.status}`);
    const tooManyError = await readError(tooMany);
    assert(tooManyError.code === 'invalid_request', `unexpected code ${tooManyError.code}`);

    const single = await request(
      `/api/workspaces/${WORKSPACE_A}/comparisons`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          candidateIds: [firstCandidate.id],
          radiusMeters: 1_000,
          scoringModelId: model.id,
        }),
      },
      ownerJar,
    );
    assert(single.status === 400, `one candidate cannot be a comparison, got ${single.status}`);

    const analysisWithTwo = await request(
      `/api/workspaces/${WORKSPACE_A}/analyses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          candidateIds: [firstCandidate.id, secondCandidate.id],
          radiusMeters: 1_000,
          scoringModelId: model.id,
        }),
      },
      ownerJar,
    );
    assert(
      analysisWithTwo.status === 400,
      `the analysis endpoint scores one candidate, got ${analysisWithTwo.status}`,
    );

    note('13. An analyst can run an analysis but cannot edit the model.');
    activeJar = analystJar;
    const analystRun = await runAnalysis(WORKSPACE_A, {
      projectId: projectAId,
      candidateIds: [secondCandidate.id],
      radiusMeters: 1_000,
      scoringModelId: model.id,
      mode: 'analysis',
    });
    assert(analystRun.analysis.candidateCount === 1, 'the analyst run must be stored');
    const analystEdit = await request(
      `/api/workspaces/${WORKSPACE_A}/scoring-models/${model.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: model.name,
          description: model.description,
          status: model.status,
          factors: toFactorPayload(model.factors),
        }),
      },
      analystJar,
    );
    assert(analystEdit.status === 403, `an analyst must not edit a model, got ${analystEdit.status}`);

    note('14. A viewer can read a stored analysis but cannot run one.');
    activeJar = viewerJar;
    const viewerRead = await request(
      `/api/workspaces/${WORKSPACE_A}/analyses/${analysis.analysis.id}`,
      {},
      viewerJar,
    );
    assert(viewerRead.ok, `a viewer must read an analysis, got ${viewerRead.status}`);
    const viewerRun = await request(
      `/api/workspaces/${WORKSPACE_A}/analyses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          candidateIds: [firstCandidate.id],
          radiusMeters: 500,
          scoringModelId: model.id,
        }),
      },
      viewerJar,
    );
    assert(viewerRun.status === 403, `a viewer must not run an analysis, got ${viewerRun.status}`);
    const viewerError = await readError(viewerRun);
    assert(
      viewerError.message !== undefined && !viewerError.message.includes('policy'),
      'the refusal must never leak a policy name',
    );

    note('15. An outsider and a foreign owner get nothing from this workspace.');
    const outsiderRead = await request(
      `/api/workspaces/${WORKSPACE_A}/scoring-models`,
      {},
      outsiderJar,
    );
    assert(outsiderRead.status === 403, `an outsider must be refused, got ${outsiderRead.status}`);
    const foreignOwnerRead = await request(
      `/api/workspaces/${WORKSPACE_A}/scoring-models`,
      {},
      foreignOwnerJar,
    );
    assert(
      foreignOwnerRead.status === 403,
      `a foreign owner must be refused, got ${foreignOwnerRead.status}`,
    );
    const outsiderRun = await request(
      `/api/workspaces/${WORKSPACE_A}/analyses`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          candidateIds: [firstCandidate.id],
          radiusMeters: 500,
          scoringModelId: model.id,
        }),
      },
      outsiderJar,
    );
    assert(outsiderRun.status === 403, `an outsider must not run an analysis, got ${outsiderRun.status}`);
    const outsiderOwnRead = await request(
      `/api/workspaces/${WORKSPACE_B}/scoring-models`,
      {},
      foreignOwnerJar,
    );
    assert(
      outsiderOwnRead.ok,
      `an owner must still read their own workspace, got ${outsiderOwnRead.status}`,
    );
    const outsiderCandidate = await request(
      `/api/workspaces/${WORKSPACE_A}/candidates`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: projectAId,
          name: 'Outsider candidate',
          longitude: 69.28,
          latitude: 41.31,
        }),
      },
      outsiderJar,
    );
    assert(
      outsiderCandidate.status === 403,
      `an outsider must not save a candidate, got ${outsiderCandidate.status}`,
    );

    activeJar = null;
    const anonymousRead = await request(`/api/workspaces/${WORKSPACE_A}/scoring-models`, {}, null);
    assert(anonymousRead.status === 401, `an anonymous call must be 401, got ${anonymousRead.status}`);
    const anonymousBody = await readError(anonymousRead);
    assert(
      anonymousBody.message === SAFE_AUTH_MESSAGES.sessionExpired,
      `an anonymous refusal must use the safe message, got ${anonymousBody.message}`,
    );

    note('16. An owner edit does not move a stored score (the snapshot survives).');
    activeJar = ownerJar;
    const beforeEditScore = scoreOf(stored);
    const editedFactors = model.factors.map((factor, index) => {
      if (index === 0) return { ...factor, weight: factor.weight + 5 };
      if (index === 1) return { ...factor, weight: factor.weight - 5 };
      return factor;
    });
    const editInput = {
      name: model.name,
      description: model.description,
      status: model.status,
      factors: toFactorPayload(editedFactors),
    };
    const edited = await updateScoringModel(WORKSPACE_A, model.id, editInput);
    assert(edited.model.version > model.version, 'an edit must advance the revision');
    assert(
      edited.model.factors[0].weight === model.factors[0].weight + 5,
      'the edit must be stored',
    );

    const storedAfterEdit = await getStoredAnalysis(WORKSPACE_A, analysis.analysis.id);
    assert(
      scoreOf(storedAfterEdit) === beforeEditScore,
      `a model edit must not recalculate a stored analysis (${beforeEditScore} became ${scoreOf(storedAfterEdit)})`,
    );
    assert(
      storedAfterEdit.model.factors[0].weight === model.factors[0].weight,
      'the stored analysis keeps the weights it was run with',
    );

    note('17. A fresh run uses the edited definition and records the new revision.');
    const rescored = await runAnalysis(WORKSPACE_A, {
      projectId: projectAId,
      candidateIds: [firstCandidate.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'analysis',
    });
    assert(
      rescored.analysis.modelVersion === edited.model.version,
      'the new run must record the current revision',
    );
    assert(
      rescored.model.factors[0].weight === edited.model.factors[0].weight,
      'the new run must use the edited weights',
    );
    // The stored contribution carries the weight that produced it, so the edit is
    // visible in the new run without depending on the value of the data.
    const rescoredContribution = rescored.results[0].contributions.find(
      (contribution) => contribution.key === model.factors[0].key,
    );
    assert(
      rescoredContribution?.weight === edited.model.factors[0].weight,
      `the new run must apply the edited weight (${edited.model.factors[0].weight}) to ${model.factors[0].key}`,
    );
    assert(
      scoreOf(rescored) >= 0 && scoreOf(rescored) <= 100,
      'the rescored analysis must stay inside 0..100',
    );

    note('18. The model is restored so the smoke can be repeated.');
    const restored = await updateScoringModel(WORKSPACE_A, model.id, {
      name: model.name,
      description: model.description,
      status: model.status,
      factors: toFactorPayload(model.factors),
    });
    assert(
      restored.model.factors[0].weight === model.factors[0].weight,
      'the original weights must be back',
    );
    const restoredRun = await runAnalysis(WORKSPACE_A, {
      projectId: projectAId,
      candidateIds: [firstCandidate.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'analysis',
    });
    assert(
      scoreOf(restoredRun) === beforeEditScore,
      'restoring the weights must restore the score',
    );

    note('19. The comparison CSV export carries the stored numbers.');
    const csv = buildComparisonCsv(comparison, rows);
    const lines = csv.trim().split('\n');
    assert(lines.length === 4, `expected a header and three rows, got ${lines.length}`);
    assert(lines[0].startsWith('label,candidate,rank,score_out_of_100'), 'unexpected CSV header');
    assert(lines[1].startsWith('A,'), 'the first row must be candidate A');
    assert(csv.includes(comparison.analysis.modelName), 'the CSV must name the model');
    assert(
      csv.includes(String(comparison.analysis.modelVersion)),
      'the CSV must carry the model revision',
    );
    assert(!csv.includes('%'), 'a score is out of 100, never a percentage');
    assert(
      comparisonCsvFilename(comparison).endsWith('.csv'),
      'the export filename must be a CSV name',
    );

    note('20. The imported customers of the earlier smoke are counted, and the payload stays finite.');
    for (const result of comparison.results) {
      const metrics = result.rawMetrics;
      for (const value of [
        metrics.customersCount,
        metrics.competitorsCount,
        metrics.locationsCount,
        metrics.customersPerSqKm,
        metrics.branchDistanceScore,
      ]) {
        assert(Number.isFinite(value), `raw metric ${value} must be finite`);
      }
      assert(Number.isFinite(Number(metrics.customersRevenueTotal)), 'revenue must stay numeric');
    }

    note('21. A project is created explicitly, and only an owner or admin may create one.');
    const viewerCreate = await request(
      `/api/workspaces/${WORKSPACE_A}/projects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Viewer project' }),
      },
      viewerJar,
    );
    assert(viewerCreate.status === 403, `a viewer must not create a project, got ${viewerCreate.status}`);
    const analystCreate = await request(
      `/api/workspaces/${WORKSPACE_A}/projects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Analyst project' }),
      },
      analystJar,
    );
    assert(analystCreate.status === 403, `an analyst must not create a project, got ${analystCreate.status}`);
    const foreignCreate = await request(
      `/api/workspaces/${WORKSPACE_A}/projects`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Foreign project' }),
      },
      foreignOwnerJar,
    );
    assert(foreignCreate.status === 403, `a foreign owner must not create a project, got ${foreignCreate.status}`);

    activeJar = ownerJar;
    const projectBName = `Smoke project B ${process.pid}`;
    const projectB = await createWorkspaceProject(WORKSPACE_A, { name: projectBName });
    assert(projectB.id.length === 36, 'creating a project must return its id');
    assert(projectB.name === projectBName && projectB.status === 'active', 'the project must be stored as created');
    const projectsAfterCreate = await listWorkspaceProjects(WORKSPACE_A);
    assert(
      projectsAfterCreate.length === projectsAtStart.length + 1 &&
        projectsAfterCreate.some((project) => project.id === projectB.id),
      'exactly the created project must be added to the selector list',
    );

    note('22. With several projects an unnamed request is refused, and a foreign project fails identically.');
    const unnamed = await request(`/api/workspaces/${WORKSPACE_A}/candidates`, {}, ownerJar);
    assert(
      unnamed.status === 400,
      `an unnamed project in a multi-project workspace must be 400, got ${unnamed.status}`,
    );
    const unnamedError = await readError(unnamed);
    assert(unnamedError.code === 'project_required', `unexpected code ${unnamedError.code}`);
    assert(
      unnamedError.message === PROJECT_REQUIRED_MESSAGE,
      `the refusal must use the documented safe message, got ${unnamedError.message}`,
    );

    // A project of the *other* workspace and a project that does not exist must
    // fail exactly like the missing project id: one response, no oracle.
    const foreignProjectId = '00000000-0000-4000-8000-000000000021';
    const missingProjectId = '00000000-0000-4000-8000-0000000000ff';
    for (const [label, projectId] of [
      ['a project of another workspace', foreignProjectId],
      ['a project that does not exist', missingProjectId],
    ] as const) {
      const read = await request(
        `/api/workspaces/${WORKSPACE_A}/candidates?projectId=${projectId}`,
        {},
        ownerJar,
      );
      assert(read.status === 400, `${label} must be refused with 400, got ${read.status}`);
      assert(
        JSON.stringify(await readError(read)) === JSON.stringify(unnamedError),
        `${label} must fail identically to a missing project id`,
      );

      const save = await request(
        `/api/workspaces/${WORKSPACE_A}/candidates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, name: 'Foreign site', longitude: 69.28, latitude: 41.31 }),
        },
        ownerJar,
      );
      assert(save.status === 400, `${label} must be refused for saving with 400, got ${save.status}`);
      assert(
        JSON.stringify(await readError(save)) === JSON.stringify(unnamedError),
        `${label} must fail identically on the save path`,
      );
    }

    const foreignRun = await runAnalysis(WORKSPACE_A, {
      projectId: foreignProjectId,
      candidateIds: [firstCandidate.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'analysis',
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert(foreignRun instanceof ScoringApiError, 'an analysis with a foreign project must be refused');
    assert(
      foreignRun.status === 400 && foreignRun.code === 'project_required',
      `a foreign project must fail identically to a missing one, got ${foreignRun.status} ${foreignRun.code}`,
    );
    assert(
      foreignRun.message === PROJECT_REQUIRED_MESSAGE,
      'the refusal must never reveal whether the foreign project exists',
    );

    note('23. A saved candidate belongs to its project: switching projects hides the other project sites.');
    const listB = await listSavedCandidates(WORKSPACE_A, projectB.id);
    assert(listB.projectId === projectB.id && listB.candidates.length === 0, 'a new project starts empty');
    const savedB = await saveCandidate(WORKSPACE_A, {
      projectId: projectB.id,
      name: `Smoke B site ${process.pid}`,
      longitude: 69.335,
      latitude: 41.285,
    });
    const listBAfter = await listSavedCandidates(WORKSPACE_A, projectB.id);
    assert(
      listBAfter.candidates.some((candidate) => candidate.id === savedB.id),
      'the site saved in project B must appear in project B',
    );
    assert(
      !listBAfter.candidates.some((candidate) => candidate.id === savedCandidate.id),
      'a candidate of project A must never appear in project B',
    );
    const listAAfter = await listSavedCandidates(WORKSPACE_A, projectAId);
    assert(
      listAAfter.candidates.some((candidate) => candidate.id === savedCandidate.id),
      'switching back to project A must show project A sites again',
    );
    assert(
      !listAAfter.candidates.some((candidate) => candidate.id === savedB.id),
      'a candidate of project B must never appear in project A',
    );

    note('24. A comparison may not mix projects, and the model stays workspace-owned.');
    const mixed = await runAnalysis(WORKSPACE_A, {
      projectId: projectB.id,
      candidateIds: [savedB.id, savedCandidate.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'comparison',
    }).then(
      () => null,
      (error: unknown) => error,
    );
    assert(mixed instanceof ScoringApiError, 'a comparison mixing two projects must be refused');
    assert(
      mixed.status === 400 || mixed.status === 404,
      `a mixed-project comparison must be refused safely, got ${mixed.status}`,
    );
    assert(
      !/policy|sql|relation|constraint/i.test(mixed.message),
      'the refusal must not leak schema or policy details',
    );

    const inB = await runAnalysis(WORKSPACE_A, {
      projectId: projectB.id,
      candidateIds: [savedB.id],
      radiusMeters: 500,
      scoringModelId: model.id,
      mode: 'analysis',
    });
    assert(
      inB.analysis.projectId === projectB.id && inB.results[0]?.candidateId === savedB.id,
      'the same workspace model must score a candidate of the second project',
    );

    const historyB = await listStoredAnalyses(WORKSPACE_A, projectB.id, { limit: 50 });
    assert(
      historyB.analyses.length === 1 &&
        historyB.analyses.every((entry) => entry.analysis.projectId === projectB.id),
      `project B history must hold only its own analysis, got ${historyB.analyses.length}`,
    );
    const historyA = await listStoredAnalyses(WORKSPACE_A, projectAId, { limit: 50 });
    assert(
      historyA.analyses.some((entry) => entry.analysis.id === analysis.analysis.id),
      'switching back must still find the original analysis of project A',
    );
    assert(
      historyA.analyses.every(
        (entry) =>
          entry.analysis.projectId === projectAId &&
          entry.results.every((result) => result.candidateId !== savedB.id),
      ),
      'project A history must never contain a result of project B',
    );
    assert(
      !historyB.analyses.some((entry) => entry.analysis.id === analysis.analysis.id),
      'a stored analysis may not appear in two projects',
    );

    const modelsAfterProjects = await listScoringModels(WORKSPACE_A);
    assert(
      modelsAfterProjects.length === models.length &&
        modelsAfterProjects.some((entry) => entry.id === model.id),
      'projects must not duplicate or fork the workspace scoring models',
    );

    console.log('scoring smoke passed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tail = sanitizeDiagnostic(serverLog.join(''));
    if (process.env.GITHUB_ACTIONS) {
      console.error(
        `::error title=scoring smoke failed (${currentScenario})::${sanitizeDiagnostic(message, 600)}`,
      );
    }
    console.error(`SCORING SMOKE FAILED during: ${currentScenario}\n${message}`);
    if (tail) console.error(`--- server log tail ---\n${tail}`);
    process.exitCode = 1;
  } finally {
    stopServer(child);
  }
}

void main();
