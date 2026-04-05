#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/test/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-/tmp/onward-git-diff-submodules-autotest.log}"
TARGET_REPO="${3:-${ONWARD_AUTOTEST_TARGET_CWD:-}}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

if [[ -z "$TARGET_REPO" || ! -d "$TARGET_REPO" ]]; then
  echo "ERROR: target repo with submodules is required as the third argument." >&2
  echo "Example: $0 \"$APP_BIN\" \"$LOG_FILE\" /path/to/repo-with-submodules" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting Git Diff multi-submodule autotest..."
echo "  Binary:     $APP_BIN"
echo "  Target repo: $TARGET_REPO"
echo "  Log:        $LOG_FILE"
echo ""

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-diff-submodules \
ONWARD_AUTOTEST_CWD="$TARGET_REPO" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

echo ""
echo "=== Test log (last 80 lines) ==="
tail -n 80 "$LOG_FILE"
echo ""

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git Diff multi-submodule autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "DSM-01-root-only-discovers-submodules" "$LOG_FILE"; then
  echo "Missing DSM-01 result; the test may not have executed correctly" >&2
  tail -n 40 "$LOG_FILE" >&2
  exit 1
fi

echo "Git Diff multi-submodule autotest passed"
echo "  Log: $LOG_FILE"
