#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
export ONWARD_THEME_TEST_GROUP=persistence
exec bash "$(dirname "$0")/run-themes-autotest.sh" "$@"
