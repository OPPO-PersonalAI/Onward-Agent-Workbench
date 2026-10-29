<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Windows build and regression entry isolation

## Scope

The entry repair is isolated from the later product repairs on base `13b0f0d9`.
Windows resolved System32's WSL Bash, which returned 127 for Node and could not
access the Windows application path. Earlier cleanup also continued into build
after failing to remove a locked output directory. These are setup failures;
the original build timing evidence recorded a successful 82.78-second build.

The entry commit selects Git for Windows, validates the real shell environment,
stops the exact development app, requires successful cleanup, bounds setup
processes, and creates only the selected suite's fixture. Architecture-aware
launch discovery cannot choose a foreign-platform binary. Failure summaries
remain available after setup or runner cleanup fails. The trace self-check uses
the same exact cleanup and cannot reuse historical trace files as new evidence.

No runner budgets, product assertions or full-regression suite selection change.

## Diagnostic coverage audit

| Modified control-flow nodes | Location | Evidence / exemption |
|---|---|---|
| Shell discovery/rejection, environment, tool probes, selection and executable resolution | `test/autotest/run-full-regression.py`: `find_bash`, `runner_environment`, `validate_runner_tools`, `select_scripts`, `app_bin_candidates`, `resolve_app_bin` | Test infrastructure: persisted preflight stages, ORE-04 and regression-entry unit cases. No application trace event. |
| Exact app stop, process identity checks, failed tool/timeout handling and escalation | `test/autotest/dev_app_cleanup.py`: `AppCleanup` | Test infrastructure: explicit cleanup output/errors; 19 mocked Windows/macOS/Linux contracts. No application trace event. |
| Strict output removal, setup subprocess exit/timeout/interrupt, fixture ownership and teardown | `test/autotest/run-full-regression.py`: `remove_tree_strict`, `run_setup_command`, `run_dev_build`, `generate_recursive_submodule_fixture` | Test infrastructure: stage records and complete build/fixture logs; ORE-01..03 and unit failure tests. |
| Setup failure, completed attempt retention, cleanup/retry errors, aborted summary and unrun list | `test/autotest/run-full-regression.py`: `main` | Test infrastructure: summary JSON ERROR rows and phase context; ORE-05 subprocess cases and mocked main cases. |
| Native wrapper interpreter resolution, both child invocations, first-error propagation and UTF-8 output | `test/autotest/run-orchestrator-watchdog-autotest.{sh,ps1}` | Test infrastructure: OWD-PS and real watchdog/entry logs. |
| Trace inventory, new-file selection, parse failure, app launch and exact cleanup | `test/autotest/run-trace-infra-self-check-autotest.sh`, `trace-self-check-files.mjs` | Test infrastructure: current-run trace validation and eight unit/CLI cases; no new product event. |
| Host/architecture-specific packaged executable selection and missing-binary result | `scripts/dist-dev.js`: `getPackagedAppPath` | Build-only: exact path/executable checks and packaged startup; no application trace event. |
| Test fixtures and unit drivers | `test/autotest/fixtures/{orchestrator-entry,trace-self-check}`, `test/unittest/*{regression-entry,dev-app-cleanup,orchestrator-watchdog-powershell,trace-self-check-files}*` | Test-only exemption; assertions and process exit status. |

## Verification

Verification is performed in a separate worktree, with the original dirty tree
preserved. Windows x64 is the execution host. macOS/Linux path, shell, cleanup
and signal differences are checked structurally and through mocked unit cases;
they are not represented as native execution.

Entry verification on 2026-10-29:

- Fresh `pnpm install --frozen-lockfile`: complete postinstall chain, exit 0.
- Clean `pnpm dist:dev`: typecheck and packaging completed. Electron-builder
  retried transient rcedit resource-write failures internally before success.
- 31 regression-entry + 19 cleanup Python checks, one real PowerShell wrapper
  check, and eight trace-file tests passed.
- Three consecutive isolated orchestrator runs passed: `20261029T193215`,
  `20261029T193400`, `20261029T193550`. Each recorded 2 PASS, 0 FAIL and 1 opt-in
  SKIP, without flake retry. Both the trace self-check and watchdog ran each time.
  ORE-01..04 repeated five internal trials; ORE-05 verified three abort scenarios.
- Playwright CDP startup confirmed the packaged renderer, completed loading and
  visible main UI, still alive after three seconds; screenshot retained locally.
  The temporary smoke probe first needed an explicit CDP command-line flag and
  the main-content selector (the Prompt editor is initially hidden). No product
  or existing test assertion was changed for this probe correction.

## Native build candidate

The second isolated change contains the build hooks, pinned MIT-licensed
`node-pty@1.2.0-beta.18` and `@vscode/windows-process-tree@0.8.0`, their native
patches, matching unit fixtures and generated license notices. It excludes the
application's process-provider/PTY quit strategy changes, Monaco patch, extra
WebSocket dependency and the unrelated regression repairs.

Native patch markers make the source patches and build helpers a dependency
unit: the helpers must prove that the loader selects the patched binary rather
than an upstream prebuild. Flat staging also avoids pnpm's hashed package paths
being expanded into unnormalized MSBuild include/output paths.

### Native diagnostic coverage audit

| Modified control-flow nodes | Location | Event or evidence |
|---|---|---|
| PE bounds/signature/architecture checks | `scripts/ensure-windows-process-tree.js:9-13` | Pure-data exemption: WPT-B01 tests invalid/truncated/foreign headers. |
| Windows/architecture dispatch, binary-read fallback, child probe and rebuild selection | `scripts/ensure-windows-process-tree.js:16-37`, `scripts/ensure-node-pty-native.js:18-35` | Build-only: probe exit codes, marker/architecture checks and explicit build output/errors. |
| Flat staging, native compiler invocation, binary/PDB copy, unconditional staging cleanup and post-build validation | `scripts/ensure-windows-process-tree.js:38-64`, `scripts/ensure-node-pty-native.js:36-51` | Build-only: complete install/build logs and nonzero error exit. |
| ConPTY companion version/architecture validation and copying; top-level error propagation | `scripts/ensure-node-pty-native.js:53-66` | Build-only: explicit errors or readiness output. |
| Exact nonzero file-identity comparison, already-linked return, ordinary copy and filesystem-error propagation | `scripts/ensure-node-pty-native.js:9-16` | Build-only; PTY-COPY-01..05 real filesystem cases and full postinstall. No runtime application event. |
| Target platform/host rejection, target-architecture dispatch, child spawn/nonzero errors | `scripts/windows-process-tree-before-pack.js:7-17` | Packaging-only: electron-builder output and build exit status. |
| Invoke preparation during install/dev/release/pack; unpack native resources | `package.json`, `scripts/dist-dev.js`, `scripts/dist-release.js` | Build/configuration evidence; no application runtime event. |
| Snapshot failure sentinel, uncapped iteration and handle cleanup | `patches/@vscode__windows-process-tree@0.8.0.patch:4-25,37-47` | Native dependency boundary: undefined failure result; source contract and native public-API probes. Provider integration remains separate. |
| Safe async completion, pending exception preservation, original exception rethrow and unexpected translation failure | Same patch: `33-47,64-105` | Native stderr `[process-tree] completion ...`; calling a JS trace logger during disabled-JS teardown is unsafe. PTN-05 proves exact exception identity. |
| TSFN creation/failure, finalizer thread join/delete, producer payload allocation/submission | `patches/node-pty@1.2.0-beta.18.patch:91-147` | Native shutdown exception: no JS logger in finalizer; normal delivery reaches existing `main:pty.exit`. Setup failure propagates; PTY-NATIVE verifies ownership/status handling. |
| Null-env/callback draining, raw API argument/invocation sequence and unexpected status | Same patch: `165-180` | Native stderr `exit-callback`; ordinary delivered callback reaches `main:pty.exit`. Expected teardown drains are unit-covered. |
| Pre-enqueue ownership transfer, failure reclaim, closing return, producer release and unexpected release status | Same patch: `182-194` | Native stderr `exit-enqueue`/`exit-release`; closing intentionally never re-enters JS. Native ownership fixture covers synchronous consumption and failures. |
| Export native patch capability markers | Both native patches | Declarative capabilities checked by loader/build probes, not trace events. |
| POSIX synchronous-write patch migration | `patches/node-pty@1.2.0-beta.18.patch:4-83` | Existing algorithm/counters retained; NPS-U-01..04 cover installed patch and upstream Windows guards. |
| Native tests and fixtures | `test/unittest/{windows-process-tree-build,process-table-native,pty-exit-callback-native,node-pty-sync-write-patch}.*`, `test/autotest/fixtures/pty-exit-callback/`, `test-windows-process-tree-callback.cjs` | Test-only exemption. |

### Native verification boundary

Only targeted build F2P/P2P is intended here. A successful fresh install/build
is not by itself F2P; the before-path compiler failure must be observed against
the same native sources and toolchain. No full product regression or independent
acceptance of native shutdown/product repairs is claimed.

Observed build F2P on Windows x64, using the same pinned/patched native sources:

- Before: direct `@electron/rebuild` against the pnpm-installed process-tree
  package exited 1. gyp reported `node_addon_api.gyp not found`. The normalized
  target existed; the expanded, unnormalized dependency path was 261 characters.
- After: `node scripts/ensure-windows-process-tree.js` rebuilt those sources
  from its flat staging tree and exited 0. Its native loader probe verified
  architecture, patch capability and a public process-list result containing
  the probe's own PID.
- This is an A/B validation of native build-path handling. It is not F2P proof
  for the separate native callback/shutdown behavior changes.

The first full clean postinstall exposed a second, independent build defect:
ConPTY companion source/destination were hard links (equal device/inode, link
count 4). `cpSync` rejected them with `ERR_FS_CP_EINVAL`, aborting postinstall.
The user approved an exact-identity guard: use bigint filesystem IDs, skip only
the same regular file with a nonzero inode, and propagate other read/copy errors.
This is platform-neutral filesystem handling, not a new cache policy. Five real
filesystem unit cases cover hard links, same path, absent target, stale target,
and real failures. The complete installation chain is rerun from a deleted
`node_modules`, rather than manually resuming the failed postinstall steps.

The corrected clean installation completed in 50.3 seconds with exit 0, including
Electron extraction, better-sqlite3 rebuild, both source-patched native rebuilds,
ConPTY companion preparation, spawn-helper handling and ripgrep validation.
All 14 focused native/copy tests passed, including real compiled C++ ownership
and Node-API exception-identity cases. PTY-COPY-01..05 also passed independently
before the final clean installation.

Clean development packaging and its TypeScript gate passed. The installed
beforePack hook revalidated both patched binaries. Bundled SQLite executed an
in-memory query; the Parcel native module loaded; bundled ripgrep ran; ConPTY's
actual loader selected the source-built patch; the bundled process-tree binary
returned a real snapshot containing the verifier PID. All eight required runtime
artifacts were present. SQLite 13 uses its platform prebuild; the matching
process-tree PDB is retained locally (electron-builder excludes PDBs by default).
The generated notice diff adds only the MIT process-tree license and node-pty
version update.

Targeted P2P run `20261029T195903` recorded 2 PASS, 0 FAIL, 1 opt-in SKIP:
`run-shell-integration-cwd` and `run-trace-infra-self-check`. No flake retry or
full-regression run was used for this native build gate.

Final Playwright CDP smoke exited 0 and confirmed the packaged renderer's visible
main UI after a three-second stability window. The temporary probe was corrected
to use Chromium's dynamically allocated debug port after a fixed-port bind
conflict, and to close its owned stderr pipe after app cleanup. The earlier
dynamic-port attempt reached the same UI assertion but its probe process retained
the pipe; that interrupted probe was not counted as a passing run. These changes
are confined to the temporary verifier, with application assertions unchanged.

Local evidence is archived under `traces/windows-build-commit/`: `entry/` contains
the first candidate's logs/results; `native/` contains the build-path failure,
successful flat rebuild, failing/fixed clean installs, unit results, packaged
inventory, targeted runner results and startup screenshot. No logs are committed.

## Evaluation

This is a setup-contract correction rather than a retry-until-green workaround.
Remaining debt includes native-platform verification on macOS/Linux and the
separate product failures under investigation. These commits do not establish
per-product-patch F2P/P2P or a green full regression.
Maintained dependency patches and the pinned prerelease node-pty version must
be revalidated on dependency upgrades; upstream fixes should eventually replace
the local patches while preserving callback ownership and build probes.
