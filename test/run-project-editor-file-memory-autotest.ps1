# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $RootDir "test/Resolve-DevAppBin.ps1")

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin $RootDir }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $env:TEMP "onward-project-editor-file-memory-autotest.log" }

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found or not executable: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "project-editor-file-memory"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

& $AppBin *> $LogFile

if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
  Write-Error "ProjectEditor file-memory autotest failed. Log: $LogFile"
}

if (-not (Select-String -Path $LogFile -Pattern "PFM-49-app-state-round-trip-retains-tree-and-outline-scroll" -Quiet)) {
  Write-Error "Missing PFM-49-app-state-round-trip-retains-tree-and-outline-scroll result. Log: $LogFile"
}

Write-Output "ProjectEditor file-memory autotest passed. Log: $LogFile"
