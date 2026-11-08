# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
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
  $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
  $LogFile = Join-Path $RepoRoot "traces/test-logs/onward-prompt-list-autotest.log"
  New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

$ResultsDir = Join-Path $RootDir "test/autotest/results"
New-Item -ItemType Directory -Force $ResultsDir | Out-Null
$UserDataDir = Join-Path $ResultsDir ("prompt-list-user-data-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $UserDataDir | Out-Null

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  Remove-Item -Path $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

function Invoke-AutotestFixtureSweep {
  Get-ChildItem -Path $RootDir -Filter '__autotest_*' -Force -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -Path $UserDataDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Starting prompt list autotest..."

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "prompt-list"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_USER_DATA_DIR = $UserDataDir

try {
  & $AppBin *> $LogFile
} catch {
} finally {
  Invoke-AutotestFixtureSweep
  Remove-Item Env:\ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
}

$logContent = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue

if ($logContent -match "\[AutoTest\] FAIL") {
  Write-Error "Prompt list autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 160
  exit 1
}

if (-not $logContent -or $logContent -notmatch "PL-10-filter-disable-resets-state" -or $logContent -notmatch "PL-21-editor-paste-files-and-folders") {
  Write-Error "Prompt list autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 160
  exit 1
}

Write-Host "Prompt list autotest passed. Log: $LogFile"
