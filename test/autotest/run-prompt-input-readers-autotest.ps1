# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param([string]$AppBin = "", [string]$LogFile = "")
$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
& (Join-Path $RootDir "test/autotest/run-prompt-input-shortcuts-autotest.ps1") -AppBin $AppBin -LogFile $LogFile -Group readers
exit $LASTEXITCODE
