# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
param([string]$AppBin = "", [string]$LogFile = "")
$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
if (-not $AppBin) {
  . (Join-Path $RootDir "test/autotest/Resolve-DevAppBin.ps1")
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}
if (-not $LogFile) { $LogFile = Join-Path $RootDir "traces/test-logs/change-log-autotest.log" }
node (Join-Path $RootDir "test/autotest/test-changelog-startup.mjs") $AppBin $LogFile
exit $LASTEXITCODE
