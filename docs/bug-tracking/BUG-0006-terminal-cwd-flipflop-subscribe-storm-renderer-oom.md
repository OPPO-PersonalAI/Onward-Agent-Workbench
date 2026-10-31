<!--
SPDX-FileCopyrightText: 2026 OPPO
SPDX-License-Identifier: Apache-2.0
-->

# BUG-0006 — UI disappears: `lastCwd` flip-flop drives a git-info subscribe storm until the renderer OOMs

| Field | Value |
|---|---|
| **Status** | **FIX LANDED 2026-10-30 (uncommitted)** — verified RED→GREEN by GSY-04/05; TTM-08/32 regression found and fixed en route |
| **Reported** | 2026-10-30 (two "UI vanished" incidents on the same day, no diagnostic bundle) |
| **Analyzed** | 2026-10-30 |
| **Code baseline** | `13b0f0d` (master); field build `2.1.0-daily.20260731.1`, darwin arm64, Electron 43.2.0 — the two defective effects are byte-identical between the two |
| **Evidence source** | macOS crash reports `Onward 2 Helper (Renderer)-<date>-*.ips` + `<userData>/traces/perf-*.jsonl` (no bundle) |

---

## 1. Symptom (user's own words)

> 为什么 onward 这两天出现界面消失的情况。已经遇到两次了。我猜是不是渲染线程崩溃了？

The window shell stays, the web contents are gone: classic renderer death with a live main process.

## 2. Root cause (Confirmed by repro)

Two writers of the same persisted field `terminal.lastCwd` in `TerminalGrid.tsx` disagreed whenever the
renderer's raw OSC cwd differed from main's realpath-resolved terminal cwd (symlink entry, stale OSC value,
main-probe cwd):

1. `applyTerminalInfoUpdate` persists the bridge's `info.cwd` (main `resolveExistingTerminalCwd` → realpath).
2. The OSC "late persist" effect, keyed on `[oscDetectedCwds, terminals, …]`, re-persisted the raw OSC cwd
   **on every `terminals` change** (level-triggered).

The amplifier: the git-info subscription effect was keyed on the `visibleTerminals` **array identity**,
so every `lastCwd` write unsubscribed + resubscribed every visible terminal; each resubscribe creates a
fresh `TerminalGitInfoBridge` entry (null fingerprint) which unconditionally re-emits `GIT_TERMINAL_INFO`.

```
subscribe → bridge emits realpath → persist realpath → terminals changes
  → OSC effect persists raw cwd → terminals changes → visibleTerminals new identity
  → unsubscribe+subscribe all visible → bridge re-emits → …
```

The loop crosses IPC, so React's "maximum update depth" guard never fires. Measured in repro:
~2.4k `GIT_TERMINAL_INFO`/s, 4.8k `setTerminalLastCwd`/s (exactly half bailed — the flip-flop signature),
~3.5k React renders/s. In the field it ran ≥ 30 min before the renderer died with `EXC_BREAKPOINT`
(V8 fatal; many `ThreadPoolForegroundWorker` threads inside cppgc/GC at crash time → heap exhaustion).

## 3. Analysis walk (as it happened)

1. Crash reports: both incidents are `Onward 2 Helper (Renderer)`, `EXC_BREAKPOINT/SIGTRAP`; telemetry
   `rendererCrashCount=1, gpuCrashCount=0`; trace `main:renderer-process-gone {reason:crashed, exitCode:5}`
   at the exact crash second.
2. Trace 30 min before crash: `main:git.prewarm.repo-skipped-dedup` 183k recorded + ~3.2M dropped
   (`trace-store:dropped-summary`) ≈ **1.8k/s**, all `reason:"attach"`, over exactly the 6 visible
   Tasks' cwds. **Stops the second the renderer dies** → source is the renderer.
3. `attach` only comes from `TerminalGitInfoBridge.subscribe()` for a NEW entry → the renderer was
   unsubscribing + resubscribing ~300×/s. No `detach-cancelled` during the storm → every detach was
   cancelled by a re-attach inside the grace window (consistent).
4. Code read → subscription effect keyed on `visibleTerminals` identity; found the two `lastCwd` writers.
5. Falsified: "pure resubscribe loop" — `setTerminalLastCwd` / `setTerminalInfos` both bail on equal
   values, so a loop needs a value that actually alternates → the two-writer disagreement.
6. Falsified (for this user's field case): "symlinked project dirs" — none of the affected cwds is a
   symlink. The field trigger is most likely a renderer/main cwd desync (stale OSC value); GSY-05 covers it.
7. Repro: GSY suite already pushes a symlink OSC cwd; added GSY-04 (symlink) and GSY-05 (desync) storm
   probes. RED on baseline (7406 / 7742 events per 3 s), GREEN after fix (0 / 0).

## 4. Fix

| Change | Effect |
|---|---|
| Subscription effect keyed on the joined visible-terminal-ID string (`visibleTerminalIdsKey`) | Breaks the amplifier: per-terminal field writes no longer resubscribe |
| OSC late-persist effect made edge-triggered via `oscPersistedCwdsRef` | Removes the flip-flop source: each (terminalId, cwd) persisted once |
| `bridgeTerminalInfosRef` keeps last raw bridge info; phantom-OSC rollback restores its cwd instead of `null`; autotest override clear restores it | Replaces behaviour that previously worked only through the accidental resubscribe (TTM-08 / TTM-32 went RED without it) |

## 5. Trace events added

| Event | Meaning |
|---|---|
| `renderer:terminal.git-info-subscription-sync` | Subscription effect (re)ran; should fire only on layout/tab/visibility changes |
| `renderer:terminal.osc-cwd-late-persist` | Late OSC persist; at most once per (terminalId, cwd) |
| `renderer:terminal.osc-cwd-rolled-back` (+`restoredCwd`) | Rollback now records the restored valid cwd |

## 6. Repro triage playbook (next "UI disappeared" report)

1. Crash report process = `Helper (Renderer)` + `EXC_BREAKPOINT`? → renderer fatal, continue.
2. Count `main:git.prewarm.repo-skipped-dedup` and `trace-store:dropped-summary` per minute before
   `main:renderer-process-gone`. Thousands/min with `reason:"attach"` = this bug class.
3. On a fixed build, check `renderer:terminal.git-info-subscription-sync` and
   `renderer:terminal.osc-cwd-late-persist` rates — a sustained stream means a new feedback path.

## 7. Open questions

- Exact field trigger (which terminal's OSC cwd disagreed with main) is not recorded by the old build.
- Main-side `subscribe`/`unsubscribe` still re-emits on every fresh entry; a short-window dedup there
  would be defence in depth against future renderer loops.

## 8. Update history

| Date | Change |
|---|---|
| 2026-10-30 | Created: root cause confirmed, fix landed (uncommitted), GSY-04/05 added |
