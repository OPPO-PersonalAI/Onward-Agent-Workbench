# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Get-SanitizedBranchName {
  try {
    $raw = (git -C $RootDir rev-parse --abbrev-ref HEAD).Trim()
  } catch {
    $raw = "detached"
  }
  if (-not $raw -or $raw -eq "HEAD") {
    $raw = "detached"
  }
  $sanitized = [Regex]::Replace($raw, "[^a-zA-Z0-9._-]+", "-")
  $sanitized = [Regex]::Replace($sanitized, "-+", "-").Trim("-")
  if (-not $sanitized) {
    return "branch"
  }
  return $sanitized
}

function Find-AppExe {
  $branch = Get-SanitizedBranchName
  $version = "0.0.0"
  try {
    $version = (Get-Content -Raw (Join-Path $RootDir "package.json") | ConvertFrom-Json).version
  } catch {}
  $productName = "Under Development $version-$branch"
  $candidates = @(
    (Join-Path $RootDir "release\win-unpacked\$productName.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  $fallback = Get-ChildItem -Path (Join-Path $RootDir "release") -Recurse -Filter "Under Development *.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($fallback) {
    return $fallback.FullName
  }

  return $null
}

$DefaultExe = Find-AppExe
$AppExe = if ($args.Count -ge 1 -and $args[0]) { $args[0] } else { $DefaultExe }
$LogFile = if ($args.Count -ge 2 -and $args[1]) { $args[1] } else { "$env:TEMP\onward-mermaid-panzoom-autotest.log" }

if (-not $AppExe -or -not (Test-Path $AppExe)) {
  Write-Error "App executable not found: $AppExe`nRun a development build first: remove the out and release directories, then run pnpm dist:dev"
}

if (Test-Path $LogFile) {
  Remove-Item $LogFile -Force
}

$env:ONWARD_DEBUG = "1"
$env:ONWARD_AUTOTEST = "1"
$env:ONWARD_AUTOTEST_SUITE = "mermaid-panzoom"
$env:ONWARD_AUTOTEST_CWD = $RootDir
$env:ONWARD_AUTOTEST_EXIT = "1"

& $AppExe *> $LogFile

$content = Get-Content $LogFile -Raw
if ($content -match "\[AutoTest\] FAIL") {
  Get-Content $LogFile -Tail 240 | Write-Host
  Write-Error "Mermaid pan/zoom autotest failed. Log: $LogFile"
}

if ($content -notmatch "MPZ-final-no-orphan-fullscreen") {
  Get-Content $LogFile -Tail 240 | Write-Host
  Write-Error "Missing MPZ-final-no-orphan-fullscreen result. Log: $LogFile"
}

Write-Host "Mermaid pan/zoom autotest passed. Log: $LogFile"
