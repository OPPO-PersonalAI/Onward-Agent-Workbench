#!/usr/bin/env bash
set -euo pipefail

# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

sanitize_branch_name() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | sed -E 's/[^a-zA-Z0-9._-]+/-/g; s/-+/-/g; s/^-+|-+$//g')"
  if [[ -z "$value" || "$value" == "HEAD" ]]; then
    value="detached"
  fi
  printf '%s\n' "$value"
}

detect_dev_product_name() {
  local root_dir="${1:?root_dir is required}"
  local branch
  branch="$(git -C "$root_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo detached)"
  branch="$(sanitize_branch_name "$branch")"
  printf 'Onward 2-%s\n' "$branch"
}

resolve_dev_app_bin() {
  local root_dir="${1:?root_dir is required}"
  local product_name="${2:-$(detect_dev_product_name "$root_dir")}"
  local candidates=(
    "$root_dir/release/mac-arm64/$product_name.app/Contents/MacOS/$product_name"
    "$root_dir/release/mac/$product_name.app/Contents/MacOS/$product_name"
    "$root_dir/release/linux-unpacked/$product_name"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local fallback
  fallback="$(find "$root_dir/release" -type f \( -path "*/Contents/MacOS/Onward 2-*" -o -path "*/linux-unpacked/Onward 2-*" \) 2>/dev/null | head -n 1 || true)"
  if [[ -n "$fallback" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  root_dir="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
  resolve_dev_app_bin "$root_dir"
fi
