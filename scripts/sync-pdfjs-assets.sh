#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Sync pdf.js distribution assets into resources/pdfjs/.
#
# Usage:
#   scripts/sync-pdfjs-assets.sh [SOURCE_DIR]
#
# SOURCE_DIR defaults to ../Dark_PDF_Reader/vendor/pdfjs relative to the repo
# root. It must contain the standard pdf.js layout: build/, web/, cmaps/,
# standard_fonts/, and a LICENSE file.
#
# The embedded viewer under resources/pdfjs/app/ is NOT touched by this script.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SRC="${REPO_ROOT}/../Dark_PDF_Reader/vendor/pdfjs"
SRC_DIR="${1:-$DEFAULT_SRC}"
DEST_DIR="${REPO_ROOT}/resources/pdfjs"

if [ ! -d "$SRC_DIR" ]; then
  echo "Error: source directory not found: $SRC_DIR" >&2
  exit 1
fi

for sub in build web cmaps standard_fonts; do
  if [ ! -d "$SRC_DIR/$sub" ]; then
    echo "Error: missing required subdirectory: $SRC_DIR/$sub" >&2
    exit 1
  fi
done

mkdir -p "$DEST_DIR"
for sub in build web cmaps standard_fonts; do
  rm -rf "${DEST_DIR:?}/$sub"
  cp -R "$SRC_DIR/$sub" "$DEST_DIR/"
done

if [ -f "$SRC_DIR/LICENSE" ]; then
  cp "$SRC_DIR/LICENSE" "$DEST_DIR/LICENSE"
fi

echo "Synced pdf.js assets from: $SRC_DIR"
echo "Into:                     $DEST_DIR"
