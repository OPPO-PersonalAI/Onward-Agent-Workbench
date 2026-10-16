# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
param([string]$AppBin = '', [string]$LogFile = '')
$ErrorActionPreference = 'Stop'
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
. (Join-Path $PSScriptRoot 'Resolve-DevAppBin.ps1')
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin) { throw 'Development executable is missing.' }
if (-not $env:GSM_QUIT_GROUP) { $env:GSM_QUIT_GROUP = 'normal' }
$env:REPO_ROOT = $RootDir
$env:APP_BIN = $AppBin
$env:LOG_FILE = if ($LogFile) { $LogFile } else { Join-Path $RootDir "traces/test-logs/quit-$($env:GSM_QUIT_GROUP).log" }
$env:RESULT_FILE = Join-Path $RootDir "traces/analysis/quit-$($env:GSM_QUIT_GROUP).json"
$ExactName = [IO.Path]::GetFileName($AppBin)
function Stop-ExactDevApp {
  $ProcessName = [IO.Path]::GetFileNameWithoutExtension($ExactName)
  Get-Process | Where-Object { $_.ProcessName -ceq $ProcessName } | Stop-Process -Force -ErrorAction SilentlyContinue
}
try {
  Stop-ExactDevApp
  & node (Join-Path $PSScriptRoot 'test-git-state-mirror-quit-cdp.mjs')
  $Result = $LASTEXITCODE
} finally {
  Stop-ExactDevApp
  Get-ChildItem -LiteralPath $RootDir -Force | Where-Object { $_.Name.StartsWith('__autotest_') } | Remove-Item -Recurse -Force
}
exit $Result
