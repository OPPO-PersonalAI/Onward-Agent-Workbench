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
  $LogFile = Join-Path $env:TEMP "onward-git-nested-submodules-autotest.log"
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

$FixtureJson = node (Join-Path $RootDir "test\create-nested-git-submodule-fixture.mjs")
$Fixture = $FixtureJson | ConvertFrom-Json
$FixtureRoot = $Fixture.repoRoot

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting Git nested-submodule autotest..."
Write-Host "  Binary:      $AppBin"
Write-Host "  Target repo: $FixtureRoot"
Write-Host "  Log:         $LogFile"
Write-Host ""

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "git-nested-submodules"
$env:ONWARD_AUTOTEST_CWD = $FixtureRoot
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

Write-Host ""
Write-Host "=== Test log (last 100 lines) ==="
Get-Content $LogFile -Tail 100
Write-Host ""

$content = Get-Content $LogFile -Raw

if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "Git nested-submodule autotest FAILED" -ForegroundColor Red
  Write-Host ""
  Write-Host "=== Failure details ==="
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

if ($content -notmatch "GNS-01-history-root-is-current-repo-only") {
  Write-Host "Missing GNS-01 result; the test may not have executed correctly" -ForegroundColor Yellow
  Get-Content $LogFile -Tail 60
  exit 1
}

Write-Host "Git nested-submodule autotest PASSED" -ForegroundColor Green
Write-Host "  Log: $LogFile"
