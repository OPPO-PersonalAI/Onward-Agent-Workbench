#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# T02 — trace infrastructure self-check (required baseline test).
# Samples a packaged app for six seconds and validates only newly created
# trace files, preserving earlier runners' diagnostic evidence. If installed,
# the Perfetto parser also validates the new NDJSON events in a JSON envelope.
#
# Usage:
#   bash test/autotest/run-trace-infra-self-check-autotest.sh <APP_BIN> [LOG_FILE]

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
APP_BIN="${1:?usage: $0 <APP_BIN> [LOG_FILE]}"
# Normalize native Windows paths before deriving the exact executable name.
if command -v cygpath >/dev/null 2>&1; then
  REPO_ROOT="$(cygpath -m "$REPO_ROOT")"
  APP_BIN="$(cygpath -m "$APP_BIN")"
fi
APP_NAME="$(basename "$APP_BIN")"
LOG_FILE="${2:-$REPO_ROOT/traces/test-logs/trace-infra-self-check-autotest.log}"
TRACE_DIR="$REPO_ROOT/traces/perf"
FILES_HELPER="$REPO_ROOT/test/autotest/trace-self-check-files.mjs"
PY="${PYTHON3:-}"
if [[ -z "$PY" ]]; then
  if command -v py >/dev/null 2>&1; then PY="py"
  elif command -v python3 >/dev/null 2>&1; then PY="python3"
  else PY="python"; fi
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")" "$TRACE_DIR" "$REPO_ROOT/traces/test-logs"
RUN_DIR="$(mktemp -d "$REPO_ROOT/traces/test-logs/trace-self-check.XXXXXX")"
APP_OWNED=0
APP_PID=""

stop_app() {
  "$PY" "$REPO_ROOT/test/autotest/dev_app_cleanup.py" \
    --app-name "$APP_NAME" --app-bin "$APP_BIN"
}

cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM HUP
  if [[ "$APP_OWNED" == "1" ]]; then
    if stop_app; then
      if [[ -n "$APP_PID" ]]; then wait "$APP_PID" 2>/dev/null || true; fi
    else
      status=1
    fi
  fi
  rm -rf "$RUN_DIR" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

USER_DATA_DIR="$RUN_DIR/user-data"
TRACECHK_CWD="$RUN_DIR/workspace"
INVENTORY="$RUN_DIR/before.json"
SEALED="$RUN_DIR/merged.json"
mkdir -p "$USER_DATA_DIR" "$TRACECHK_CWD"

stop_app
sleep 0.5
# Both operations receive the identical TRACE_DIR; no shell glob or latest.txt
# pointer can accidentally select a trace from an earlier runner.
node "$FILES_HELPER" inventory "$TRACE_DIR" "$INVENTORY"

# Mark ownership before spawning so a signal cannot skip app cleanup. exec
# makes the background job the app itself; its PID is used only for wait.
APP_OWNED=1
(
  export ONWARD_AUTOTEST=1 ONWARD_AUTOTEST_SKIP_CONSENT=1 ONWARD_PERF_TRACE=1
  export ONWARD_REPO_ROOT="$REPO_ROOT" ONWARD_USER_DATA_DIR="$USER_DATA_DIR"
  export ONWARD_AUTOTEST_CWD="$TRACECHK_CWD"
  exec "$APP_BIN"
) > "$LOG_FILE" 2>&1 &
APP_PID=$!

# Keep the existing sample interval and runner budget.
sleep 6
stop_app
wait "$APP_PID" 2>/dev/null || true
APP_OWNED=0

if ! node "$FILES_HELPER" validate "$TRACE_DIR" "$INVENTORY" "$SEALED"; then
  echo "      last 40 lines of app output:" >&2
  tail -n 40 "$LOG_FILE" >&2 || true
  exit 1
fi

# Only NDJSON creates a sealed envelope; legacy validation remains standalone.
TP="$HOME/.local/share/perfetto/prebuilts/trace_processor_shell"
if [[ -f "$SEALED" && -x "$TP" ]]; then
  if ! "$TP" --run-metrics trace_stats --metrics-output=binary "$SEALED" > /dev/null 2>&1; then
    echo "FAIL: trace_processor_shell rejected merged trace ($SEALED)" >&2
    exit 1
  fi
fi

echo "T02 trace infrastructure self-check: PASS"
