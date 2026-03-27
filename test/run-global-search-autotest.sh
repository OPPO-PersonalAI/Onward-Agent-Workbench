#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/release/mac-arm64"
APP_NAME="$(ls "$APP_DIR" 2>/dev/null | grep '\.app$' | head -1)"

if [[ -z "$APP_NAME" ]]; then
  echo "ERROR: no packaged .app was found. Run: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

APP_STEM="${APP_NAME%.app}"
APP_BIN="${1:-$APP_DIR/$APP_NAME/Contents/MacOS/$APP_STEM}"
LOG_FILE="${2:-/tmp/onward-global-search-autotest.log}"

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting global search autotest..."

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=global-search \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Global search autotest failed. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GS-11-search-cancel" "$LOG_FILE"; then
  echo "Global search autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Global search autotest passed. Log: $LOG_FILE"
