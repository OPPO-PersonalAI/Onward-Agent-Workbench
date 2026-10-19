# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param([string]$AppBin = "", [string]$LogFile = "", [ValidateSet("user", "guests", "boundaries", "readers")][string]$Group = "user")
$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test/autotest/Resolve-DevAppBin.ps1")
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin -or -not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
  throw "Packaged development executable missing. Pass its exact path with -AppBin."
}

# Keep the native Windows runner on the identical Node lifecycle and assertions.
$Arguments = @((Join-Path $RootDir "test/autotest/prompt-input-shortcuts-driver.mjs"), "--app-bin", $AppBin, "--group", $Group)
# Windows PowerShell 5 drops empty native arguments; never put an empty value
# before another option, or --group would be consumed as the log filename.
if ($LogFile) { $Arguments += @("--log-file", $LogFile) }
& node @Arguments
exit $LASTEXITCODE
