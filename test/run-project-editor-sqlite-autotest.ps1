# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$defaultExe = $null
$releaseDir = Join-Path $RootDir "release\win-unpacked"
if (Test-Path $releaseDir) {
  $defaultExe = Get-ChildItem -Path $releaseDir -Filter "*.exe" -File | Select-Object -First 1 | ForEach-Object { $_.FullName }
}

$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $defaultExe }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { "$env:TEMP\onward-project-editor-sqlite-autotest.log" }

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "project-editor-sqlite"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

& $AppExe *> $LogFile

$content = Get-Content $LogFile -Raw
if ($content -match "\[AutoTest\] FAIL") {
  Get-Content $LogFile -Tail 150 | Write-Host
  Write-Error "ProjectEditor SQLite autotest failed. Log: $LogFile"
}

if ($content -notmatch "PSQL-28-file-copy-menu-visible") {
  Get-Content $LogFile -Tail 150 | Write-Host
  Write-Error "Missing PSQL-28-file-copy-menu-visible result. Log: $LogFile"
}

Write-Host "ProjectEditor SQLite autotest passed. Log: $LogFile"
