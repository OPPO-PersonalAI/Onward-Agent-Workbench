# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
$env:GSM_QUIT_GROUP = 'extreme'
& (Join-Path $PSScriptRoot 'run-git-state-mirror-quit-autotest.ps1') @args
exit $LASTEXITCODE
