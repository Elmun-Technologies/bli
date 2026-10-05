# Location scoring — Phase 6

The scoring engine answers one question with measurements, not with a model's opinion:
*for a saved candidate location and a chosen radius, which comparable business metrics does the
database measure, how are they normalized, and what weighted total do they produce?*

Nothing in this phase predicts. A score is a transparent weighted sum on a 0–100 scale, it is never
a probability, a confidence, a likelihood or an AI prediction, and the interface never presents it
as one. The qualitative bands (80–100 Strong, 60–79 Good, 40–59 Moderate, 0–39 Weak) are UI wording
for a numeric score; they are not stored and they carry no statistical meaning.

## 1. Data model

| Table | Purpose | Key columns |
| --- | --- | --- |
| `scoring_models` | A named, versioned scoring definition owned by one workspace | `id`, `workspace_id`, `name`, `description`, `status` (`draft`/`active`/`archived`), `version`, `UNIQUE (id, workspace_id)` |
| `scoring_model_factors` | One factor per row: what is measured, how much it counts and how it is normalized | `model_id`, `key`, `label`, `metric`, `weight numeric(5,2)`, `direction`, `normalization`, `configuration jsonb`, `enabled`, `sort_order` |
| `location_analyses` | One stored run: the snapshot and the context | `workspace_id`, `project_id`, `mode` (`analysis`/`comparison`), `radius_meters`, `candidate_count`, `scoring_model_id`, `model_version`, `model_snapshot jsonb`, `data_snapshot_at`, `created_at`, `UNIQUE (id, workspace_id)` |
| `location_analysis_results` | One row per candidate in a run: what was measured and how the score was built | `analysis_id`, `candidate_id`, `final_score`, `raw_metrics jsonb`, `normalized_metrics jsonb`, `factor_contributions jsonb`, `rank` |

Saved candidates are the pre-existing `analysis_locations` rows (Phase 2): a name, a
`geography(Point, 4326)` position and the project they belong to. Phase 6 adds no new candidate
table and no spatial column of its own.

There is no rules engine, no expression language and no scripting: a factor's `configuration` is a
small JSON object with a documented shape per method.

## 2. Factor model

A factor is `metric + weight + direction + normalization + configuration`.

* **metric** — one of the twelve measured metrics below. The list is a database `CHECK` constraint,
  mirrored in the editor; an unknown metric is rejected in both places.
* **weight** — a percentage with at most two decimals. The enabled factors of a model must total
  **exactly 100**, enforced by a deferred constraint trigger on the factor table (so one save is
  evaluated as a whole), rejected again by every RPC and shown live in the editor. A disabled factor
  keeps its definition and contributes nothing.
* **direction** — `positive` (more is better, the default), `negative` (more is worse) or `neutral`
  (no monotonic claim; only a threshold curve makes sense for it). Negative competition is factor
  configuration, never a global assumption: a different workspace can score the same metric
  differently.
* **normalization** — `threshold`, `min_max` or `inverse_min_max` (section 4).
* **configuration** — for `threshold`: `{"points": [{"value": …, "score": …}, …]}` (at least two
  strictly ascending stops with scores inside 0–100 that follow the direction);
  for every method: `missing_score` (default 0) and `degenerate_score` (default 50).

One generic configurable model ships with the seed (a generic retail-expansion model with five
enabled factors totalling 100). Nothing about it is hard-coded in the engine: a pharmacy, clinic,
restaurant or warehouse model is the same structure with different factors, and future phases can
add models without touching the scoring code.

## 3. Metrics

Measured inside the radius by PostGIS (`ST_DWithin` on the authoritative `geography` column):

| Metric | Meaning | Direction that is usually meaningful |
| --- | --- | --- |
| `customers_count` | Customer records inside the radius | positive |
| `customers_revenue_total` | Sum of their revenue, kept as exact `numeric` text | positive |
| `competitors_count` | Competitor records inside the radius | negative |
| `branches_count` | Own branches inside the radius | positive |
| `locations_count` | Saved commercial points of interest inside the radius | positive |
| `nearest_branch_distance_meters` | Distance to the closest own branch (measured workspace-wide) | negative |

Documented derived metrics (business-meaningful, no invented indices):

| Metric | Definition |
| --- | --- |
| `customers_per_sq_km` | `customers_count / area_sq_km`, 4 decimals |
| `competitors_per_sq_km` | `competitors_count / area_sq_km`, 4 decimals |
| `revenue_per_sq_km` | `customers_revenue_total / area_sq_km`, exact text, 2 decimals |
| `customer_to_competitor_ratio` | `customers_count / GREATEST(competitors_count, 1)`, 4 decimals |
| `branch_distance_score` | `100 × (1 − LEAST(distance, radius) / radius)`, 2 decimals; 0 when there is no branch or the nearest one is at or beyond the radius |
| `commercial_poi_density` | `locations_count / area_sq_km`, 4 decimals |

`area_sq_km = round(π (radius_m / 1000)², 4)`, so a 500 m radius is 0.7854 km².

## 4. Normalization methods

**`threshold`** — an authored curve you control. Stops are `value → score`, strictly ascending in
value; the score is linearly interpolated between the two surrounding stops, the first score applies
below the first stop and the last score applies above the last one. `threshold` does not depend on
which candidates are compared, so a threshold factor scores a single candidate on its own —
that is why the seeded model uses threshold curves throughout. A `threshold` factor must be
`positive` or `neutral`.

**`min_max`** — comparison-set method: the best value in the compared set scores 100 and the worst
scores 0, scaled linearly in between. A `min_max` factor must be `positive`.

**`inverse_min_max`** — the same comparison set, inverted: the worst (highest) value scores 100 and
the best (lowest) scores 0. It must be `negative`.

Both comparison-set methods are explicit, never implicit: which one a factor uses is part of the
model definition and is shown in the breakdown.

### Edge cases, documented

* **All equal** — a `min_max`/`inverse_min_max` set whose values are identical has no ordering
  information. The factor takes the documented `degenerate_score` (default 50) instead of dividing
  by zero. The engine never invents a spread.
* **Missing** — a metric that cannot be measured (no branch at all, an empty revenue sum) takes the
  documented `missing_score` (default 0) and the raw value stays explicitly `null` in the payload.
* **Zero data** — a candidate with no customers, no competitors and no POIs still produces a valid
  analysis. Every derived metric divides by the radius area (never by zero) or by
  `GREATEST(competitors_count, 1)`, and `branch_distance_score` is 0 without a branch. There is no
  `NaN` and no infinity anywhere in a payload.
* **Comparison-set dependency** — `min_max` and `inverse_min_max` are relative to the compared set,
  so adding or removing a candidate changes their normalized value. This is disclosed in the editor
  and in the factor explanation. A single candidate compared against itself is the all-equal case
  above, which is exactly why the interface encourages threshold curves for absolute statements.
* **Outlier vulnerability** — a set containing one extreme candidate compresses every other
  candidate towards the middle of the comparison range. Phase 6 documents this rather than hiding
  it: winsorization or robust scaling is deliberately **not** implemented (it would change what a
  score means without a business definition).

### Rounding and clamping

* Every normalized value is rounded to 2 decimals (`round`, half away from zero) before it is stored.
* Each contribution is `round(normalized × weight / 100, 2)`.
* The final score is the sum of the stored contributions, clamped to `[0, 100]` and stored with
  2 decimals; it is never re-derived on the client. Clamping is defensive: with normalized values in
  `[0, 100]` and weights summing to 100 the sum cannot leave the range, and the boundary is asserted
  in the SQL suite.
* Rounding is deterministic: the same inputs always produce the same stored score, and repeating an
  analysis stores an identical result under a new analysis id.

## 5. Worked example (the seeded model, real stored numbers)

Candidate "Yunusabad junction (saved candidate)", radius 500 m, `Retail Expansion Model` revision 1
(five enabled factors, weights 25 + 25 + 20 + 15 + 15 = 100, all `threshold`):

| Factor (metric) | Raw measured | Stops (value→score) | Normalized | Weight | Contribution |
| --- | --- | --- | --- | --- | --- |
| Customer Density (`customers_count`) | 2 | 0→0, 500→50, 1000→100 | 0.2 | 25% | 0.05 |
| Revenue Potential (`customers_revenue_total`) | 495.93 | 0→0, 250 000 000→50, 500 000 000→100 | 0 | 25% | 0.00 |
| Competition (`competitors_count`) | 0 | 0→100, 20→0 | 100 | 20% | 20.00 |
| Commercial Activity (`locations_count`) | 1 | 0→0, 50→50, 100→100 | 1 | 15% | 0.15 |
| Branch Coverage (`branch_distance_score`) | 0 (nearest branch 1 985.26 m, outside the 500 m radius) | 0→0, 100→100 | 0 | 15% | 0.00 |
| **Total** | | | | **100%** | **20.20** |

`20.20 / 100`, band *Weak*. The stored payload keeps the raw metrics, the normalized values, the
weights and each contribution, so this table can be reproduced from the analysis alone — no model
lookup is needed to explain an old score.

## 6. Versioning and snapshots

* `scoring_models.version` is a monotonic revision counter of the factor definition. It advances once
  per factor statement (a save that replaces the factor set advances it twice; a metadata-only save
  does not move it).
* A run copies `version`, the model header, the full factor list and the metrics into
  `location_analyses.model_snapshot` and `location_analysis_results`.
* Editing a model **never** recalculates a stored analysis. Reading an old analysis returns the
  score, weights and metrics it was run with, and the read RPC does not consult the current model at
  all.
* `workspace_data_updated_at` (the newest `updated_at` across the tenant tables a score reads) is
  stored with the run. When it is later than `data_snapshot_at`, the stored analysis reports
  `may_be_outdated: true` and the interface shows "Analysis may be outdated". This is a lightweight
  freshness signal, **not** dataset version control: the flag never rewrites the score, and there is
  no per-dataset snapshot or time travel.

## 7. Comparison flow

1. Select two to five saved candidates (hard cap 5; the sixth is refused by the API and by the RPC).
2. Choose one radius and one model. A comparison uses a **single shared radius** for every candidate,
   so the table always measures the same footprint and differing radii cannot occur; the shared
   radius is printed with the result.
3. `POST /api/workspaces/{workspaceId}/comparisons` runs and stores the comparison.
4. The map shows the candidates simultaneously, labelled A–E in stored rank order, and clicking a
   marker opens that candidate's breakdown.
5. The table lists overall score, customers, revenue, competitors, nearest branch, POI count and
   customer density, and sorts by overall score, customer potential, competition or revenue. Sorting
   never changes a number, only the order. Two columns are derived from the stored contributions and
   are labelled as such:
   * **competition score** — the stored normalized value of the model's negative factor whose metric
     contains `competitor` (usually `competitors_count`); it shows `—` when the model has no such
     factor, and it is never invented from some other metric.
   * **opportunity score** — the sum of the stored contributions of the `positive`-direction
     factors, i.e. the demand side of *this* model, not a separate index.
   Both are read straight from the stored payload; neither is recomputed or re-weighted in the
   browser.
6. Clicking a row (or a marker) opens the raw → normalized → weight → contribution table for that
   candidate, and the panel verifies that the stored contributions still add up to the stored score
   before showing them.
7. An optional CSV export copies the stored numbers for the comparison as displayed (no PDF, no
   charts, no template).

## 8. Permissions and RLS

| Action | viewer | analyst | admin | owner |
| --- | --- | --- | --- | --- |
| Read models, saved candidates, stored analyses | yes | yes | yes | yes |
| Run an analysis / comparison | no | yes | yes | yes |
| Save a candidate location | no | yes | yes | yes |
| Create or edit a scoring model | no | no | yes | yes |

RLS is enabled on all four Phase 6 tables with per-table policies: reads require membership of the
row's workspace; factor rows additionally require membership of the owning model's workspace; all
writes go through the RPCs (the tables grant no direct write path beyond what the policies require,
and `location_analyses`/`location_analysis_results` are read-only for clients because only the
scoring function writes them). `anon` has no privileges at all. Cross-workspace model use, a foreign
project id, a foreign candidate, a foreign analysis and a foreign factor write all fail with a
`42501`, `P0002` or FK violation — asserted directly in SQL, not only through the API.

No `service_role` is used anywhere in the scoring path: the RPCs are `SECURITY INVOKER`, assert
membership themselves and run under the caller's own JWT.

## 9. API contracts

| Method and path | Purpose | Notes |
| --- | --- | --- |
| `GET /api/workspaces/{workspaceId}/scoring-models` | List workspace models | Any member |
| `POST /api/workspaces/{workspaceId}/scoring-models` | Create a model | owner/admin |
| `GET /api/workspaces/{workspaceId}/scoring-models/{modelId}` | One model with its factors | Any member |
| `PATCH /api/workspaces/{workspaceId}/scoring-models/{modelId}` | Replace a model definition | owner/admin |
| `GET /api/workspaces/{workspaceId}/candidates?projectId=` | Saved candidates (project optional; the server resolves the workspace project when it is omitted) | Any member |
| `POST /api/workspaces/{workspaceId}/candidates` | Save one candidate location | owner/admin/analyst |
| `GET /api/workspaces/{workspaceId}/analyses?projectId=&mode=&limit=` | Stored analyses, newest first, `limit` 1–50 | Any member |
| `POST /api/workspaces/{workspaceId}/analyses` | Run and store one analysis (exactly one candidate) | owner/admin/analyst |
| `GET /api/workspaces/{workspaceId}/analyses/{analysisId}` | Read one stored analysis exactly as written | Any member |
| `POST /api/workspaces/{workspaceId}/comparisons` | Run and store a comparison of 2–5 candidates | owner/admin/analyst |

Errors are `{ "error": { "code", "message" } }` with safe messages only:
`invalid_request`, `invalid_model`, `duplicate_model`, `invalid_candidate`, `invalid_selection`,
`not_found`, `session_expired`, `workspace_forbidden`, `database_unavailable`, `internal_error`.
No SQL, no policy name, no schema name and no database message ever reaches a client, and a foreign
resource answers exactly like a missing one. There is no generic "score anything" endpoint: every
route takes an explicit project, candidate list, radius and model, and validates all of them.

## 10. Interface

A new **Locations** section with three tabs:

* **Analyze a site** — pick a saved candidate (or save the current map point), choose a radius preset
  (500 m / 1 km / 3 km / 5 km) or a custom radius, choose a model, then press *Run analysis*. The
  result shows `NN.NN / 100`, its band, the snapshot line (`model · revision · radius · candidates ·
  snapshot time`), the freshness warning when it applies and the full breakdown.
* **Compare sites** — select 2–5 saved candidates, run the comparison, read the sortable table,
  export the CSV, and click any candidate for its breakdown.
* **Scoring models** — the model list and the factor editor (owner/admin only; everyone else sees the
  definitions read-only). The editor mirrors the database rules and shows the live weight total.

Map clicks only select a candidate; they never run an analysis. The map draws the candidates of the
analysis currently on screen as labelled markers (A–E) and the shared radius as the existing visual
ring — the ring remains presentation, PostGIS remains the measurement.

## 11. What Phase 6 deliberately does not do

No AI recommendations, no LLM scoring, no predictive ML, no forecasting, no routing, no territory
optimization, no PDF reports, no billing, no CRM sync, no vector tiles and no national demographic
datasets. Performance is not a Phase 6 concern: analyses are small, explicit user actions.

## 12. Tests

* **SQL engine suite** (`supabase/tests/phase6_scoring_engine.sql`, 88 notices): threshold
  interpolation and rounding, min/max and inverse min/max, the all-equal degenerate score, missing
  metrics, zero-data candidates, a very large metric, disabled factors, clamping, deterministic
  repetition, ranking and tie-breaks, weights totalling something other than 100, duplicate keys,
  rejected threshold curves, comparison limits, snapshot survival across a model edit, the freshness
  flag and the candidate/history RPCs.
* **SQL RLS suite** (`supabase/tests/phase6_scoring_rls.sql`, 51 notices): catalog preflight (RLS
  enabled, expected policies, no blanket policy, only the scoring function is `SECURITY DEFINER`),
  the full role matrix, cross-workspace and foreign-key refusals, anonymous access and the service
  role's inability to bypass the tenant path.
* **Unit tests** (`src/lib/scoring/scoring.test.ts`, `src/components/app/scoring-state.test.ts`):
  the editor's rule mirror, request validation, normalization/formatting, sorting, CSV escaping and
  the parser, plus contract tests that parse payloads captured verbatim from the shipped
  `location_analysis_payload` RPC.
* **Scoring smoke** (`scripts/smoke-scoring-mode.ts`, CI only): drives the shipped API end to end
  against a clean Supabase stack — models, saved candidates, an analysis, a comparison, the stored
  read, snapshot survival across a model edit, the refusal paths and the CSV export — and parses every
  raw HTTP response with the shipped client parser.
