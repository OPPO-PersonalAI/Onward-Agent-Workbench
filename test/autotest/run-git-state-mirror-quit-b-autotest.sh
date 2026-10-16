#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
GSM_QUIT_GROUP=pressure exec bash "$(dirname "$0")/run-git-state-mirror-quit-autotest.sh" "$@"
