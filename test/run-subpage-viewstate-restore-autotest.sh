#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/test/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-/tmp/onward-subpage-viewstate-restore-autotest.log}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting subpage view-state restore autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $ROOT_DIR"
echo "  Log:    $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=subpage-viewstate-restore \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Subpage view-state restore autotest FAILED" >&2
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if grep -Eq "totalFailed: [1-9]" "$LOG_FILE"; then
  echo "Subpage view-state restore autotest reported failed cases" >&2
  grep -E "totalFailed: [1-9]" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "SVR-15-rapid-roundtrip-scroll" "$LOG_FILE"; then
  echo "Missing SVR-15 result; the test may not have executed all phases" >&2
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

echo "Subpage view-state restore autotest PASSED"
echo "  Log: $LOG_FILE"
