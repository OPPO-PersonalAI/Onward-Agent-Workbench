#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/prompt-integrity-autotest.log}"
mkdir -p "$(dirname "$LOG_FILE")"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi
APP_BIN="$(cd "$(dirname "$APP_BIN")" && pwd)/$(basename "$APP_BIN")"
LOG_FILE="$(cd "$(dirname "$LOG_FILE")" && pwd)/$(basename "$LOG_FILE")"

PROCESS_NAME="$(basename "$APP_BIN")"
HOST_OS="$(uname -s)"
stop_app() {
  local signal="${1:-TERM}"
  if [[ "$HOST_OS" == "Linux" ]]; then
    node --input-type=module - "$ROOT_DIR" "$APP_BIN" "$signal" <<'NODE'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { readdirSync, realpathSync } from 'node:fs'
const [root, executable, signal] = process.argv.slice(2)
const { readLinuxProcessIdentity, signalVerifiedLinuxMainProcesses } = await import(pathToFileURL(path.join(root, 'test/autotest/themes-linux-process-identity.mjs')))
signalVerifiedLinuxMainProcesses({
  expectedExecutable: realpathSync(executable), selfPid: process.pid,
  pids: readdirSync('/proc').filter(name => /^[1-9]\d*$/.test(name)).map(Number),
  readIdentity: readLinuxProcessIdentity,
  signal: pid => process.kill(pid, `SIG${signal}`)
})
NODE
  elif [[ "$signal" == "KILL" ]]; then
    pkill -9 -x "$PROCESS_NAME" 2>/dev/null || true
  else
    pkill -x "$PROCESS_NAME" 2>/dev/null || true
  fi
}
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/onward-prompt-integrity.XXXXXX")"
WORK_DIR="$SCRATCH/work"
USER_DATA_DIR="$SCRATCH/user-data"

cleanup() {
  local status=$?
  trap - EXIT
  stop_app TERM || status=1
  sleep 0.5
  stop_app KILL || status=1
  onward_robust_rm "$SCRATCH"
  if [[ -e "$SCRATCH" ]]; then
    echo "Scratch cleanup failed: $SCRATCH" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node "$ROOT_DIR/test/autotest/fixtures/prompt-capture-stdin.cjs" --prepare "$WORK_DIR"
mkdir -p "$USER_DATA_DIR"
stop_app TERM
sleep 0.5

echo "Starting prompt integrity autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $WORK_DIR"
echo "  Log:    $LOG_FILE"
echo ""

set +e
(
cd "$WORK_DIR" || exit 1
ONWARD_REPO_ROOT="$ROOT_DIR" \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_PERF_TRACE=1 \
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=prompt-integrity \
ONWARD_AUTOTEST_CWD="$WORK_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
node "$ROOT_DIR/test/autotest/run-with-timeout.mjs" 180 "$APP_BIN"
) > "$LOG_FILE" 2>&1
APP_STATUS=$?
set -e

echo ""
echo "=== Test log (last 120 lines) ==="
tail -n 120 "$LOG_FILE"
echo ""

if [[ "$APP_STATUS" -ne 0 ]]; then
  echo "Prompt integrity app exited unsuccessfully: $APP_STATUS" >&2
  exit "$APP_STATUS"
fi

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Prompt integrity autotest failed" >&2
  echo ""
  echo "=== Failure details ==="
  grep "\[AutoTest\] FAIL" "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "PI-99-exact-input-contract-complete" "$LOG_FILE"; then
  echo "Missing PI-99 completion; all five trials must finish" >&2
  tail -n 80 "$LOG_FILE" >&2
  exit 1
fi

echo "Prompt integrity autotest passed"
echo "  Log: $LOG_FILE"
