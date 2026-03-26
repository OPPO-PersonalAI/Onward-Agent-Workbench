#!/bin/bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
# Sync CLAUDE.md to AGENTS.md for compatibility with other AI coding assistants
# AGENTS.md is the convention used by Cursor, Windsurf, and other tools

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_FILE="${SCRIPT_DIR}/CLAUDE.md"
TARGET_FILE="${SCRIPT_DIR}/AGENTS.md"

if [[ -f "$SOURCE_FILE" ]]; then
    cp "$SOURCE_FILE" "$TARGET_FILE"
    echo "Synced: CLAUDE.md -> AGENTS.md"
else
    echo "Error: CLAUDE.md not found in ${SCRIPT_DIR}"
    exit 1
fi
