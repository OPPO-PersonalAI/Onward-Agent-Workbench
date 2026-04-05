# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
. (Join-Path $RootDir 'test/Resolve-DevAppBin.ps1')

$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { Resolve-DevAppBin -RootDir $RootDir }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $env:TEMP 'onward-project-editor-markdown-navigation-autotest.log' }

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found. Run a development build first: rm -rf out release && pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

Write-Host "Starting Project Editor Markdown navigation autotest..."
Write-Host "  Binary: $AppBin"
Write-Host "  CWD:    $RootDir"
Write-Host "  Log:    $LogFile"
Write-Host ""

$env:ONWARD_DEBUG = '1'
$env:ONWARD_AUTOTEST = '1'
$env:ONWARD_AUTOTEST_SUITE = 'project-editor-markdown-navigation'
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
  Write-Error "Project Editor Markdown navigation autotest failed"
}

if (Select-String -Path $LogFile -Pattern 'totalFailed:\s+[1-9]' -Quiet) {
  Write-Error "Project Editor Markdown navigation autotest reported failed cases in the summary"
}

if (-not (Select-String -Path $LogFile -Pattern 'PMN-17-markdown-editor-restored' -Quiet)) {
  Write-Error "Missing PMN-17 result; the test may not have executed correctly"
}

Write-Host "Project Editor Markdown navigation autotest passed"
Write-Host "  Log: $LogFile"
