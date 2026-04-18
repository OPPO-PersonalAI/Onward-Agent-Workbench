# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

function Get-SanitizedBranchName {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir
  )

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

function Resolve-DevAppBin {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir
  )

  $branch = Get-SanitizedBranchName -RootDir $RootDir
  $pkgPath = Join-Path $RootDir "package.json"
  $version = "0.0.0"
  try {
    $version = (Get-Content -Raw $pkgPath | ConvertFrom-Json).version
  } catch {}
  $productName = "Under Development $version-$branch"
  $candidates = @(
    (Join-Path $RootDir "release\win-unpacked\$productName.exe"),
    (Join-Path $RootDir "release\win-ia32-unpacked\$productName.exe"),
    (Join-Path $RootDir "release\win-arm64-unpacked\$productName.exe")
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
