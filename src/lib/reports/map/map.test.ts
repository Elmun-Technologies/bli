/**
 * Phase 7 map provider tests: the deterministic fake provider, the Mapbox
 * request builder (no network, no token, no credits) and the guarantee that no
 * customer-level value can reach a provider.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutiveSummary } from '../summary';
import { buildSingleSnapshot, buildReportSnapshot, snapshotInput, loadStoredPayload } from '../test-fixtures';
import { buildReportViewModel } from '../view-model';
import { FakeReportMapProvider } from './fake-provider';
import { FAKE_MAP_FIXTURE_BYTES } from './fixture-png';
import { fakeMapFixturePng, FAKE_MAP_FIXTURE_SIZE } from './fixture-png';
import {
  buildOverlayPath,
  buildViewport,
  circleRing,
  DEFAULT_REPORT_MAP_STYLE,
  MapboxReportMapProvider,
  MAPBOX_ATTRIBUTION,
} from './mapbox-provider';
import { ReportMapError, type ReportMapProvider } from './provider';
import { resolveReportMapProvider } from './index';
import { PII_MARKERS, buildPiiPayload } from '../test-fixtures';

const MARKERS = [
  { label: 'A', longitude: 69.2797, latitude: 41.3111 },
  { label: 'B', longitude: 69.2604, latitude: 41.2950 },
  { label: 'C', longitude: 69.3001, latitude: 41.3202 },
];

test('the fake provider returns the committed fixture and records its request', async () => {
  const provider = new FakeReportMapProvider();
  const result = await provider.renderComparisonMap({
    markers: MARKERS,
    radiusMeters: 1000,
    width: 1200,
    height: 700,
  });

  assert.equal(result.provider, 'fake');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.attribution, provider.attribution);
  assert.equal(result.bytes.byteLength, FAKE_MAP_FIXTURE_BYTES);
  // A real PNG signature, so the bytes are an image and not a placeholder.
  assert.deepEqual([...result.bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(FAKE_MAP_FIXTURE_SIZE.width, 640);
  assert.equal(FAKE_MAP_FIXTURE_SIZE.height, 360);
  assert.deepEqual(fakeMapFixturePng(), fakeMapFixturePng());

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].kind, 'comparison');
  assert.deepEqual(
    (provider.calls[0].request as { markers: typeof MARKERS }).markers,
    MARKERS,
  );
});

test('the fake provider fails loudly when it is configured to fail', async () => {
  const provider = new FakeReportMapProvider('provider unavailable');
  await assert.rejects(
    () => provider.renderSingleLocationMap({ markers: [MARKERS[0]], radiusMeters: 500, width: 100, height: 100 }),
    (error: unknown) => error instanceof ReportMapError,
  );
});

test('provider selection follows the documented order and never needs a token', () => {
  const fake = resolveReportMapProvider({ REPORT_MAP_PROVIDER: 'fake' });
  assert.equal(fake.name, 'fake');
  assert.ok(fake.provider);

  const mapbox = resolveReportMapProvider({ MAPBOX_ACCESS_TOKEN: 'pk.test-token' });
  assert.equal(mapbox.name, 'mapbox-static');
  assert.equal(mapbox.attribution, MAPBOX_ATTRIBUTION);

  // A fake provider wins even when a token exists, so CI can never spend credits.
  const both = resolveReportMapProvider({ REPORT_MAP_PROVIDER: 'fake', MAPBOX_ACCESS_TOKEN: 'pk.test-token' });
  assert.equal(both.name, 'fake');

  const none = resolveReportMapProvider({});
  assert.equal(none.name, 'none');
  assert.equal(none.provider, null);
  assert.match(none.attribution, /No static map/);
});

test('the Mapbox request carries the markers, the radius circle and the attribution flags', async () => {
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }) as unknown as typeof fetch;

  const provider = new MapboxReportMapProvider({
    accessToken: 'pk.secret-token',
    style: 'mapbox/streets-v12',
    fetchImpl,
  });

  const url = provider.buildUrl(MARKERS, 1000, 1200, 700, 48);
  assert.match(url, /^https:\/\/api\.mapbox\.com\/styles\/v1\/mapbox\/streets-v12\/static\//);
  assert.match(url, /pin-s-a\(69\.27970,41\.31110\)/);
  assert.match(url, /pin-s-b\(69\.26040,41\.29500\)/);
  assert.match(url, /pin-s-c\(69\.30010,41\.32020\)/);
  assert.match(url, /logo=true/);
  assert.match(url, /attribution=true/);
  assert.match(url, /access_token=pk\.secret-token/);

  const result = await provider.renderComparisonMap({
    markers: MARKERS,
    radiusMeters: 1000,
    width: 1200,
    height: 700,
  });
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.attribution, MAPBOX_ATTRIBUTION);
  assert.equal(requests.length, 1);

  // The default style is documented, and the token is never returned to a caller.
  assert.equal(DEFAULT_REPORT_MAP_STYLE, 'mapbox/light-v11');
  assert.ok(!JSON.stringify({ ...result, bytes: undefined }).includes('pk.secret-token'));
});

test('a single-location request draws the radius circle to scale', () => {
  const overlay = buildOverlayPath([MARKERS[0]], 1000);
  assert.match(overlay, /^geojson\(/);
  assert.match(overlay, /pin-s-a\(69\.27970,41\.31110\)/);

  // No circle for a comparison: the shared radius is documented in the text.
  const comparison = buildOverlayPath(MARKERS, 1000);
  assert.ok(!comparison.includes('geojson('));

  const ring = circleRing(69.2797, 41.3111, 1000, 64);
  assert.equal(ring.length, 65);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  // Every point is roughly the requested distance from the center.
  const centerLat = 41.3111;
  for (const [longitude, latitude] of ring) {
    const dLat = (latitude - centerLat) * 111_320;
    const dLon = (longitude - 69.2797) * 111_320 * Math.cos((centerLat * Math.PI) / 180);
    const distance = Math.sqrt(dLat * dLat + dLon * dLon);
    assert.ok(Math.abs(distance - 1000) < 25, `ring point ${distance.toFixed(0)} m from the centre`);
  }

  assert.equal(buildViewport(1200, 700, 48), 'auto1200x700@2x,48');
  assert.equal(buildViewport(1200, 700, 0), 'auto1200x700@2x');
});

test('a provider failure is a loud error, never a blank map', async () => {
  const failingFetch = (async () =>
    new Response('nope', { status: 429 })) as unknown as typeof fetch;
  const provider = new MapboxReportMapProvider({ accessToken: 'pk.test', fetchImpl: failingFetch });

  await assert.rejects(
    () =>
      provider.renderComparisonMap({ markers: MARKERS, radiusMeters: 1000, width: 800, height: 500 }),
    (error: unknown) => error instanceof ReportMapError && /429/.test((error as Error).message),
  );

  const throwingFetch = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const unreachable = new MapboxReportMapProvider({ accessToken: 'pk.test', fetchImpl: throwingFetch });
  await assert.rejects(
    () => unreachable.renderComparisonMap({ markers: MARKERS, radiusMeters: 1000, width: 800, height: 500 }),
    (error: unknown) => error instanceof ReportMapError,
  );

  // A 200 that is not an image is refused rather than embedded.
  const htmlFetch = (async () =>
    new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const wrongType = new MapboxReportMapProvider({ accessToken: 'pk.test', fetchImpl: htmlFetch });
  await assert.rejects(
    () => wrongType.renderComparisonMap({ markers: MARKERS, radiusMeters: 1000, width: 800, height: 500 }),
    (error: unknown) => error instanceof ReportMapError,
  );
});

test('a real report request contains only labels, coordinates, radius and size', async () => {
  const provider = new FakeReportMapProvider();
  const snapshot = buildReportSnapshot(snapshotInput(buildPiiPayload()));
  const viewModel = buildReportViewModel(snapshot, { mapAvailable: true });

  await provider.renderComparisonMap({
    markers: snapshot.candidates.map((candidate) => ({
      label: candidate.label,
      longitude: candidate.longitude,
      latitude: candidate.latitude,
    })),
    radiusMeters: snapshot.analysis.radiusMeters,
    width: 1200,
    height: 700,
  });

  const sent = JSON.stringify(provider.calls);
  for (const marker of Object.values(PII_MARKERS)) {
    assert.ok(!sent.includes(marker), `the map request leaked ${marker}`);
  }
  for (const key of ['customer', 'phone', 'address', 'raw_data', 'metadata']) {
    assert.ok(!sent.toLowerCase().includes(key), `the map request carried a "${key}" field`);
  }
  // What it does carry is exactly the display contract.
  assert.ok(sent.includes('"label":"A"'));
  assert.ok(sent.includes('"longitude"'));
  assert.ok(sent.includes(String(snapshot.analysis.radiusMeters)));

  // The snapshot the map is drawn from is the comparison, and the summary
  // remains true for the same snapshot.
  assert.equal(snapshot.report.type, 'comparison');
  assert.equal(viewModel.candidates.length, snapshot.candidates.length);
  assert.deepEqual(viewModel.summary.paragraphs, buildExecutiveSummary(snapshot).paragraphs);
  assert.equal(buildSingleSnapshot().report.type, 'single_location');
  assert.equal(loadStoredPayload('stored-comparison').results.length, 3);
});

test('the provider contract is the two documented methods', () => {
  const provider: ReportMapProvider = new FakeReportMapProvider();
  assert.equal(typeof provider.renderSingleLocationMap, 'function');
  assert.equal(typeof provider.renderComparisonMap, 'function');
  assert.equal(provider.available, true);
});
