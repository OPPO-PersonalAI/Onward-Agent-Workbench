# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = "",
  [ValidateSet("core", "draft", "tasks", "imports", "visual", "latency", "persistence", "migration", "surfaces")]
  [string]$Group = $(if ($env:ONWARD_THEME_TEST_GROUP) { $env:ONWARD_THEME_TEST_GROUP } else { "core" })
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test/autotest/Resolve-DevAppBin.ps1")
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin -or -not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
  throw "Packaged development executable missing. Pass its exact path with -AppBin."
}

# Lifecycle and artifacts are deliberately identical to the POSIX runner.
$Arguments = @((Join-Path $RootDir "test/autotest/test-themes-ui.mjs"), "--app-bin", $AppBin, "--group", $Group)
if ($LogFile) { $Arguments += @("--log-file", $LogFile) }
& node @Arguments
exit $LASTEXITCODE
