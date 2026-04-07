#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-/tmp/onward-feedback-autotest.log}"
USER_DATA_DIR="${3:-}"

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-feedback-autotest.XXXXXX")"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$LOG_FILE"

echo "Starting feedback autotest..."
echo "Using isolated user data dir: $USER_DATA_DIR"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=feedback \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Feedback autotest failed. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "FBU-11-remove-local-record" "$LOG_FILE"; then
  echo "Feedback autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

echo "Feedback autotest passed. Log: $LOG_FILE"
