#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Run the complete PDF/EPUB autotest suite (preview + diff + history).
#
# Usage:
#   test/run-pdf-epub-full-autotest.sh [APP_BIN] [LOG_FILE] [USER_DATA_DIR]

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-/tmp/onward-pdf-epub-full-autotest.log}"
USER_DATA_DIR="${3:-}"

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-pdf-epub-full-autotest.XXXXXX")"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting PDF/EPUB full autotest (preview + diff + history)..."
echo "Using isolated user data dir: $USER_DATA_DIR"
echo "App bin: $APP_BIN"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=pdf-epub-preview,pdf-epub-diff \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "PDF/EPUB full autotest failed. Log: $LOG_FILE" >&2
  grep -A1 "\[AutoTest\] FAIL" "$LOG_FILE" | tail -n 80 >&2
  exit 1
fi

if ! grep -q "suite-done:PdfEpubPreview" "$LOG_FILE"; then
  echo "PDF/EPUB preview suite did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "suite-done:PdfEpubDiff" "$LOG_FILE"; then
  echo "PDF/EPUB diff suite did not complete. Log: $LOG_FILE" >&2
  tail -n 200 "$LOG_FILE" >&2
  exit 1
fi

echo "PDF/EPUB full autotest passed. Log: $LOG_FILE"
