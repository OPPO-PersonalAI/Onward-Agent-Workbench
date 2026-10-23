# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = "",
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test/autotest/Resolve-DevAppBin.ps1")
if ($Help) {
  & node (Join-Path $RootDir "test/autotest/prompt-input-settings-driver.mjs") --help
  exit $LASTEXITCODE
}
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin -or -not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
  throw "Packaged development executable missing. Pass its exact path with -AppBin."
}
if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces/test-logs/prompt-input-settings-autotest.log"
}

# Keep native PowerShell behavior identical to the POSIX runner.
& node (Join-Path $RootDir "test/autotest/prompt-input-settings-driver.mjs") --app-bin $AppBin --log-file $LogFile
exit $LASTEXITCODE
