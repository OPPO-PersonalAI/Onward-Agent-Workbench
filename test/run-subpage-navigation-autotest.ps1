# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")
$DefaultExe = Resolve-DevAppBin -RootDir $RootDir
$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultExe }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { "$env:TEMP\onward-subpage-navigation-autotest.log" }

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "subpage-navigation"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

& $AppExe *> $LogFile

$content = Get-Content $LogFile -Raw
if ($content -match "\[AutoTest\] FAIL") {
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Error "Subpage navigation autotest failed. Log: $LogFile"
}

if ($content -match "totalFailed: [1-9]") {
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Error "Subpage navigation autotest reported failed cases in the summary. Log: $LogFile"
}

if ($content -notmatch "SN-14-diff-to-editor-missing-file-opens-empty-state") {
  Get-Content $LogFile -Tail 120 | Write-Host
  Write-Error "Missing SN-14 result. Log: $LogFile"
}

Write-Host "Subpage navigation autotest passed. Log: $LogFile"
