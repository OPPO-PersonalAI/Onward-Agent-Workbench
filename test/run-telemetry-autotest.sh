#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-/tmp/onward-telemetry-autotest.log}"

if [[ -z "$APP_BIN" ]]; then
  APP_PATH="$(find "$ROOT_DIR/release" -maxdepth 2 -type d -name '*.app' | sort | head -1)"
  if [[ -z "$APP_PATH" ]]; then
    echo "ERROR: no packaged .app was found. Run: rm -rf out release && pnpm dist:dev" >&2
    exit 1
  fi

  APP_STEM="$(basename "${APP_PATH%.app}")"
  APP_BIN="$APP_PATH/Contents/MacOS/$APP_STEM"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting telemetry end-to-end autotest..."

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=telemetry \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_TELEMETRY_FAST_HEARTBEAT=1 \
ONWARD_TELEMETRY_FORCE_UPLOAD=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

# Check for failures
if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Telemetry autotest FAILED." >&2
  grep "\[AutoTest\]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "telemetry-test:done" "$LOG_FILE"; then
  echo "Telemetry autotest did not complete." >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo ""
echo "=== AutoTest Results ==="
grep "\[AutoTest\] PASS\|FAIL\|suite-done\|Completed" "$LOG_FILE" | grep -o '\[AutoTest\].*' | head -20
echo ""

# Check upload log
echo "=== Upload Log ==="
grep "\[Telemetry\]" "$LOG_FILE" || echo "(no telemetry log messages)"
echo ""

echo "Telemetry autotest PASSED. Log: $LOG_FILE"
