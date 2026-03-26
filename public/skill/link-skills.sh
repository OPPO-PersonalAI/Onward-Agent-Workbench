#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

# Get the absolute path to the directory where the script is located (i.e. public/skill/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="$HOME/.claude/skills"

# Parse parameters: support --dry-run at any location
DRY_RUN=false
ACTION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -*) echo "Unknown option: $arg"; exit 1 ;;
    *) ACTION="$arg" ;;
  esac
done
ACTION="${ACTION:-help}"

# Get symlink target path cross-platform
resolve_link() {
  readlink "$1"
}

case "$ACTION" in
  install)
    $DRY_RUN && echo "[dry-run] The following operations will not be executed:"
    $DRY_RUN || mkdir -p "$TARGET_DIR"
    found=0
    for skill_dir in "$SCRIPT_DIR"/*/; do
      [ -d "$skill_dir" ] || continue
      [ -f "$skill_dir/SKILL.md" ] || continue
      name="$(basename "$skill_dir")"
      if $DRY_RUN; then
        echo "  will link: $name → $skill_dir"
      else
        ln -sfn "$skill_dir" "$TARGET_DIR/$name"
        echo "✓ linked: $name → $skill_dir"
      fi
      found=$((found + 1))
    done
    if [ "$found" -eq 0 ]; then
      echo "No skills found in $SCRIPT_DIR (looking for directories containing SKILL.md)"
    else
      $DRY_RUN && echo "Will link $found skill(s) to $TARGET_DIR" || echo "Done. $found skill(s) linked to $TARGET_DIR"
    fi
    ;;
  uninstall)
    $DRY_RUN && echo "[dry-run] The following operations will not be executed:"
    if [ ! -d "$TARGET_DIR" ]; then
      echo "No skills directory found at $TARGET_DIR, nothing to uninstall."
      exit 0
    fi
    removed=0
    for link in "$TARGET_DIR"/*; do
      [ -L "$link" ] || continue
      target="$(resolve_link "$link")"
      if [[ "$target" == "$SCRIPT_DIR"/* || "$target" == "$SCRIPT_DIR" ]]; then
        if $DRY_RUN; then
          echo "  will unlink: $(basename "$link")"
        else
          rm "$link"
          echo "✗ unlinked: $(basename "$link")"
        fi
        removed=$((removed + 1))
      fi
    done
    if [ "$removed" -eq 0 ]; then
      echo "No skills from this project found in $TARGET_DIR"
    else
      $DRY_RUN && echo "Will unlink $removed skill(s) from $TARGET_DIR" || echo "Done. $removed skill(s) unlinked from $TARGET_DIR"
    fi
    ;;
  *)
    echo "Usage: $0 <command> [--dry-run]"
    echo ""
    echo "Commands:"
    echo "  install    Link all skills from public/skill/ to ~/.claude/skills/"
    echo "  uninstall  Remove symlinks pointing to this project's skills"
    echo ""
    echo "Options:"
    echo "  --dry-run  Preview operations without executing them"
    ;;
esac
