#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
export REPO_ROOT="$ROOT_DIR"
export APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
export GSM_QUIT_GROUP="${GSM_QUIT_GROUP:-normal}"
export LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/quit-${GSM_QUIT_GROUP}.log}"
export RESULT_FILE="$ROOT_DIR/traces/analysis/quit-${GSM_QUIT_GROUP}.json"
APP_NAME="$(detect_dev_product_name "$ROOT_DIR")"
pkill -x "$APP_NAME" 2>/dev/null || true
cleanup() {
  pkill -x "$APP_NAME" 2>/dev/null || true
  find "$ROOT_DIR" -maxdepth 1 -name '__autotest_*' -exec rm -rf {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM
node "$ROOT_DIR/test/autotest/test-git-state-mirror-quit-cdp.mjs"
