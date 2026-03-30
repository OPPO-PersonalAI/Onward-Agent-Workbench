# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
    [string]$TestCwd = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

if (-not $TestCwd) {
    $TestCwd = $ProjectDir
}

$Branch = git -C $ProjectDir rev-parse --abbrev-ref HEAD 2>$null
if (-not $Branch) { $Branch = "unknown" }

$AppPath = Join-Path $ProjectDir "release\win-unpacked\Onward 2-${Branch}.exe"
if (-not (Test-Path $AppPath)) {
    Write-Host "ERROR: App binary not found: $AppPath"
    Write-Host "Build the development package first with: rm -rf out release && pnpm dist:dev"
    exit 1
}

Write-Host "=== File Watch Autotest ==="
Write-Host "App: $AppPath"
Write-Host "Test root: $TestCwd"
Write-Host ""

$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_EXIT = "1"
$env:ONWARD_AUTOTEST_SUITE = "file-watch"
$env:ONWARD_AUTOTEST_CWD = $TestCwd
$env:ONWARD_DEBUG = "1"

& $AppPath --autotest
