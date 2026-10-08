#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"

if [[ "${1:-}" == "--help" ]]; then
  node "$ROOT_DIR/test/autotest/test-themes-ui.mjs" --help
  exit 0
fi

APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-}"
GROUP="${ONWARD_THEME_TEST_GROUP:-core}"
if [[ -z "$APP_BIN" || ! -f "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "Packaged development executable missing. Pass its exact path as argument 1." >&2
  exit 1
fi

# The shared driver owns its child, deadline, logs, and finally/signal cleanup.
# exec keeps the driver's signal handlers reachable from the regression harness.
exec node "$ROOT_DIR/test/autotest/test-themes-ui.mjs" --app-bin "$APP_BIN" --log-file "$LOG_FILE" --group "$GROUP"
