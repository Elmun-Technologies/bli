/**
 * End-to-end smoke test for Phase 4 authentication, membership and the
 * authenticated tenant GIS routes.
 *
 * It starts the production build in database mode against a running local
 * Supabase project, signs in through the shipped sign-in endpoint with the
 * deterministic seeded identities, then drives the shipped routes exactly as a
 * browser would: same cookies, same URLs, same parsers. It exists because unit
 * tests cannot see server/client drift, RLS misconfiguration or a route that
 * quietly accepts a foreign workspace id.
 *
 * Requires SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY) plus a database that has been reset and seeded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SAFE_AUTH_MESSAGES } from '@/lib/auth/messages';
import type { ViewportBounds } from '@/lib/spatial/contracts';
import { parseViewportFeatureCollection } from '@/lib/spatial/response';

const PORT = Number(process.env.SMOKE_PORT ?? 3312);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Deterministic seed identities (supabase/seed.sql). Synthetic and local only.
const OWNER_A = { email: 'owner-a@example.test', password: 'phase4-demo-password' };
const VIEWER_B = { email: 'owner-b@example.test', password: 'phase4-demo-password' };
const WORKSPACE_A = '00000000-0000-4000-8000-000000000010';
const WORKSPACE_B = '00000000-0000-4000-8000-000000000011';
const MISSING_WORKSPACE = '00000000-0000-4000-8000-00000000dead';
const BOUNDS: ViewportBounds = { west: 69.2, south: 41.25, east: 69.36, north: 41.37 };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Scenario markers and failure reporting. GitHub Actions annotations are the
 * only channel that survives this workflow's log retention, so each scenario
 * announces itself and a failure names the scenario it happened in. Secret-like
 * values are redacted before anything is printed.
 */
let currentScenario = 'startup';

function note(scenario: string) {
  currentScenario = scenario;
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=authenticated smoke::${scenario}`);
  }
}

function sanitizeDiagnostic(text: string, limit = 1200): string {
  return text
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<redacted-jwt>')
    .replace(/\b(?:sb|sk)_[A-Za-z0-9_-]{6,}/g, '<redacted-key>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Minimal cookie jar: browsers and this script store the same SSR cookies. */
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

  get isEmpty(): boolean {
    return this.cookies.size === 0;
  }
}

async function request(
  url: string,
  init: RequestInit = {},
  jar?: CookieJar,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar?.header();
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(`${BASE_URL}${url}`, { ...init, headers, redirect: 'manual' });
  jar?.store(response);
  return response;
}

async function readError(response: Response): Promise<{ code?: string; message?: string }> {
  const payload = (await response.json()) as { error?: { code?: string; message?: string } };
  return payload.error ?? {};
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
      throw new Error(`authenticated smoke server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/sign-in`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await delay(250);
  }
  throw new Error('authenticated smoke server did not become ready in time');
}

async function signIn(credentials: { email: string; password: string }, jar: CookieJar) {
  return request(
    '/api/auth/sign-in',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(credentials),
    },
    jar,
  );
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for the authenticated smoke test');
  }
  if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('An elevated Supabase key is required so the public demo route can run');
  }

  const child = startServer();
  const serverLog: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

  try {
    await waitForServer(child);

    note('1. The sign-in page renders a real form.');
    // 1. The sign-in page renders a real form.
    const signInPage = await fetch(`${BASE_URL}/sign-in`);
    const signInHtml = await signInPage.text();
    assert(signInPage.status === 200, `GET /sign-in returned ${signInPage.status}`);
    assert(signInHtml.includes('name="email"'), 'the sign-in form is missing the email field');
    assert(signInHtml.includes('name="password"'), 'the sign-in form is missing the password field');

    note('2. Protected pages redirect anonymous visitors to sign-in.');
    // 2. Protected pages redirect anonymous visitors to sign-in.
    const anonymousJar = new CookieJar();
    const anonymousWorkspaces = await request('/workspaces', {}, anonymousJar);
    assert(
      anonymousWorkspaces.status === 303 || anonymousWorkspaces.status === 307,
      `anonymous /workspaces returned ${anonymousWorkspaces.status}`,
    );
    assert(
      (anonymousWorkspaces.headers.get('location') ?? '').startsWith('/sign-in'),
      'anonymous /workspaces did not redirect to /sign-in',
    );

    note('3. Anonymous tenant API calls are refused with the safe session message.');
    // 3. Anonymous tenant API calls are refused with the safe session message.
    const anonymousFeatures = await request(
      `/api/workspaces/${WORKSPACE_A}/map/features?west=69.2&south=41.25&east=69.36&north=41.37`,
    );
    assert(anonymousFeatures.status === 401, `anonymous tenant API returned ${anonymousFeatures.status}`);
    const anonymousError = await readError(anonymousFeatures);
    assert(
      anonymousError.code === 'session_expired' &&
        anonymousError.message === SAFE_AUTH_MESSAGES.sessionExpired,
      `anonymous tenant API returned an unsafe error: ${JSON.stringify(anonymousError)}`,
    );

    note('4. A wrong password fails without revealing whether the account exists.');
    // 4. A wrong password fails without revealing whether the account exists.
    const wrongPasswordJar = new CookieJar();
    const wrongPassword = await signIn(
      { email: OWNER_A.email, password: 'definitely-not-the-password' },
      wrongPasswordJar,
    );
    assert(wrongPassword.status === 401, `wrong password returned ${wrongPassword.status}`);
    const wrongPasswordError = await readError(wrongPassword);
    assert(
      wrongPasswordError.code === 'invalid_credentials' &&
        wrongPasswordError.message === SAFE_AUTH_MESSAGES.invalidCredentials,
      `wrong password returned an unsafe error: ${JSON.stringify(wrongPasswordError)}`,
    );
    assert(wrongPasswordJar.isEmpty, 'a failed sign-in must not issue a session cookie');

    note('5. Correct credentials establish a server-validated session.');
    // 5. Correct credentials establish a server-validated session.
    const ownerJar = new CookieJar();
    const signInResponse = await signIn(OWNER_A, ownerJar);
    assert(signInResponse.status === 200, `sign-in returned ${signInResponse.status}`);
    assert(!ownerJar.isEmpty, 'sign-in did not issue a session cookie');

    note("6. The selector lists only the signed-in user's memberships.");
    // 6. The selector lists only the signed-in user's memberships.
    const workspacesResponse = await request('/workspaces', {}, ownerJar);
    assert(workspacesResponse.status === 200, `GET /workspaces returned ${workspacesResponse.status}`);
    const workspacesHtml = await workspacesResponse.text();
    assert(
      workspacesHtml.includes(`/workspaces/${WORKSPACE_A}`),
      'the selector does not list workspace A',
    );
    assert(
      !workspacesHtml.includes(`/workspaces/${WORKSPACE_B}`),
      'the selector leaked a workspace the caller is not a member of',
    );

    note('7. The protected workspace route renders for a member.');
    // 7. The protected workspace route renders for a member.
    const workspaceResponse = await request(`/workspaces/${WORKSPACE_A}`, {}, ownerJar);
    assert(
      workspaceResponse.status === 200,
      `GET /workspaces/{A} returned ${workspaceResponse.status}`,
    );

    note('8. The authenticated viewport route answers for a member, and the shipped');
    // 8. The authenticated viewport route answers for a member, and the shipped
    //    browser parser accepts the payload.
    const viewportResponse = await request(
      `/api/workspaces/${WORKSPACE_A}/map/features?west=${BOUNDS.west}&south=${BOUNDS.south}&east=${BOUNDS.east}&north=${BOUNDS.north}`,
      {},
      ownerJar,
    );
    assert(viewportResponse.status === 200, `tenant viewport returned ${viewportResponse.status}`);
    const collection = parseViewportFeatureCollection(await viewportResponse.json());
    assert(collection.features.length > 0, 'tenant viewport returned no features');
    assert(collection.meta.truncated === false, 'tenant viewport was unexpectedly truncated');
    for (const feature of collection.features) {
      if (feature.properties.kind === 'customers') {
        assert(!('name' in feature.properties), 'a customer feature leaked a display name');
      }
    }

    note('9. The authenticated radius route answers for a member.');
    // 9. The authenticated radius route answers for a member.
    const radiusResponse = await request(
      `/api/workspaces/${WORKSPACE_A}/analysis/radius`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: { longitude: 69.2897, latitude: 41.3111 }, radiusMeters: 500 }),
      },
      ownerJar,
    );
    assert(radiusResponse.status === 200, `tenant radius returned ${radiusResponse.status}`);
    const radiusPayload = (await radiusResponse.json()) as {
      analysis?: { customersCount?: unknown; customersRevenueTotal?: unknown };
    };
    assert(
      typeof radiusPayload.analysis?.customersCount === 'number' &&
        typeof radiusPayload.analysis?.customersRevenueTotal === 'string',
      `tenant radius returned no aggregates: ${JSON.stringify(radiusPayload).slice(0, 200)}`,
    );

    note('10. Workspace-id tampering fails identically for a foreign workspace and a');
    // 10. Workspace-id tampering fails identically for a foreign workspace and a
    //     workspace that does not exist: no existence oracle, never a 200.
    const foreignViewport = await request(
      `/api/workspaces/${WORKSPACE_B}/map/features?west=${BOUNDS.west}&south=${BOUNDS.south}&east=${BOUNDS.east}&north=${BOUNDS.north}`,
      {},
      ownerJar,
    );
    const missingViewport = await request(
      `/api/workspaces/${MISSING_WORKSPACE}/map/features?west=${BOUNDS.west}&south=${BOUNDS.south}&east=${BOUNDS.east}&north=${BOUNDS.north}`,
      {},
      ownerJar,
    );
    assert(foreignViewport.status === 403, `foreign workspace returned ${foreignViewport.status}`);
    assert(missingViewport.status === 403, `missing workspace returned ${missingViewport.status}`);

    const foreignError = await readError(foreignViewport);
    const missingError = await readError(missingViewport);
    assert(
      foreignError.code === 'workspace_forbidden' &&
        foreignError.message === SAFE_AUTH_MESSAGES.noWorkspaceAccess,
      `foreign workspace returned an unsafe error: ${JSON.stringify(foreignError)}`,
    );
    assert(
      missingError.code === foreignError.code && missingError.message === foreignError.message,
      'a missing workspace is distinguishable from a foreign workspace',
    );

    const foreignRadius = await request(
      `/api/workspaces/${WORKSPACE_B}/analysis/radius`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: { longitude: 69.2897, latitude: 41.3111 }, radiusMeters: 500 }),
      },
      ownerJar,
    );
    assert(foreignRadius.status === 403, `foreign workspace radius returned ${foreignRadius.status}`);

    const foreignPage = await request(`/workspaces/${WORKSPACE_B}`, {}, ownerJar);
    assert(foreignPage.status === 200, `foreign workspace page returned ${foreignPage.status}`);
    assert(
      (await foreignPage.text()).includes(SAFE_AUTH_MESSAGES.noWorkspaceAccess),
      'the foreign workspace page did not render the safe no-access state',
    );

    note('11. The public demo path is unaffected by the tenant routes.');
    // 11. The public demo path is unaffected by the tenant routes.
    const demoResponse = await fetch(`${BASE_URL}/api/demo/map/features?west=${BOUNDS.west}&south=${BOUNDS.south}&east=${BOUNDS.east}&north=${BOUNDS.north}`);
    assert(demoResponse.status === 200, `public demo returned ${demoResponse.status}`);
    const demoCollection = parseViewportFeatureCollection(await demoResponse.json());
    assert(demoCollection.features.length > 0, 'public demo returned no features');

    note("12. Membership is per workspace: workspace B's owner cannot read A.");
    // 12. Membership is per workspace: workspace B's owner cannot read A.
    const viewerJar = new CookieJar();
    const viewerSignIn = await signIn(VIEWER_B, viewerJar);
    assert(viewerSignIn.status === 200, `workspace B sign-in returned ${viewerSignIn.status}`);
    const viewerForeign = await request(
      `/api/workspaces/${WORKSPACE_A}/map/features?west=${BOUNDS.west}&south=${BOUNDS.south}&east=${BOUNDS.east}&north=${BOUNDS.north}`,
      {},
      viewerJar,
    );
    assert(
      viewerForeign.status === 403,
      `workspace B owner reached workspace A with status ${viewerForeign.status}`,
    );

    note('13. Sign-out invalidates the session server-side.');
    // 13. Sign-out invalidates the session server-side.
    const signOut = await request(
      '/api/auth/sign-out',
      { method: 'POST', headers: { Accept: 'application/json' } },
      ownerJar,
    );
    assert(signOut.status === 200, `sign-out returned ${signOut.status}`);
    const afterSignOut = await request('/workspaces', {}, ownerJar);
    assert(
      afterSignOut.status === 303 || afterSignOut.status === 307,
      `after sign-out /workspaces returned ${afterSignOut.status}`,
    );

    console.log(
      'authenticated smoke passed: sign-in, wrong password, session, selector, protected page, ' +
        'tenant viewport, tenant radius, workspace-id tampering, cross-workspace denial, ' +
        'public demo, sign-out',
    );
  } finally {
    stopServer(child);
    await delay(500);
    if (child.exitCode === null) {
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    if (serverLog.length > 0 && typeof process.exitCode === 'number' && process.exitCode !== 0) {
      const tail = serverLog.join('').split('\n').slice(-40).join('\n');
      if (process.env.GITHUB_ACTIONS) {
        console.error(
          `::notice title=authenticated smoke server output::${sanitizeDiagnostic(tail)}`,
        );
      }
      console.error('--- authenticated smoke server output ---');
      console.error(tail);
    }
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.env.GITHUB_ACTIONS) {
      console.error(
        `::error title=authenticated smoke::[${currentScenario}] ${sanitizeDiagnostic(message, 400)}`,
      );
    }
    console.error(`authenticated smoke failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
