# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$AppBin = "",
  [string]$LogFile = ""
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
. (Join-Path $RootDir "test\autotest\Resolve-DevAppBin.ps1")
if (-not $AppBin) { $AppBin = Resolve-DevAppBin -RootDir $RootDir }
if (-not $AppBin -or -not (Test-Path -LiteralPath $AppBin -PathType Leaf)) {
  throw "Packaged development executable missing; run a clean pnpm dist:dev first."
}
if (-not $LogFile) { $LogFile = Join-Path $RootDir "traces\test-logs\prompt-sender-autotest.log" }
$LogFile = [IO.Path]::GetFullPath($LogFile)
$TraceRoot = [IO.Path]::GetFullPath((Join-Path $RootDir "traces")) + [IO.Path]::DirectorySeparatorChar
if (-not $LogFile.StartsWith($TraceRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Sender logs must be under the repository traces directory."
}
New-Item -ItemType Directory -Force (Split-Path -Parent $LogFile) | Out-Null

$ImageName = [IO.Path]::GetFileName($AppBin)
$AppPath = [IO.Path]::GetFullPath($AppBin)
$ScratchDir = Join-Path ([IO.Path]::GetTempPath()) ("onward-prompt-sender-" + [Guid]::NewGuid().ToString("N"))
$WorkDir = Join-Path $ScratchDir "work"
$UserDataDir = Join-Path $ScratchDir "user-data"
$ExitCode = 1
$EnvironmentBefore = @{}
$EnvironmentForRun = @{
  ONWARD_DEBUG = "1"
  ONWARD_AUTOTEST = "1"
  ONWARD_AUTOTEST_SUITE = "prompt-sender"
  ONWARD_AUTOTEST_CWD = $WorkDir
  ONWARD_AUTOTEST_EXIT = "1"
  ONWARD_AUTOTEST_SKIP_CONSENT = "1"
  ONWARD_USER_DATA_DIR = $UserDataDir
  ONWARD_REPO_ROOT = $RootDir
  ONWARD_PERF_TRACE = "1"
}

function Stop-SenderApp {
  # Windows Electron helpers share the image name. Query exact image identity,
  # exclude --type child processes, then terminate only the verified main PID.
  $previous = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $NameFilter = $ImageName.Replace("'", "\'")
    $Processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = '$NameFilter'" -ErrorAction SilentlyContinue
    foreach ($Process in $Processes) {
      if ($Process.ExecutablePath -eq $AppPath -and $Process.CommandLine -and $Process.CommandLine -notmatch '(?:^|[\s"])--type(?:=|\s)') {
        & taskkill.exe /F /PID $Process.ProcessId 2>$null | Out-Null
      }
    }
  } finally { $ErrorActionPreference = $previous }
}

try {
  New-Item -ItemType Directory -Force $WorkDir, $UserDataDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $RootDir "test\autotest\fixtures\prompt-shell-ready.cjs") -Destination (Join-Path $WorkDir "prompt-shell-ready.cjs")
  [IO.File]::WriteAllText((Join-Path $WorkDir ".prompt-sender-root"), "prompt-sender-v2`n", (New-Object Text.UTF8Encoding $false))
  foreach ($Name in $EnvironmentForRun.Keys) {
    $EnvironmentBefore[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
    [Environment]::SetEnvironmentVariable($Name, $EnvironmentForRun[$Name], "Process")
  }
  Stop-SenderApp
  Start-Sleep -Milliseconds 500
  Write-Host "Starting prompt sender autotest. CWD: $WorkDir; log: $LogFile"
  # The shared watchdog preserves nonzero process exits and leaves cleanup
  # margin below the full regression's hard 300-second runner ceiling.
  $Node = (Get-Command node -ErrorAction Stop).Source
  # Windows PowerShell 5 wraps redirected native stderr as non-terminating
  # errors. Electron diagnostics on stderr must not abort an otherwise valid run.
  try {
    $ErrorActionPreference = "Continue"
    & $Node (Join-Path $RootDir "test\autotest\run-with-timeout.mjs") 280 $AppBin *> $LogFile
    $AppStatus = $LASTEXITCODE
  } finally { $ErrorActionPreference = "Stop" }
  $LogContent = Get-Content -LiteralPath $LogFile -Raw
  if ($AppStatus -ne 0 -or $LogContent -match '\[AutoTest\] FAIL|totalFailed"?\s*:\s*[1-9]|autotest-error') {
    throw "Prompt sender failed (exit $AppStatus). Log: $LogFile"
  }
  if ($LogContent -notmatch 'PASS PS-99-contract-completed' -or $LogContent -notmatch 'Autotest Completed') {
    throw "Prompt sender did not complete every contract case. Log: $LogFile"
  }
  $ExitCode = 0
} catch {
  Write-Host $_ -ForegroundColor Red
  if (Test-Path -LiteralPath $LogFile) { Get-Content -LiteralPath $LogFile -Tail 120 }
} finally {
  Stop-SenderApp
  foreach ($Name in $EnvironmentBefore.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $EnvironmentBefore[$Name], "Process")
  }
  # File handles may outlive the parent briefly on Windows; bounded cleanup
  # retries do not retry assertions or conceal an app/test failure.
  for ($Attempt = 0; $Attempt -lt 5 -and (Test-Path -LiteralPath $ScratchDir); $Attempt++) {
    try { Remove-Item -LiteralPath $ScratchDir -Recurse -Force } catch { Start-Sleep -Milliseconds 300 }
  }
  if (Test-Path -LiteralPath $ScratchDir) {
    Write-Host "Could not remove sender scratch: $ScratchDir" -ForegroundColor Red
    $ExitCode = 1
  }
}
if ($ExitCode -eq 0) { Write-Host "Prompt sender autotest passed. Log: $LogFile" }
exit $ExitCode
