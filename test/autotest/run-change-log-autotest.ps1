# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = "$env:TEMP\onward-change-log-autotest.log"
)

$ErrorActionPreference = "Stop"

$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$TestTag = "v9.9.9-daily.20990101.1"
$LegacyTag = "v9.9.1-daily.20980101.1"

if (-not $AppBin) {
  . (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
  $AppBin = Resolve-DevAppBin -RootDir $RootDir
}

if (-not $AppBin -or -not (Test-Path $AppBin)) {
  throw "App binary not found or not executable: $AppBin"
}

Write-Host "Running Change Log pipeline unit tests..."
node --test `
  (Join-Path $RootDir "test\autotest\test-changelog-generation.mjs") `
  (Join-Path $RootDir "test\autotest\test-changelog-manifest.mjs")
if ($LASTEXITCODE -ne 0) {
  throw "Change Log pipeline unit tests failed with exit code $LASTEXITCODE"
}

node --experimental-strip-types --test `
  (Join-Path $RootDir "test\unittest\changelog-upgrade.test.mts")
if ($LASTEXITCODE -ne 0) {
  throw "changelog-upgrade.test.mts failed with exit code $LASTEXITCODE"
}

$tempRoot = Join-Path $env:TEMP ("onward-change-log-autotest-" + [guid]::NewGuid().ToString("N"))
$tempWorkspace = Join-Path $tempRoot "workspace"
$tempChangelog = Join-Path $tempRoot "changelog"
$tempUserData = Join-Path $tempRoot "user-data"

New-Item -ItemType Directory -Path $tempWorkspace -Force | Out-Null
Set-Content -Path (Join-Path $tempWorkspace "README.md") -Value "# Change Log Autotest Workspace" -Encoding UTF8
New-Item -ItemType Directory -Path (Join-Path $tempChangelog "en\daily") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tempChangelog "html\en\daily") -Force | Out-Null
New-Item -ItemType Directory -Path $tempUserData -Force | Out-Null

function Remove-TreeWithRetry {
  param([string]$TargetPath)
  if (-not $TargetPath -or -not (Test-Path $TargetPath)) {
    return
  }
  for ($attempt = 1; $attempt -le 8; $attempt++) {
    Remove-Item -LiteralPath $TargetPath -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path $TargetPath)) {
      return
    }
    Start-Sleep -Milliseconds 300
  }
}

function Invoke-ChangeLogScenario {
  param(
    [string]$Mode,
    [string]$UserDataDir,
    [string[]]$RequiredMarkers
  )

  Write-Host "Starting Change Log UI scenario [$Mode]..."
  Add-Content -Path $LogFile -Value "=== SCENARIO: $Mode ===" -Encoding UTF8

  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "change-log"
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $Mode
  $env:ONWARD_AUTOTEST_CWD = $tempWorkspace
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_AUTOTEST_SKIP_CONSENT = "1"
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_TAG = $TestTag
  $env:ONWARD_CHANGELOG_ROOT = $tempChangelog

  $timeoutRunner = Join-Path $RootDir "test\autotest\run-with-timeout.mjs"
  $runnerScript = @"
const fs = require('fs');
const { spawnSync } = require('child_process');
const fd = fs.openSync(process.argv[3], 'a');
let rc = 0;
try {
  const res = spawnSync(process.execPath, [process.argv[1], '60', process.argv[2]], { stdio: ['ignore', fd, fd], windowsHide: false });
  rc = res.status ?? 1;
} finally {
  fs.closeSync(fd);
}
process.exit(rc);
"@
  node -e $runnerScript $timeoutRunner $AppBin $LogFile
  if ($LASTEXITCODE -eq 124) {
    Get-Content $LogFile -Tail 120 | Write-Host
    throw "Change Log autotest scenario [$Mode] timed out after 60s. Log: $LogFile"
  }

  if (Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" -Quiet) {
    Get-Content $LogFile -Tail 160 | Write-Host
    throw "Change Log autotest failed during [$Mode]. Log: $LogFile"
  }

  foreach ($marker in $RequiredMarkers) {
    if (-not (Select-String -Path $LogFile -Pattern ([Regex]::Escape($marker)) -Quiet)) {
      Get-Content $LogFile -Tail 160 | Write-Host
      throw "Change Log autotest scenario [$Mode] missing marker '$marker'. Log: $LogFile"
    }
  }
}

try {
  # Seed a stale historical release file and verify single-latest pruning removes it
  $staleFile = Join-Path $tempChangelog "en\daily\$LegacyTag.md"
  Set-Content -Path $staleFile -Value "# Legacy release $LegacyTag" -Encoding UTF8

  Copy-Item -LiteralPath (Join-Path $RootDir "test\autotest\fixtures\change-log\index.json") -Destination (Join-Path $tempChangelog "index.json") -Force
  Copy-Item -LiteralPath (Join-Path $RootDir "test\autotest\fixtures\change-log\en\daily\$TestTag.md") -Destination (Join-Path $tempChangelog "en\daily\$TestTag.md") -Force
  Copy-Item -LiteralPath (Join-Path $RootDir "test\autotest\fixtures\change-log\html\en\daily\$TestTag.html") -Destination (Join-Path $tempChangelog "html\en\daily\$TestTag.html") -Force

  node (Join-Path $RootDir "scripts\compile-changelog.js") --root $tempChangelog
  if ($LASTEXITCODE -ne 0) {
    throw "compile-changelog.js failed with exit code $LASTEXITCODE"
  }

  if (Test-Path $staleFile) {
    throw "Expected single-latest pruning to remove stale file: $staleFile"
  }

  $compiledShowcase = Join-Path $tempChangelog "html\en\daily\$TestTag.html"
  if (-not (Test-Path $compiledShowcase)) {
    throw "Expected Showcase HTML to exist at: $compiledShowcase"
  }

  if (Test-Path $LogFile) {
    Remove-Item $LogFile -Force
  }

  # Scenario 1: Fresh install (default en setting) does NOT auto-open, renders animated stages + SVG + Esc close, and seeds legacy tag in localStorage
  Invoke-ChangeLogScenario `
    -Mode "fresh-install" `
    -UserDataDir $tempUserData `
    -RequiredMarkers @(
      "CL-00b-fresh-install-does-not-auto-open",
      "CL-05-renders-animated-stages-and-svg",
      "CL-06-auto-follows-en-language-setting",
      "CL-11-escape-closes-modal"
    )

  Start-Sleep -Milliseconds 800

  # Switch user language preference to zh-CN before the upgrade launch
  $seedSettings = @{
    language         = "zh-CN"
    telemetryConsent = $false
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText(
    (Join-Path $tempUserData "settings.json"),
    $seedSettings,
    (New-Object System.Text.UTF8Encoding($false))
  )

  # Scenario 2: First launch after upgrade (localStorage holds v9.9.1 -> current v9.9.9) auto-opens latest Showcase in zh-CN and advances stored tag
  Invoke-ChangeLogScenario `
    -Mode "upgrade-first-launch" `
    -UserDataDir $tempUserData `
    -RequiredMarkers @(
      "CL-UPG-01-auto-opens-on-upgrade",
      "CL-UPG-02-renders-latest-showcase-release",
      "CL-UPG-02b-auto-follows-zh-cn-language-setting",
      "CL-UPG-03-persists-latest-seen-tag"
    )

  Start-Sleep -Milliseconds 800

  # Scenario 3: Second launch on the same version stays closed
  Invoke-ChangeLogScenario `
    -Mode "upgrade-second-launch" `
    -UserDataDir $tempUserData `
    -RequiredMarkers @(
      "CL-UPG-04-relaunch-does-not-reopen"
    )

  Write-Host "Change Log autotest passed (all 3 scenarios). Log: $LogFile"
} finally {
  $envVars = @(
    "ONWARD_DEBUG",
    "ONWARD_AUTOTEST",
    "ONWARD_AUTOTEST_SUITE",
    "ONWARD_AUTOTEST_FIXTURE_EXTRA",
    "ONWARD_AUTOTEST_CWD",
    "ONWARD_AUTOTEST_EXIT",
    "ONWARD_AUTOTEST_SKIP_CONSENT",
    "ONWARD_USER_DATA_DIR",
    "ONWARD_TAG",
    "ONWARD_CHANGELOG_ROOT"
  )
  foreach ($varName in $envVars) {
    Remove-Item "Env:$varName" -ErrorAction SilentlyContinue
  }

  Remove-TreeWithRetry -TargetPath $tempRoot

  Get-ChildItem -LiteralPath $RootDir -Force -Filter "__autotest_*" -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-TreeWithRetry -TargetPath $_.FullName
  }
}
