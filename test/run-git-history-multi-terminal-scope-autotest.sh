#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/test/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-/tmp/onward-git-history-multi-terminal-scope-autotest.log}"
TARGET_REPO="${3:-${ONWARD_AUTOTEST_TARGET_CWD:-$ROOT_DIR}}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=git-history-multi-terminal-scope \
ONWARD_AUTOTEST_CWD="$TARGET_REPO" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Git History multi-terminal scope autotest failed. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "GHMS-10-clear-stale-repo-state" "$LOG_FILE"; then
  echo "Missing GHMS-10-clear-stale-repo-state result. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

echo "Git History multi-terminal scope autotest passed. Log: $LOG_FILE"
