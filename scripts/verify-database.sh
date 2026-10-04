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
  printf '\n::group::%s\n' "$CURRENT_STAGE"
  printf '\n== %s ==\n' "$CURRENT_STAGE" | tee -a "$VERIFICATION_LOG"
  "$@" 2>&1 | tee -a "$VERIFICATION_LOG"
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
printf 'Supabase CLI version: %s\n' "$actual_cli_version"

run_stage "Start local PostgreSQL through the Supabase CLI" supabase db start
run_stage "Reset the local database and replay every migration from zero" \
  supabase db reset --local --no-seed

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

run_stage "Verify PostGIS, schema, indexes, ownership, RLS, deletion and distance assertions" \
  psql "$database_url" -X -v ON_ERROR_STOP=1 -f supabase/tests/phase2_integrity.sql

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
