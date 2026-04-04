<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Performance Regression Testing Guide

This guide describes how to run manual and semi-automated performance regression tests for the Onward terminal application. The primary focus is **input responsiveness under multi-terminal load** — the scenario where multiple terminals are producing high-volume output (e.g., Claude Code running in 3-6 panes) while the user types in the Prompt input area.

## Prerequisites

- A development build of Onward with `ONWARD_DEBUG=1` (enables PerfMonitor output in DevTools console).
- Build command: `rm -rf out release && pnpm dist:dev`
- Launch: set environment variable `ONWARD_DEBUG=1` before starting the app.

## 1. Terminal Stress Test (6-Pane Output Flood)

### Purpose

Verify that the Prompt input area remains responsive when all 6 terminal panes are producing continuous high-volume output simultaneously. This is the most demanding real-world scenario (e.g., 3 Claude Code instances plus 3 build/test terminals all running at once).

### Steps

1. **Launch the app** with `ONWARD_DEBUG=1`.

2. **Open 6-pane layout**: Click the 6-grid icon in the left sidebar.

3. **Start continuous output in all 6 terminals**. In each terminal, run:

   ```powershell
   # Windows PowerShell
   while ($true) { echo "stress-$(Get-Date -f ss.fff)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
   ```

   ```bash
   # macOS / Linux
   yes "stress-$(date +%s.%N)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```

   Alternatively, use the provided stress script (simulates Claude Code output patterns):

   ```powershell
   # Windows — requires PowerShell 7+
   pwsh -NoLogo -File test/stress-claude-output.ps1 -Duration 600 -Mode mixed
   ```

   ```bash
   # macOS / Linux
   bash test/stress-claude-output.sh 600 mixed
   ```

   To send the command to all 6 terminals at once via the API:

   ```bash
   API="http://127.0.0.1:<port>"  # port from /api/health
   TIDS=$(curl -s "$API/api/tasks" | python3 -c "import sys,json; [print(t['id']) for t in json.load(sys.stdin)['tasks']]" | tr -d '\r')
   while IFS= read -r tid; do
     curl -s -X POST "$API/api/terminal/$tid/write" \
       -H "Content-Type: application/json" \
       -d '{"text":"while ($true) { echo \"stress-$(Get-Date -f ss.fff)-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" }","execute":true}'
     sleep 2
   done <<< "$TIDS"
   ```

4. **Type in the active terminal and in the Prompt input area** while output is running. Pay attention to:
   - Keystroke-to-character delay (should feel instant, target < 80ms, never obviously delayed)
   - Cursor movement responsiveness
   - Whether the Prompt area freezes or stutters

5. **Let the test run for at least 10-20 minutes** to catch long-running degradation (memory pressure, GC pauses, resource leaks).

6. **Stop all terminals**: Press `Ctrl+C` in each terminal, or send via API:

   ```bash
   while IFS= read -r tid; do
     curl -s -X POST "$API/api/terminal/$tid/write" \
       -H "Content-Type: application/json" -d '{"text":"\u0003","execute":false}'
   done <<< "$TIDS"
   ```

### Key Metrics (from DevTools Console)

Open DevTools (`Ctrl+Shift+I`) and look for `[PerfMon]` lines in the Console tab. Key fields:

| Metric | Healthy | Degraded | Meaning |
|--------|---------|----------|---------|
| `fps` | 28-33 | < 15 or 0 | Renderer frame rate; 0 means main thread is completely blocked |
| `drops` | 0-3 | > 10 | Frames exceeding 33ms threshold per second |
| `longest` | < 50ms | > 200ms | Longest single frame in the last second |
| `writes` | < 100/s | > 500/s | xterm.write() calls per second (should be throttled) |
| `writeMax` | < 5ms | > 20ms | Most expensive single xterm.write() call |
| `ipc` | < 80/s | > 200/s | IPC messages from main process per second |
| `hidden` | 0 (if all visible) | > 0 when tabs hidden | Data chunks buffered instead of rendered |

### Expected Results (Current Baseline)

With focused-terminal interactive boost enabled:

| Condition | fps | writes/s | ipc/s | Typing feel |
|-----------|-----|----------|-------|-------------|
| 6 terminals idle | 32 | 0 | 0 | Instant |
| 6 terminals max output | 28-32 | 40-80 | bursty on focused terminal | Responsive |
| 6 output + typing in focused terminal | 28-32 | focused terminal may spike temporarily | focused terminal may spike temporarily | Still feels near-instant |

## 2. Hidden Terminal Optimization Verification

### Purpose

Verify that terminals in background tabs do not consume rendering resources.

### Steps

1. Open 6-pane layout in **Tab A**.
2. Start continuous output in all 6 terminals.
3. Create a new **Tab B** and switch to it.
4. Check PerfMon output: `hidden` counter should increase (data is being buffered, not rendered).
5. `writes` should drop significantly (only Tab B's terminals are rendered).
6. Switch back to Tab A: buffered data should flush and output should appear.

### Expected Results

| Metric | Tab A visible | Tab B visible (Tab A hidden) |
|--------|--------------|------------------------------|
| `writes/s` | 40-60 | < 10 (only Tab B terminals) |
| `hidden` | 0 | > 0 (Tab A data buffered) |
| `fps` | 31-32 | 32-33 (less rendering work) |

## 3. Automated Stress Test Suite

The `src/autotest/test-terminal-stress.ts` file contains automated tests (TP-06 through TP-10) that can be run via:

```powershell
# Windows
pwsh test/run-terminal-stress-autotest.ps1

# macOS / Linux
bash test/run-terminal-stress-autotest.sh
```

These tests programmatically create terminals, inject output, toggle visibility via `setVisibility()`, and measure performance. They complement the manual test above but do not replace it — manual testing captures the real Prompt input feel that automated probes cannot fully measure.

## 4. Performance Architecture Overview

The terminal data pipeline and where throttling occurs:

```
PTY (node-pty)
  -> TerminalDataBuffer (main process, 100ms flush interval)
     -> IPC: webContents.send('terminal:data', id, merged)
        -> Renderer: registerGlobalDataListener()
           -> pendingData[] buffer (per session)
              -> requestAnimationFrame + 50ms throttle
                 -> terminal.write(merged)  (~20 fps)
```

Key optimization points:
- **Main process**: `TerminalDataBuffer.FLUSH_INTERVAL_MS = 100` (was 16)
- **Renderer**: `VISIBLE_WRITE_THROTTLE_MS = 50` with rAF scheduling
- **Focused terminal input**: recent user input enables a short interactive bypass window in both main and renderer
- **Hidden terminals**: Data buffered in `pendingData[]`, skips `terminal.write()` entirely
- **WebGL pooling**: Hidden terminals release GPU contexts via `setVisibility(false)`

## 5. Regression Checklist

When making changes to the terminal rendering pipeline, verify:

- [ ] 6-pane layout opens without hanging at "Initializing"
- [ ] `fps` stays above 28 under 6-terminal full output
- [ ] `writes/s` stays below 100 (throttle is working)
- [ ] Focused terminal typing remains responsive while terminals are outputting
- [ ] Prompt input area is responsive while terminals are outputting
- [ ] Switching tabs flushes buffered data correctly
- [ ] Hidden terminals show `hidden > 0` in PerfMon
- [ ] No WebGL context errors in console after tab switching
- [ ] No memory growth over 20-minute sustained output
