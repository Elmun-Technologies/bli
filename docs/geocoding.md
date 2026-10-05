# Geocoding — provider abstraction, Mapbox v6 and the confidence policy (Phase 5)

## Status

- **IMPLEMENTED:** a provider-agnostic `GeocodingProvider` interface, a Mapbox Geocoding v6 implementation that only ever requests **permanent** results, a deterministic fake provider for tests and CI, a documented confidence/ambiguity policy, retry/backoff/rate-limit handling, bounded resumable batches, and manual placement.
- **CI:** every geocoding test runs against the fake provider. CI needs no network access and no Mapbox token, and never spends geocoding credits.
- **NOT IMPLEMENTED:** reverse geocoding, autocomplete/suggest-as-you-type, batch geocoding via Mapbox's `/batch` endpoint, caching of provider responses across imports, and any second production provider (Google included — deliberately absent).

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `GEOCODING_PROVIDER` | no | `mapbox` (default) or `fake`. Anything else falls back to Mapbox, never to "off". |
| `MAPBOX_ACCESS_TOKEN` | yes, for Mapbox | **Server-only.** Never exposed, never logged, never a `NEXT_PUBLIC_*` value. |
| `GEOCODING_COUNTRY_CODE` | no | ISO 3166-1 alpha-2 hard country filter, e.g. `uz`. |
| `GEOCODING_COUNTRY_NAME` | no | Country name appended to a query that does not already mention it. |
| `GEOCODING_PROXIMITY` | no | `longitude,latitude` **bias** (never a restriction). |
| `GEOCODING_LANGUAGE` | no | IETF language tag for returned addresses. |
| `GEOCODING_ACCEPT_THRESHOLD` | no | Default `0.85`. |
| `GEOCODING_REVIEW_THRESHOLD` | no | Default `0.45`. |
| `GEOCODING_AMBIGUITY_DELTA` | no | Default `0.1`. |

Without `MAPBOX_ACCESS_TOKEN` the Mapbox provider refuses to construct and the API answers `503 geocoding_unavailable` with a safe message — an unconfigured deployment reports geocoding as unavailable instead of silently guessing or degrading to another service.

The Uzbekistan bias is configuration, not code: `GEOCODING_COUNTRY_CODE=uz` (plus a proximity hint) makes Tashkent results likely without hard-coding Tashkent anywhere, and the same deployment works globally.

## Provider interface

```ts
interface GeocodingProvider {
  readonly name: string;
  geocode(address: string, context: GeocodingContext): Promise<GeocodingProviderResult>;
}

type GeocodingProviderResult =
  | { status: 'success'; candidates: GeocodingCandidate[] }
  | { status: 'no_match' }
  | { status: 'rate_limited'; retryAfterMs: number | null }
  | { status: 'provider_error'; message: string; retryable: boolean };
```

A candidate carries longitude/latitude, a formatted address, the provider name and result id, the raw relevance, a normalized 0–1 confidence, the accuracy class, the feature type, the country code and the provider's own match-confidence label. Adding a provider means adding one file that satisfies the interface; nothing above the boundary (validation, staging, batching, the UI) changes.

Provider messages are untrusted input: whatever comes back is sanitized before it can reach a user-visible row, so a provider that echoes a request URL cannot leak the token.

## Mapbox Geocoding v6

`GET https://api.mapbox.com/search/geocode/v6/forward` with:

- `permanent=true` — **always**. Mapbox results are ephemeral unless they are permanent, and only permanent results may be stored. The import workflow stores geocoded coordinates and commits them to a dataset, so a temporary result would be a licence violation *and* a silent data-loss bug: nothing in this codebase may request a non-permanent result, and a test asserts the flag is present on every call.
- `autocomplete=false` — the workflow geocodes complete addresses, never partial user input.
- `limit=5` (allowed maximum 10), `language`, `country` (hard ISO alpha-2 filter), `proximity` (bias only), `types=address` when the query is an address.
- Structured input (`address_line1`/`place`/`region`/`postcode`/`country`) is used when the address can be split reliably; otherwise `q` carries the whole line.

Confidence is computed locally from what Mapbox reports: the minimum of the feature-type weight (address > place), the accuracy class (`rooftop`/`parcel` > `point`/`interpolated` > `approximate`/`intersection`) and the `match_code` confidence (`exact` > `high` > `medium` > `low`). A "successful" response with no usable point is treated as `no_match`.

Address normalization is conservative: trim and collapse whitespace, keep the original text untouched for the record, and only optionally append the configured country name when the query does not already contain it. Nothing is rewritten, transliterated or guessed. The original address is preserved on the staged row regardless of what the provider returns, and manual placement never alters it.

HTTP mapping: 429 → `rate_limited` (honouring `Retry-After`, seconds or HTTP-date), 5xx/network/timeout → retryable `provider_error`, 401/403 → non-retryable `provider_error` (a deployment problem, not a transient one), 2xx with an empty feature list → `no_match`.

## Confidence policy

| Situation | Decision |
| --- | --- |
| Confidence ≥ accept and clearly ahead of the runner-up | `accepted` — coordinates stored, row becomes `valid` |
| Confidence ≥ review but < accept | `review_required` (`below_accept_threshold`) |
| Two candidates within `ambiguity_delta` | `review_required` (`ambiguous_candidates`) even if both score high |
| Best candidate's country contradicts the configured country | `review_required` (`country_mismatch`) |
| Confidence < review, or no candidates | `no_match` |

Accepted rows are still reviewable before the commit: nothing reaches a production table until the user commits. Review rows expose up to three candidates; accepting one, or placing the point manually, resolves the row. Manual placement stores `manual_override = true`, is authoritative, is re-validated on the server (finite, in range), and leaves the address untouched.

## Batches, retries and rate limits

- The browser drives batches (`POST /imports/{id}/geocode-batch`, `limit` ≤ 50, default 25); there is no fake worker and no queue. Closing the tab pauses the import and continuing later resumes it.
- `claim_import_geocoding_rows` claims atomically with a lease (`geocoding_claimed_at`); a claim abandoned mid-request is requeued after the stale window (10 minutes).
- Only `pending`, `rate_limited` and `provider_error` rows with attempts left are claimed; `success`, `ambiguous`, `no_match` and `manual_override` rows stay resolved.
- `geocoding_attempts` is capped (`maxGeocodeAttempts = 5`): a permanently failing address stops being retried automatically and stays in the staging table for a human decision.
- Inside one batch: bounded concurrency (4), exponential backoff with full jitter (base 400 ms, cap 4 s) for transient errors, at most 2 transient retries per row, and `Retry-After` respected for 429s.
- Applying results is idempotent: `apply_import_geocoding_results` only writes rows that are still claimed by the caller, so a replayed batch is a no-op.

## Testing

- `src/lib/imports/geocoding/batch.test.ts` covers success, no match, ambiguity, rate limiting, transient provider errors, the retry budget, resume behaviour, idempotent replays, the manual-override path, the confidence thresholds, country mismatch, provider selection, and the request shape sent to Mapbox (including `permanent=true`).
- The fake provider is keyword-driven (`ok`, `ambiguous`, `none`, `rate`, `flaky`, `permanent`, `country:xx`) and derives coordinates deterministically from the address, so a test for "the provider is out" never becomes flaky.
- The end-to-end import smoke runs with `GEOCODING_PROVIDER=fake`: CI verifies the whole pipeline without a token, network access or credits.

## Manually probing the live provider (optional, never in CI)

The live provider is only exercised by hand, from a shell that has the token, e.g.:

```bash
MAPBOX_ACCESS_TOKEN=... GEOCODING_COUNTRY_CODE=uz \
  npx tsx -e "import { resolveGeocodingProvider } from './src/lib/imports/geocoding';
             const { provider, context } = resolveGeocodingProvider();
             console.log(await provider.geocode('Amir Temur 1, Tashkent', context));"
```

Rules for a live probe: run it from a local shell (never from a browser, never from CI), never paste the token or a raw response containing it into an issue, a log or a document, and remember every request is billed — one address is enough to confirm a deployment is configured correctly.
