# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = "$env:TEMP\onward-change-log-autotest.log"
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TestTag = "v9.9.9-daily.20990101.1"

if (-not $AppBin) {
  . (Join-Path $RootDir "test\Resolve-DevAppBin.ps1")
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  throw "App binary not found or not executable: $AppBin"
}

Write-Host "Running Change Log pipeline unit tests..."
node --test `
  (Join-Path $RootDir "test\test-changelog-generation.mjs") `
  (Join-Path $RootDir "test\test-changelog-manifest.mjs")

$tempRoot = Join-Path $env:TEMP ("onward-change-log-autotest-" + [guid]::NewGuid().ToString("N"))
$tempChangelog = Join-Path $tempRoot "changelog"
$tempUserData = Join-Path $tempRoot "user-data"

New-Item -ItemType Directory -Path (Join-Path $tempChangelog "en\daily") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempChangelog "html\en\daily") -Force | Out-Null
New-Item -ItemType Directory -Path $tempUserData -Force | Out-Null

try {
  @"
# Onward Daily Build $TestTag

Changes since ``v9.9.8-daily.20981231.1``.

## New Features
- Autotest fixture feature appears in the change log.

## Bug Fixes
- Autotest fixture bug fix renders correctly.
"@ | Set-Content -Path (Join-Path $tempChangelog "en\daily\$TestTag.md") -Encoding UTF8

  @"
<h1>Onward Daily Build $TestTag</h1>
<p>Changes since <code>v9.9.8-daily.20981231.1</code>.</p>
<h2>New Features</h2>
<ul>
  <li>Autotest fixture feature appears in the change log.</li>
</ul>
<h2>Bug Fixes</h2>
<ul>
  <li>Autotest fixture bug fix renders correctly.</li>
</ul>
"@ | Set-Content -Path (Join-Path $tempChangelog "html\en\daily\$TestTag.html") -Encoding UTF8

  @"
{
  "entries": [
    {
      "tag": "$TestTag",
      "version": "9.9.9-daily.20990101.1",
      "channel": "daily",
      "previousTag": "v9.9.8-daily.20981231.1",
      "publishedAt": "2099-01-01T00:00:00.000Z",
      "markdown": {
        "en": "en/daily/$TestTag.md"
      },
      "html": {
        "en": "html/en/daily/$TestTag.html"
      }
    }
  ]
}
"@ | Set-Content -Path (Join-Path $tempChangelog "index.json") -Encoding UTF8

  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  Write-Host "Starting Change Log UI autotest..."
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "change-log"
  $env:ONWARD_AUTOTEST_CWD = $RootDir
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_USER_DATA_DIR = $tempUserData
  $env:ONWARD_TAG = $TestTag
  $env:ONWARD_CHANGELOG_ROOT = $tempChangelog

  & $AppBin *>> $LogFile

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Get-Content $LogFile -Tail 160 | Write-Host
    throw "Change Log autotest failed. Log: $LogFile"
  }

  if (-not (Select-String -Path $LogFile -Pattern "CL-11-escape-closes-modal" -Quiet)) {
    Get-Content $LogFile -Tail 160 | Write-Host
    throw "Change Log autotest did not complete. Log: $LogFile"
  }

  Write-Host "Change Log autotest passed. Log: $LogFile"
} finally {
  Remove-Item Env:ONWARD_DEBUG -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_SUITE -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_CWD -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_AUTOTEST_EXIT -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_USER_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_TAG -ErrorAction SilentlyContinue
  Remove-Item Env:ONWARD_CHANGELOG_ROOT -ErrorAction SilentlyContinue

  if (Test-Path $tempRoot) {
    Remove-Item $tempRoot -Recurse -Force
  }
}
