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
$LogFile = Join-Path $RepoRoot "traces/test-logs/onward-settings-update-autotest.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
}

if (-not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting settings update autotest..."

$TempUserDataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("onward-su-autotest-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $TempUserDataDir | Out-Null

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "settings-update"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_USER_DATA_DIR = $TempUserDataDir

$StdoutFile = "$LogFile.stdout"
$StderrFile = "$LogFile.stderr"

try {
  $proc = Start-Process -FilePath $AppBin -NoNewWindow -PassThru -Wait -RedirectStandardOutput $StdoutFile -RedirectStandardError $StderrFile
  $combined = @()
  if (Test-Path $StdoutFile) { $combined += Get-Content $StdoutFile }
  if (Test-Path $StderrFile) { $combined += Get-Content $StderrFile }
  $combined | Set-Content -Path $LogFile -Encoding UTF8
} catch {
} finally {
  Remove-Item -Force $StdoutFile, $StderrFile -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $TempUserDataDir -ErrorAction SilentlyContinue
}

if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
  Write-Error "Settings update autotest failed. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

if (-not (Select-String -Path $LogFile -Pattern "SU-07d-preparing-disables-action-and-shows-indeterminate-progress" -Quiet)) {
  Write-Error "Settings update autotest missing SU-07d preparing assertion. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

if (-not (Select-String -Path $LogFile -Pattern "SU-10-restart-error-visible" -Quiet)) {
  Write-Error "Settings update autotest did not complete. Log: $LogFile"
  Get-Content $LogFile -Tail 120
  exit 1
}

Write-Host "Settings update autotest passed. Log: $LogFile"
