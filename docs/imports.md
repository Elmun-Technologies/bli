# Imports — CSV/XLSX upload, validation, geocoding and commit (Phase 5)

## Status

- **IMPLEMENTED (Phase 5):** private per-import upload, CSV and XLSX inspection, multilingual column mapping with editable suggestions, deterministic per-row validation, staging in `import_jobs`/`import_rows`, provider-abstracted geocoding (Mapbox Geocoding v6 as the only production provider, permanent results only), UI-driven resumable geocoding batches, manual point placement, transactional commit into `customers`/`locations` with provenance, and a formula-safe error export.
- **VERIFIED:** unit and parser suites, the deterministic fake-geocoder suite, the Phase 2/5 SQL assertion suites on a clean database, and the end-to-end import smoke in CI (upload → mapping → validation → geocode → commit → map visibility, including adversarial workspace tampering).
- **NOT IMPLEMENTED (deliberately):** background workers/queues, scheduled geocoding, Google Sheets/Drive imports, CRM synchronisation, dataset deletion, retention automation, per-row editing of staged values, and imports into tables other than `customers`/`locations`.

## Formats and limits

| Limit | Value | Behaviour when exceeded |
| --- | --- | --- |
| File size | 5 MB (`IMPORT_LIMITS.maxFileBytes`) | Rejected with `file_too_large`; nothing is stored |
| Rows (selected sheet/CSV) | 10 000 | Rejected with `too_many_rows`; **the whole import is refused, never partially imported** |
| Columns | 100 | Rejected with `too_many_columns` |
| Cell length | 4 000 characters | Value rejected during validation |
| File types | `.csv`, `.xlsx` | `.xls` (legacy), `.txt`, `.ods`, `.xlsm` … are refused |
| Sheets | first *selected* sheet only | A workbook with several usable sheets requires an explicit choice |
| Geocoding batch | 50 rows (default 25) | API refuses > 50 with `22023` → `invalid_request` |

The file type is decided by **content**, and the extension must agree:

- PK ZIP signature → XLSX; OLE2 signature (`d0cf11e0`) → legacy `.xls` → `unsupported_type`;
- a NUL byte in the first 2 048 bytes → binary → `unreadable_file` for a `.csv`;
- ZIP content named `.csv`, or CSV text named `.xlsx` → `file_type_mismatch`;
- more than 1 % U+FFFD replacement characters → `unreadable_file`.

The uploaded MIME type is never trusted for anything.

## Lifecycle

```text
POST /imports                     create the job (uploaded)
POST /imports/{id}/file           store the file privately, detect headers/sheets
POST /imports/{id}/mapping        map columns → validate every row → stage
POST /imports/{id}/geocode-batch  bounded, resumable, UI-driven batches
POST /imports/{id}/rows/{rowId}/point   manual placement (authoritative)
POST /imports/{id}/commit         promote validated rows into a dataset
GET  /imports/{id}                job + counters
GET  /imports/{id}/rows           paginated preview, filterable by outcome
GET  /imports/{id}/errors.csv     failed/review rows as a safe CSV
GET  /datasets                    destinations the commit may use
```

Job status: `uploaded → mapping_required → ready | review_required → completed`, with `failed` reserved for an unrecoverable error. The status is derived from the staged rows (`refresh_import_job_counters`), so it can never disagree with the data.

Nothing is written to `customers`/`locations` until the commit: the staging tables are the only place a row lives before that, and a commit that fails leaves the import exactly as it was.

## Parsing

- **CSV:** UTF-8 (a BOM is stripped), `\r\n`/`\r`/`\n` line endings, delimiter auto-detected from `, ; \t |`, quoted values (including embedded newlines and commas) honoured, blank rows ignored, ragged rows padded and reported as warnings, duplicate or empty headers refused with a clear message. `info.lines` gives the file line number, so `source_row_number` is the number a human sees in a spreadsheet — even with quoted newlines.
- **XLSX:** `read-excel-file` (no formula evaluation, no macros, no external links). Cell values are converted exactly as Excel holds them: dates become ISO calendar dates, numbers keep their textual value, cached formula results are read as values and never recalculated. Sheet names are listed, sizes reported, and a sheet with a header plus at least one data row counts as usable.
- All parsed rows are stored as text; the *raw* values are kept in `import_rows.raw_data` and the normalized/coerced values in `normalized_data`.

Warnings are deduplicated (digits masked) and capped so a pathological file cannot produce thousands of notices.

## Mapping

Suggestions cover Uzbek Latin, Russian/Cyrillic and English headings, e.g.

| Canonical field | Examples |
| --- | --- |
| `name` | name, ism, mijoz, mijoz nomi, клиент, имя, фио, наименование |
| `phone` | phone, telefon, tel, aloqa, телефон, мобильный |
| `address` | address, manzil, адрес, yuridik manzil |
| `latitude` / `longitude` | latitude, lat, широта, kenglik / longitude, lng, lon, долгота, uzunlik |
| `revenue` | revenue, sales, savdo, tushum, summa, выручка, продажи |
| `order_count` | orders, buyurtma, buyurtma soni, заказы |
| `last_order_date` | sana, date, дата, oxirgi sana |
| `segment` | segment, toifa, сегмент |
| `external_id` | id, code, kod, код, mijoz id |
| `category` / `subcategory` (locations) | category, kategoriya, категория / subcategory, подкатегория |

Only **exact** alias matches are preselected; partial matches are offered as a hint. Every column can be remapped by the user, and a column that names a real field already claimed by an earlier column is deliberately left unmapped rather than guessed. The mapping is stored on the job and can be applied repeatedly: re-validating upserts staged rows per row number (the tables grant no `DELETE`), so the same import never duplicates rows.

## Validation and per-row outcome

Each staged row ends in exactly one state, with a machine-readable code, the field, the source row number and a safe message:

| Status | Meaning |
| --- | --- |
| `valid` | Complete, with coordinates (supplied or geocoded) |
| `needs_geocoding` | Everything needed is present except a coordinate; an address can supply it |
| `invalid` | At least one blocking error; the row stays staged and appears in the export |

Normalization rules (all values are trimmed; internal whitespace collapsed; empty → `null`):

- **Text/phone:** stored as text, never coerced to a number, so `+998…` and leading zeros survive. Phone is never displayed on the map.
- **Money (`revenue`):** decimal-safe. Thousands separators, a comma decimal separator, a leading `+`/`-`, accounting negatives `(1 234,50)` and a currency suffix are understood; the canonical form is `-?\d+\.\d{2}` and the value is stored in the database as `numeric(18,2)` — never a binary float, never compared with `==` on floats.
- **Integers (`order_count`):** whole numbers only (`3.0` is `3`, `-3` is rejected).
- **Dates:** ISO `YYYY-MM-DD` and `d/m/yyyy` when the day unambiguously exceeds 12; ambiguous dates are refused instead of guessed.
- **Coordinates:** finite numbers within −180…180 (longitude) and −90…90 (latitude). `NaN`/`Infinity` and out-of-range values are errors. If a pair only fits when read the other way round, the row is flagged `coordinate_swap_suspected` and the mapping is questioned — **values are never swapped automatically**.
- **Duplicates:** within one import the first row with a given `external_id` wins and later rows are marked invalid (`duplicate_external_id`). On commit, a staged row whose `external_id` already exists in the destination dataset is marked invalid with the same code and stays reviewable/exportable — never silently dropped, never merged.
- **Missing spatial input:** a row with neither coordinates nor an address is `invalid` (`missing_spatial_input`).

Nothing is ever silently discarded: every uploaded data row exists as a staged row, and every non-promoted row is reachable through the preview and the CSV export.

## Preview

`GET /imports/{id}/rows` returns the requesting member's rows with pagination (`pageSize` default 25, max 100) and an outcome filter (`all`, `valid`, `invalid`, `needs_geocoding`, `committed`). Only **canonical** fields are projected (`previewFieldsFor(target)`), not arbitrary spreadsheet columns, and never internals such as `storage_path` or `created_by`. The total count is returned so the UI can show "1 of 9 842" instead of hiding truncation.

## Geocoding

Provider abstraction: `GeocodingProvider.geocode(address, context)` returns `success` (candidates), `no_match`, `rate_limited` (with `Retry-After` when the provider gives one) or `provider_error` (`retryable` flag). The only production provider is **Mapbox Geocoding v6** with `permanent=true` (see [geocoding.md](geocoding.md)); a deterministic fake provider is used by tests and CI, and `GEOCODING_PROVIDER` selects between them.

Row geocoding status: `pending → geocoding → success | ambiguous | no_match | provider_error | rate_limited`, plus `manual_override`. Outages are never permanent failures: `provider_error` and `rate_limited` rows are retried by later batches, with `retry_count`/`geocoding_attempts` capped by `IMPORT_LIMITS.maxGeocodeAttempts` (5).

Confidence policy (environment-configurable, conservative defaults):

- `≥ 0.85` and clearly better than the runner-up → **accepted** (coordinates stored);
- `≥ 0.45` but below the accept threshold → **review required**;
- two candidates within `0.1` of each other → **review required** (`ambiguous_candidates`) no matter how high the top score is;
- a candidate whose country contradicts the configured country → **review required**;
- below `0.45` or nothing returned → `no_match`.

Review rows expose up to three candidates; the user accepts one or places the point manually. Manual placement sets `manual_override = true`, is authoritative, is validated again on the server (finite, in range), and **never rewrites the original address**.

### Batches, resume and idempotency

- The browser drives batches (`POST …/geocode-batch`), so no background worker is required and closing the tab pauses the work rather than losing it.
- The database claims work atomically (`claim_import_geocoding_rows`, ≤ 50 rows, lease `geocoding_claimed_at`), so concurrent batches never process the same row twice.
- A batch claims only rows in `pending`, `rate_limited` or `provider_error` that have attempts left; completed rows are never re-claimed.
- A stopped request leaves a lease that expires after 10 minutes and the rows return to `pending` — resumable, not stuck.
- Inside a batch: bounded concurrency (4), exponential backoff with a cap and full jitter for transient failures, `Retry-After` honoured on 429.
- Replaying a batch is a no-op (`applied: 0`, `skipped: 0`), because `apply_import_geocoding_results` ignores rows that are no longer claimed by the caller.

## Commit

`POST /imports/{id}/commit` promotes every `valid` staged row into a **new** dataset (owner/admin) or a dataset of the same workspace that was explicitly selected. It runs in one transaction inside `public.commit_import_job`:

- the job row is locked, which serialises concurrent commits;
- the destination is resolved first: an existing dataset of *this* workspace, or a new one; a dataset of another workspace raises `42501`/`23503` and is refused by RLS/constraints independently;
- duplicate `external_id` rows become `invalid` with `duplicate_external_id` and stay staged;
- inserted records carry provenance: `import_job_id`, `source_row_number`, and the dataset;
- the summary reports exact counts (`inserted_rows`, `conflicting_rows`, `previously_committed_rows`, `job_status`) and whether a dataset was created;
- repeating the same commit is idempotent (`inserted_rows: 0`), while re-pointing a committed import at a *different* dataset is refused (`22023` → `already_committed`, `invalid_request` on the wire) so no unexplained empty dataset can appear;
- invalid and review rows stay staged and are still exportable after the commit;
- completion fields (`status = 'completed'`, `committed_at`) can only be written by the commit function; a direct `UPDATE` from a client is rejected by a trigger.

## Error export

`GET /imports/{id}/errors.csv` returns `row_number,error_code,error_field,error_message` plus the canonical fields of the failed/review rows — no stack traces, no SQL, no internal identifiers, and never the storage path. Every exported cell that starts with `=`, `+`, `-`, `@`, TAB or CR is prefixed with an apostrophe (so `+998…` exports as `'+998…`), which makes opening the file in Excel/LibreOffice safe. The download filename is derived from the original name after stripping any path segments.

## Storage security

Source files live in the **private** `workspace-imports` bucket at `{workspace_id}/{import_id}/source.{ext}`. The path is a convention, never the authorization: every policy re-derives the workspace from the first path segment (`import_object_workspace_id`, which returns `NULL` for a malformed name instead of raising) and then asks `has_workspace_role(...)`. Owner/admin/analyst may read, upload, overwrite and delete through the Storage API (a direct SQL `DELETE` is refused by the platform — removal is an API operation authorized by the same policy); a viewer has no access to the file at all (they may still read import metadata so the import list is visible). `anon` has no policy and no privileges. The bucket itself enforces the 5 MB limit and an explicit MIME allow-list. Retention is manual in Phase 5: files live as long as the import job; there is deliberately no lifecycle automation yet.

## PII

An imported customer carries phone, address and revenue, so the Phase 4 map DTO rules apply unchanged: the map receives `id`/`kind`/`category` for customer features and never a phone number, a raw address, an individual revenue value or private metadata. Import previews and exports are membership-scoped API responses (never public, never cached: every response is `Cache-Control: no-store`), which is a different boundary from the map payload. The wizard's result and preview screens are the only place this data is shown, and only to a member.

## Error codes the client can see

`invalid_request`, `invalid_file`, `file_too_large`, `unsupported_type`, `sheet_required`, `invalid_mapping`, `invalid_destination`, `cross_workspace_dataset`, `not_found`, `session_expired`, `workspace_forbidden`, `geocoding_unavailable`, `storage_unavailable`, `database_unavailable`, `internal_error`.

Internal diagnostics (SQL, policy names, storage paths) only ever reach the server log, tagged `[imports:<scope>]`.

## Known limitations

- Rows are validated in memory per request; a 10 000-row import is bounded but a single request still parses the whole file (batched staging writes of 500 rows keep the database round trips bounded).
- The geocoding workflow is UI-driven: a job only progresses while someone keeps batches running. That is a deliberate Phase 5 choice (no worker, no scheduler), documented rather than hidden.
- `external_id` is the only duplicate key; fuzzy matching (similar names/addresses) is not attempted.
- An existing staged row cannot be deleted (no `DELETE` grant), so re-validating with a *different* file that yields fewer rows is refused (`staging_conflict`) instead of silently truncating: start a new import.
- Only the first selected sheet is imported and only `customers`/`locations` are supported targets; the architecture reuses the same staging pipeline for future targets.
- Coordinate-swap detection only catches pairs that are out of range in their mapped order (e.g. `longitude=41.3`); a pair where both values are valid in both ranges (Tashkent `41.3/69.3`) cannot be detected and is the user's responsibility.
