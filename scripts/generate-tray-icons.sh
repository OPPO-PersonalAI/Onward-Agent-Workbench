#!/bin/bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0


# Generate macOS tray icon
# Convert SVG to PNG using rsvg-convert

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOURCES_DIR="$SCRIPT_DIR/../resources"
SVG_FILE="$RESOURCES_DIR/tray-icon-template.svg"

# Check if SVG file exists
if [ ! -f "$SVG_FILE" ]; then
    echo "Error: SVG file not found: $SVG_FILE"
    exit 1
fi

# Check if rsvg-convert is available
if ! command -v rsvg-convert &> /dev/null; then
    echo "Error: rsvg-convert not found. Install with: brew install librsvg"
    exit 1
fi

echo "Generating tray icons from: $SVG_FILE"

# Build 18x18 standard version
rsvg-convert -w 18 -h 18 "$SVG_FILE" -o "$RESOURCES_DIR/tray-icon-template.png"
echo "Created: tray-icon-template.png (18x18)"

# Generate 36x36 @2x HD version
rsvg-convert -w 36 -h 36 "$SVG_FILE" -o "$RESOURCES_DIR/tray-icon-template@2x.png"
echo "Created: tray-icon-template@2x.png (36x36)"

echo "Done!"
