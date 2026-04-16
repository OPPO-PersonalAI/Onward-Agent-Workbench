# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AppBin = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { '' }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { Join-Path $env:TEMP 'onward-project-editor-markdown-session-restore-autotest.log' }
$FixtureRoot = if ($args.Count -ge 3 -and $args[2]) { $args[2] } else { $RepoRoot }

if (-not $AppBin) {
  $Resolver = Join-Path $RepoRoot 'test/resolve-dev-app-bin.sh'
  if (Get-Command bash -ErrorAction SilentlyContinue) {
    $AppBin = & bash $Resolver $RepoRoot
  }
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found or not executable: $AppBin. Run: rm -rf out release && pnpm dist:dev"
}

if (-not (Test-Path $FixtureRoot -PathType Container)) {
  Write-Error "Fixture root not found: $FixtureRoot"
}

Remove-Item -Path $LogFile -Force -ErrorAction SilentlyContinue

Write-Host 'Starting Project Editor Markdown session restore autotest...'
Write-Host "  Binary:      $AppBin"
Write-Host "  Fixture CWD: $FixtureRoot"
Write-Host "  Log:         $LogFile"

$env:ONWARD_DEBUG = '1'
$env:ONWARD_AUTOTEST = '1'
$env:ONWARD_AUTOTEST_SUITE = 'project-editor-markdown-session-restore'
$env:ONWARD_AUTOTEST_CWD = $FixtureRoot
$env:ONWARD_AUTOTEST_EXIT = '1'

& $AppBin *> $LogFile

Write-Host ''
Write-Host '=== Test log (last 100 lines) ==='
Get-Content $LogFile -Tail 100
Write-Host ''

$content = Get-Content $LogFile -Raw
if ($content -match '\[AutoTest\] FAIL') {
  Write-Error "Project Editor Markdown session restore autotest failed. Log: $LogFile"
}
if ($content -match 'totalFailed: [1-9]') {
  Write-Error "Project Editor Markdown session restore autotest reported failed cases. Log: $LogFile"
}
if ($content -notmatch 'PMSR-11-editor-section-restored-after-reopen') {
  Write-Error "Missing PMSR-11 result; the test may not have executed correctly. Log: $LogFile"
}

Write-Host 'Project Editor Markdown session restore autotest passed'
Write-Host "  Log: $LogFile"
