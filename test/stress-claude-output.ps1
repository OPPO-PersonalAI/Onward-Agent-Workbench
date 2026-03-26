# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0

<#
.SYNOPSIS
  Simulates Claude Code terminal output patterns for performance stress testing.

.DESCRIPTION
  Produces three output modes that mimic Claude Code behaviour:
    A) Thinking — slow streaming with grey ANSI text
    B) Code burst — rapid output with syntax-highlighted ANSI
    C) Tool call — ANSI-intensive cursor operations and progress redraws

  Run in multiple Onward terminal panes simultaneously to stress-test
  the renderer under realistic multi-terminal load.

.PARAMETER Duration
  Total run time in seconds (default: 60).

.PARAMETER Mode
  Output mode: 'thinking', 'burst', 'mixed' (default: mixed).
#>

param(
  [int]$Duration = 60,
  [ValidateSet('thinking', 'burst', 'mixed')]
  [string]$Mode = 'mixed'
)

$ESC = [char]0x1b
$startTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$endTime = $startTime + ($Duration * 1000)

# --- ANSI helpers ---
function Write-Ansi([string]$text) {
  [Console]::Out.Write($text)
}

# --- Mode A: Thinking (slow stream) ---
function Invoke-ThinkingMode {
  $thoughts = @(
    "Let me analyze the performance bottleneck in the terminal rendering pipeline..."
    "The issue appears to be related to xterm.js write() calls on hidden terminals..."
    "I can see that TerminalDataBuffer batches at 16ms intervals, but with 6 terminals..."
    "Each WebGL context requires GPU resources. With 6 active contexts..."
    "The IPC message rate peaks at approximately 360 messages per second..."
    "Looking at the React component tree, TerminalGrid re-renders on every git info update..."
    "I'll trace the data flow: PTY onData -> TerminalDataBuffer -> IPC -> session.terminal.write()..."
    "The main thread appears blocked during xterm.js ANSI parsing of large chunks..."
  )

  $idx = Get-Random -Minimum 0 -Maximum $thoughts.Count
  $text = $thoughts[$idx]

  # Print the bullet point
  Write-Ansi "${ESC}[34m`u{25CF}${ESC}[0m ${ESC}[90m"

  # Stream character by character
  foreach ($ch in $text.ToCharArray()) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($now -ge $script:endTime) { return }
    Write-Ansi $ch
    Start-Sleep -Milliseconds (Get-Random -Minimum 15 -Maximum 60)
  }
  Write-Ansi "${ESC}[0m`n"
  Start-Sleep -Milliseconds (Get-Random -Minimum 200 -Maximum 800)
}

# --- Mode B: Code burst (rapid output) ---
function Invoke-BurstMode {
  $codeBlocks = @(
    @"
${ESC}[32m$('```')typescript${ESC}[0m
${ESC}[33mclass${ESC}[0m ${ESC}[37mTerminalDataBuffer${ESC}[0m {
  ${ESC}[36mprivate${ESC}[0m chunks: ${ESC}[33mstring${ESC}[0m[] = []
  ${ESC}[36mprivate${ESC}[0m totalBytes = ${ESC}[35m0${ESC}[0m
  ${ESC}[36mprivate${ESC}[0m timer: ReturnType<${ESC}[33mtypeof${ESC}[0m setTimeout> | ${ESC}[35mnull${ESC}[0m = ${ESC}[35mnull${ESC}[0m

  ${ESC}[36mprivate static readonly${ESC}[0m FLUSH_INTERVAL_MS = ${ESC}[35m16${ESC}[0m
  ${ESC}[36mprivate static readonly${ESC}[0m FORCE_FLUSH_BYTES = ${ESC}[35m65536${ESC}[0m

  push(data: ${ESC}[33mstring${ESC}[0m): ${ESC}[33mvoid${ESC}[0m {
    ${ESC}[36mif${ESC}[0m (${ESC}[36mthis${ESC}[0m.disposed) ${ESC}[36mreturn${ESC}[0m
    ${ESC}[36mthis${ESC}[0m.chunks.push(data)
    ${ESC}[36mthis${ESC}[0m.totalBytes += data.length

    ${ESC}[36mif${ESC}[0m (${ESC}[36mthis${ESC}[0m.totalBytes >= TerminalDataBuffer.FORCE_FLUSH_BYTES) {
      ${ESC}[36mthis${ESC}[0m.flush()
      ${ESC}[36mreturn${ESC}[0m
    }
  }

  flush(): ${ESC}[33mvoid${ESC}[0m {
    ${ESC}[36mif${ESC}[0m (${ESC}[36mthis${ESC}[0m.chunks.length === ${ESC}[35m0${ESC}[0m) ${ESC}[36mreturn${ESC}[0m
    ${ESC}[36mconst${ESC}[0m merged = ${ESC}[36mthis${ESC}[0m.chunks.join(${ESC}[33m''${ESC}[0m)
    ${ESC}[36mthis${ESC}[0m.send(${ESC}[36mthis${ESC}[0m.terminalId, merged)
  }
}
${ESC}[32m$('```')${ESC}[0m
"@,
    @"
${ESC}[32m$('```')typescript${ESC}[0m
${ESC}[33mexport function${ESC}[0m ${ESC}[37mregisterGlobalDataListener${ESC}[0m(): ${ESC}[33mvoid${ESC}[0m {
  window.electronAPI.terminal.onData((termId, data) => {
    ${ESC}[36mconst${ESC}[0m session = ${ESC}[36mthis${ESC}[0m.sessions.get(termId)
    ${ESC}[36mif${ESC}[0m (!session) ${ESC}[36mreturn${ESC}[0m

    ${ESC}[90m// Performance instrumentation${ESC}[0m
    ${ESC}[36mconst${ESC}[0m t0 = performance.now()
    session.terminal.write(data)
    ${ESC}[36mconst${ESC}[0m elapsed = performance.now() - t0

    ${ESC}[90m// Track hidden terminal overhead${ESC}[0m
    ${ESC}[36mif${ESC}[0m (!session.container) {
      perfMonitor.recordHiddenTermWrite(data.length)
    }
    perfMonitor.recordXtermWrite(elapsed)
    perfMonitor.recordIpcData(data.length)
  })
}
${ESC}[32m$('```')${ESC}[0m
"@,
    @"
${ESC}[32m$('```')css${ESC}[0m
${ESC}[33m.terminal-grid-hidden${ESC}[0m {
  ${ESC}[36mposition${ESC}[0m: ${ESC}[35mabsolute${ESC}[0m;
  ${ESC}[36mleft${ESC}[0m: ${ESC}[35m-9999px${ESC}[0m;
  ${ESC}[36mvisibility${ESC}[0m: ${ESC}[35mhidden${ESC}[0m;
  ${ESC}[36mpointer-events${ESC}[0m: ${ESC}[35mnone${ESC}[0m;
}

${ESC}[33m.terminal-grid${ESC}[0m[${ESC}[36mdata-layout${ESC}[0m="${ESC}[35m6${ESC}[0m"] {
  ${ESC}[36mgrid-template-columns${ESC}[0m: ${ESC}[35m1fr 1fr 1fr${ESC}[0m;
  ${ESC}[36mgrid-template-rows${ESC}[0m: ${ESC}[35m1fr 1fr${ESC}[0m;
}
${ESC}[32m$('```')${ESC}[0m
"@
  )

  $idx = Get-Random -Minimum 0 -Maximum $codeBlocks.Count
  $block = $codeBlocks[$idx]

  # Simulate rapid line-by-line output
  foreach ($line in $block -split "`n") {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($now -ge $script:endTime) { return }
    Write-Ansi "$line`n"
    Start-Sleep -Milliseconds (Get-Random -Minimum 5 -Maximum 20)
  }
  Write-Ansi "`n"
}

# --- Mode C: Tool call (ANSI-intensive) ---
function Invoke-ToolCallMode {
  $tools = @(
    @{ name = "Read"; target = "src/terminal/terminal-session-manager.ts"; lines = 556 },
    @{ name = "Grep"; target = "registerGlobalDataListener"; files = 3 },
    @{ name = "Glob"; target = "**/*.tsx"; files = 47 },
    @{ name = "Read"; target = "electron/main/ipc-handlers.ts"; lines = 312 },
    @{ name = "Edit"; target = "src/utils/perf-monitor.ts"; lines = 24 }
  )

  $tool = $tools[(Get-Random -Minimum 0 -Maximum $tools.Count)]

  # Tool header
  Write-Ansi "${ESC}[34m`u{25CF}${ESC}[0m ${ESC}[1m$($tool.name)${ESC}[0m ${ESC}[90m$($tool.target)${ESC}[0m`n"
  Start-Sleep -Milliseconds 100

  # Simulate progress bar with cursor manipulation
  $total = if ($tool.lines) { $tool.lines } else { $tool.files * 50 }
  $steps = [Math]::Min(20, $total)
  for ($i = 1; $i -le $steps; $i++) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($now -ge $script:endTime) { return }
    $pct = [Math]::Floor(($i / $steps) * 100)
    $filled = [Math]::Floor($i / $steps * 30)
    $empty = 30 - $filled
    $bar = "$('=' * $filled)$('>' * [Math]::Min(1, $empty))$(' ' * [Math]::Max(0, $empty - 1))"
    # Cursor up + erase line + redraw
    Write-Ansi "${ESC}[2K${ESC}[G  ${ESC}[36m[$bar]${ESC}[0m ${ESC}[90m${pct}%${ESC}[0m"
    Start-Sleep -Milliseconds (Get-Random -Minimum 10 -Maximum 40)
  }
  Write-Ansi "`n"

  # Result line
  if ($tool.lines) {
    Write-Ansi "  ${ESC}[32m`u{2713}${ESC}[0m ${ESC}[90m$($tool.lines) lines${ESC}[0m`n`n"
  } else {
    Write-Ansi "  ${ESC}[32m`u{2713}${ESC}[0m ${ESC}[90m$($tool.files) files matched${ESC}[0m`n`n"
  }
  Start-Sleep -Milliseconds 200
}

# --- Main loop ---
Write-Ansi "${ESC}[1m[stress-test]${ESC}[0m Starting Claude Code output simulation`n"
Write-Ansi "${ESC}[90m  Duration: ${Duration}s  Mode: $Mode${ESC}[0m`n`n"

$iteration = 0
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $endTime) {
  $iteration++

  switch ($Mode) {
    'thinking' {
      Invoke-ThinkingMode
    }
    'burst' {
      Invoke-BurstMode
    }
    'mixed' {
      # Cycle through all three modes
      $phase = $iteration % 3
      switch ($phase) {
        0 { Invoke-ThinkingMode; Invoke-ThinkingMode; Invoke-ThinkingMode }
        1 { Invoke-BurstMode; Invoke-BurstMode }
        2 { Invoke-ToolCallMode; Invoke-ToolCallMode }
      }
    }
  }
}

Write-Ansi "`n${ESC}[1m[stress-test]${ESC}[0m Done ($iteration iterations)`n"
