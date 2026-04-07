#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${1:-}"
SEED_LOG_FILE="${2:-/tmp/onward-feedback-persistence-seed.log}"
VERIFY_LOG_FILE="${3:-/tmp/onward-feedback-persistence-verify.log}"
USER_DATA_DIR="${4:-}"

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$("$ROOT_DIR/test/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ -z "$USER_DATA_DIR" ]]; then
  USER_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-feedback-persistence.XXXXXX")"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

rm -f "$SEED_LOG_FILE" "$VERIFY_LOG_FILE"

run_suite() {
  local suite_id="$1"
  local log_file="$2"
  local marker="$3"

  ONWARD_DEBUG=1 \
  ONWARD_AUTOTEST=1 \
  ONWARD_AUTOTEST_SUITE="$suite_id" \
  ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
  ONWARD_AUTOTEST_EXIT=1 \
  ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
  "$APP_BIN" > "$log_file" 2>&1 || true

  if grep -q "\[AutoTest\] FAIL" "$log_file"; then
    echo "Feedback persistence autotest failed in suite '$suite_id'. Log: $log_file" >&2
    tail -n 160 "$log_file" >&2
    exit 1
  fi

  if ! grep -q "$marker" "$log_file"; then
    echo "Feedback persistence autotest did not complete suite '$suite_id'. Log: $log_file" >&2
    tail -n 160 "$log_file" >&2
    exit 1
  fi
}

echo "Starting feedback persistence autotest..."
echo "Using isolated user data dir: $USER_DATA_DIR"

run_suite "feedback-persistence-seed" "$SEED_LOG_FILE" "FBP-SEED-03-create-pending-history-record"
run_suite "feedback-persistence-verify" "$VERIFY_LOG_FILE" "FBP-VERIFY-04-history-record-removable"

echo "Feedback persistence autotest passed."
echo "Seed log: $SEED_LOG_FILE"
echo "Verify log: $VERIFY_LOG_FILE"
