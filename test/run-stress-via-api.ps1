# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
  Orchestrates a multi-terminal stress test via the Onward API server.

.DESCRIPTION
  1. Discovers running Onward instance via API health check
  2. Lists all terminals in the active tab
  3. Sends stress-test commands (stress-claude-output.ps1) to all terminals
  4. Waits for test duration while collecting PerfMonitor data from console output
  5. Stops tests and outputs performance analysis report

  PREREQUISITES:
  - Onward must be running with ONWARD_DEBUG=1 (for PerfMonitor output)
  - Switch to 6-pane layout in the UI before running this script
  - All 6 terminals should be initialized (showing a shell prompt)

.PARAMETER ApiPort
  API server port (auto-discovered if omitted).

.PARAMETER Duration
  Stress test duration in seconds (default: 30).

.PARAMETER Mode
  Output mode for the stress script: thinking, burst, mixed (default: mixed).
#>

param(
  [int]$ApiPort = 0,
  [int]$Duration = 30,
  [ValidateSet('thinking', 'burst', 'mixed')]
  [string]$Mode = 'mixed'
)

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$StressScript = Join-Path $RootDir "test\stress-claude-output.ps1"

# --- API helpers ---
function Invoke-OnwardApi {
  param([string]$Path, [string]$Method = 'GET', [hashtable]$Body)
  $uri = "http://127.0.0.1:$script:ApiPort/api$Path"
  $params = @{ Uri = $uri; Method = $Method; ContentType = 'application/json' }
  if ($Body) { $params.Body = ($Body | ConvertTo-Json) }
  try {
    $resp = Invoke-RestMethod @params
    return $resp
  } catch {
    Write-Host "  API error on $Path : $_" -ForegroundColor Red
    return $null
  }
}

# --- Step 1: Discover API port ---
if ($ApiPort -eq 0) {
  Write-Host "[1/6] Discovering Onward API port..." -ForegroundColor Cyan
  $found = $false
  # Try common Onward userData dirs
  $appData = $env:APPDATA
  $dirs = Get-ChildItem -Path $appData -Directory -Filter "Onward 2-*" -ErrorAction SilentlyContinue
  foreach ($dir in $dirs) {
    $lockFile = Join-Path $dir.FullName "onward-api.lock"
    if (Test-Path $lockFile) {
      $lock = Get-Content $lockFile -Raw | ConvertFrom-Json
      $ApiPort = $lock.port
      Write-Host "  Found lock file: port=$ApiPort (pid=$($lock.pid))" -ForegroundColor Green
      $found = $true
      break
    }
  }
  # Fallback: try netstat to find listening port
  if (-not $found) {
    Write-Host "  No lock file found, scanning ports..." -ForegroundColor Yellow
    $testPorts = @(59276, 59277, 59278, 59279, 59280, 49152..49200)
    foreach ($port in $testPorts) {
      try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1 -ErrorAction Stop
        if ($resp.status -eq 'ok' -and $resp.app -like 'Onward*') {
          $ApiPort = $port
          Write-Host "  Found Onward API on port $port (app=$($resp.app))" -ForegroundColor Green
          $found = $true
          break
        }
      } catch { }
    }
  }
  if (-not $found -or $ApiPort -eq 0) {
    Write-Error "Cannot find running Onward instance. Start Onward with ONWARD_DEBUG=1 first."
    exit 1
  }
} else {
  Write-Host "[1/6] Using specified API port: $ApiPort" -ForegroundColor Cyan
}

# Verify health
$health = Invoke-OnwardApi -Path "/health"
if (-not $health -or $health.status -ne 'ok') {
  Write-Error "Onward API at port $ApiPort is not responding."
  exit 1
}
Write-Host "  Connected: $($health.app) (uptime=$($health.uptime)s)" -ForegroundColor Green

# --- Step 2: List terminals ---
Write-Host "`n[2/6] Listing terminals in active tab..." -ForegroundColor Cyan
$tasks = Invoke-OnwardApi -Path "/tasks"
if (-not $tasks -or -not $tasks.tasks) {
  Write-Error "No terminals found. Open Onward and switch to 6-pane layout."
  exit 1
}

$termCount = $tasks.tasks.Count
Write-Host "  Tab: $($tasks.tabName) ($termCount terminals)" -ForegroundColor Green
foreach ($t in $tasks.tasks) {
  $activeFlag = if ($t.isActive) { " [active]" } else { "" }
  Write-Host "    #$($t.index) $($t.name)$activeFlag" -ForegroundColor Gray
}

if ($termCount -lt 2) {
  Write-Host "  WARNING: Only $termCount terminal(s). For a meaningful stress test, switch to 4 or 6-pane layout." -ForegroundColor Yellow
}

# --- Step 3: Record pre-test baseline ---
Write-Host "`n[3/6] Recording pre-test baseline (3 seconds)..." -ForegroundColor Cyan
Start-Sleep -Seconds 3
# Read buffer from first terminal to check if PerfMon is visible in console
$baseBuffer = Invoke-OnwardApi -Path "/terminal/$($tasks.tasks[0].id)/buffer?mode=tail-lines&lines=20"
$hasPerfMon = $false
if ($baseBuffer -and $baseBuffer.content -match '\[PerfMon\]') {
  $hasPerfMon = $true
  Write-Host "  PerfMonitor output detected in terminal" -ForegroundColor Green
} else {
  Write-Host "  PerfMonitor output not in terminal buffer (will check console log)" -ForegroundColor Yellow
}

# --- Step 4: Send stress commands to all terminals ---
Write-Host "`n[4/6] Sending stress test to all $termCount terminals (duration=${Duration}s, mode=$Mode)..." -ForegroundColor Cyan

$stressCmd = "pwsh -NoLogo -File `"$StressScript`" -Duration $Duration -Mode $Mode"
Write-Host "  Command: $stressCmd" -ForegroundColor Gray

$startTime = Get-Date
foreach ($t in $tasks.tasks) {
  $resp = Invoke-OnwardApi -Path "/terminal/$($t.id)/write" -Method 'POST' -Body @{
    text = $stressCmd
    execute = $true
  }
  if ($resp -and $resp.success) {
    Write-Host "    -> #$($t.index) $($t.name): sent" -ForegroundColor Green
  } else {
    Write-Host "    -> #$($t.index) $($t.name): FAILED" -ForegroundColor Red
  }
  Start-Sleep -Milliseconds 200
}

# --- Step 5: Wait and collect data ---
Write-Host "`n[5/6] Stress test running... collecting performance snapshots" -ForegroundColor Cyan
$snapshots = @()
$checkInterval = 5
$elapsed = 0

while ($elapsed -lt $Duration) {
  $waitSec = [Math]::Min($checkInterval, $Duration - $elapsed)
  Start-Sleep -Seconds $waitSec
  $elapsed += $waitSec

  $pct = [Math]::Floor($elapsed / $Duration * 100)
  Write-Host "  [$pct%] ${elapsed}s / ${Duration}s elapsed" -ForegroundColor Gray -NoNewline

  # Try to read PerfMon data from terminal buffers
  foreach ($t in $tasks.tasks) {
    $buf = Invoke-OnwardApi -Path "/terminal/$($t.id)/buffer?mode=tail-chars&chars=3000"
    if ($buf -and $buf.content) {
      $lines = $buf.content -split "`n"
      foreach ($line in $lines) {
        if ($line -match '\[PerfMon\]\s+fps=(\d+)\s+drops=(\d+)\s+longest=([\d.]+)ms\s+writes=(\d+)\s+writeMax=([\d.]+)ms\s+ipc=(\d+)\s+ipcMB=([\d.]+)\s+hidden=(\d+)\s+webgl=(\d+)\s+renders=(\d+)') {
          $snap = [PSCustomObject]@{
            timestamp = $elapsed
            fps       = [int]$Matches[1]
            drops     = [int]$Matches[2]
            longest   = [double]$Matches[3]
            writes    = [int]$Matches[4]
            writeMax  = [double]$Matches[5]
            ipc       = [int]$Matches[6]
            ipcMB     = [double]$Matches[7]
            hidden    = [int]$Matches[8]
            webgl     = [int]$Matches[9]
            renders   = [int]$Matches[10]
          }
          # Avoid duplicates (same fps+writes+ipc combo)
          $isDupe = $snapshots | Where-Object { $_.fps -eq $snap.fps -and $_.writes -eq $snap.writes -and $_.ipc -eq $snap.ipc -and $_.hidden -eq $snap.hidden }
          if (-not $isDupe) {
            $snapshots += $snap
          }
        }
      }
    }
  }
  Write-Host " (snapshots: $($snapshots.Count))" -ForegroundColor DarkGray
}

$endTime = Get-Date
$totalSec = ($endTime - $startTime).TotalSeconds

# --- Step 6: Analyze and report ---
Write-Host "`n[6/6] Analysis Report" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor White

if ($snapshots.Count -eq 0) {
  Write-Host "  No PerfMonitor snapshots captured." -ForegroundColor Yellow
  Write-Host "  This may happen if:" -ForegroundColor Yellow
  Write-Host "    - ONWARD_DEBUG was not set to 1 when launching the app" -ForegroundColor Yellow
  Write-Host "    - PerfMonitor output is only in DevTools console (not in terminal buffer)" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  To check manually: Open Onward DevTools (Ctrl+Shift+I) -> Console tab" -ForegroundColor Yellow
  Write-Host "  Look for [PerfMon] lines with fps, writes, hidden counters" -ForegroundColor Yellow
} else {
  Write-Host "`nPerformance Snapshots: $($snapshots.Count)" -ForegroundColor White
  Write-Host "Test Duration: $([Math]::Round($totalSec, 1))s | Terminals: $termCount | Mode: $Mode" -ForegroundColor Gray

  $avgFps    = ($snapshots | Measure-Object -Property fps -Average).Average
  $minFps    = ($snapshots | Measure-Object -Property fps -Minimum).Minimum
  $maxDrops  = ($snapshots | Measure-Object -Property drops -Maximum).Maximum
  $maxLongest = ($snapshots | Measure-Object -Property longest -Maximum).Maximum
  $avgWrites = ($snapshots | Measure-Object -Property writes -Average).Average
  $maxWriteMs = ($snapshots | Measure-Object -Property writeMax -Maximum).Maximum
  $avgIpc    = ($snapshots | Measure-Object -Property ipc -Average).Average
  $totalHidden = ($snapshots | Measure-Object -Property hidden -Sum).Sum
  $avgWebgl  = ($snapshots | Measure-Object -Property webgl -Average).Average

  Write-Host ""
  Write-Host "  Frame Rate:" -ForegroundColor White
  Write-Host "    avg fps          = $([Math]::Round($avgFps, 1))" -ForegroundColor $(if ($avgFps -ge 25) { 'Green' } elseif ($avgFps -ge 15) { 'Yellow' } else { 'Red' })
  Write-Host "    min fps          = $minFps" -ForegroundColor $(if ($minFps -ge 15) { 'Green' } elseif ($minFps -ge 5) { 'Yellow' } else { 'Red' })
  Write-Host "    max frame drops  = $maxDrops" -ForegroundColor Gray
  Write-Host "    max longest frame= $([Math]::Round($maxLongest, 1))ms" -ForegroundColor $(if ($maxLongest -lt 100) { 'Green' } elseif ($maxLongest -lt 300) { 'Yellow' } else { 'Red' })

  Write-Host ""
  Write-Host "  Terminal Rendering:" -ForegroundColor White
  Write-Host "    avg xterm writes = $([Math]::Round($avgWrites, 0))/s" -ForegroundColor Gray
  Write-Host "    max write time   = $([Math]::Round($maxWriteMs, 1))ms" -ForegroundColor $(if ($maxWriteMs -lt 20) { 'Green' } elseif ($maxWriteMs -lt 50) { 'Yellow' } else { 'Red' })
  Write-Host "    avg IPC msgs     = $([Math]::Round($avgIpc, 0))/s" -ForegroundColor Gray

  Write-Host ""
  Write-Host "  Optimization Metrics:" -ForegroundColor White
  Write-Host "    hidden writes    = $totalHidden (buffered, NOT rendered)" -ForegroundColor $(if ($totalHidden -gt 0) { 'Green' } else { 'Gray' })
  Write-Host "    avg WebGL ctx    = $([Math]::Round($avgWebgl, 1))" -ForegroundColor Gray

  Write-Host ""
  if ($totalHidden -gt 0) {
    Write-Host "  [OK] Hidden terminal optimization is ACTIVE" -ForegroundColor Green
    Write-Host "       $totalHidden data chunks were buffered instead of rendered" -ForegroundColor Green
  } else {
    Write-Host "  [INFO] No hidden terminal writes detected" -ForegroundColor Yellow
    Write-Host "         All terminals may be in the visible tab" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "=" * 60 -ForegroundColor White
Write-Host "Done. Raw data: $($snapshots.Count) snapshots collected." -ForegroundColor Green
