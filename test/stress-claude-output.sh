#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 OPPO
# SPDX-License-Identifier: Apache-2.0
#
# Simulates Claude Code terminal output patterns for performance stress testing.
# macOS / Linux version.  See stress-claude-output.ps1 for Windows.
#
# Usage:  ./stress-claude-output.sh [duration_seconds] [mode]
#   duration  — total run time in seconds (default: 60)
#   mode      — thinking | burst | mixed (default: mixed)

set -euo pipefail

DURATION="${1:-60}"
MODE="${2:-mixed}"
ESC=$'\033'
END_TIME=$(( $(date +%s) + DURATION ))

# --- ANSI helpers ---
write_ansi() { printf '%s' "$1"; }

# --- Mode A: Thinking (slow stream) ---
thinking_mode() {
  local thoughts=(
    "Let me analyze the performance bottleneck in the terminal rendering pipeline..."
    "The issue appears to be related to xterm.js write() calls on hidden terminals..."
    "I can see that TerminalDataBuffer batches at 16ms intervals, but with 6 terminals..."
    "Each WebGL context requires GPU resources. With 6 active contexts..."
    "The IPC message rate peaks at approximately 360 messages per second..."
    "Looking at the React component tree, TerminalGrid re-renders on every git info update..."
    "I'll trace the data flow: PTY onData -> TerminalDataBuffer -> IPC -> session.terminal.write()..."
    "The main thread appears blocked during xterm.js ANSI parsing of large chunks..."
  )
  local idx=$(( RANDOM % ${#thoughts[@]} ))
  local text="${thoughts[$idx]}"

  write_ansi "${ESC}[34m●${ESC}[0m ${ESC}[90m"

  local i
  for (( i=0; i<${#text}; i++ )); do
    [ "$(date +%s)" -ge "$END_TIME" ] && return
    write_ansi "${text:$i:1}"
    sleep 0.0$(( RANDOM % 45 + 15 ))
  done
  write_ansi "${ESC}[0m"
  printf '\n'
  sleep 0.$(( RANDOM % 6 + 2 ))
}

# --- Mode B: Code burst (rapid output) ---
burst_mode() {
  local block
  block=$(cat <<'CODEBLOCK'
\033[32m```typescript\033[0m
\033[33mclass\033[0m \033[37mTerminalDataBuffer\033[0m {
  \033[36mprivate\033[0m chunks: \033[33mstring\033[0m[] = []
  \033[36mprivate\033[0m totalBytes = \033[35m0\033[0m

  \033[36mprivate static readonly\033[0m FLUSH_INTERVAL_MS = \033[35m16\033[0m
  \033[36mprivate static readonly\033[0m FORCE_FLUSH_BYTES = \033[35m65536\033[0m

  push(data: \033[33mstring\033[0m): \033[33mvoid\033[0m {
    \033[36mif\033[0m (\033[36mthis\033[0m.disposed) \033[36mreturn\033[0m
    \033[36mthis\033[0m.chunks.push(data)
    \033[36mthis\033[0m.totalBytes += data.length
  }

  flush(): \033[33mvoid\033[0m {
    \033[36mif\033[0m (\033[36mthis\033[0m.chunks.length === \033[35m0\033[0m) \033[36mreturn\033[0m
    \033[36mconst\033[0m merged = \033[36mthis\033[0m.chunks.join(\033[33m''\033[0m)
    \033[36mthis\033[0m.send(\033[36mthis\033[0m.terminalId, merged)
  }
}
\033[32m```\033[0m
CODEBLOCK
  )

  while IFS= read -r line; do
    [ "$(date +%s)" -ge "$END_TIME" ] && return
    printf '%b\n' "$line"
    sleep 0.0$(( RANDOM % 15 + 5 ))
  done <<< "$block"
  printf '\n'
}

# --- Mode C: Tool call (ANSI-intensive) ---
tool_call_mode() {
  local tools=("Read:src/terminal/terminal-session-manager.ts:556"
               "Grep:registerGlobalDataListener:3"
               "Glob:**/*.tsx:47"
               "Read:electron/main/ipc-handlers.ts:312"
               "Edit:src/utils/perf-monitor.ts:24")

  local pick="${tools[$(( RANDOM % ${#tools[@]} ))]}"
  IFS=: read -r name target count <<< "$pick"

  write_ansi "${ESC}[34m●${ESC}[0m ${ESC}[1m${name}${ESC}[0m ${ESC}[90m${target}${ESC}[0m"
  printf '\n'
  sleep 0.1

  local steps=20
  local i
  for (( i=1; i<=steps; i++ )); do
    [ "$(date +%s)" -ge "$END_TIME" ] && return
    local pct=$(( i * 100 / steps ))
    local filled=$(( i * 30 / steps ))
    local empty=$(( 30 - filled ))
    local bar
    bar=$(printf '=%.0s' $(seq 1 "$filled"))
    [ "$empty" -gt 0 ] && bar="${bar}>"
    [ "$empty" -gt 1 ] && bar="${bar}$(printf ' %.0s' $(seq 1 $(( empty - 1 ))))"
    write_ansi "${ESC}[2K${ESC}[G  ${ESC}[36m[${bar}]${ESC}[0m ${ESC}[90m${pct}%${ESC}[0m"
    sleep 0.0$(( RANDOM % 30 + 10 ))
  done
  printf '\n'
  write_ansi "  ${ESC}[32m✓${ESC}[0m ${ESC}[90m${count} lines${ESC}[0m"
  printf '\n\n'
  sleep 0.2
}

# --- Main loop ---
write_ansi "${ESC}[1m[stress-test]${ESC}[0m Starting Claude Code output simulation"
printf '\n'
write_ansi "${ESC}[90m  Duration: ${DURATION}s  Mode: ${MODE}${ESC}[0m"
printf '\n\n'

iteration=0
while [ "$(date +%s)" -lt "$END_TIME" ]; do
  iteration=$(( iteration + 1 ))

  case "$MODE" in
    thinking) thinking_mode ;;
    burst)    burst_mode ;;
    mixed)
      phase=$(( iteration % 3 ))
      case "$phase" in
        0) thinking_mode; thinking_mode; thinking_mode ;;
        1) burst_mode; burst_mode ;;
        2) tool_call_mode; tool_call_mode ;;
      esac
      ;;
  esac
done

printf '\n'
write_ansi "${ESC}[1m[stress-test]${ESC}[0m Done (${iteration} iterations)"
printf '\n'
