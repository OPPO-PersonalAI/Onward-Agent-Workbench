#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR")}"
LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/cli-shortcut-compatibility-autotest.log}"
node "$ROOT_DIR/test/autotest/run-with-timeout.mjs" 240 node "$ROOT_DIR/test/autotest/test-cli-shortcut-compatibility.mjs" "$APP_BIN" "$LOG_FILE"
