#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Runner script for the Windows auto-update E2E test.
#
# This test builds three release versions, starts a local HTTP server to serve
# the update manifest, validates Windows pending-update recovery behavior,
# triggers an update, and verifies the new version launches after restart.
#
# Prerequisites:
#   - Windows with PowerShell available
#   - Node.js and pnpm installed
#   - Run from the repository root or test/ directory
#
# Usage:
#   bash test/run-auto-update-windows-e2e.sh
#
# The first run builds three app versions (~10-15 min each). Subsequent runs
# reuse the cached builds and complete in ~3-5 minutes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=================================================="
echo "  Windows Auto-Update E2E Test"
echo "=================================================="
echo ""
echo "Root: $ROOT_DIR"
echo "Node: $(node --version)"
echo ""

# Run the test
node "$SCRIPT_DIR/test-auto-update-windows-e2e.mjs"
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "Test completed successfully."
else
  echo ""
  echo "Test FAILED with exit code $EXIT_CODE."
fi

exit $EXIT_CODE
