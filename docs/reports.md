# Executive decision reports (Phase 7)

Phase 7 turns a **stored** analysis into a document an executive can read: a
single-location review or a comparison of two to five sites, with the map, the
ranking, the factor arithmetic, the methodology and the disclaimer that says what
the score is *not*.

Everything in a report is copied from an immutable snapshot taken when the report
was created. Nothing is recomputed, and no report ever claims to predict
anything.

---

## 1. Lifecycle

```text
stored analysis (Phase 6, immutable)
        │  create            (owner / admin / analyst)
        ▼
draft ──────────────► generating ──────────────► ready   storage_path + generated_at
  ▲                        │
  │                        └──────────────► failed      failure_code (safe, enumerable)
  └─────────────────────────── retry ──────► generating
```

- **Create** freezes the snapshot and stores its SHA-256 (`snapshot_hash`). The
  report is a `draft`: it has numbers and a title, but no artifact yet.
- **Generate** renders the PDF from the stored snapshot and uploads it to private
  storage. The report becomes `ready` with `generated_at` and `storage_path`.
- **Regenerate** re-renders *the same snapshot*: same scores, same ranks, same
  metrics, same model revision. A new model revision or new data never changes an
  old report; that requires a new analysis and therefore a new report.
- **Retry** is the same operation from `failed`.

Generation is **synchronous inside the request**. There is no queue, no
background worker, no "job engine" and no unawaited promise: the route awaits the
map image, the PDF bytes and the storage upload, then updates the row. A failure
leaves the snapshot untouched and marks the report `failed` with one of the
enumerable `failure_code` values (`map_provider_unavailable`, `pdf_render_failed`,
`storage_unavailable`), so the UI can always offer a meaningful retry.

`analysis_reports` rows are never deleted by the application: the reports are the
audit trail of what was shown, and there is no `DELETE` grant on the table.

---

## 2. Report types

| Type | Source analysis | Candidates |
| --- | --- | --- |
| `single_location` | `location_analyses.mode = 'analysis'` | exactly one |
| `comparison` | `location_analyses.mode = 'comparison'` | two to five |

The type is derived from the stored analysis, never chosen by the client, and it
is re-validated when the snapshot is parsed: a `single_location` snapshot with
three candidates (or a comparison with one) is refused before anything renders.
Candidates from unrelated analyses can therefore never be mixed into one report.

---

## 3. The snapshot

`analysis_reports.snapshot` (jsonb) is written once and protected by a trigger
that raises `42501` if anyone tries to change `snapshot`, `snapshot_hash`,
`analysis_id`, `report_type`, `created_by`, `created_at`, `workspace_id` or
`project_id`. It contains:

- `workspace` — id and name;
- `project` — id and name;
- `analysis` — id, mode, radius (meters), candidate count, model id/name/version,
  the analysis timestamp, the data-snapshot timestamp, the workspace's
  data-updated timestamp and the freshness flag;
- `model` — the **factor definitions as they were used**: key, label, metric,
  weight, direction, normalization, enabled, sort order;
- `candidates[]` — id, presentation label (A–E in stored rank order), name,
  coordinate, rank, final score, the aggregate raw metrics, the normalized
  metrics and every stored contribution (`raw_text`, normalized, weight,
  contribution, direction, normalization);
- `branding` — company display name and an optional logo reference;
- `map` — whether a map is included, the provider name and the **attribution
  text**;
- `methodology` — the deterministic score explanation and the disclaimer, frozen
  at creation time so an old report keeps the wording it was generated with;
- `report` — type, title, subtitle and the creation timestamp;
- `version` — the snapshot schema revision (`REPORT_SNAPSHOT_VERSION = 1`).

### Projection, not drizzle

Raw metrics are copied through an explicit allow-list
(`toReportMetrics`): radius, area, customers count, **exact** customer revenue
(`numeric` → decimal *string*), competitors, branches, commercial locations,
derived densities, nearest-branch label/distance, branch-distance score, POI
density and the category distribution. A new column in the source table cannot
leak into a report accidentally, and no customer-level field has anywhere to
land.

### Money

Revenue is stored and printed as the exact decimal string the database produced
(`"2908.59"`). It is never parsed into a binary float; the UI's thousands
separator is applied at display time only.

---

## 4. Snapshot hash and integrity

`snapshot_hash` is `SHA-256(canonical JSON of the snapshot)`, lowercase hex.

- **Canonicalization** sorts object keys recursively (arrays keep their order)
  and serializes with `JSON.stringify`, so the same snapshot always produces the
  same digest regardless of key insertion order.
- Before every generation the server recomputes the hash and compares it to the
  stored one. A mismatch marks the report `failed` (`report_integrity_failed`)
  and refuses to render: the report would otherwise print numbers nobody can
  vouch for.
- The hash is printed on the cover and in the methodology section, so a reader
  (or an auditor with database access) can verify which snapshot produced the
  PDF.

The hash is an **integrity check, not a signature**. It detects mutation; it does
not prove authorship, and it is not a digital certificate. Phase 7 deliberately
has no signing infrastructure.

---

## 5. Executive summary, strengths and considerations

All of it is **deterministic text assembly** from the stored contributions:
no LLM, no generated narrative, no subjective consulting language.

Comparison example (numbers are the stored numbers):

> **Yunusabad junction (saved candidate) (A) ranked first with a score of 34.65 / 100.**
> 3 candidate locations were compared using Retail Expansion Model v1 within a
> 1 km radius. Yunusabad junction (A) ranked first with a score of 34.65 / 100
> (Weak). Its strongest weighted contributions were Competition and Branch
> Coverage. Its weakest enabled contributions were Revenue Potential and
> Commercial Activity.

Single location:

> **Yunusabad junction scored 64.20 / 100.** … was scored with Retail Expansion
> Model v1 within a 1 km radius, using the stored analysis of this workspace
> data. It scored 64.20 / 100 (Good).

Rules:

- **Strengths** are the enabled factors with the highest stored contribution
  (top 1–2), written as "*label* contributed *x.xx* points."
- **Considerations** are the enabled factors with the lowest stored contribution
  (bottom 1–2), written as "*label* contributed the least of the enabled
  factors (*x.xx* points)."
- A **disabled** factor is never presented as either.
- Ties break on the stored factor order and label, so the same snapshot always
  produces the same text.
- The wording never claims causality ("because"), never advises, and never turns
  the score into a probability.

---

## 6. The view model: one formatting path

```text
ReportSnapshot ─► buildReportViewModel() ─┬─► ReportPreview (HTML, React)
                                          └─► ReportDocument (@react-pdf/renderer)
```

`ReportViewModel` is the single place where stored numbers become text:
`82.40 / 100` (always two decimals), `1 km`, `2 908.59`, `41.31110, 69.27970`,
`2026-10-05 06:02 UTC`. The preview and the PDF render **this** object; neither
re-derives a business number, and neither reads the database. If a value is wrong
it is wrong in both, on purpose — there is no second computation to disagree
with.

The client receives the view model through a strict shipped parser
(`src/lib/reports/parser.ts`) that refuses a payload with a missing score, a bad
status, an unknown snapshot version or an impossible candidate count, and
tolerates additive fields so an installed client keeps working.

---

## 7. What a report contains

A4 portrait, no page padding tricks, standard PDF fonts:

1. **Cover** — report type, project, workspace/company, analysis date, generation
   date, model and revision, radius, snapshot hash, disclaimer.
2. **Executive summary** — the headline, the stored top candidate and score, the
   number of sites, the key contributions, the freshness block.
3. **Map and ranking** — the static map (when configured) with its attribution,
   and the A–E ranking table; a single-location report lists the measured
   aggregate metrics inside the radius here.
4. **Comparison** — rank, site, score, customers, revenue, competitors, nearest
   branch, POIs and customer density, all copied from the stored analysis.
5. **Candidate detail** — one page per candidate: score, rank, coordinates,
   radius, model, the factor breakdown (factor, raw metric, normalized, weight,
   contribution), strengths, considerations and the measured metric grid.
6. **Methodology** — model and revision, radius, timestamps, snapshot hash, the
   configured factor weights with direction and normalization, the score
   explanation, the freshness statement, the map attribution and the disclaimer.

Score presentation is always `82.40 / 100` with an optional qualitative band
(Strong / Good / Moderate / Weak). Never `82%`, never "82% chance of success",
never "AI recommends".

---

## 8. Maps

```ts
interface ReportMapProvider {
  renderSingleLocationMap(request): Promise<ReportMapResult>;
  renderComparisonMap(request): Promise<ReportMapResult>;
}
```

A provider returns `{ bytes, mimeType, provider, attribution, width, height }`.
Two implementations ship:

| Provider | When | Notes |
| --- | --- | --- |
| `MapboxReportMapProvider` | `MAPBOX_ACCESS_TOKEN` is set | Mapbox Static Images API, server-side only, `pin-s-{label}` markers plus a GeoJSON radius circle for a single site, `auto{width}x{height}@2x` viewport |
| `FakeReportMapProvider` | `REPORT_MAP_PROVIDER=fake` | deterministic 640×360 PNG fixture committed to the repository; no network, no token, no credits |

Selection order: `REPORT_MAP_PROVIDER=fake` wins over a token (so CI can never
spend credits), then a configured token, otherwise **no provider** — and a report
without a map is still a complete report: it states explicitly that no static map
was included rather than showing a blank rectangle.

Rules that hold for every provider:

- **No customer points.** A provider receives markers (a label and a coordinate)
  and the radius, nothing else. The PII boundary therefore holds across the
  network boundary too, and a unit test asserts the exact request object.
- **Attribution is always preserved** — Mapbox's own rendered attribution/logotype
  stays enabled in the request (`logo=true`, `attribution=true`) *and* the
  attribution text is printed in the report and stored in the snapshot, so the
  requirement survives any style or print path.
- **The token never leaves the server.** It is read from `MAPBOX_ACCESS_TOKEN`
  (never `NEXT_PUBLIC_*`), used inside a Server Route, and never stored in a
  snapshot, a response or an artifact.
- **A failure is loud.** A provider error marks the report `failed` with
  `map_provider_unavailable`, keeps the snapshot intact and offers a retry. The
  report is never generated with a misleading blank or placeholder map.

`REPORT_MAP_STYLE` overrides the style (default `mapbox/light-v11`);
`MAPBOX_STATIC_BASE_URL` exists for a manual live probe.

---

## 9. Private storage

- Bucket: **`analysis-reports`**, private, 10 MB per object, PDF/PNG/JPEG.
- Paths: `{workspace_id}/{project_id}/{report_id}/report.pdf`, plus `map.png`
  and `logo.png|jpg` in the same prefix. The database enforces that a stored path
  literally starts with the row's own workspace/project/report prefix, so a
  storage-path swap is a constraint violation, not a working exploit.
- Access is membership-scoped: `storage.objects` policies call
  `public.report_object_workspace_id(object_name)` and compare it with the
  caller's own workspace memberships and role. A path is never authorization by
  itself, and there is no `anon` policy and no `DELETE` policy.
- The application never returns a signed public URL and never exposes a storage
  path to a client. Downloads go through
  `GET /api/workspaces/{workspaceId}/reports/{reportId}/download`, which checks
  the session, the workspace membership and the row's visibility before reading
  the object **under the caller's own session**.

---

## 10. Permissions

| Action | viewer | analyst | admin | owner |
| --- | --- | --- | --- | --- |
| List report history | ✅ | ✅ | ✅ | ✅ |
| Preview (view model + artifacts) | ✅ | ✅ | ✅ | ✅ |
| Download a ready PDF | ✅ | ✅ | ✅ | ✅ |
| Create a report from a stored analysis | ❌ | ✅ | ✅ | ✅ |
| Generate / regenerate / retry the PDF | ❌ | ✅ | ✅ | ✅ |
| Rename, set the company name, upload a logo | ❌ | ❌ | ✅ | ✅ |
| Delete a report | ❌ | ❌ | ❌ | ❌ (audit trail) |

Enforced twice: the route guard resolves the caller's role from the database
before doing anything, and the RLS policies plus the explicit grants enforce the
same matrix independently. No `service_role` is used anywhere in the tenant
report path (the phase grants it nothing and no report code path calls it),
and there is no `anon` privilege on the table or the bucket.

The interface only avoids offering an impossible action; it is never the
authority.

---

## 11. API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workspaces/{workspaceId}/reports?projectId=…&status=…&limit=…` | Project-scoped history plus the caller's selectable projects |
| `POST` | `/api/workspaces/{workspaceId}/reports` | Create from `{ projectId, analysisId, title?, subtitle?, companyName?, includeMap? }` |
| `GET` | `/api/workspaces/{workspaceId}/reports/{reportId}` | The report summary and its view model |
| `PATCH` | `/api/workspaces/{workspaceId}/reports/{reportId}` | Presentation fields only (`title`, `subtitle`, `companyName`) |
| `POST` | `/api/workspaces/{workspaceId}/reports/{reportId}/generate` | Render/upload the PDF from the stored snapshot |
| `GET` | `/api/workspaces/{workspaceId}/reports/{reportId}/download` | Authorized PDF download |
| `GET` | `/api/workspaces/{workspaceId}/reports/{reportId}/map` | Stored map image for the HTML preview |
| `GET/PUT/DELETE` | `/api/workspaces/{workspaceId}/reports/{reportId}/logo` | Logo artifact (owner/admin) |

Error codes are a closed set — `invalid_request`, `project_required`,
`no_project`, `access_denied`, `report_not_found`, `report_not_ready`,
`report_generation_failed`, `report_integrity_failed`, `storage_unavailable`,
`session_expired`, `database_unavailable`, `internal_error` — and every message
comes from `src/lib/reports/messages.ts`. No SQL, policy name, storage path,
bucket name, token or stack trace ever reaches a client. Metadata and preview
responses are `Cache-Control: no-store`, downloads are `no-store` attachments.

### Project context (Phase 6.5 rules, unchanged)

A report always belongs to exactly one project. There is no "all projects" view,
no implicit oldest/first project, and `projectId` is verified against the
caller's own workspace projects on every call. An unnamed project in a
multi-project workspace is a safe `400 project_required`; a project the caller
cannot use fails exactly like one that does not exist (no resource-existence
oracle); an analysis of another project is refused instead of being re-pointed.
Reports never mix two projects' candidates.

---

## 12. PII protection

The report path may show: counts, aggregate revenue, category distribution,
densities and aggregate spatial metrics. It may never show an individual
customer's name, phone, address, individual revenue, metadata or raw import row.

That is enforced in four places:

1. **Projection at snapshot time** — the explicit metric allow-list; a report has
   no field an individual customer value could occupy.
2. **No customer objects in map requests** — providers receive labels and
   coordinates only.
3. **Tests** — a fixture payload deliberately carries recognisable markers
   (`Zulfiya-PII-MARKER-Karimova`, `+998-PII-MARKER-900000`, …) and both the unit
   suite and the contract smoke assert that no marker appears in the snapshot, the
   view model, the preview JSON, the PDF text or a provider request. The smoke
   also checks the seeded workspace markers (`synthetic-customer-`, customer
   UUIDs, contact-field names).
4. **The map artifact** contains no customer points at all.

---

## 13. Regeneration and freshness

`may_be_outdated` and the data-snapshot timestamps are copied into the snapshot
and printed. They are *information*: a report is never rewritten, and
"regenerate" never picks up newer data or a newer model revision. The correct
workflow for fresh numbers is:

```text
new data or new model revision ─► run a new analysis ─► create a new report
```

The UI says so explicitly, in the reports section and in the analysis detail
where a report is created.

---

## 14. Limitations (known, deliberate)

- PDF bytes are not byte-identical between two renders of the same snapshot: the
  PDF writer stamps a creation timestamp. The **content** is identical (the smoke
  asserts identical extracted text, identical pagination and identical size), and
  the **snapshot** is provably identical through its hash. Report determinism is
  therefore a content guarantee plus a snapshot-hash guarantee, not a byte-level
  repaintability guarantee.
- There is no digital signature, no public share link, no scheduled or emailed
  report, no template/builder, no vector tiles, and no AI-written narrative — by
  design and by scope.
- The static map is an image. It is not interactive, it cannot be zoomed inside
  the PDF, and its circle is a visualization: PostGIS remains the authority on
  what is inside the radius.
- A report covers one stored analysis. There is no cross-analysis or
  portfolio-level report.
- Generation is synchronous: a very large comparison report occupies the request
  until the PDF is stored (seconds). There is no queue to hide that cost, and
  none is pretended.

---

## 15. Verification

| Layer | Where | What it proves |
| --- | --- | --- |
| SQL/RLS matrix | `supabase/tests/phase7_reports_rls.sql` | permissions per role, cross-workspace/project isolation, re-parenting, storage-path tampering, anonymous access, lifecycle transitions, snapshot immutability |
| Unit | `src/lib/reports/reports.test.ts` | snapshot content, canonicalization/hash, mutation detection, deterministic summary, view-model formatting, parser strictness, validation, PII projection, claim-free wording |
| Unit | `src/lib/reports/map/map.test.ts` | provider selection, deterministic fixture, Mapbox request construction, radius circle, failure paths, no-PII request |
| Unit | `src/lib/reports/pdf/pdf.test.ts` | logo/image rules (PNG/JPEG only, 2 MB, byte sniffing) |
| End-to-end | `npm run smoke:reports` | the shipped routes and client: create, generate, download, PDF validity and content, regeneration stability, branding, project context, role refusals, foreign workspace/outsider/anonymous refusals, tampered ids, PII and claim regressions |

`npm run verify` (database gate + unit tests + lint + typecheck + build +
fixtures smoke) is the local equivalent of CI; the report smoke additionally
requires the local Supabase stack.
