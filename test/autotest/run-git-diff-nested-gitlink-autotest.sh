#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Nested gitlink (NO .gitmodules) discovery autotest. Deliberately a small,
# fast, FOCUSED runner: one app session drives the main process directly via
# git.getDiff / git.getHistory IPC over a 1-parent + 2-gitlink fixture, so even
# on an EDR-throttled host it finishes well under the per-runner budget (no
# 40-scenario serial diff storm).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
ROOT_DIR="$REPO_ROOT"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/git-diff-nested-gitlink-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
# Generous upper bound only — the suite is 3 IPC calls; this caps a hang, it is
# NOT a slow-test crutch. Keep it under the 3-minute per-runner ceiling.
WATCHDOG_SEC="${NGL_WATCHDOG_SEC:-150}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Per CLAUDE.md "Test fixture isolation": fresh user-data dir so persisted state
# from a previous run can't leak in.
RUN_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-ngl-run.XXXXXX")"
USER_DATA_DIR="$RUN_TMP_DIR/user-data"
mkdir -p "$USER_DATA_DIR"

# Build the gitlink-without-.gitmodules fixture (wipe-and-recreate; runtime dir
# is gitignored).
FIXTURE_JSON="$(node "$REPO_ROOT/test/autotest/create-nested-gitlink-fixture.mjs")"
PARENT_ROOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).parentRoot)' "$FIXTURE_JSON")"
MANIFEST_PATH="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).manifestPath)' "$FIXTURE_JSON")"

cleanup() { rm -rf "$RUN_TMP_DIR" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

rm -f "$LOG_FILE"

echo "Starting nested-gitlink (no .gitmodules) autotest..."
echo "  Binary:        $APP_BIN"
echo "  Parent repo:   $PARENT_ROOT"
echo "  Manifest:      $MANIFEST_PATH"
echo "  User data dir: $USER_DATA_DIR"
echo "  Watchdog:      ${WATCHDOG_SEC}s"
echo "  Log:           $LOG_FILE"
echo ""

APP_EXIT=0
TMPDIR="$RUN_TMP_DIR" \
ONWARD_DEBUG=1 \
ONWARD_REPO_ROOT="$REPO_ROOT" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-nested-gitlink \
ONWARD_AUTOTEST_CWD="$PARENT_ROOT" \
ONWARD_AUTOTEST_FIXTURE_EXTRA="$MANIFEST_PATH" \
ONWARD_AUTOTEST_EXIT=1 \
node "$REPO_ROOT/test/autotest/run-with-timeout.mjs" "$WATCHDOG_SEC" "$APP_BIN" > "$LOG_FILE" 2>&1 || APP_EXIT=$?

echo ""
echo "=== Test log (last 60 lines) ==="
tail -n 60 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "nested-gitlink autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if [[ "$APP_EXIT" -ne 0 ]]; then
  echo "nested-gitlink autotest exited with code $APP_EXIT (watchdog or crash)" >&2
  exit "$APP_EXIT"
fi

for marker in \
  NGL-00-fixture-loaded \
  NGL-01-diff-gitlink-no-gitmodules-surfaces \
  NGL-02-multiple-gitlinks-all-discovered \
  NGL-03-history-gitlink-no-gitmodules-surfaces; do
  if ! grep -q "$marker" "$LOG_FILE"; then
    echo "Missing $marker; the test may not have executed correctly" >&2
    tail -n 40 "$LOG_FILE" >&2
    exit 1
  fi
done

echo "nested-gitlink (no .gitmodules) autotest passed"
echo "  Log: $LOG_FILE"
