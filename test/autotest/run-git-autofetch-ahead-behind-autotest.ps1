# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Git ahead/behind + background auto-fetch suite (AB-*) — Windows runner.
# Logical parity with run-git-autofetch-ahead-behind-autotest.sh: builds a local
# bare remote + clones fixture, launches the app under ONWARD_AUTOTEST with the
# automatic fetch loop DISABLED, and asserts the AB-00..17 markers. The fetch
# ceiling is shortened to $FetchCeilingMs for AB-08 via the autotest-only
# ONWARD_GIT_FETCH_CEILING_MS (production: 10 min, git-fetch-policy.ts).

param(
  [string]$AppBin,
  [string]$LogFile
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RepoRoot "test\autotest\Resolve-DevAppBin.ps1")

if (-not $AppBin) {
  $AppBin = Resolve-DevAppBin -RootDir $RepoRoot
}
if (-not $AppBin -or -not (Test-Path $AppBin)) {
  Write-Error "App binary not found: $AppBin`nRun a development build first: rm -rf out release && pnpm dist:dev"
  exit 1
}

$Suite = "git-autofetch-ahead-behind"
if (-not $LogFile) {
  $LogFile = Join-Path $RepoRoot "traces/test-logs/$Suite.log"
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }

# 240: AB-08 spends the (shortened) fetch ceiling BY DESIGN, AB-17 waits 22 s by
# design, and AB-14/15 repeat a ~3 s in-flight window 5 times.
# Kept in lockstep with the .sh runner (runner-parity hard rule).
$WatchdogSec = if ($env:WATCHDOG_SEC) { $env:WATCHDOG_SEC } else { "240" }
# Must exceed AB-17's 22 s delay and stay well under ext::sleep 60 (AB-08).
$FetchCeilingMs = "30000"
$RunTmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("onward-$Suite-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
$UserDataDir = Join-Path $RunTmpDir "user-data"
$FixtureDir = Join-Path $RunTmpDir "fixture"
New-Item -ItemType Directory -Force $UserDataDir | Out-Null
New-Item -ItemType Directory -Force $FixtureDir | Out-Null

try {
  $env:ONWARD_AB_FIXTURE_DIR = $FixtureDir
  $env:ONWARD_GIT_FETCH_CEILING_MS = $FetchCeilingMs
  $FixtureJson = & node (Join-Path $RepoRoot "test\autotest\create-git-autofetch-ahead-behind-fixture.mjs")
  Remove-Item Env:\ONWARD_AB_FIXTURE_DIR -ErrorAction SilentlyContinue
  $Fixture = $FixtureJson | ConvertFrom-Json
  $NeutralCwd = $Fixture.neutralCwd
  $ManifestPath = $Fixture.manifestPath

  Write-Host "Starting git ahead/behind + auto-fetch autotest..."
  Write-Host "  Binary:        $AppBin"
  Write-Host "  Neutral cwd:   $NeutralCwd"
  Write-Host "  Manifest:      $ManifestPath"
  Write-Host "  User data dir: $UserDataDir"
  Write-Host "  Watchdog:      ${WatchdogSec}s"
  Write-Host "  Log:           $LogFile"
  Write-Host ""

  $env:TMPDIR = $RunTmpDir
  $env:ONWARD_DEBUG = "1"
  $env:ONWARD_PERF_TRACE = "1"
  $env:ONWARD_REPO_ROOT = $RepoRoot
  $env:ONWARD_USER_DATA_DIR = $UserDataDir
  $env:ONWARD_AUTOTEST = "1"
  $env:ONWARD_AUTOTEST_SUITE = "git-autofetch-ahead-behind"
  $env:ONWARD_AUTOTEST_CWD = $NeutralCwd
  $env:ONWARD_AUTOTEST_FIXTURE_EXTRA = $ManifestPath
  $env:ONWARD_AUTOTEST_EXIT = "1"
  $env:ONWARD_DISABLE_GIT_AUTOFETCH = "1"
  $env:ONWARD_GIT_FETCH_CEILING_MS = $FetchCeilingMs

  $AppExit = 0
  & node (Join-Path $RepoRoot "test\autotest\run-with-timeout.mjs") $WatchdogSec $AppBin *> $LogFile
  if ($LASTEXITCODE -ne 0) { $AppExit = $LASTEXITCODE }

  foreach ($v in @("TMPDIR","ONWARD_DEBUG","ONWARD_PERF_TRACE","ONWARD_REPO_ROOT","ONWARD_USER_DATA_DIR","ONWARD_AUTOTEST","ONWARD_AUTOTEST_SUITE","ONWARD_AUTOTEST_CWD","ONWARD_AUTOTEST_FIXTURE_EXTRA","ONWARD_AUTOTEST_EXIT","ONWARD_DISABLE_GIT_AUTOFETCH","ONWARD_GIT_FETCH_CEILING_MS")) {
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
  }

  Write-Host ""
  Write-Host "=== Test log (last 60 lines) ==="
  Get-Content $LogFile -Tail 60
  Write-Host ""

  $content = Get-Content $LogFile -Raw

  if ($content -match "\[AutoTest\] FAIL") {
    Write-Host "git ahead/behind + auto-fetch autotest FAILED" -ForegroundColor Red
    Select-String -Path $LogFile -Pattern "\[AutoTest\] FAIL" | ForEach-Object { Write-Host $_.Line -ForegroundColor Red }
    exit 1
  }
  if ($AppExit -ne 0) {
    Write-Host "git ahead/behind + auto-fetch autotest exited with code $AppExit" -ForegroundColor Red
    exit $AppExit
  }

  $markers = @(
    "AB-00-fixture-loaded",
    "AB-01-up-to-date",
    "AB-02-ahead-only",
    "AB-03-behind-only",
    "AB-04-diverged",
    "AB-05-no-upstream-undefined",
    "AB-06-background-fetch-flips-behind",
    "AB-07-fast-failure-carries-evidence",
    "AB-08-timeout-failure-carries-evidence",
    "AB-09-success-stamps-last-fetch-ok",
    "AB-10-failure-marks-attempt-without-success",
    "AB-11-user-fetch-ipc-succeeds",
    "AB-12-no-remote-does-not-claim-unreachable",
    "AB-13-connection-refused-reports-unreachable",
    "AB-14-click-joins-running-fetch",
    "AB-15-in-flight-published-and-cleared",
    "AB-16a-manual-failure-reports-no-remote",
    "AB-16b-manual-failure-reports-network",
    "AB-17-slow-fetch-beyond-old-ceiling-succeeds"
  )
  foreach ($m in $markers) {
    if ($content -notmatch [regex]::Escape($m)) {
      Write-Host "Missing $m marker; the suite may not have completed" -ForegroundColor Yellow
      Get-Content $LogFile -Tail 40
      exit 1
    }
  }

  Write-Host "git ahead/behind + auto-fetch autotest PASSED" -ForegroundColor Green
  Write-Host "  Log: $LogFile"
}
finally {
  Remove-Item -Recurse -Force $RunTmpDir -ErrorAction SilentlyContinue
}
