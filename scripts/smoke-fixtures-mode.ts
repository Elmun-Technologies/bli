/**
 * End-to-end smoke test for the fixtures data source.
 *
 * It starts the production build with DATA_SOURCE=fixtures, then drives the
 * *shipped* browser client (src/lib/spatial/client.ts) against the *shipped*
 * route handlers and validates the responses with the *shipped* parsers.
 *
 * This exists because database mode and fixtures mode were each covered
 * separately while disagreeing with each other: fixtures emitted `customer-03`
 * ids that the client parser refused, so the map could not render in fixtures
 * mode even though every individual unit test passed. Unit tests cannot see
 * server/client drift; this can.
 *
 * No database, credentials or network access are required.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { fetchViewportFeatures, requestRadiusAnalysis, SpatialApiError } from '@/lib/spatial/client';
import { isAllowedServerMapFeatureId } from '@/lib/spatial/feature-id';
import type { ViewportBounds } from '@/lib/spatial/contracts';

const PORT = Number(process.env.SMOKE_PORT ?? 3311);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DEMO_BOUNDS: ViewportBounds = { west: 69.2, south: 41.25, east: 69.36, north: 41.37 };
const EMPTY_BOUNDS: ViewportBounds = { west: 1, south: 1, east: 2, north: 2 };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * The browser client uses same-origin relative URLs. Rewrite them to the smoke
 * server so the shipped client code runs unchanged.
 */
function installRelativeFetchBridge() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch(`${BASE_URL}${input}`, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

async function waitForServer(child: ChildProcess) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`fixtures server exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  throw new Error('fixtures server did not become ready in time');
}

async function readErrorPayload(response: Response): Promise<{ code?: string; message?: string }> {
  const payload = (await response.json()) as { error?: { code?: string; message?: string } };
  return payload.error ?? {};
}

/**
 * Start the production server directly (not through npm) so the process we
 * signal is the server itself, and detached so the whole group can be stopped.
 */
function startServer(): ChildProcess {
  const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) {
    throw new Error(`Next.js CLI not found at ${nextBin}; run this from the repository root`);
  }

  return spawn(
    process.execPath,
    [nextBin, 'start', '--hostname', '0.0.0.0', '--port', String(PORT)],
    {
      env: { ...process.env, DATA_SOURCE: 'fixtures' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
}

function stopServer(child: ChildProcess) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

async function main() {
  const child = startServer();
  const serverLog: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => serverLog.push(chunk.toString()));

  try {
    await waitForServer(child);
    installRelativeFetchBridge();

    // 1. Viewport features parse through the shipped browser parser.
    const collection = await fetchViewportFeatures(
      DEMO_BOUNDS,
      ['customers', 'competitors', 'branches', 'places'],
    );
    assert(collection.features.length > 0, 'fixtures viewport returned no features');
    assert(
      collection.meta.returnedCount === collection.features.length,
      'fixtures viewport meta.returnedCount disagrees with the feature list',
    );
    assert(collection.meta.truncated === false, 'fixtures viewport unexpectedly truncated');
    assert(
      JSON.stringify(collection.meta.kinds) ===
        JSON.stringify(['customers', 'competitors', 'branches', 'places']),
      `fixtures viewport echoed unexpected kinds: ${JSON.stringify(collection.meta.kinds)}`,
    );
    for (const feature of collection.features) {
      assert(
        isAllowedServerMapFeatureId(feature.properties.id),
        `fixtures viewport returned an unacceptable id: ${feature.properties.id}`,
      );
      if (feature.properties.kind === 'customers') {
        assert(
          !('name' in feature.properties),
          `customer feature ${feature.properties.id} leaked a display name`,
        );
      }
    }
    const kinds = new Set(collection.features.map((feature) => feature.properties.kind));
    assert(kinds.size > 1, 'fixtures viewport returned only one kind for a mixed layer request');

    // 2. Empty viewports are valid, not errors.
    const empty = await fetchViewportFeatures(EMPTY_BOUNDS, ['customers']);
    assert(empty.features.length === 0, 'empty viewport returned features');
    assert(empty.meta.truncated === false, 'empty viewport must not be truncated');

    // 3. Validation errors surface as structured client errors.
    const invalid = await fetch(`${BASE_URL}/api/demo/map/features?west=69.36&south=41.25&east=69.2&north=41.37&kinds=customers`);
    assert(invalid.status === 400, `inverted bounds should be rejected, got ${invalid.status}`);
    assert(
      (await readErrorPayload(invalid)).code === 'invalid_request',
      'inverted bounds should report invalid_request',
    );

    // 4. Fixtures are never used for metrics: radius analysis must refuse.
    try {
      await requestRadiusAnalysis({
        candidate: { longitude: 69.2797, latitude: 41.3111 },
        radiusMeters: 500,
      });
      throw new Error('radius analysis must not be served from fixtures');
    } catch (error) {
      assert(error instanceof SpatialApiError, `expected SpatialApiError, got ${String(error)}`);
      assert(error.status === 503, `expected status 503, got ${error.status}`);
      assert(
        error.code === 'database_required',
        `expected database_required, got ${error.code}`,
      );
    }

    console.log(
      `fixtures smoke passed: ${collection.features.length} viewport features, ` +
        `${kinds.size} kinds, empty viewport ok, invalid bounds rejected, analysis refused`,
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
      console.error('--- fixtures server output ---');
      console.error(serverLog.join(''));
    }
  }
}

main().catch((error: unknown) => {
  console.error(
    `fixtures smoke failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
