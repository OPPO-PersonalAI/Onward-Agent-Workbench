# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$AppDir = Join-Path $RootDir "release\win-unpacked"

if (-not $AppBin) {
  $Candidates = Get-ChildItem -Path $AppDir -Filter "*.exe" -ErrorAction SilentlyContinue | Sort-Object Name
  if (-not $Candidates -or $Candidates.Count -eq 0) {
    Write-Error "No packaged .exe was found. Run: rm -rf out release && pnpm dist:dev"
    exit 1
  }
  $AppBin = $Candidates[0].FullName
}

if (-not $LogFile) {
  $LogFile = Join-Path $env:TEMP "onward-terminal-autofollow-autotest.log"
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting terminal autofollow autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "terminal-autofollow"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

try {
  & $AppBin *> $LogFile
} catch {
}

$logContent = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue

if ($logContent -match "\[AutoTest\] FAIL") {
  Write-Error "Terminal autofollow autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

if ($logContent -notmatch "TA-13-fixture-completed") {
  Write-Error "Terminal autofollow autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

Write-Host "Terminal autofollow autotest passed. Log: $LogFile"
