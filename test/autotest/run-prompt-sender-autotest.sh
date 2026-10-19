#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT_DIR/test/autotest/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-$ROOT_DIR/traces/test-logs/prompt-sender-autotest.log}"
if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

APP_NAME="$(basename "$APP_BIN")"
HOST_OS="$(uname -s)"
stop_app() {
  local signal="${1:-TERM}"
  if [[ "$HOST_OS" == "Linux" ]]; then
    # Linux comm is truncated to 15 bytes. Match the full executable path
    # exactly instead of broadening pkill to a command-line substring search.
    node - "$APP_BIN" "$signal" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const expected = fs.realpathSync(path.resolve(process.argv[2]))
for (const entry of fs.readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(entry)) continue
  try {
    const actual = fs.readlinkSync(path.join('/proc', entry, 'exe')).replace(/ \(deleted\)$/, '')
    if (actual !== expected) continue
    // Electron helpers share the executable on Linux. Only the browser/main
    // process lacks --type; its children own their normal shutdown lifecycle.
    const args = fs.readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8').split('\0')
    if (!args.some(arg => arg === '--type' || arg.startsWith('--type='))) {
      process.kill(Number(entry), `SIG${process.argv[3]}`)
    }
  } catch (error) {
    if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error
  }
}
NODE
  elif [[ "$signal" == "KILL" ]]; then
    pkill -9 -x "$APP_NAME" 2>/dev/null || true
  else
    pkill -x "$APP_NAME" 2>/dev/null || true
  fi
}
SCRATCH_DIR=""
WATCHDOG_PID=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_app TERM || status=1
  sleep 0.5
  stop_app KILL || status=1
  if [[ -n "$WATCHDOG_PID" ]]; then
    kill -TERM "$WATCHDOG_PID" 2>/dev/null || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
  fi
  if [[ -n "$SCRATCH_DIR" ]]; then
    onward_robust_rm "$SCRATCH_DIR"
    if [[ -e "$SCRATCH_DIR" ]]; then
      echo "Could not remove sender scratch: $SCRATCH_DIR" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Fixtures and userData belong to this invocation. No test touches the checkout
# as a working directory, and diagnostics remain under the checkout's traces/.
SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/onward-prompt-sender.XXXXXX")"
WORK_DIR="$SCRATCH_DIR/work"
USER_DATA_DIR="$SCRATCH_DIR/user-data"
node - "$ROOT_DIR" "$WORK_DIR" "$USER_DATA_DIR" "$LOG_FILE" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [root, work, userData, log] = process.argv.slice(2)
const relative = path.relative(path.join(root, 'traces'), path.resolve(log))
if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('Sender logs must be under the repository traces directory')
}
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.mkdirSync(path.dirname(path.resolve(log)), { recursive: true })
fs.copyFileSync(path.join(root, 'test', 'autotest', 'fixtures', 'prompt-shell-ready.cjs'), path.join(work, 'prompt-shell-ready.cjs'))
fs.writeFileSync(path.join(work, '.prompt-sender-root'), 'prompt-sender-v2\n')
NODE

echo "Starting prompt sender autotest..."
echo "  Binary: $APP_BIN"
echo "  CWD:    $WORK_DIR"
echo "  Log:    $LOG_FILE"

# Match only this exact packaged application's main process.
stop_app TERM
sleep 0.5
APP_STATUS=0
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=prompt-sender \
ONWARD_AUTOTEST_CWD="$WORK_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_AUTOTEST_SKIP_CONSENT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_REPO_ROOT="$ROOT_DIR" \
ONWARD_PERF_TRACE=1 \
node "$ROOT_DIR/test/autotest/run-with-timeout.mjs" 280 "$APP_BIN" > "$LOG_FILE" 2>&1 &
WATCHDOG_PID=$!
# Waiting on our child is interruptible, so EXIT/INT/TERM always reach cleanup.
wait "$WATCHDOG_PID" || APP_STATUS=$?
WATCHDOG_PID=""

if [[ "$APP_STATUS" -ne 0 ]] || grep -Eq '\[AutoTest\] FAIL|totalFailed"?[[:space:]]*:[[:space:]]*[1-9]|autotest-error' "$LOG_FILE"; then
  echo "Prompt sender autotest failed (exit $APP_STATUS). Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q 'PASS PS-99-contract-completed' "$LOG_FILE" || ! grep -q 'Autotest Completed' "$LOG_FILE"; then
  echo "Prompt sender did not complete every contract case. Log: $LOG_FILE" >&2
  tail -n 120 "$LOG_FILE" >&2
  exit 1
fi

echo "Prompt sender autotest passed"
echo "  Log: $LOG_FILE"
