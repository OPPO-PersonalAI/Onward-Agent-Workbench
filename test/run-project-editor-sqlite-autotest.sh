#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -d "$ROOT_DIR/release/mac-arm64" ]]; then
  DEFAULT_APP_BIN="$(find "$ROOT_DIR/release/mac-arm64" -maxdepth 6 -type f -path "*/Contents/MacOS/*" | head -n 1)"
else
  DEFAULT_APP_BIN=""
fi

APP_BIN="${1:-$DEFAULT_APP_BIN}"
LOG_FILE="${2:-/tmp/onward-project-editor-sqlite-autotest.log}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=project-editor-sqlite \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "ProjectEditor SQLite autotest failed. Log: $LOG_FILE" >&2
  tail -n 150 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PSQL-28-file-copy-menu-visible" "$LOG_FILE"; then
  echo "Missing PSQL-28-file-copy-menu-visible result. Log: $LOG_FILE" >&2
  tail -n 150 "$LOG_FILE" >&2
  exit 1
fi

echo "ProjectEditor SQLite autotest passed. Log: $LOG_FILE"
