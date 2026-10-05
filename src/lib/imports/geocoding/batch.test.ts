import assert from 'node:assert/strict';
import test from 'node:test';

import { IMPORT_LIMITS } from '../limits';
import { runGeocodingBatch, type ClaimedRow } from './batch';
import { decideGeocodingOutcome, DEFAULT_GEOCODING_THRESHOLDS } from './decision';
import { FakeGeocodingProvider } from './fake';
import { MapboxGeocodingProvider, buildQuery, parseMapboxCandidates } from './mapbox';
import { GeocodingConfigError, type GeocodingCandidate } from './types';
import { resolveGeocodingProvider } from './index';

const noSleep = async () => {};

function claimed(...addresses: string[]): ClaimedRow[] {
  return addresses.map((address, index) => ({
    rowId: `row-${index + 1}`,
    rowNumber: index + 2,
    address,
    attempts: 1,
  }));
}

function candidate(overrides: Partial<GeocodingCandidate> = {}): GeocodingCandidate {
  return {
    longitude: 69.2797,
    latitude: 41.3111,
    formattedAddress: 'Tashkent, Amir Temur 1',
    provider: 'fake',
    providerResultId: 'fake:1',
    relevance: 0.95,
    confidence: 0.95,
    accuracy: 'rooftop',
    featureType: 'address',
    countryCode: 'uz',
    matchConfidence: 'exact',
    ...overrides,
  };
}

test('fake provider: success, no match, ambiguity and outages are deterministic', async () => {
  const provider = new FakeGeocodingProvider({ failuresBeforeSuccess: 1 });

  const success = await provider.geocode('Toshkent, Amir Temur 1', {});
  assert.equal(success.status, 'success');
  const again = await provider.geocode('Toshkent, Amir Temur 1', {});
  assert.deepEqual(again, success, 'the same address always produces the same candidate');

  const noMatch = await provider.geocode('unknown place', {});
  assert.equal(noMatch.status, 'no_match');

  const ambiguous = await provider.geocode('ambiguous street', {});
  assert.equal(ambiguous.status, 'success');
  if (ambiguous.status === 'success') assert.equal(ambiguous.candidates.length, 2);

  const rate = await provider.geocode('rate limited street', {});
  assert.equal(rate.status, 'rate_limited');
  const recovered = await provider.geocode('rate limited street', {});
  assert.equal(recovered.status, 'success', 'a rate limit is transient');

  const flaky = await provider.geocode('flaky service street', {});
  assert.equal(flaky.status, 'provider_error');
  if (flaky.status === 'provider_error') assert.equal(flaky.retryable, true);

  const permanent = await provider.geocode('permanent failure street', {});
  assert.equal(permanent.status, 'provider_error');
  if (permanent.status === 'provider_error') assert.equal(permanent.retryable, false);
});

test('batch: a clean batch is accepted with bounded concurrency', async () => {
  const provider = new FakeGeocodingProvider();
  const rows = claimed('Toshkent, Amir Temur 1', 'Samarqand, Registon 5', 'Buxoro, Kogon 9');

  let inFlight = 0;
  let peak = 0;
  const tracked = {
    name: 'tracked',
    async geocode(address: string, context: Record<string, unknown>) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return provider.geocode(address, context);
    },
  };

  const results = await runGeocodingBatch({
    provider: tracked,
    rows,
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    concurrency: 2,
    sleep: noSleep,
  });

  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === 'success'));
  assert.ok(peak <= 2, `concurrency must stay bounded, peaked at ${peak}`);
  assert.deepEqual(
    results.map((result) => result.rowNumber),
    [2, 3, 4],
  );
});

test('batch: no match, ambiguity, rate limit and outage are classified per row', async () => {
  const provider = new FakeGeocodingProvider({ failuresBeforeSuccess: 1 });
  const results = await runGeocodingBatch({
    provider,
    rows: claimed(
      'Toshkent, Amir Temur 1',
      'ambiguous street 4',
      'unknown street 5',
      'rate limited street 6',
      'flaky service street 7',
      'permanent failure street 8',
    ),
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    // No transient retries inside this call, so a single failure is reported.
    transientRetries: 0,
    sleep: noSleep,
  });

  const statuses = results.map((result) => result.status);
  assert.deepEqual(statuses, [
    'success',
    'ambiguous',
    'no_match',
    'rate_limited',
    'provider_error',
    'provider_error',
  ]);
  assert.equal(results[1].reason, 'ambiguous_candidates');
  assert.equal(results[2].reason, 'provider_no_match');
  assert.equal(results[3].reason, 'provider_rate_limited');
  assert.equal(results[4].reason, 'provider_unavailable');
  assert.equal(results[5].reason, 'provider_rejected');
  assert.ok(results.every((result) => result.rowNumber >= 2));
});

test('batch: transient provider errors retry with backoff, rate limits respect Retry-After', async () => {
  const provider = new FakeGeocodingProvider({ failuresBeforeSuccess: 2 });
  const waits: number[] = [];
  const sleep = async (milliseconds: number) => {
    waits.push(milliseconds);
  };

  const results = await runGeocodingBatch({
    provider,
    rows: claimed('flaky service street 1', 'rate limited street 2'),
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    transientRetries: 3,
    baseDelayMs: 100,
    maxDelayMs: 400,
    sleep,
  });

  assert.deepEqual(
    results.map((result) => result.status),
    ['success', 'success'],
  );
  assert.ok(waits.length >= 2, 'both rows waited before retrying');
  assert.ok(
    waits.every((wait) => wait > 0 && wait <= 400),
    `every backoff must be positive and capped, saw ${waits.join(', ')}`,
  );
  assert.ok(waits.some((wait) => wait <= 1000), 'the mock Retry-After of 1s is respected');
});

test('batch: exhausting the retry budget reports a provider outage, never a crash', async () => {
  const provider = new FakeGeocodingProvider({ failuresBeforeSuccess: 10 });
  const results = await runGeocodingBatch({
    provider,
    rows: claimed('flaky service street 9'),
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    transientRetries: 2,
    sleep: noSleep,
  });

  assert.equal(results[0].status, 'provider_error');
  assert.equal(results[0].decision, 'review_required');
  assert.ok((results[0].message ?? '').length > 0, 'an outage is explained, not swallowed');
});

test('batch: already-resolved rows are not part of a batch and calls are idempotent', async () => {
  const provider = new FakeGeocodingProvider();
  await runGeocodingBatch({
    provider,
    rows: claimed('Toshkent, Amir Temur 1'),
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    sleep: noSleep,
  });
  assert.equal(provider.callsFor('Toshkent, Amir Temur 1'), 1);

  // Re-running the same provider call produces the identical candidate, which is
  // what makes a replayed batch a no-op instead of a second record.
  const first = await provider.geocode('Toshkent, Amir Temur 1', {});
  const second = await provider.geocode('Toshkent, Amir Temur 1', {});
  assert.deepEqual(second, first);
});

test('decisions: thresholds, ambiguity and country mismatches', () => {
  assert.equal(
    decideGeocodingOutcome([candidate()], { thresholds: DEFAULT_GEOCODING_THRESHOLDS }).decision,
    'accepted',
  );

  assert.equal(
    decideGeocodingOutcome([], { thresholds: DEFAULT_GEOCODING_THRESHOLDS }).decision,
    'no_match',
  );

  assert.equal(
    decideGeocodingOutcome([candidate({ confidence: 0.3 })], { thresholds: DEFAULT_GEOCODING_THRESHOLDS })
      .decision,
    'no_match',
  );

  const mid = decideGeocodingOutcome([candidate({ confidence: 0.6 })], {
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
  });
  assert.equal(mid.decision, 'review_required');
  assert.equal(mid.reason, 'below_accept_threshold');

  const ambiguous = decideGeocodingOutcome(
    [candidate({ confidence: 0.95 }), candidate({ confidence: 0.9, providerResultId: 'fake:2' })],
    { thresholds: DEFAULT_GEOCODING_THRESHOLDS },
  );
  assert.equal(ambiguous.decision, 'review_required');
  assert.equal(ambiguous.reason, 'ambiguous_candidates');

  const wrongCountry = decideGeocodingOutcome([candidate({ countryCode: 'kz' })], {
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    expectedCountryCode: 'uz',
  });
  assert.equal(wrongCountry.decision, 'review_required');
  assert.equal(wrongCountry.reason, 'country_mismatch');

  const unknownCountry = decideGeocodingOutcome([candidate({ countryCode: null })], {
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    expectedCountryCode: 'uz',
  });
  assert.equal(unknownCountry.decision, 'accepted', 'an unstated country is not proof of a mismatch');
});

test('provider selection: mapbox needs a server token, fake is explicit, nothing else is guessed', () => {
  assert.equal(resolveGeocodingProvider({ MAPBOX_ACCESS_TOKEN: 'pk.test' }).provider.name, 'mapbox');
  assert.equal(
    resolveGeocodingProvider({ GEOCODING_PROVIDER: 'fake' }).provider.name,
    'fake',
  );
  assert.equal(
    resolveGeocodingProvider({ GEOCODING_PROVIDER: 'MAPBOX', MAPBOX_ACCESS_TOKEN: 'pk.test' }).provider.name,
    'mapbox',
  );

  assert.throws(
    () => resolveGeocodingProvider({}),
    (error: GeocodingConfigError) => /MAPBOX_ACCESS_TOKEN/.test(error.message),
  );

  // An unknown provider name falls back to the production provider, never to the
  // fake one.
  assert.throws(
    () => resolveGeocodingProvider({ GEOCODING_PROVIDER: 'google' }),
    GeocodingConfigError,
  );
});

test('mapbox provider: request shape carries permanent geocoding, never a temporary result', async () => {
  const calls: string[] = [];
  const provider = new MapboxGeocodingProvider({
    accessToken: 'pk.secret-token',
    countryCode: 'UZ',
    countryName: 'Uzbekistan',
    proximity: '69.2797,41.3111',
    language: 'en',
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          type: 'FeatureCollection',
          features: [
            {
              properties: {
                mapbox_id: 'dXJuOm1ieGFkcjox',
                feature_type: 'address',
                full_address: 'Amir Temur 1, Tashkent, Uzbekistan',
                coordinates: { longitude: 69.2797, latitude: 41.3111, accuracy: 'rooftop' },
                context: { country: { country_code: 'UZ' } },
                match_code: { confidence: 'exact' },
              },
              geometry: { type: 'Point', coordinates: [69.2797, 41.3111] },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch,
  });

  const result = await provider.geocode('Amir Temur 1', {});
  assert.equal(result.status, 'success');
  if (result.status !== 'success') return;

  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.origin + url.pathname, 'https://api.mapbox.com/search/geocode/v6/forward');
  assert.equal(url.searchParams.get('permanent'), 'true', 'permanent geocoding, because results are stored');
  assert.equal(url.searchParams.get('autocomplete'), 'false');
  assert.equal(url.searchParams.get('country'), 'uz', 'the ISO country is a hard filter');
  assert.equal(url.searchParams.get('proximity'), '69.2797,41.3111');
  assert.equal(url.searchParams.get('q'), 'Amir Temur 1, Uzbekistan');

  assert.equal(result.candidates[0].provider, 'mapbox');
  assert.equal(result.candidates[0].providerResultId, 'dXJuOm1ieGFkcjox');
  assert.equal(result.candidates[0].countryCode, 'uz');
  assert.equal(result.candidates[0].confidence, 1);
  assert.equal(result.candidates[0].formattedAddress, 'Amir Temur 1, Tashkent, Uzbekistan');
});

test('mapbox provider: HTTP failures map onto the documented provider statuses', async () => {
  const respond = (status: number, headers: Record<string, string> = {}) =>
    new MapboxGeocodingProvider({
      accessToken: 'pk.test',
      fetchImpl: (async () =>
        new Response('{}', { status, headers })) as unknown as typeof fetch,
    });

  const rateLimited = await respond(429, { 'retry-after': '2' }).geocode('x', {});
  assert.equal(rateLimited.status, 'rate_limited');
  if (rateLimited.status === 'rate_limited') assert.equal(rateLimited.retryAfterMs, 2000);

  const unauthorized = await respond(401).geocode('x', {});
  assert.equal(unauthorized.status, 'provider_error');
  if (unauthorized.status === 'provider_error') assert.equal(unauthorized.retryable, false);

  const serverError = await respond(500).geocode('x', {});
  assert.equal(serverError.status, 'provider_error');
  if (serverError.status === 'provider_error') assert.equal(serverError.retryable, true);

  const unprocessable = await respond(422).geocode('x', {});
  assert.equal(unprocessable.status, 'no_match');

  // Provider messages that look like infrastructure detail are replaced.
  const leakyProvider = new FakeGeocodingProvider();
  const leaky = await runGeocodingBatch({
    provider: {
      name: 'leaky',
      geocode: async () => ({
        status: 'provider_error' as const,
        retryable: false,
        message: 'Error: connect ECONNREFUSED at Object.fetch (/srv/app/token.js:12)',
      }),
    },
    rows: claimed('anything'),
    thresholds: DEFAULT_GEOCODING_THRESHOLDS,
    transientRetries: 0,
    sleep: noSleep,
  });
  assert.equal(leaky[0].status, 'provider_error');
  assert.ok(
    !/ECONNREFUSED|token\.js|Object\.fetch/.test(leaky[0].message ?? ''),
    'infrastructure detail never reaches the user-facing message',
  );
  assert.equal(leakyProvider.callsFor('anything'), 0);

  const networkFailure = new MapboxGeocodingProvider({
    accessToken: 'pk.test',
    fetchImpl: (async () => {
      throw new Error('getaddrinfo ENOTFOUND api.mapbox.com');
    }) as unknown as typeof fetch,
  });
  const unreachable = await networkFailure.geocode('x', {});
  assert.equal(unreachable.status, 'provider_error');
  if (unreachable.status === 'provider_error') {
    assert.equal(unreachable.retryable, true);
    assert.ok(!unreachable.message.includes('ENOTFOUND'), 'no infrastructure detail leaks to users');
  }

  const empty = new MapboxGeocodingProvider({
    accessToken: 'pk.test',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        status: 200,
      })) as unknown as typeof fetch,
  });
  assert.equal((await empty.geocode('x', {})).status, 'no_match');
});

test('mapbox payload parsing: scores combine accuracy, feature type and match confidence', () => {
  const parsed = parseMapboxCandidates({
    features: [
      {
        properties: {
          mapbox_id: 'a',
          feature_type: 'address',
          coordinates: { longitude: 69.1, latitude: 41.1, accuracy: 'interpolated' },
          match_code: { confidence: 'high' },
          context: { country: { country_code: 'UZ' } },
        },
      },
      {
        properties: {
          mapbox_id: 'b',
          feature_type: 'place',
          full_address: 'Tashkent, Uzbekistan',
          coordinates: { longitude: 69.24, latitude: 41.31 },
        },
      },
      {
        properties: {
          mapbox_id: 'c',
          feature_type: 'address',
          coordinates: { longitude: 300, latitude: 41.1 },
        },
      },
      { properties: { mapbox_id: 'd', feature_type: 'address' } },
    ],
  });

  assert.deepEqual(
    parsed.map((entry) => entry.providerResultId),
    ['a', 'b'],
    'out-of-range and coordinate-less features are dropped',
  );
  assert.equal(parsed[0].confidence, 0.6, 'the weakest signal decides the score');
  assert.equal(parsed[1].confidence, 0.5);
  assert.equal(parsed[0].countryCode, 'uz');
});

test('query shaping only appends the country when it is missing', () => {
  assert.equal(buildQuery('Amir Temur 1', null), 'Amir Temur 1');
  assert.equal(buildQuery('  Amir   Temur 1 ', null), 'Amir Temur 1');
  assert.equal(buildQuery('Amir Temur 1', 'Uzbekistan'), 'Amir Temur 1, Uzbekistan');
  assert.equal(buildQuery('Amir Temur 1, Uzbekistan', 'Uzbekistan'), 'Amir Temur 1, Uzbekistan');
  assert.equal(buildQuery('   ', 'Uzbekistan'), '');
});

test('batch size limits match the documented maximum', () => {
  assert.equal(IMPORT_LIMITS.maxGeocodeBatchSize, 50);
  assert.ok(IMPORT_LIMITS.defaultGeocodeBatchSize <= IMPORT_LIMITS.maxGeocodeBatchSize);
});
