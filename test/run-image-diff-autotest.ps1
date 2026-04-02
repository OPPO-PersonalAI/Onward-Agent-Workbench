# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $RootDir 'test/Resolve-DevAppBin.ps1')

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin -RootDir $RootDir }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $env:TEMP 'onward-image-diff-autotest.log' }

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run a development build first: rm -rf out release && pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting image diff autotest..."
Write-Host "  Binary: $AppBin"
Write-Host "  CWD:    $RootDir"
Write-Host "  Log:    $LogFile"
Write-Host ""

$env:ONWARD_DEBUG = '1'
$env:ONWARD_AUTOTEST = '1'
$env:ONWARD_AUTOTEST_SUITE = 'image-diff'
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = '1'

try {
  & $AppBin *> $LogFile
} catch {
}

Write-Host ""
Write-Host "=== Test log (last 80 lines) ==="
Get-Content $LogFile -Tail 80
Write-Host ""

if (Select-String -Path $LogFile -Pattern '\[AutoTest\] FAIL' -Quiet) {
  Write-Error "Image diff autotest failed"
}

if (-not (Select-String -Path $LogFile -Pattern 'ID-21-cleanup' -Quiet)) {
  Write-Error "Missing ID-21 result; the test may not have executed correctly"
}

Write-Host "Image diff autotest passed"
Write-Host "  Log: $LogFile"
