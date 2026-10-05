#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CURRENT_STAGE="preflight"
TEMP_TYPES_FILE=""
VERIFICATION_LOG="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bli-database-verification.log"
mkdir -p "$(dirname -- "$VERIFICATION_LOG")"
: > "$VERIFICATION_LOG"

cleanup() {
  if [[ -n "$TEMP_TYPES_FILE" ]]; then
    rm -f -- "$TEMP_TYPES_FILE"
  fi
}

report_failure() {
  local exit_code=$?
  printf '::endgroup::\n' >&2
  printf '::error::Database verification failed during: %s (exit %s)\n' \
    "$CURRENT_STAGE" "$exit_code" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '\n## Database verification failure\n\nStage: `%s` (exit %s)\n\n' \
        "$CURRENT_STAGE" "$exit_code"
      printf 'Last verification output:\n\n```text\n'
      tail -n 250 "$VERIFICATION_LOG"
      printf '\n```\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit "$exit_code"
}

trap cleanup EXIT
trap report_failure ERR

run_stage() {
  CURRENT_STAGE="$1"
  shift
  local stage_output_file
  local stage_exit_code
  stage_output_file="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bli-stage-output.XXXXXX")"

  printf '\n::group::%s\n' "$CURRENT_STAGE"
  printf '\n== %s ==\n' "$CURRENT_STAGE" | tee -a "$VERIFICATION_LOG"
  if "$@" > "$stage_output_file" 2>&1; then
    cat "$stage_output_file" | tee -a "$VERIFICATION_LOG"
    if [[ "$CURRENT_STAGE" == Verify* && -n "${GITHUB_ACTIONS:-}" ]]; then
      local runtime_version_summary
      runtime_version_summary="$(grep -E 'NOTICE:[[:space:]]+(PostgreSQL version|PostGIS extension version)' \
        "$stage_output_file" \
        | sed -E 's/^psql:[^:]+:[0-9]+: NOTICE: +//' \
        | paste -sd '; ' - || true)"
      if [[ -n "$runtime_version_summary" ]]; then
        runtime_version_summary="${runtime_version_summary//'%'/'%25'}"
        printf '::notice title=Verified database runtime::%s\n' \
          "$runtime_version_summary"
      fi
    fi
    rm -f -- "$stage_output_file"
  else
    stage_exit_code=$?
    cat "$stage_output_file" | tee -a "$VERIFICATION_LOG" >&2
    if [[ "$CURRENT_STAGE" == Verify* ]]; then
      local diagnostic_output
      diagnostic_output="$(grep -E '(^|[[:space:]])(ERROR|FATAL|PANIC):|^(DETAIL|HINT|CONTEXT):' \
        "$stage_output_file" | tail -n 12 || true)"
      if [[ -z "$diagnostic_output" ]]; then
        diagnostic_output="$(tail -n 12 "$stage_output_file")"
      fi
      diagnostic_output="${diagnostic_output//'%'/'%25'}"
      diagnostic_output="${diagnostic_output//$'\r'/'%0D'}"
      diagnostic_output="${diagnostic_output//$'\n'/'%0A'}"
      printf '::error title=Database verification SQL diagnostic::%s\n' \
        "$diagnostic_output" >&2
    fi
    rm -f -- "$stage_output_file"
    return "$stage_exit_code"
  fi
  printf '::endgroup::\n'
}

CURRENT_STAGE="required local tooling"
for tool in supabase docker psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '::error::Required command is unavailable: %s\n' "$tool" >&2
    exit 2
  fi
done

docker info >/dev/null
expected_cli_version="$(node -p "require('./package.json').devDependencies.supabase")"
actual_cli_version="$(supabase --version)"
if [[ "$actual_cli_version" != "$expected_cli_version" ]]; then
  printf '::error::Supabase CLI version mismatch: package-lock expects %s; found %s\n' \
    "$expected_cli_version" "$actual_cli_version" >&2
  exit 2
fi
psql_client_version="$(psql --version)"
printf 'Supabase CLI version: %s\npsql client version: %s\n' \
  "$actual_cli_version" "$psql_client_version"
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  printf '::notice title=Database CLI versions::Supabase CLI %s; %s\n' \
    "$actual_cli_version" "$psql_client_version"
fi

# The full local stack (PostgreSQL + Auth + REST + Storage behind Kong) is
# required, not just the database container: the authenticated end-to-end smoke
# signs in through GoTrue and queries through PostgREST with real JWT claims,
# and Phase 5 imports upload to the private storage bucket through the Storage
# API, whose own schema and policies this gate verifies.
# Studio, mail, realtime, imgproxy and analytics are excluded.
run_stage "Start the local Supabase stack (PostgreSQL, Auth, REST, Storage) through the Supabase CLI" \
  supabase start -x realtime,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit
run_stage "Reset the local database, replay migrations, and load deterministic synthetic seed data" \
  supabase db reset --local

CURRENT_STAGE="confirm the local Supabase API is serving (required for the authenticated smoke)"
api_probe="$(supabase status --output env 2>/dev/null | awk -F= '$1 == "API_URL" || $1 == "SUPABASE_URL" { print; found = 1 } END { if (!found) exit 1 }')" || api_probe=""
if [[ -z "$api_probe" ]]; then
  printf '::error::supabase status did not expose an API URL: the full local stack is required (npm run verify:database starts it)\n' >&2
  exit 2
fi
printf 'Local Supabase API: %s\n' "${api_probe#*=}"

CURRENT_STAGE="resolve the local database connection"
database_url="$(supabase status --output env | awk -F= '
  $1 == "DB_URL" {
    sub(/^[^=]*=/, "")
    gsub(/"/, "")
    print
    found = 1
  }
  END { if (!found) exit 1 }
')"
if [[ -z "$database_url" ]]; then
  printf '::error::Supabase status did not return DB_URL\n' >&2
  exit 2
fi

# `supabase db reset` recreates the database; the Storage API normally recreates
# its own schema when the stack restarts, but that restart is version-dependent,
# so prove it rather than assume it. Phase 5 stores import files through the
# Storage API and its suites assert the real storage schema, so a missing schema
# must never be silently tolerated (or silently skipped).
CURRENT_STAGE="ensure the Storage API schema exists after the database reset"
storage_ready="$(psql "$database_url" -X -tAc "select pg_catalog.to_regclass('storage.objects') is not null")"
if [[ "$storage_ready" != "t" ]]; then
  printf '::warning title=Storage schema missing::storage.objects was absent after the reset; restarting the local stack so the Storage API recreates it\n'
  run_stage "Restart the local Supabase stack so the Storage API recreates its schema" \
    bash -c 'supabase stop --no-backup >/dev/null 2>&1 || true; supabase start -x realtime,imgproxy,studio,edge-runtime,logflare,vector,supavisor,mailpit'
  storage_ready="$(psql "$database_url" -X -tAc "select pg_catalog.to_regclass('storage.objects') is not null")"
  if [[ "$storage_ready" != "t" ]]; then
    printf '::error::storage.objects is still missing after restarting the stack; Phase 5 import assertions cannot run\n' >&2
    exit 2
  fi
fi
printf 'Storage schema present: the private import bucket policies can be asserted.\n'

run_stage "Verify Phase 2 PostGIS, ownership, RLS, deletion and distance assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase2_integrity.sql
run_stage "Verify Phase 3 viewport, radius, workspace isolation, DTO shape and spatial index assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase3_spatial_queries.sql
run_stage "Verify Phase 4 auth, workspace membership, RLS, grant and last-owner assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase4_membership_rls.sql
run_stage "Verify Phase 5 import workflow, storage and RLS assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase5_import_rls.sql
run_stage "Verify Phase 5 geocoding batch, resume, idempotency and manual override assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase5_geocoding.sql
run_stage "Verify Phase 6 scoring engine, normalization, snapshot and freshness assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase6_scoring_engine.sql
run_stage "Verify Phase 6 scoring permissions, cross-workspace and forgery assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase6_scoring_rls.sql

CURRENT_STAGE="generate TypeScript types from the verified local schema"
mkdir -p src/lib/database
TEMP_TYPES_FILE="$(mktemp src/lib/database/database.types.ts.tmp.XXXXXX)"
supabase gen types --lang typescript --local --schema public > "$TEMP_TYPES_FILE"
if [[ ! -s "$TEMP_TYPES_FILE" ]]; then
  printf '::error::Supabase CLI produced an empty database.types.ts file\n' >&2
  exit 1
fi
mv -- "$TEMP_TYPES_FILE" src/lib/database/database.types.ts
TEMP_TYPES_FILE=""
printf 'Generated src/lib/database/database.types.ts from the reset local database.\n'
