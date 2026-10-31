<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Settings page Save implementation

## Contract and design

General, Appearance, Fonts and Shortcuts each own one draft and one bottom Save/Discard footer. About has no footer. Prompt Input Actions participates in the Shortcuts transaction. Theme previews stay inside Settings; fonts and application language remain applied from the last acknowledged settings until Save succeeds.

Discard restores saved values without leaving the page. Category navigation, closing Settings and shortcut-driven exits ask Keep editing / Leave without saving / Save and leave. A failed save retains the draft and vetoes navigation. Interactive application quit and update restart use a main/renderer confirmation handshake. Forced shutdown and recovery retain their existing lifecycle contracts.

The renderer coordinates bounded page data and nested editor participants. The main process validates and three-way merges only the page-owned fields, reserves a changed global shortcut, writes a sibling temporary settings file and replaces the saved file, then acknowledges. A failed write rolls back the reservation. Debounced snapshots and concurrent local edits wait behind the page acknowledgement. No new persistence schema or renderer worker is introduced.

The approved design and interactive prototype are in `docs/html/settings-page-save-design.html` and `docs/html/settings-save-playground.html`.

### Peer references

VS Code's Electron lifecycle service uses an asynchronous renderer veto before completing interactive shutdown. That supports retaining renderer-owned drafts while letting the main process own application lifetime. Electron global shortcuts return registration success/failure; a failed registration cannot be treated as a successful settings save. The implementation therefore keeps the old binding active until the replacement is reserved and the settings write succeeds.

- <https://github.com/microsoft/vscode/blob/main/src/vs/platform/lifecycle/electron-main/lifecycleMainService.ts>
- <https://github.com/electron/electron/blob/v43.2.0/docs/api/global-shortcut.md>

## Main files

| Area | Files |
|---|---|
| Shared draft, footer, leave dialog | `src/components/Settings/SettingsDraft.tsx`, `Settings.css`, `src/i18n/settings-save.ts` |
| Page fields and nested editors | `Settings.tsx`, `PromptInputSettings.tsx`, `ThemeSelector.tsx`, `ThemeScheduleEditor.tsx`, `ShortcutInput.tsx` |
| ACK ordering and navigation | `src/contexts/SettingsContext.tsx`, `PromptActionsContext.tsx`, `src/App.tsx`, `src/utils/settings-leave-guard.ts` |
| Merge and conflict validation | `src/utils/settings-page.ts` |
| Durable commit, shortcuts, interactive quit | `electron/main/ipc-handlers.ts`, `settings-storage.ts`, `shortcut-manager.ts`, `settings-exit-guard.ts`, `index.ts` |
| IPC contract | `electron/shared/ipc-channels.ts`, `electron/preload/index.ts`, `src/types/settings.d.ts` |
| Trace registry and feature index | `src/utils/perf-trace-names.ts`, `infra/trace.md`, `test/README.md` |

## Diagnostic-trace coverage audit

Event names below are registered in `src/utils/perf-trace-names.ts`. Stages/reasons distinguish the nodes sharing an event. Payloads contain state, bounded codes and counts, not edited content or accelerator strings.

| Modified control-flow node | Evidence in a user trace | Location |
|---|---|---|
| Draft dirty/saving changes, discard and disposal | `renderer:settings.draft-action` (`state`, `discarded`, `disposed`) | `src/components/Settings/SettingsDraft.tsx:103`, `:167`, `:195` |
| Nested validation rejects Save; validation focus | `renderer:settings.commit-page` (`validation-rejected`), nested editor validation events | `src/components/Settings/SettingsDraft.tsx:114` |
| Save button and keyboard Save enter the page transaction; success/NACK update draft state | `renderer:settings.commit-page` (`send`, `received`, `rejected`) plus draft state | `src/components/Settings/SettingsDraft.tsx:125`, `:179`; `src/contexts/SettingsContext.tsx:316` |
| Leave confirmation opens and resolves all three decisions, including failed Save | `renderer:settings.leave-page` (`confirmation-opened`, `decision`) | `src/components/Settings/SettingsDraft.tsx:151` |
| Draft-state IPC send and main receive/rejection | `renderer:settings.draft-action` / `main:settings.confirm-exit` | `SettingsDraft.tsx:167`; `electron/main/settings-exit-guard.ts:26` |
| Main exit request, renderer receive/reply and main settlement | `main:settings.confirm-exit` / `renderer:settings.leave-page` | `settings-exit-guard.ts:57`; `SettingsDraft.tsx:171` |
| Leave-guard registration, removal and request dispatch | `renderer:settings.leave-page` (`registered`, `unregistered`, `requested`) | `src/utils/settings-leave-guard.ts:12` |
| Settings close, panel switch and shortcut-driven exit await permission | `renderer:settings.leave-page` request/decision; existing Settings-open event | `src/App.tsx:1343`, `:1361`, `:1425`, `:2176` |
| Category/search navigation awaits permission and applies destination | `renderer:settings.leave-page`, `renderer:settings.page-changed` | `src/components/Settings/Settings.tsx:183`, `:222` |
| Font draft apply-all and missing Task selection fallback | Existing `RENDERER_SETTINGS_FONTS` (`draft-apply-all`, `selection-fallback`); draft state for input changes | `Settings.tsx:229`, `:298` |
| Prompt action participant reset, accepted Save and invalid editor | Existing `RENDERER_PROMPT_INPUT_SETTINGS` (`editor-cancel`, `editor-save-result`, `editor-invalid`) | `PromptInputSettings.tsx:223`, `:235` |
| Theme draft staging, failure, page acceptance, customization discard and import discard | Existing `RENDERER_THEME_CUSTOMIZE` / `RENDERER_THEME_IMPORT_UI` | `ThemeSelector.tsx:321`, `:347`, `:564` |
| Schedule draft stage, discard, accepted page Save and failure | Existing `RENDERER_THEME_SCHEDULE` (`stage`, `page-discard`, `page-save-accepted`, `save-result`, `save-error`) | `ThemeScheduleEditor.tsx:64`, `:71`, `:81` |
| Shortcut recorder reads the composed draft and stops on discard | Existing `RENDERER_PROMPT_INPUT_SETTINGS` (`record-check-draft`, `record-stop`) | `ShortcutInput.tsx:144`, `:160`, `:166` |
| Provider unavailable/busy rejection; delayed snapshots and state updates | `renderer:settings.commit-page` (`unavailable`, `busy`, `snapshot-deferred`, `update-deferred`) | `src/contexts/SettingsContext.tsx:283`, `:316`, `:372` |
| Page IPC sender/schema rejection, merge conflict, write failure, durable ACK and notification exceptions | `main:settings.commit-page` (`received`, `rejected`, `acknowledged`, notification failure stages) | `electron/main/ipc-handlers.ts:3070` |
| Settings temporary-file replacement, write failure and cleanup failure; consent committed with General | Existing `MAIN_THEME_SETTINGS` / `MAIN_PROMPT_INPUT_SETTINGS` and `main:settings.commit-page` | `electron/main/settings-storage.ts:414`, `:463` |
| Shortcut reservation, rejection, commit, rollback, failed release and stale callback ownership gate | `main:settings.reserve-shortcut` | `electron/main/shortcut-manager.ts:142`, `:200` |
| Interactive quit/update restart; guard installation/disposal, renderer loss, duplicate/unnecessary confirmation, rejected state/reply | `main:settings.confirm-exit` | `electron/main/index.ts:463`; `settings-exit-guard.ts:16`, `:57` |
| Preload transport and callback forwarding | Paired send/receive events at controller/provider and main endpoints above | `electron/preload/index.ts:2331` |
| Prompt action close/switch callback forwarding | `renderer:settings.leave-page` at the registered App/controller endpoint | `src/contexts/PromptActionsContext.tsx:175`, `:179` |
| Page selection, equality, merge and shortcut conflict transforms | Exempt: pure-data transforms, covered by `settings-page.test.mts` (SP-U01..06) | `src/utils/settings-page.ts` |
| Test drivers, fixture command replacement and acceptance helpers | Exempt: autotest-only programs, not shipped user code | `test/autotest/**` |
| Native blur helper observes window/content events; Windows requires minimized window and unfocused WebContents, macOS/Linux require unfocused window | Exempt: helper reachable only under `ONWARD_AUTOTEST=1`; PIK-30 verifies native cancellation and recovery over five trials | `electron/main/ipc-handlers.ts:1148` |

Per-keystroke fields do not emit trace events on every character. Their dirty-state transitions, validation/commit boundaries and existing blur/action diagnostics provide evidence without adding a hot-loop logging cost.

## Validation and portability

Unit coverage includes page field isolation, three-way merge/conflict decisions, shortcut alias decisions on all three platform values, ACK barriers, rejected saves, atomic consent, global shortcut ownership and deduplicated exit confirmation. UI coverage amends the existing theme and Prompt runners and adds SP-UI01..04 to the draft suite. The prototype's Playwright checks are separate from packaged-application acceptance.

Windows is the execution host. macOS and Linux paths are reviewed structurally: platform-specific Save modifiers, native shortcut normalization, shell quoting, filesystem APIs and existing runner launch/cleanup adapters remain explicit. No claim of running macOS or Linux UI tests is made.

Final packaged-run results are recorded in the task completion report. Intermediate failures are retained in gitignored `test/full-regression-results/` and `traces/test-logs/`.

### Acceptance progress (2026-10-30)

- Focused unit run: 68/68 passed across page merge, ACK ordering, durable settings, shortcut ownership, exit confirmation, theme editor focus and native driver contracts. Type checking and comment lint passed.
- `20261030T182208`: Prompt Settings passed 41 cases, including six launches and five write-failure/retry/restart trials. Cross-surface themes passed all 26 five-trial scenarios and the enclosing cleanup gate.
- The boundary receiver failure was a test-fixture `status.json.next` replacement crash, visible in its retained terminal screenshot. Command and status replacements now tolerate bounded Windows sharing violations while preserving exact bytes and ACK IDs.
- Cross-surface cleanup now explicitly stops its owned app before deleting the fixture repository; the harness's outer cleanup remains the failure-path backstop.
- The remaining boundary fixture mixed CRLF source with an LF suffix. Its inserted text now follows the source EOL so the exact editor-content assertion matches Monaco's model semantics on all platforms.
- The earlier native-input rejection did not reproduce in the initial 41-case Prompt Settings run or the final three stability iterations; rejection logging records the native focus witness if it recurs. Its original cause remains unproven.
- PIK-22 now scopes the editor's Discard button to its dialog, distinguishing it from the new Settings footer. Windows native-blur setup uses the guarded test IPC to minimize its owned window and awaits the real OS event; Electron's CDP does not expose Chrome's Browser window-management commands. No OS-level UI automation is used.
- The isolated native-blur probe and retained trace show that Windows can report `BrowserWindow.isFocused() === true` after minimize while WebContents is unfocused and the production shortcut state machine emits `contents-blur` cancellation. The helper now requires both native minimization and content-focus loss on Windows; PIK-30 independently checks focus loss, cancellation, exact receiver bytes and fresh-sequence recovery. All 15 internal trials across the final three stability iterations passed.

### Final focused acceptance (2026-10-30)

The clean development package built successfully, and the packaged Playwright launches reached the main UI. The final selection passed all three iterations without isolation retries, failures, flaky classifications, unrun suites or budget overruns. This is focused feature acceptance, not a repository-wide full regression.

| Selected suite | Cases per iteration | Iterations passed |
|---|---:|---:|
| Prompt shortcut boundaries | 18 | 3/3 |
| Prompt Settings | 41 | 3/3 |
| Theme/page drafts, including SP-UI01..04 | 11 | 3/3 |
| Theme latency and terminal-pressure stress | 4 | 3/3 |
| Trace infrastructure self-check | Runner gate | 3/3 |

Summary directories: `test/full-regression-results/20261030T190100/`, `20261030T190641/`, `20261030T191236/`. Combined output: `traces/test-logs/settings-save-stability.log`. Build output: `traces/build/settings-save-build.txt`. Each iteration also records the unrelated opt-in Windows updater E2E as skipped.

The nine six-terminal Save-to-paint samples measured 66.1–69.8 ms against the existing 200 ms budget. The earlier packaged theme core, tasks/fonts, import/export, visual, persistence and cross-surface acceptance and 23-case Prompt shortcut main suite also passed. Focused units passed 68/68; type checking, comment lint and scoped diff whitespace checks passed.

Interactive quit deduplication and veto are unit-covered; the packaged harness's debug quit bypasses the interactive guard, so those debug exits are not claimed as end-to-end quit-veto coverage. Windows was executed; macOS/Linux were reviewed structurally only. Changes remain uncommitted and unpushed.

## Evaluation and remaining debt

This is a shared page-transaction design rather than separate Save implementations per field. Nested editor participation preserves existing domain validation while centralizing navigation and persistence decisions.

The provider still supports legacy full-snapshot save APIs for non-page callers. The ACK barrier and unit tests protect their interaction with page commits, but consolidating those callers around narrowly scoped transactions is a reasonable future cleanup. Nested theme/schedule controls also retain some historical save-oriented internal names even though they now stage drafts. Those names can be simplified separately without changing the approved interaction contract.
