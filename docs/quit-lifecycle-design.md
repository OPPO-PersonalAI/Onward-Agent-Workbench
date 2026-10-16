<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Unified quit and native watcher isolation

## Decision (2026-10-15)

The user approved one quit coordinator plus an isolated watcher service, with a
10-second total exit budget shared by production and tests. The coordinator
reserves 500 ms of that budget for OS process termination and final Electron exit.
The timer remains armed until Electron emits `quit`.

The 2026-10-14 incident trace recorded `main:quit.hard-floor-triggered` at
19:15:34.758 -0700; the same PID aborted inside Parcel's native completion
callback at 19:15:36.122. The old outer 10-second deadline bypassed the inner
15-second worker shutdown timer and `will-quit` cleanup.

## Ownership

```text
Menu / tray / window / signal / update / recovery / test quit
                         |
                   QuitCoordinator
                         |
       renderer -> cwd snapshot -> state save -> terminal stop
                         |
                services -> Electron exit

Main project tree -------- WatcherServiceClient --- UtilityProcess
Git computation worker -- proxy / parentPort -----     |
                                                @parcel/watcher
```

Only `watcher-service-entry.ts` loads the native addon in application code.
Git computation stays in its existing worker; subscriptions travel through the
main broker. Both consumers share one native service. Runtime filtering,
reconcile cadence, cache authority and Git computation semantics are unchanged.

The utility owns native asynchronous subscribe/unsubscribe calls from call time.
A subscribe finishing after shutdown immediately unsubscribes. Shutdown rejects
new subscriptions and only acknowledges a successful real drain. Native failure
or a never-settling call is not reported as successful cleanup. The application
deadline can terminate the isolated process without freeing its native addon
inside the main process.

The RPC client fences subscriptions by connection generation: a late reply cannot
publish an old subscription, and disposing an old connection cannot start a new
service. Only established subscriptions receive a disconnect callback. File-tree
subscriptions resolve the physical root before native watching and event matching,
while renderer notifications retain the caller's logical cwd.

## Exit contract

- One active exit promise; repeated requests join it.
- Repeated native app/window quit requests are prevented until required saves
  finish; the main window is disabled once quit is confirmed. Trace lifecycle
  listeners register once per process, independently of trace stop/start cycles.
- Cancelled confirmation leaves the app active. A signal can supersede a pending
  confirmation without starting a second teardown.
- Save renderer changes before taking the cwd snapshot and flushing storage;
  capture cwd before ending terminal processes.
- Renderer components publish their local debounced drafts synchronously through
  `pending-state-flush.ts` before AppState builds its final snapshot. The preload
  acknowledgment carries success/failure and belongs to the requesting window;
  unmount unregisters the listener. This closes the 300 ms Prompt-local debounce
  gap discovered by the immediate-input/restart tests.
- Final renderer saves also await the initial AppState load. Startup exit must
  preserve already-saved prompts instead of writing the provider's default empty
  state over them; a failed initial load cannot produce a successful save ACK.
- Record a clean ledger only after all required stages succeed. A stalled save
  leads to an abnormal marker and nonzero forced-exit code.
- Telemetry upload is best-effort and cannot block state or terminal shutdown.
- The final deadline stops the owned watcher process and remaining PTYs, then
  exits. It does not wait for another component's independent deadline.
- Component disposal while the app remains running still releases subscriptions.

## Platform behavior

| Platform | Forced watcher termination | Abrupt parent death |
|---|---|---|
| macOS | SIGKILL to the live owned PID; avoid Electron `kill()`'s synchronous two-second reap wait | Chromium's IO-thread browser-disconnect handler terminates the utility |
| Linux | SIGKILL to the live owned PID | Chromium's IO-thread disconnect handler |
| Windows | Owned UtilityProcess `kill()` invokes native termination | Dedicated worker-thread parent watchdog, independent of the watcher JS loop |

No process-name pattern searches are used for service termination. The spawn
handler honors a pending forced-stop request, because Electron `kill()` before
the `spawn` event does not queue termination.

## Acceptance matrix

All stochastic correctness cases repeat five times inside the driver. Every
trial must preserve its integrity contract. Latency excludes fixture/startup
cost and passes only if at least one of the first three samples meets 10 seconds.
The observer's 15-second timeout is a harness kill guard, not an acceptance limit.

| Group | Cases | Required evidence |
|---|---|---|
| Normal | Startup exit, menu, 50 repeated requests, cancel/retry, external app.quit, window close/hide | No native crash or leftover watcher PID; established sessions finish cleanly without the emergency deadline |
| Pressure | Three mutating repositories, 12 streaming terminal jobs (at least 256 KiB actually received), pending subscribe/unsubscribe, recovery/update entry | Watcher outside main, real Git updates, child jobs stopped, final user-entered draft restored, approved budget |
| Faults | Unexpected service death, death during quit, held persistence, stalled telemetry | File-tree recovery, no respawn during quit, no false clean marker |
| Service shutdown | Held shutdown, blocked utility JS loop | Process termination independent of child JS; separate timeout scope |
| Signals | SIGTERM/SIGINT on POSIX, abrupt parent death with blocked utility JS on all platforms | No interactive-dialog stall; utility disappears; abnormal parent-death ledger |

Recovery/update tests replace only the external relaunch/installer side effect,
verify it was requested, and launch the same profile again to verify persisted
state. They do not download or install real releases. OS logout/reboot cannot be
claimed as physically tested by an application-level shutdown simulation.

Each launch uses an isolated HOME, user-data directory, temporary directory and
Git configuration. Windows test shells additionally use the autotest-only
`ONWARD_AUTOTEST_WINDOWS_CLEAN_SHELL=1` gate to suppress PowerShell profiles and
interactive history (or cmd AutoRun). Reusable inputs live under
`test/autotest/fixtures/quit-stress/`; scratch is removed on success, failure and
signal paths. Latency includes main exit and owned watcher/terminal disappearance.

## Diagnostic coverage audit

| Boundary / decision | Evidence | Source |
|---|---|---|
| Confirmation, cancellation, repeated requests, required-stage outcomes, deadline and failed exit request | `main:quit.coordinator-phase` with phase/reason/stage/clean outcome | `electron/main/quit-coordinator.ts`; adapter in `electron/main/index.ts` |
| Renderer flush send, accepted/rejected/foreign ACK, input freeze, deferred native quit/window close, forced cleanup error | `main:quit.coordinator-phase` | `electron/main/index.ts` |
| Late terminal creation | Same event, `terminal-create-refused`; localized response | `electron/main/ipc-handlers.ts` |
| Utility start/ready/error/exit; RPC send/reply; admission refusal; graceful/forced stop and kill outcome | `main:watcher-service.lifecycle` | `electron/main/watcher-service-client.ts` |
| Native subscribe/unsubscribe completion/failure, shutdown receive/drain/failure | `utility:watcher-service.lifecycle` | `electron/main/watcher-service-entry.ts`, wrapping `watcher-service-registry.ts` |
| Worker RPC send/reply and owner exit cleanup | `worker:watcher-service.rpc`, `main:watcher-service.lifecycle` | `watcher-worker-proxy.ts`; `watcher-service-client.ts::bindWatcherWorker` |
| Native event transport and main relay load | Aggregated `utility:watcher-service.batch-stats`, `main:watcher-service.relay-stats` | Utility entry and main worker bridge |
| Windows owner guard armed/failed/parent gone | `utility:watcher-service.lifecycle`; parent-gone emission is necessarily best-effort because its destination is already dead | `watcher-owner-watchdog-entry.ts`; utility entry |
| File-tree physical-root subscription, late/disposed results, connection-loss recovery | Existing `main:project-tree-watch.subscribe` plus `main:watcher-service.lifecycle` / `tree-resubscribe` | `project-tree-watch-manager.ts` |
| Mirror admission/respawn suppression and computation shutdown acknowledgment/exit | `main:watcher-service.lifecycle`, existing mirror shutdown/respawn events | `git-state-mirror-router.ts`; worker entry |
| Initial renderer load wait/failure, editor flush registration/collection/unmount, final save and ACK | `renderer:quit.state-flush` | `AppStateContext.tsx`; `PromptNotebook.tsx`; preload |
| Trace reinitialization and process-lifetime hook guard | `main:trace-start` includes `lifecycleHooksRegistered`; actual logger tested through repeated stop/start/quit | `performance-trace.ts`; `perf-trace-lifecycle.test.mjs` |
| Pure snapshot, load-readiness, generation and respawn decisions | Exempt: unit-locked pure decisions (PSF, WS-U, GSM-R). RPC/native effects are traced at the wrappers above | `pending-state-flush.ts`; `watcher-rpc.ts`; `git-state-mirror-teardown.ts` |
| Fault injection, restart mocks, isolated Windows test arguments and test programs | Exempt: autotest-only paths; Windows argument transform is unit-locked by TAI-01 | Quit stress hooks; `pty-manager.ts`; `terminal-env.ts`; `test/**` |
| Static bundle entries, dictionaries and type signatures | Exempt: no executable control-flow node; packaging, bilingual integration and type checks cover wiring | `electron.vite.config.ts`; i18n dictionary; type declarations |

## Validation — 2026-10-15

- Development package: Onward 2.0.1, `master`; packaged macOS arm64 launches and
  enters the main UI through Playwright.
- Unit gate: **163/163 test files passed**; type check and project-text lint passed.
- Final stability: **3/3 iterations, 15/15 runner executions, 300/300 trials across
  20 scenarios**, zero failures and zero flaky classifications. Local result
  directories: `20261015T042111`, `20261015T042738`, `20261015T043409` under
  `test/full-regression-results/`.
- Maximum observed exit/owned-process cleanup latency: **9621.35 ms** (10-second
  approved budget). Menu exit: 348–390 ms; 12-terminal pressure plus immediate
  input: 405–558 ms. Startup-exit tests retained the seeded saved prompt in all
  final trials.
- Five related runners passed: file-index UI, Git mirror static state, watcher
  failure injection, mirror subscription leakage and infrastructure/session-ledger
  recovery. Results: `test/full-regression-results/20261015T041700/`.
- Trace self-check: **PASS**, 196 valid events, one chunk, zero invalid records.
  It used `traces/analysis/quit-trace-selfcheck/` to preserve existing perf captures.
- The first combined fault runner reached the existing **180-second** runner
  timeout despite passing individual quit assertions. Splitting fault recovery
  from service shutdown removed the aggregate overrun; neither deadline changed.
- Windows/Linux paths, process branches and runner parity were reviewed
  structurally; this host did not execute those platforms. Actual OS logout and
  release installation remain separate integration validation. Update/recovery
  tests assert the handoff request and reopen the same real profile.

## Sources

- [VS Code watcher process architecture](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals)
- [Electron 43.2 utility lifecycle implementation](https://github.com/electron/electron/blob/v43.2.0/shell/browser/api/electron_api_utility_process.cc)
- [Electron ParentPort API](https://github.com/electron/electron/blob/v43.2.0/docs/api/parent-port.md)
- [Chromium macOS process termination](https://github.com/chromium/chromium/blob/150.0.7871.129/base/process/kill_mac.cc)
- [Chromium child disconnect handling](https://github.com/chromium/chromium/blob/150.0.7871.129/content/child/child_thread_impl.cc)
