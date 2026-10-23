#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

if [[ "${1:-}" == "--help" ]]; then
  exec node "$ROOT_DIR/test/autotest/prompt-input-settings-driver.mjs" --help
fi

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/prompt-input-settings-autotest.log}"
if [[ -z "$APP_BIN" || ! -f "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "Packaged development executable missing. Pass its exact path as argument 1." >&2
  exit 1
fi

# The shared Node driver owns deadlines, child lifetime, profiles, and cleanup.
exec node "$ROOT_DIR/test/autotest/prompt-input-settings-driver.mjs" --app-bin "$APP_BIN" --log-file "$LOG_FILE"
