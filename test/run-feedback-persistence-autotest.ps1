# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$SeedLogFile = "",
  [string]$VerifyLogFile = "",
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

if (-not $SeedLogFile) {
  $SeedLogFile = Join-Path $env:TEMP "onward-feedback-persistence-seed.log"
}

if (-not $VerifyLogFile) {
  $VerifyLogFile = Join-Path $env:TEMP "onward-feedback-persistence-verify.log"
}

if (-not $UserDataDir) {
  $UserDataDir = Join-Path $env:TEMP ("onward-feedback-persistence-" + [guid]::NewGuid().ToString())
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
if (Test-Path $SeedLogFile) {
  Remove-Item $SeedLogFile -Force
}
if (Test-Path $VerifyLogFile) {
  Remove-Item $VerifyLogFile -Force
}

function Invoke-FeedbackPersistenceSuite {
  param(
    [string]$SuiteId,
    [string]$LogFile,
    [string]$Marker
  )

  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = $SuiteId
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_USER_DATA_DIR = $UserDataDir

  try {
    & $AppBin *> $LogFile
  } catch {
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Write-Error "Feedback persistence autotest failed in suite '$SuiteId'. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }

  if (-not (Select-String -Path $LogFile -Pattern $Marker -Quiet)) {
    Write-Error "Feedback persistence autotest did not complete suite '$SuiteId'. Log: $LogFile"
    Get-Content $LogFile -Tail 160
    exit 1
  }
}

Write-Host "Starting feedback persistence autotest..."
Write-Host "Using isolated user data dir: $UserDataDir"

Invoke-FeedbackPersistenceSuite -SuiteId "feedback-persistence-seed" -LogFile $SeedLogFile -Marker "FBP-SEED-03-create-pending-history-record"
Invoke-FeedbackPersistenceSuite -SuiteId "feedback-persistence-verify" -LogFile $VerifyLogFile -Marker "FBP-VERIFY-04-history-record-removable"

Write-Host "Feedback persistence autotest passed."
Write-Host "Seed log: $SeedLogFile"
Write-Host "Verify log: $VerifyLogFile"
