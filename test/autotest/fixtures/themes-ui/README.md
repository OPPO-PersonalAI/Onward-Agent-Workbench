<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Themes acceptance fixtures

All theme samples are original test data, not copied third-party palettes.
`acceptance-midnight.json` and `acceptance-midnight.jsonc` describe the same
palette under distinct names so equivalence does not depend on collision policy.
Distinct application/editor/terminal colors make token misrouting visible.

`vsix-source/` is an original extension-shaped fixture. The test driver packages
these on-disk files into an isolated temporary VSIX using the repository's `yazl`
dependency. No extension executable is included. `invalid-theme.json` is
intentionally malformed; `invalid-color.json` has a syntactically valid object
with an invalid color. `legacy-settings.json` is a pre-overhaul v7 profile.
`missing-include.json` references an intentionally absent parent.
`corrupt-vsix.txt` is copied to a `.vsix` filename to test archive failure.

`terminal-screen.txt` contains literal `\x1b` escapes, decoded only when injected
through the existing autotest PTY-output boundary. The visible marker verifies
that palette switching preserves terminal output.
`prompt-draft.json` supplies the unsent title/content and five typed suffixes for
the live-output pressure case; the driver fills/types into the real Prompt editor.

Run one group per runner invocation; there is deliberately no all-groups mode:

```sh
bash test/autotest/run-themes-autotest.sh
bash test/autotest/run-themes-draft-autotest.sh
bash test/autotest/run-themes-tasks-autotest.sh
bash test/autotest/run-themes-imports-autotest.sh
bash test/autotest/run-themes-visual-autotest.sh
bash test/autotest/run-themes-latency-autotest.sh
bash test/autotest/run-themes-persistence-autotest.sh
bash test/autotest/run-themes-migration-autotest.sh
bash test/autotest/run-themes-surfaces-autotest.sh
```

Windows: use the matching `.ps1` filename with `pwsh -File`.
Every runner accepts positional `[APP_BIN] [LOG_FILE]`; PowerShell also accepts
`-AppBin` and `-LogFile`. Argument 2 is always a log path, never a group name.
The main runner defaults to `core`; `ONWARD_THEME_TEST_GROUP` may select another
group directly. The small group wrappers pin the group for orchestrator discovery.
No runner builds, installs, or downloads browsers.

The approved theme-switch budget is 200 ms with six visible ready terminals:
three measured clicks, every result correct, at least one within budget. The
clock starts at the real trusted click in the renderer, not at the CDP request.
Five-trial state-transition checks are separate from the three-trial latency gate.
`TH-STRESS-02` streams the on-disk terminal fixture to all six Tasks every 50 ms
through `injectPtyData`, during five light/dark System round trips. It verifies
advancing sequence markers in actual xterm buffers, preserved Task IDs, and
Prompt draft/focus retention while typing. Its interval is cleared in `finally`;
this correctness case does not impose an additional latency budget.
Each invocation has a 260 s work deadline with bounded cleanup before 300 s.

Artifacts are retained in `traces/test-logs/themes-ui/<group>-<run>/`; the latest
driver transcript defaults to `traces/test-logs/themes-autotest-<group>.log`,
or uses the caller-supplied `LOG_FILE`. Screenshots
and results are evidence, not golden images. Every owned temporary profile and
fixture copy is removed after app shutdown, including failure and signal paths.
Before each launch, the shared driver checks/kills only the exact packaged app
name (`pgrep -lx` then `pkill -x` on macOS/Linux; exact-image `tasklist` then
`taskkill /IM` on Windows), using argument arrays without a shell, then waits
500 ms. Other branch product names are never targeted. Post-run cleanup uses
the owned child handle or its own debug quit IPC.

Required debug contract: `getState().settings` is ThemeSettings v2, and
`getTerminalThemes()[].theme` is the actual xterm palette. The `surfaces` group
invokes `theme-surfaces-checks.mjs` for editor, Markdown/Mermaid, reader, and
Git Diff/History adapters. Its optional fourth callback records each completed
scenario immediately in the transcript, `surface-results.jsonl`, and final
`results.json`; a later failure is recorded by `TH-SURF-SUITE`.
Native Electron chrome is not emulated by Playwright `emulateMedia`; its main
process adapter needs its own host-appearance coverage.

The driver also accepts the current full-SettingsState wrapper (`settings.theme`)
and actual terminal snapshots using `terminalId`; readiness is read from the
existing terminal-session debug API. These adaptations do not resolve colors.
For `TH-IMP-03`, `setImportPathForAutotest(null)` must inject a one-shot canceled
selection. Clearing the stub and opening a real native dialog is not this contract.

## Scenario groups

| Group | Acceptance IDs / behavior |
| --- | --- |
| core | TH-SYS-01..04, TH-SEL-01/03/04: fresh defaults, six cards, chosen pair, five OS cycles, inactive member, manual override, Classic preset/accent |
| draft | TH-DR-01/04/05/06/07: five cancel cycles, save, ANSI16/cursor/selection, invalid input, scoped reset, pinned draft across five OS changes |
| tasks | TH-TASK-01..04: two Tasks, independent per-theme slots, five manual and five System round trips, scoped resets |
| imports | TH-IMP-01..06: JSON/JSONC, five native cancels, five package-choice cancels, selective VSIX import, deduplication, bilingual error recovery |
| visual | TH-VIS-01, TH-UX-01/02: six full-workbench screenshots, real keyboard activation, real 300px resize, English/Chinese card and customization screenshots |
| latency | TH-PERF-01, TH-STRESS-01/02: three static 200ms trials with six visible Tasks, twenty rapid selections, then five System round trips with 50ms output streams and real Prompt input |
| persistence | TH-PERSIST-01/02: two actual launches, saved overrides/import/pair/task identity, abandoned preview, source-file-independent imported definition |
| migration | TH-MIG-01/02: v7 Classic raw defaults, second-launch idempotence, customization cancellation |
| surfaces | TH-SURF-SUITE + TH-SURF-*: editor cursor/content, Markdown/Mermaid layout/scroll/fullscreen/idle, PDF/EPUB readers, authored HTML/image preservation, Git Diff/History code/PDF/EPUB; five trials per transition |

The source includes deterministic validation assertions and five-trial asynchronous
correctness scenarios. It does not claim stability until the maintainer provides
a current packaged build and every selected group has actually run.
