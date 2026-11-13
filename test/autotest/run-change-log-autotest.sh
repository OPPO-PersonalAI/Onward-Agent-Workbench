#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/change-log-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
TEST_TAG="v9.9.9-daily.20990101.1"
LEGACY_TAG="v9.9.1-daily.20980101.1"
TEMP_ROOT=""

cleanup() {
  if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
    onward_robust_rm "$TEMP_ROOT"
  fi
  shopt -s nullglob dotglob
  local leftovers=("$ROOT_DIR"/__autotest_*)
  shopt -u nullglob dotglob
  if (( ${#leftovers[@]} > 0 )); then
    onward_robust_rm "${leftovers[@]}"
  fi
}

trap cleanup EXIT

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$(bash "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

echo "Running Change Log pipeline unit tests..."
node --test \
  "$ROOT_DIR/test/autotest/test-changelog-generation.mjs" \
  "$ROOT_DIR/test/autotest/test-changelog-manifest.mjs"
node --experimental-strip-types --test \
  "$ROOT_DIR/test/unittest/changelog-upgrade.test.mts"

# Strip any trailing slash from TMPDIR first so ONWARD_CHANGELOG_ROOT never contains '//'
BASE_TMP="${TMPDIR:-/tmp}"; BASE_TMP="${BASE_TMP%/}"
TEMP_ROOT="$(mktemp -d "$BASE_TMP/onward-change-log-autotest.XXXXXX")"
TEMP_WORKSPACE="$TEMP_ROOT/workspace"
TEMP_CHANGELOG="$TEMP_ROOT/changelog"
TEMP_USER_DATA="$TEMP_ROOT/user-data"

mkdir -p "$TEMP_WORKSPACE" "$TEMP_CHANGELOG/en/daily" "$TEMP_CHANGELOG/html/en/daily" "$TEMP_USER_DATA"
printf '# Change Log Autotest Workspace\n' > "$TEMP_WORKSPACE/README.md"

to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

APP_WORKSPACE="$(to_native_path "$TEMP_WORKSPACE")"
APP_CHANGELOG_ROOT="$(to_native_path "$TEMP_CHANGELOG")"
APP_USER_DATA="$(to_native_path "$TEMP_USER_DATA")"

# Seed a stale historical release file and verify single-latest pruning removes it
STALE_FILE="$TEMP_CHANGELOG/en/daily/$LEGACY_TAG.md"
printf '# Legacy release %s\n' "$LEGACY_TAG" > "$STALE_FILE"

cp "$ROOT_DIR/test/autotest/fixtures/change-log/index.json" "$TEMP_CHANGELOG/index.json"
cp "$ROOT_DIR/test/autotest/fixtures/change-log/en/daily/$TEST_TAG.md" "$TEMP_CHANGELOG/en/daily/$TEST_TAG.md"
cp "$ROOT_DIR/test/autotest/fixtures/change-log/html/en/daily/$TEST_TAG.html" "$TEMP_CHANGELOG/html/en/daily/$TEST_TAG.html"

node "$ROOT_DIR/scripts/compile-changelog.js" --root "$APP_CHANGELOG_ROOT"

if [[ -e "$STALE_FILE" ]]; then
  echo "ERROR: expected single-latest pruning to remove stale file: $STALE_FILE" >&2
  exit 1
fi

if [[ ! -f "$TEMP_CHANGELOG/html/en/daily/$TEST_TAG.html" ]]; then
  echo "ERROR: expected Showcase HTML at $TEMP_CHANGELOG/html/en/daily/$TEST_TAG.html" >&2
  exit 1
fi

rm -f "$LOG_FILE"

run_scenario() {
  local mode="$1"
  local user_data_dir="$2"
  shift 2
  local markers=("$@")

  echo "Starting Change Log UI scenario [$mode]..."
  printf '=== SCENARIO: %s ===\n' "$mode" >> "$LOG_FILE"

  local rc=0
  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE=change-log \
  ONWARD_AUTOTEST_FIXTURE_EXTRA="$mode" \
  ONWARD_AUTOTEST_CWD="$APP_WORKSPACE" \
  ONWARD_AUTOTEST_EXIT=1 \
  ONWARD_AUTOTEST_SKIP_CONSENT=1 \
  ONWARD_USER_DATA_DIR="$user_data_dir" \
  ONWARD_TAG="$TEST_TAG" \
  ONWARD_CHANGELOG_ROOT="$APP_CHANGELOG_ROOT" \
  node "$ROOT_DIR/test/autotest/run-with-timeout.mjs" 60 "$APP_BIN" >> "$LOG_FILE" 2>&1 || rc=$?

  if [[ "$rc" -eq 124 ]]; then
    echo "Change Log autotest scenario [$mode] timed out after 60s. Log: $LOG_FILE" >&2
    tail -n 120 "$LOG_FILE" >&2
    exit 124
  fi

  if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
    echo "Change Log autotest failed during [$mode]. Log: $LOG_FILE" >&2
    tail -n 160 "$LOG_FILE" >&2
    exit 1
  fi

  local marker
  for marker in "${markers[@]}"; do
    if ! grep -Fq "$marker" "$LOG_FILE"; then
      echo "Change Log autotest scenario [$mode] missing marker '$marker'. Log: $LOG_FILE" >&2
      tail -n 160 "$LOG_FILE" >&2
      exit 1
    fi
  done
}

# Scenario 1: Fresh install (default en setting) does NOT auto-open, renders animated stages + SVG + Esc close, and seeds legacy tag in localStorage
run_scenario "fresh-install" "$APP_USER_DATA" \
  "CL-00b-fresh-install-does-not-auto-open" \
  "CL-05-renders-animated-stages-and-svg" \
  "CL-06-auto-follows-en-language-setting" \
  "CL-11-escape-closes-modal"

sleep 0.8

# Switch user language preference to zh-CN before the upgrade launch
cat > "$TEMP_USER_DATA/settings.json" <<EOF
{
  "language": "zh-CN",
  "telemetryConsent": false
}
EOF

# Scenario 2: First launch after upgrade (localStorage holds v9.9.1 -> current v9.9.9) auto-opens latest Showcase in zh-CN and advances stored tag
run_scenario "upgrade-first-launch" "$APP_USER_DATA" \
  "CL-UPG-01-auto-opens-on-upgrade" \
  "CL-UPG-02-renders-latest-showcase-release" \
  "CL-UPG-02b-auto-follows-zh-cn-language-setting" \
  "CL-UPG-03-persists-latest-seen-tag"

sleep 0.8

# Scenario 3: Second launch on the same version stays closed
run_scenario "upgrade-second-launch" "$APP_USER_DATA" \
  "CL-UPG-04-relaunch-does-not-reopen"

echo "Change Log autotest passed (all 3 scenarios). Log: $LOG_FILE"
