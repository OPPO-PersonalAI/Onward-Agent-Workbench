# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

# Terminal focus activation autotest runner (Windows)
# For macOS/Linux, use run-terminal-focus-activation-autotest.sh

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
  $LogFile = Join-Path $env:TEMP ("onward-terminal-focus-activation-autotest-" + [DateTime]::Now.ToString("yyyyMMdd-HHmmss") + ".log")
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

if (Test-Path $LogFile) {
  try {
    Remove-Item $LogFile -Force
  } catch {
    $LogFile = Join-Path $env:TEMP ("onward-terminal-focus-activation-autotest-" + [Guid]::NewGuid().ToString("N") + ".log")
  }
}

Write-Host "Starting Terminal focus activation autotest..."
Write-Host "  Binary:   $AppBin"
Write-Host "  CWD:      $RootDir"
Write-Host "  Platform: Windows"
Write-Host "  Log:      $LogFile"
Write-Host ""

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "terminal-focus-activation"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

$proc = $null
$deadline = (Get-Date).AddSeconds(120)

try {
  $proc = Start-Process -FilePath $AppBin -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -NoNewWindow

  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $proc.Refresh()
  }

  if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
    throw "Autotest timed out after 120 seconds."
  }

  if (Test-Path "$LogFile.err") {
    Get-Content "$LogFile.err" | Add-Content $LogFile
    Remove-Item "$LogFile.err" -Force -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item Env:\ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:\ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "=== Test log (last 120 lines) ==="
Get-Content $LogFile -Tail 120
Write-Host ""

$content = Get-Content $LogFile -Raw

if ($content -match "\[AutoTest\] FAIL") {
  Write-Host "Terminal focus activation autotest FAILED" -ForegroundColor Red
  Write-Host ""
  Write-Host "=== Failure details ==="
  Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
  exit 1
}

if ($content -notmatch "TFA-08-window-focus-restores-terminal-when-pointer-is-stale") {
  Write-Host "Missing TFA-08 result; the test may not have executed correctly" -ForegroundColor Yellow
  Get-Content $LogFile -Tail 40
  exit 1
}

Write-Host "Terminal focus activation autotest PASSED" -ForegroundColor Green
Write-Host "  Log: $LogFile"
