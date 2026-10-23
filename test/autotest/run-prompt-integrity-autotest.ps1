# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$RootDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot "Resolve-DevAppBin.ps1")
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin -or -not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
  throw "Packaged development executable missing. Pass its exact path with -AppBin."
}
$AppBin = (Resolve-Path -LiteralPath $AppBin).ProviderPath
if (-not $LogFile) {
  $LogFile = Join-Path $RootDir "traces/test-logs/prompt-integrity-autotest.log"
}
$LogFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($LogFile)
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null

$ProcessName = [IO.Path]::GetFileName($AppBin)
$Scratch = Join-Path ([IO.Path]::GetTempPath()) ("onward-prompt-integrity-" + [Guid]::NewGuid().ToString("N"))
$WorkDir = Join-Path $Scratch "work"
$UserDataDir = Join-Path $Scratch "user-data"
$Environment = @{
  ONWARD_REPO_ROOT = $RootDir
  ONWARD_USER_DATA_DIR = $UserDataDir
  ONWARD_PERF_TRACE = "1"
  ONWARD_DEBUG = "1"
  ONWARD_AUTOTEST = "1"
  ONWARD_AUTOTEST_SUITE = "prompt-integrity"
  ONWARD_AUTOTEST_CWD = $WorkDir
  ONWARD_AUTOTEST_EXIT = "1"
}
$PreviousEnvironment = @{}
foreach ($Name in $Environment.Keys) {
  $PreviousEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
}
$Result = 1
$LocationPushed = $false
try {
  & node (Join-Path $RootDir "test/autotest/fixtures/prompt-capture-stdin.cjs") --prepare $WorkDir
  if ($LASTEXITCODE -ne 0) { throw "Fixture preparation failed." }
  New-Item -ItemType Directory -Force $UserDataDir | Out-Null
  foreach ($Name in $Environment.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $Environment[$Name], "Process")
  }
  try { & taskkill.exe /IM $ProcessName /T /F *> $null } catch {}
  Start-Sleep -Milliseconds 500
  Write-Host "Starting prompt integrity autotest..."
  Write-Host "  Binary: $AppBin"
  Write-Host "  CWD:    $WorkDir"
  Write-Host "  Log:    $LogFile"
  Push-Location -LiteralPath $WorkDir
  $LocationPushed = $true
  try {
    # Windows PowerShell 5 treats native stderr as ErrorRecords. Electron's
    # diagnostic stderr must not terminate the runner before its exit-code gate.
    $ErrorActionPreference = "Continue"
    & node (Join-Path $PSScriptRoot "run-with-timeout.mjs") 180 $AppBin *> $LogFile
    $AppStatus = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = "Stop"
  }
  $LogContent = Get-Content -LiteralPath $LogFile -Raw
  Get-Content -LiteralPath $LogFile -Tail 120
  if ($AppStatus -ne 0) { throw "Prompt integrity app exited unsuccessfully: $AppStatus" }
  if ($LogContent -match "\[AutoTest\] FAIL") { throw "Prompt integrity assertions failed." }
  if ($LogContent -notmatch "PI-99-exact-input-contract-complete") {
    throw "Missing PI-99 completion; all five trials must finish."
  }
  $Result = 0
} catch {
  Write-Host "Prompt integrity autotest failed: $_" -ForegroundColor Red
} finally {
  if ($LocationPushed) { Pop-Location }
  try { & taskkill.exe /IM $ProcessName /T /F *> $null } catch {}
  for ($Attempt = 0; $Attempt -lt 5; $Attempt++) {
    try {
      if (Test-Path -LiteralPath $Scratch) { Remove-Item -LiteralPath $Scratch -Recurse -Force }
      break
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (Test-Path -LiteralPath $Scratch) {
    Write-Host "Scratch cleanup failed: $Scratch" -ForegroundColor Red
    $Result = 1
  }
  foreach ($Name in $Environment.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $PreviousEnvironment[$Name], "Process")
  }
}
if ($Result -eq 0) { Write-Host "Prompt integrity autotest passed. Log: $LogFile" }
exit $Result
