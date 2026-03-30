# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin,
  [string]$LogFile
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
. (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $LogFile) {
  $LogFile = Join-Path $env:TEMP "onward-git-history-multi-terminal-scope-autotest.log"
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "git-history-multi-terminal-scope"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

$proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow -Wait
if (Test-Path "$LogFile.err") {
  Get-Content "$LogFile.err" | Add-Content $LogFile
  Remove-Item "$LogFile.err" -Force -ErrorAction SilentlyContinue
}

Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue

$content = Get-Content $LogFile -Raw

if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "Git History multi-terminal scope autotest FAILED" -ForegroundColor Red
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

if ($content -notmatch "GHMS-10-clear-stale-repo-state") {
  Write-Host "Missing GHMS-10-clear-stale-repo-state result. Log: $LogFile" -ForegroundColor Yellow
  Get-Content $LogFile -Tail 120
  exit 1
}

Write-Host "Git History multi-terminal scope autotest PASSED" -ForegroundColor Green
Write-Host "  Log: $LogFile"
