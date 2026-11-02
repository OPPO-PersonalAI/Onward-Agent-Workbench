# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
param([string]$AppBin = '', [string]$LogFile = '')
$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'Resolve-DevAppBin.ps1')
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $LogFile) { $LogFile = Join-Path $RootDir 'traces/test-logs/cli-shortcut-compatibility-autotest.log' }
& node (Join-Path $PSScriptRoot 'run-with-timeout.mjs') 240 node (Join-Path $PSScriptRoot 'test-cli-shortcut-compatibility.mjs') $AppBin $LogFile
exit $LASTEXITCODE
