#!/usr/bin/env bash
# Pack source code for release, excluding build artifacts and dependencies.
# Works on macOS, Linux, and Windows (Git Bash / MSYS2).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FOLDER_NAME="$(basename "$PROJECT_DIR")"
OUTPUT="$(cd "$PROJECT_DIR/.." && pwd)/Onward2-source.tar.gz"

echo "Packing source code..."
echo "Source:  $PROJECT_DIR"
echo "Output:  $OUTPUT"

tar czf "$OUTPUT" \
  --exclude="node_modules" \
  --exclude=".git" \
  --exclude="out" \
  --exclude="release" \
  --exclude="dist" \
  --exclude="*.log" \
  -C "$PROJECT_DIR/.." \
  "$FOLDER_NAME"

if [ $? -eq 0 ]; then
  SIZE=$(wc -c < "$OUTPUT" | tr -d ' ')
  echo ""
  echo "Done! Archive: $OUTPUT"
  echo "Size: $SIZE bytes"
else
  echo ""
  echo "Failed to create archive."
  exit 1
fi
