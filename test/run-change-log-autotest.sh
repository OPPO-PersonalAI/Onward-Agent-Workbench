#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${1:-}"
LOG_FILE="${2:-/tmp/onward-change-log-autotest.log}"
TEST_TAG="v9.9.9-daily.20990101.1"
TEMP_ROOT=""
TEMP_CHANGELOG=""
TEMP_USER_DATA=""

cleanup() {
  if [[ -n "$TEMP_ROOT" && -d "$TEMP_ROOT" ]]; then
    rm -rf "$TEMP_ROOT"
  fi
}

trap cleanup EXIT

if [[ -z "$APP_BIN" ]]; then
  APP_BIN="$(bash "$ROOT_DIR/test/resolve-dev-app-bin.sh" "$ROOT_DIR")"
fi

if [[ ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: $APP_BIN" >&2
  exit 1
fi

echo "Running Change Log pipeline unit tests..."
node --test \
  "$ROOT_DIR/test/test-changelog-generation.mjs" \
  "$ROOT_DIR/test/test-changelog-manifest.mjs"

TEMP_ROOT="$(mktemp -d /tmp/onward-change-log-autotest.XXXXXX)"
TEMP_CHANGELOG="$TEMP_ROOT/changelog"
TEMP_USER_DATA="$TEMP_ROOT/user-data"
mkdir -p "$TEMP_CHANGELOG/en/daily" "$TEMP_USER_DATA"
mkdir -p "$TEMP_CHANGELOG/html/en/daily"

cat > "$TEMP_CHANGELOG/en/daily/$TEST_TAG.md" <<EOF
# Onward Daily Build $TEST_TAG

Changes since \`v9.9.8-daily.20981231.1\`.

## New Features
- Autotest fixture feature appears in the change log.

## Bug Fixes
- Autotest fixture bug fix renders correctly.
EOF

cat > "$TEMP_CHANGELOG/html/en/daily/$TEST_TAG.html" <<EOF
<h1>Onward Daily Build $TEST_TAG</h1>
<p>Changes since <code>v9.9.8-daily.20981231.1</code>.</p>
<h2>New Features</h2>
<ul>
  <li>Autotest fixture feature appears in the change log.</li>
</ul>
<h2>Bug Fixes</h2>
<ul>
  <li>Autotest fixture bug fix renders correctly.</li>
</ul>
EOF

cat > "$TEMP_CHANGELOG/index.json" <<EOF
{
  "entries": [
    {
      "tag": "$TEST_TAG",
      "version": "9.9.9-daily.20990101.1",
      "channel": "daily",
      "previousTag": "v9.9.8-daily.20981231.1",
      "publishedAt": "2099-01-01T00:00:00.000Z",
      "markdown": {
        "en": "en/daily/$TEST_TAG.md"
      },
      "html": {
        "en": "html/en/daily/$TEST_TAG.html"
      }
    }
  ]
}
EOF

rm -f "$LOG_FILE"

echo "Starting Change Log UI autotest..."
ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=change-log \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
ONWARD_USER_DATA_DIR="$TEMP_USER_DATA" \
ONWARD_TAG="$TEST_TAG" \
ONWARD_CHANGELOG_ROOT="$TEMP_CHANGELOG" \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Change Log autotest failed. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "CL-11-escape-closes-modal" "$LOG_FILE"; then
  echo "Change Log autotest did not complete. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

echo "Change Log autotest passed. Log: $LOG_FILE"
