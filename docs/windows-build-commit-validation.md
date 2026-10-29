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

## Evaluation

This is a setup-contract correction rather than a retry-until-green workaround.
Remaining debt includes native-platform verification on macOS/Linux and the
separate product failures under investigation. These commits do not establish
per-product-patch F2P/P2P or a green full regression.
