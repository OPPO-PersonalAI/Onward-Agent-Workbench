#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT_DIR/test/resolve-dev-app-bin.sh"
APP_BIN="${1:-$(resolve_dev_app_bin "$ROOT_DIR" || true)}"
LOG_FILE="${2:-/tmp/onward-file-index-cache-ui-autotest.log}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

# Use the committed fixture tree at test/fixtures/file-index-cache. The
# autotest creates its own scratch files inside this directory during the run
# (prefixed `onward-fic-`) and deletes them on cleanup, so re-running the
# script is idempotent. We never touch the user's home directory or the
# live project root.
FIXTURE_DIR="$ROOT_DIR/test/fixtures/file-index-cache"
if [[ ! -d "$FIXTURE_DIR" ]]; then
  echo "ERROR: fixture directory missing: $FIXTURE_DIR" >&2
  echo "Expected committed test asset — do not delete." >&2
  exit 1
fi

# Isolated user-data dir prevents the prior session's persisted state (e.g. an
# open ProjectEditor subpage pinned to a different cwd) from being restored
# and clobbering our fixture cwd during startup.
USER_DATA_DIR="$(mktemp -d "/tmp/onward-fic-userdata.XXXXXX")"
trap 'rm -rf "$USER_DATA_DIR"; find "$FIXTURE_DIR" -name "onward-fic-*" -delete 2>/dev/null || true' EXIT

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=file-index-cache-ui \
ONWARD_AUTOTEST_CWD="$FIXTURE_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$USER_DATA_DIR" \
ONWARD_TELEMETRY_RESET_CONSENT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "File index cache UI autotest failed. Log: $LOG_FILE" >&2
  grep -n "\[AutoTest\] \(PASS\|FAIL\)" "$LOG_FILE" | tail -n 60 >&2 || true
  tail -n 60 "$LOG_FILE" >&2
  exit 1
fi

required_markers=(
  "FIC-03-initial-build-counted"
  "FIC-06-repeated-opens-reuse-cache"
  "FIC-08-found-c-after-create"
  "FIC-09-create-did-not-rebuild"
  "FIC-11-renamed-appears"
  "FIC-14-b-removed"
  "FIC-15-mutations-did-not-rebuild"
  "FIC-17-nested-propagated"
  "FIC-18-nested-did-not-rebuild"
  "FIC-20-force-refresh-triggered-rebuild"
  "FIC-22-folder-not-in-results"
)
for marker in "${required_markers[@]}"; do
  if ! grep -q "$marker" "$LOG_FILE"; then
    echo "Missing required assertion marker in log: $marker" >&2
    tail -n 60 "$LOG_FILE" >&2
    exit 1
  fi
done

echo "File index cache UI autotest passed. Log: $LOG_FILE"
grep -E "\[AutoTest\] (PASS|FAIL) " "$LOG_FILE" | tail -n 40 || true
