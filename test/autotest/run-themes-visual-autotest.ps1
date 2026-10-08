# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
param([string]$AppBin = "", [string]$LogFile = "")
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "run-themes-autotest.ps1") -AppBin $AppBin -LogFile $LogFile -Group "visual"
exit $LASTEXITCODE
