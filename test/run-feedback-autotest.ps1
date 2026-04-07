# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = "",
  [string]$UserDataDir = ""
)

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (-not $LogFile) {
  $LogFile = Join-Path $env:TEMP "onward-feedback-autotest.log"
}

if (-not $UserDataDir) {
  $UserDataDir = Join-Path $env:TEMP ("onward-feedback-autotest-" + [guid]::NewGuid().ToString())
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting feedback autotest..."
Write-Host "Using isolated user data dir: $UserDataDir"

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "feedback"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_USER_DATA_DIR = $UserDataDir

try {
  & $AppBin *> $LogFile
} catch {
}

if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
  Write-Error "Feedback autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 160
  exit 1
}

if (-not (Select-String -Path $LogFile -Pattern "FBU-11-remove-local-record" -Quiet)) {
  Write-Error "Feedback autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 160
  exit 1
}

Write-Host "Feedback autotest passed. Log: $LogFile"
