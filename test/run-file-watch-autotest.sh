#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH=$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [[ "$(uname)" == "Darwin" ]]; then
  APP_BIN_DEFAULT="$ROOT_DIR/release/mac-arm64/Onward 2-${BRANCH}.app/Contents/MacOS/Onward 2-${BRANCH}"
else
  APP_BIN_DEFAULT=$(find "$ROOT_DIR/release" -maxdepth 1 -name "*.AppImage" 2>/dev/null | head -1)
fi

APP_BIN="${1:-$APP_BIN_DEFAULT}"
LOG_FILE="${2:-/tmp/onward-file-watch-autotest.log}"

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: App binary does not exist or is not executable: $APP_BIN" >&2
  echo "Build the development package first with: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "=== File Watch Autotest ==="
echo "App: $APP_BIN"
echo "Log: $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=file-watch \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "--- Results ---"

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "FAILED: at least one assertion failed" >&2
  grep "\[AutoTest\]" "$LOG_FILE" | grep -E "PASS|FAIL" >&2
  echo "" >&2
  echo "Full log: $LOG_FILE" >&2
  exit 1
fi

if ! grep -q "FW-05c-old-file-no-effect" "$LOG_FILE"; then
  echo "INCOMPLETE: final file watch assertion was not found" >&2
  grep "\[AutoTest\]" "$LOG_FILE" | tail -20 >&2
  echo "" >&2
  echo "Full log: $LOG_FILE" >&2
  exit 1
fi

PASS_COUNT=$(grep -c "\[AutoTest\] PASS" "$LOG_FILE" || echo "0")
echo "Passed ($PASS_COUNT assertions)"
echo "Log: $LOG_FILE"
