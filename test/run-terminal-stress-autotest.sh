#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Terminal Stress autotest runner (macOS / Linux)
# For Windows, use run-terminal-stress-autotest.ps1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=resolve-dev-app-bin.sh
source "$SCRIPT_DIR/resolve-dev-app-bin.sh"

APP_BIN="${1:-}"
LOG_FILE="${2:-/tmp/onward-terminal-stress-autotest.log}"

if [ -z "$APP_BIN" ]; then
  APP_BIN="$(resolve_dev_app_bin "$ROOT_DIR")"
fi

if [ ! -f "$APP_BIN" ] && [ ! -d "$APP_BIN" ]; then
  echo "ERROR: App binary not found: $APP_BIN"
  echo "Run a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting Terminal Stress autotest..."
echo "  Binary:   $APP_BIN"
echo "  CWD:      $ROOT_DIR"
echo "  Platform:  $(uname -s)"
echo "  Log:      $LOG_FILE"
echo ""

export ONWARD_DEBUG=1
export ONWARD_AUTOTEST=1
export ONWARD_AUTOTEST_SUITE=terminal-stress
export ONWARD_AUTOTEST_CWD="$ROOT_DIR"
export ONWARD_AUTOTEST_EXIT=1

"$APP_BIN" > "$LOG_FILE" 2>&1 || true

unset ONWARD_DEBUG ONWARD_AUTOTEST ONWARD_AUTOTEST_SUITE ONWARD_AUTOTEST_CWD ONWARD_AUTOTEST_EXIT

echo ""
echo "=== Test log (last 150 lines) ==="
tail -150 "$LOG_FILE"
echo ""

if grep -q '\[AutoTest\] FAIL' "$LOG_FILE"; then
  echo "Terminal Stress autotest FAILED"
  grep '\[AutoTest\] FAIL' "$LOG_FILE"
  exit 1
fi

if ! grep -q 'TP-10-input-latency-gradient' "$LOG_FILE"; then
  echo "Missing TP-10 result; the test may not have executed completely"
  tail -40 "$LOG_FILE"
  exit 1
fi

echo "Terminal Stress autotest PASSED"
echo "  Log: $LOG_FILE"
