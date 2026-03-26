#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="${2:-/tmp/onward-markdown-latex-preview-autotest.log}"

detect_app_bin() {
  local branch
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  branch="$(printf '%s' "$branch" | sed -E 's/[^a-zA-Z0-9._-]+/-/g; s/-+/-/g; s/^-+|-+$//g')"
  if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
    branch="detached"
  fi
  local product_name="Onward 2-$branch"
  local candidates=(
    "$ROOT_DIR/release/mac-arm64/$product_name.app/Contents/MacOS/$product_name"
    "$ROOT_DIR/release/mac/$product_name.app/Contents/MacOS/$product_name"
    "$ROOT_DIR/release/linux-unpacked/$product_name"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  local fallback
  fallback="$(find "$ROOT_DIR/release" -type f \( -path "*/Contents/MacOS/Onward 2-*" -o -path "*/linux-unpacked/Onward 2-*" \) 2>/dev/null | head -n 1 || true)"
  if [[ -n "$fallback" ]]; then
    echo "$fallback"
    return 0
  fi

  return 1
}

APP_BIN="${1:-$(detect_app_bin || true)}"

if [[ -z "$APP_BIN" || ! -x "$APP_BIN" ]]; then
  echo "ERROR: app binary not found or not executable: ${APP_BIN:-<empty>}" >&2
  echo "Run a development build first: rm -rf out release && pnpm dist:dev" >&2
  exit 1
fi

rm -f "$LOG_FILE"

ONWARD_DEBUG=1 \
ONWARD_AUTOTEST=1 \
ONWARD_AUTOTEST_SUITE=markdown-latex-preview \
ONWARD_AUTOTEST_CWD="$ROOT_DIR" \
ONWARD_AUTOTEST_EXIT=1 \
"$APP_BIN" > "$LOG_FILE" 2>&1 || true

if grep -q "\[AutoTest\] FAIL" "$LOG_FILE"; then
  echo "Markdown LaTeX preview autotest failed. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "MLP-15-updated-formula-visible" "$LOG_FILE"; then
  echo "Missing MLP-15-updated-formula-visible result. Log: $LOG_FILE" >&2
  tail -n 160 "$LOG_FILE" >&2
  exit 1
fi

echo "Markdown LaTeX preview autotest passed. Log: $LOG_FILE"
