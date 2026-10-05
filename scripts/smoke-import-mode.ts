/**
 * End-to-end smoke test for the Phase 5 import pipeline.
 *
 * It starts the production build in database mode against a running local
 * Supabase project and drives the *shipped* import API exactly as the wizard
 * does - same multipart upload, same JSON bodies, same client module - then
 * checks the result through the *shipped* GIS client. That is the point: unit
 * tests cannot see server/client drift, a missing storage policy, a
 * service_role shortcut, or a route that quietly accepts another workspace's id.
 *
 * Geocoding runs against the deterministic fake provider
 * (`GEOCODING_PROVIDER=fake`), so this smoke never needs a Mapbox token, never
 * touches the real service and never spends a geocoding credit. The live
 * provider is verified separately and only ever manually (see docs/geocoding.md).
 *
 * Requires SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY) plus a database that has been reset and seeded.
 * Run it after the authenticated smoke: it deliberately adds customers to the
 * seeded workspace, and asserts only on the rows and datasets it created itself.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { IMPORT_STEPS } from '@/components/app/import-state';
import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import {
  applyMapping,
  commitImport,
  createImport,
  getImport,
  listDatasets,
  listImportRows,
  runGeocodeBatch,
  uploadImportFile,
} from '@/lib/imports/client';
import { neutralizeFormulaCell } from '@/lib/imports/export';
import { fetchWorkspaceViewportFeatures } from '@/lib/spatial/client';
import type { ViewportBounds } from '@/lib/spatial/contracts';

const PORT = Number(process.env.SMOKE_PORT ?? 3313);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const OWNER_A = { email: 'owner-a@example.test', password: 'phase4-demo-password' };
const VIEWER_A = { email: 'viewer-a@example.test', password: 'phase4-demo-password' };
const OWNER_B = { email: 'owner-b@example.test', password: 'phase4-demo-password' };
const WORKSPACE_A = '00000000-0000-4000-8000-000000000010';
const WORKSPACE_B = '00000000-0000-4000-8000-000000000011';
const MISSING_WORKSPACE = '00000000-0000-4000-8000-00000000dead';
const BOUNDS: ViewportBounds = { west: 69.2, south: 41.25, east: 69.36, north: 41.37 };

/** Unique per run, so the smoke can be repeated against the same database. */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** A name that a spreadsheet would treat as a formula. Imported verbatim, exported neutralized. */
const FORMULA_NAME = "=HYPERLINK('http://evil.example','x')";

const CSV = [
  'Mijoz,Telefon,Manzil,Shirote,Uzunlik,Savdo,Buyurtma,Segments,Tashqi ID',
  `Ali Valiyev,+998901112233,"Toshkent, Amir Temur 1",,,1250000.50,12,retail,smoke-${RUN_ID}-1`,
  `Zuhra Karimova,+998902223344,"Samarqand, Registon 5",,,980000,7,wholesale,smoke-${RUN_ID}-2`,
  `"${FORMULA_NAME}",+998903334455,,,,n/a,3,retail,smoke-${RUN_ID}-3`,
  `Dilnoza Yusupova,+998904445566,"Toshkent, Chilonzor 9",41.2856,69.2034,450000,0,retail,smoke-${RUN_ID}-4`,
  `Jasur Toshmatov,+998905556677,"Toshkent, Yunusabad 4",,,100,1,retail,smoke-${RUN_ID}-5`,
].join('\n');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let currentScenario = 'startup';

function note(scenario: string) {
  currentScenario = scenario;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=import smoke::${scenario}`);
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
    // A raw request may already carry its own jar (the viewer/foreign checks do);
    // never overwrite that identity with the client bridge's jar.
    if (cookie && !headers.has('Cookie')) headers.set('Cookie', cookie);
    return originalFetch(target, { ...init, headers, redirect: 'manual' } as RequestInit);
  }) as typeof fetch;
}

async function request(url: string, init: RequestInit = {}, jar?: CookieJar): Promise<Response> {
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
    env: {
      ...process.env,
      DATA_SOURCE: 'database',
      // Deterministic provider: no token, no network, no Mapbox dependency.
      GEOCODING_PROVIDER: 'fake',
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`import smoke server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/sign-in`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await delay(250);
  }
  throw new Error('import smoke server did not become ready in time');
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
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for the import smoke test');
  }

  const child = startServer();
  const serverLog: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

  try {
    await waitForServer(child);
    installFetchBridge();

    note('1. The wizard keeps its six documented steps.');
    assert(IMPORT_STEPS.length === 6, 'the wizard must keep six steps');
    assert(IMPORT_STEPS[0] === 'upload', 'the wizard must start at the upload step');

    const ownerJar = await signIn(OWNER_A, new CookieJar());
    activeJar = ownerJar;

    note('2. An owner can list the import jobs of the workspace.');
    const listed = await request(`/api/workspaces/${WORKSPACE_A}/imports`, {}, ownerJar);
    assert(listed.ok, `import list failed with ${listed.status}`);

    note('3. Datasets of the workspace are listed for the destination picker.');
    const datasets = await listDatasets(WORKSPACE_A);
    assert(datasets.length > 0, 'the seeded workspace must have datasets');

    note('4. Creating an import returns a job in the uploaded stage.');
    const created = await createImport(WORKSPACE_A, {
      filename: 'smoke-customers.csv',
      fileType: 'csv',
      targetEntity: 'customers',
    });
    const importId = created.import.id;
    assert(created.import.status === 'uploaded', `expected uploaded, got ${created.import.status}`);
    assert(
      created.import.workspaceId === WORKSPACE_A,
      'the job must belong to the workspace in the path',
    );

    note('5. Uploading the file stores it privately and detects the columns.');
    const file = new File([CSV], 'smoke-customers.csv', { type: 'text/csv' });
    const uploaded = await uploadImportFile(WORKSPACE_A, importId, file);
    assert(uploaded.requiresSheetSelection === false, 'a CSV never needs a sheet choice');
    assert(
      uploaded.job.headers.includes('Manzil') && uploaded.job.headers.includes('Savdo'),
      `unexpected headers: ${uploaded.job.headers.join(', ')}`,
    );
    assert(
      uploaded.job.status === 'mapping_required',
      `expected mapping_required, got ${uploaded.job.status}`,
    );
    assert(
      uploaded.suggestions.length === uploaded.job.headers.length,
      'every column gets a suggestion',
    );

    note('6. Applying the mapping validates and stages every row.');
    const validated = await applyMapping(WORKSPACE_A, importId, {
      Mijoz: 'name',
      Telefon: 'phone',
      Manzil: 'address',
      Shirote: 'latitude',
      Uzunlik: 'longitude',
      Savdo: 'revenue',
      Buyurtma: 'order_count',
      Segments: 'segment',
      'Tashqi ID': 'external_id',
    });
    assert(validated.staged === 5, `expected 5 staged rows, got ${validated.staged}`);
    assert(validated.valid === 1, `expected 1 located row, got ${validated.valid}`);
    assert(validated.needsGeocoding === 3, `expected 3 rows needing geocoding, got ${validated.needsGeocoding}`);
    assert(validated.invalid === 1, `expected 1 invalid row, got ${validated.invalid}`);
    assert(validated.valid + validated.needsGeocoding + validated.invalid === 5, 'row outcomes must be exhaustive');

    note('7. The preview filters by outcome and exposes canonical fields only.');
    const invalidPage = await listImportRows(WORKSPACE_A, importId, { status: 'invalid', page: 1 });
    assert(invalidPage.total === 1, `expected one invalid row, got ${invalidPage.total}`);
    const invalidRow = invalidPage.rows[0];
    assert(
      invalidRow.errors.some((error) => error.code === 'invalid_number' && error.field === 'revenue'),
      `expected an invalid revenue error, got ${JSON.stringify(invalidRow.errors)}`,
    );
    assert(invalidRow.rowNumber === 4, `the invalid row must keep its source row number, got ${invalidRow.rowNumber}`);
    assert(
      !Object.keys(invalidRow.rawData).includes('Savdo'),
      'the preview exposes canonical fields only, not raw spreadsheet columns',
    );
    assert(
      invalidRow.rawData.name === FORMULA_NAME,
      'a formula-looking value is stored verbatim as text and never executed',
    );

    note('8. A geocoding batch resolves the address-only rows without a real provider.');
    // The batch summary is the RPC's JSONB, so its counters stay snake_case.
    const batch = await runGeocodeBatch(WORKSPACE_A, importId, 25);
    const applied = batch.summary.applied;
    assert(applied === 3, `expected 3 applied geocoding results, got ${applied}`);
    const afterBatch = await getImport(WORKSPACE_A, importId);
    assert(
      afterBatch.import.counters.geocodedRows === 3,
      `expected 3 geocoded rows, got ${afterBatch.import.counters.geocodedRows}`,
    );
    assert(
      afterBatch.import.counters.needsGeocodingRows === 0,
      `expected no rows waiting after the batch, got ${afterBatch.import.counters.needsGeocodingRows}`,
    );
    assert(
      afterBatch.import.counters.validRows === 4,
      `expected 4 ready rows, got ${afterBatch.import.counters.validRows}`,
    );

    note('9. A repeated batch is idempotent: completed rows stay completed.');
    const repeat = await runGeocodeBatch(WORKSPACE_A, importId, 25);
    assert(
      repeat.summary.applied === 0,
      `a repeated batch must not re-apply results, applied ${repeat.summary.applied}`,
    );
    assert(repeat.summary.skipped === 0, 'a repeated batch must not even claim the completed rows');

    note('10. The one unusable row stays staged and reviewable, never dropped.');
    const invalidRows = await listImportRows(WORKSPACE_A, importId, { status: 'invalid', page: 1 });
    assert(invalidRows.total === 1, `the invalid row must remain staged, got ${invalidRows.total}`);
    const needsGeocoding = await listImportRows(WORKSPACE_A, importId, {
      status: 'needs_geocoding',
      page: 1,
    });
    assert(needsGeocoding.total === 0, 'nothing may be left waiting after a successful batch');

    note('11. The error export is a safe CSV with the row number and a safe message.');
    const exportResponse = await request(
      `/api/workspaces/${WORKSPACE_A}/imports/${importId}/errors.csv`,
      {},
      ownerJar,
    );
    assert(exportResponse.ok, `error export failed with ${exportResponse.status}`);
    const exportBody = await exportResponse.text();
    assert(
      exportBody.startsWith('row_number,error_code,error_field,error_message'),
      `unexpected export header: ${exportBody.slice(0, 80)}`,
    );
    assert(exportBody.includes('invalid_number'), 'the export must name the error code');
    // Row 4 is the invalid one, so the formula-looking name and the +998 phone
    // both travel through the export and must both come out inert.
    assert(
      exportBody.includes(neutralizeFormulaCell(FORMULA_NAME)),
      'a formula-leading value must be neutralized in the export',
    );
    assert(
      exportBody.includes(neutralizeFormulaCell('+998903334455')),
      'a leading + must be neutralized in the export',
    );
    assert(!/\b(SELECT|INSERT|UPDATE|DELETE FROM)\b/i.test(exportBody), 'the export must not leak SQL');
    assert(!exportBody.includes('at Object.'), 'the export must not leak stack traces');

    note('12. Committing promotes exactly the ready rows into a new dataset.');
    const committed = await commitImport(WORKSPACE_A, importId, {
      newDatasetName: `Smoke import ${RUN_ID}`,
      newDatasetType: 'customers',
    });
    // The summary is typed on the client, so these are the shipped wire fields.
    const inserted = committed.summary.insertedRows;
    assert(inserted === 4, `expected 4 promoted rows, got ${inserted}`);
    assert(committed.summary.datasetCreated === true, 'a new dataset must report that it was created');
    assert(committed.summary.conflictingRows === 0, 'no duplicate external id was expected');
    const targetDataset = committed.summary.targetDatasetId;
    assert(targetDataset.length === 36, 'the commit must report the dataset it wrote into');
    assert(committed.summary.jobStatus === 'completed', 'the job must end completed');

    note('13. Replaying the commit is idempotent and cannot be re-pointed.');
    const afterCommit = await getImport(WORKSPACE_A, importId);
    assert(
      afterCommit.import.counters.committedRows === 4,
      `expected 4 committed rows, got ${afterCommit.import.counters.committedRows}`,
    );
    const replay = await commitImport(WORKSPACE_A, importId, { datasetId: targetDataset });
    assert(
      replay.summary.insertedRows === 0,
      `a replayed commit must insert no rows, inserted ${replay.summary.insertedRows}`,
    );
    assert(
      replay.summary.previouslyCommittedRows === 4,
      `a replayed commit must report the 4 already-promoted rows, got ${replay.summary.previouslyCommittedRows}`,
    );
    assert(replay.summary.datasetCreated === false, 'a replayed commit must not create a second dataset');

    const rePointed = await request(
      `/api/workspaces/${WORKSPACE_A}/imports/${importId}/commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newDatasetName: `Smoke import ${RUN_ID} twice`, newDatasetType: 'customers' }),
      },
      ownerJar,
    );
    assert(rePointed.status === 400, `re-pointing a committed import must be refused, got ${rePointed.status}`);
    const rePointedError = await readError(rePointed);
    assert(
      rePointedError.code === 'invalid_request',
      `re-pointing must report a safe request error, got ${rePointedError.code}`,
    );
    const datasetsAfterReplay = await listDatasets(WORKSPACE_A);
    assert(
      !datasetsAfterReplay.some((dataset) => dataset.name === `Smoke import ${RUN_ID} twice`),
      'the refused re-commit must not leave an empty dataset behind',
    );

    note('14. The created dataset appears in the workspace list.');
    const datasetsAfter = await listDatasets(WORKSPACE_A);
    assert(
      datasetsAfter.some((dataset) => dataset.id === targetDataset),
      'the created dataset must appear in the workspace list',
    );

    note('15. A foreign workspace sees neither the dataset nor the import job.');
    const bJar = await signIn(OWNER_B, new CookieJar());
    activeJar = bJar;
    const bDatasets = await listDatasets(WORKSPACE_B);
    assert(
      !bDatasets.some((dataset) => dataset.id === targetDataset),
      'workspace B must not see workspace A datasets',
    );
    const foreignJob = await request(`/api/workspaces/${WORKSPACE_A}/imports/${importId}`, {}, bJar);
    assert(foreignJob.status === 403, `a foreign import read must be 403, got ${foreignJob.status}`);

    note('16. Tampering with the workspace in the path never imports elsewhere.');
    const foreignCreate = await request(
      `/api/workspaces/${WORKSPACE_A}/imports`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'intruder.csv', fileType: 'csv', targetEntity: 'customers' }),
      },
      bJar,
    );
    assert(foreignCreate.status === 403, `expected 403 for a foreign workspace, got ${foreignCreate.status}`);
    const foreignError = await readError(foreignCreate);
    assert(
      foreignError.message === SAFE_AUTH_MESSAGES.noWorkspaceAccess,
      `unexpected foreign-workspace message: ${foreignError.message}`,
    );
    assert(!JSON.stringify(foreignError).includes(WORKSPACE_A), 'the refusal must not echo tenant identifiers');

    const missingCreate = await request(
      `/api/workspaces/${MISSING_WORKSPACE}/imports`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'missing.csv', fileType: 'csv', targetEntity: 'customers' }),
      },
      bJar,
    );
    assert(missingCreate.status === 403, `expected 403 for a missing workspace, got ${missingCreate.status}`);
    assert(
      JSON.stringify(await readError(missingCreate)) === JSON.stringify(foreignError),
      'a missing workspace must answer exactly like a foreign one',
    );

    // A body that names another workspace must not move the job either: the
    // upload route builds the storage path from the path workspace only.
    const disguisedBody = await request(
      `/api/workspaces/${WORKSPACE_A}/imports/${importId}/file`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: WORKSPACE_B }) },
      ownerJar,
    );
    assert(disguisedBody.status === 400, `expected 400 for a non-multipart upload, got ${disguisedBody.status}`);

    note('17. A viewer can read but never write.');
    const viewerJar = await signIn(VIEWER_A, new CookieJar());
    const viewerRead = await request(`/api/workspaces/${WORKSPACE_A}/imports/${importId}`, {}, viewerJar);
    assert(viewerRead.ok, `a viewer should read import metadata, got ${viewerRead.status}`);
    const viewerWrite = await request(
      `/api/workspaces/${WORKSPACE_A}/imports/${importId}/mapping`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping: { Mijoz: 'name', Manzil: 'address' } }),
      },
      viewerJar,
    );
    assert(viewerWrite.status === 403, `expected 403 for a viewer write, got ${viewerWrite.status}`);

    note('18. Committed customers are visible through the shipped GIS client, without PII.');
    activeJar = ownerJar;
    const features = await fetchWorkspaceViewportFeatures(WORKSPACE_A, BOUNDS, null);
    assert(features.features.length > 0, 'the tenant viewport must return features after the import');
    assert(
      features.features.some((feature) => feature.properties.kind === 'customers'),
      'the imported customer must appear as a customer feature',
    );
    const serialized = JSON.stringify(features);
    assert(!serialized.includes('+998'), 'no phone number may reach the map payload');
    assert(!/Amir Temur|Chilonzor|Yunusabad/.test(serialized), 'no raw address may reach the map payload');
    assert(!serialized.includes('1250000'), 'no per-customer revenue may reach the map payload');
    assert(!serialized.includes(FORMULA_NAME), 'no imported free text may reach the map payload');

    console.log('import smoke passed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const tail = sanitizeDiagnostic(serverLog.join(''));
    if (process.env.GITHUB_ACTIONS) {
      console.error(
        `::error title=import smoke failed (${currentScenario})::${sanitizeDiagnostic(message, 600)}`,
      );
    }
    console.error(`IMPORT SMOKE FAILED during: ${currentScenario}\n${message}`);
    if (tail) console.error(`--- server log tail ---\n${tail}`);
    process.exitCode = 1;
  } finally {
    stopServer(child);
  }
}

void main();
