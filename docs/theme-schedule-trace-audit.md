<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Scheduled themes: diagnostic coverage audit

The implementation adds a recurring local-time schedule to the existing theme pipeline. Native window, preload and React use the same pure selection rules. One main-process controller owns the timeout; the renderer owns the editing UI and in-place palette application.

## Runtime control-flow nodes

| Node | File:line | Evidence in a user trace |
|---|---|---|
| Controller entry, disposal, calls after disposal | `electron/main/theme-schedule-controller.ts:25` | `main:themes.schedule-reconciled`: `start`, `dispose`, `reconcile-skipped` |
| Boundary/clock reconciliation, replace timeout, active/manual mode, changed/unchanged decisions | `electron/main/theme-schedule-controller.ts:34` | `main:themes.schedule-reconciled`: reason plus `stage=publish/unchanged`, `active`, source, sequence, duration |
| Clock-request receive and sender rejection | `electron/main/index.ts:727` | `main:themes.schedule-reconciled`: `clock-request`, `allowed` |
| Send decision to renderer; destroyed-window fallback | `electron/main/index.ts:710` | `main:themes.schedule-reconciled`: `stage=publish` or `publish-skipped` |
| Startup, focus, resume, settings-save triggers and window close cleanup | `electron/main/index.ts:723`, `electron/main/index.ts:1013` | `main:themes.schedule-reconciled`: `startup`, `focus`, `resume`, `settings`, `dispose` |
| Native background resolution at startup/runtime | `electron/main/index.ts:659`, `electron/main/index.ts:690` | Existing `main:themes.native-applied`; startup bootstrap also records mode |
| Synchronous initial settings/clock/palette bootstrap | `electron/main/index.ts:1004`, `electron/preload/theme-bootstrap.ts:18` | Existing `main:themes.settings-changed` (`bootstrap`) and `renderer:themes.bootstrap` request/receive/apply |
| Async clock IPC send, completion and sanitized transport failure | `electron/preload/index.ts:2223` | `renderer:themes.schedule-action`: `clock-send`, `stage=clock-ipc`, `ok`, duration |
| Clock broadcast subscription, cleanup, initial request failure/unavailable API | `src/contexts/SettingsContext.tsx:190` | `renderer:themes.schedule-action`: `subscribe`, `unsubscribe`, `clock-request-failed`, `clock-unavailable` |
| Clock receive, invalid values and older sequence rejection | `src/contexts/SettingsContext.tsx:169` | `renderer:themes.schedule-action`: `clock-received`, `clock-invalid`, `clock-ignored` |
| Selection clock refresh failure and superseded selection rejection | `src/contexts/SettingsContext.tsx:446` | `renderer:themes.schedule-action`: `commit-clock-failed`, `commit-superseded` |
| Theme normalization/persistence acknowledgement and rollback | `src/contexts/SettingsContext.tsx:446` | Existing `renderer:themes.state-changed`: commit request/saved/rejected and rollback applied/skipped; existing `main:themes.settings-changed` records writes/rejections |
| Temporary theme selection, failed clock request, mode selection and clearing override | `src/components/Settings/ThemeSelector.tsx:373`, `src/components/Settings/ThemeSelector.tsx:552` | `renderer:themes.schedule-action`: `temporary-selection`, `temporary-clock-failed`; existing `renderer:themes.customize-action`: `select`, `mode` |
| Import while preserving Scheduled mode | `src/components/Settings/ThemeSelector.tsx:489` | Existing `renderer:themes.import-action`: `confirm`, save failure; existing state commit records `mode=schedule` |
| Schedule panel mount/unmount and draft entry | `src/components/Settings/ThemeScheduleEditor.tsx:56`, `src/components/Settings/ThemeScheduleEditor.tsx:92` | `renderer:themes.schedule-action`: `mount`, `unmount`, `edit-open` |
| Cancel/Escape, pending-save Escape rejection, close after save and focus restoration | `src/components/Settings/ThemeScheduleEditor.tsx:63` | `renderer:themes.schedule-action`: `cancel`, `cancel-skipped`, `saved` |
| Save, delete, toggle, fallback, resume, pending/disabled-save rejection, NACK/exception/late completion | `src/components/Settings/ThemeScheduleEditor.tsx:75` | `renderer:themes.schedule-action`: operation, bounded count, `save-skipped`, `save-result` (`ok`, `mounted`), `save-error` |
| Enable rejected for overlap or missing theme | `src/components/Settings/ThemeScheduleEditor.tsx:125` | `renderer:themes.schedule-action`: `toggle-rejected`, bounded cause |
| Repeat-day/preset and draft-theme selection | `src/components/Settings/ThemeScheduleEditor.tsx:155` | `renderer:themes.schedule-action`: `repeat-day`, `repeat-preset`, `draft-theme` |
| Pinned customization across a schedule boundary | `src/contexts/SettingsContext.tsx:186`, `src/components/Settings/ThemeSelector.tsx:258` | Existing preview lifecycle and `renderer:themes.applied`; schedule clock receipt identifies the boundary while the pinned palette stays active |

`durationMs` events become `ph=X`; lifecycle/action events become `ph=i`. No schedule dates/times, imported names, raw theme IDs, Prompt text or file paths are added to the new events. Input typing is deliberately silent; discrete actions and commit/rejection boundaries carry diagnostics.

### Named daily timeline revision, 2026-10-20

| Node | File:line | Evidence in a user trace |
|---|---|---|
| Timeline first mount/unmount and parent editing-lock release | `src/components/Settings/ThemeScheduleTimeline.tsx:67` | `renderer:themes.schedule-timeline-action`: `mount`, `unmount` |
| Region open/switch, dismiss, Escape/Close, pending-close rejection | `src/components/Settings/ThemeScheduleTimeline.tsx:99`, `:145` | Same event: `open` with range/fallback scope and bounded region count; `dismiss`, `cancel`, `close-skipped` |
| Initial choice focus and scroll; focus return after controls re-enable | `src/components/Settings/ThemeScheduleTimeline.tsx:73`, `:80` | Same event: `open`, then `focus-returned` with origin-connected/focused flags after close |
| Day/rule change removes the open region; dismiss and unlock | `src/components/Settings/ThemeScheduleTimeline.tsx:89` | Same event: `target-dismissed`, fixed cause |
| Direct selection, busy rejection, unchanged choice, missing owner/theme | `src/components/Settings/ThemeScheduleTimeline.tsx:109` | Same event: `choose`, `choose-skipped`, `unchanged`, `target-rejected` |
| Save success/NACK/exception, late completion after unmount | `src/components/Settings/ThemeScheduleTimeline.tsx:118` | Same event: `save-result` with `ok`, `mounted`, duration; `save-error`; `saved` after success |
| Parent clears old error and locks schedule/mode/customization actions while choosing | `src/components/Settings/ThemeScheduleEditor.tsx:36`, `:108` | Child open/close/lifecycle events above identify the lock transition |
| Stable segment identity and owner-specific theme patch | `src/themes/theme-schedule.ts:125`, `:147` | Exempt pure-data transforms; SCH-U05/09/10 cover adjacent equal themes, shared fallback, overnight ownership, immutable patches and invalid targets |
| Thumbnail markup, derived labels, layout and localized copy | `src/components/Settings/ThemeScheduleTimeline.tsx:28`, `:130`, `ThemeScheduleEditor.css:6`, `src/i18n/theme-schedule.ts:10` | Declarative presentation; module reach is covered by mount. TH-SCH-06 and TH-SCH-VIS02 cover actual DOM/keyboard behavior. |
| Focus-only arrow/Home/End navigation | `src/components/Settings/ThemeScheduleTimeline.tsx:173` | Per-keystroke tracing deliberately prohibited by trace budget; picker lifecycle and committed selection are instrumented above. |

The new event is registered in `src/utils/perf-trace-names.ts` and indexed in `infra/trace.md`. `TH-SCH-04` checks the real timeline lifecycle/actions and a failed-save completion span. The existing `run-themes` and `run-themes-visual` runners own the new cases, including five direct-edit/keyboard/overnight/day-change cycles and bilingual 300/600px one-minute-region screenshots. No timing budget or scheduling strategy changes are introduced by this presentation work.

## Explicit exemptions

| Node | File:line | Exemption and verification |
|---|---|---|
| Weekly matching, overlap, local/DST boundary enumeration, temporary precedence/expiry, input parsing, normalization, daily segments | `src/themes/theme-schedule.ts:14` | Pure-data transforms; `theme-schedule.test.mts` SCH-U01..06 |
| Schema v4 defaults, migration and schedule-aware palette selection | `src/constants/themes.ts:130`, `src/themes/theme-engine.ts:130` | Pure-data transforms; existing `theme-engine.test.mts` plus SCH-U04 |
| Available theme ID projection and detached clock snapshot | `src/themes/theme-engine.ts:205`, `electron/main/settings-storage.ts:430` | Pure-data transforms; TSS-11 checks detached results and absence of catalogs/unrelated settings |
| Type declarations, event/channel constants, bilingual dictionaries and CSS | `src/types/theme.d.ts`, `src/types/electron.d.ts`, `electron/shared/ipc-channels.ts`, `src/i18n/theme-schedule.ts`, `src/components/Settings/ThemeScheduleEditor.css` | Declarative data/layout; no runtime control-flow node. SCH-U08 verifies bilingual value interpolation. |
| Locale dictionary registration for the commit/build text lint | `scripts/check-chinese-comments.js:18` | Build-time allowlist data, no application runtime node. Existing `pnpm lint:comments` validates the newly staged dictionary; the earlier untracked file was outside the linter's `git ls-files` input. |
| Fake clock env/IPC and debug state readout | `electron/main/index.ts:646`, `electron/main/index.ts:735`, `electron/preload/index.ts:2235`, `src/contexts/SettingsContext.tsx:501` | Autotest-only paths gated by `ONWARD_AUTOTEST=1`; production clock APIs remain separately instrumented |
| Acceptance driver, fixture and assertion helpers | `test/autotest/theme-schedule-checks.mjs`, `test/unittest/theme-schedule.test.mts` | Test-only code |

## Test ownership and platform review

- Existing runners are amended: `run-themes`, `run-themes-draft`, `run-themes-visual`, `run-themes-latency`, `run-themes-persistence`. No duplicate regression registration is needed.
- Five internal correctness trials cover clock boundaries, override/resume, preview precedence, six streaming Tasks with Prompt input and ten actual app restarts. Unit tests cover delayed clock replies, schedule save rollback, clock subscription cleanup and DST gaps/repeats, including Lord Howe's half-hour transition. Selection intent ordering is distinct from persisted-write ordering: a newer clock request that fails before committing cannot suppress an earlier rejected write's rollback (TSL-SCH03, reproduced red before the fix).
- `TH-SCH-04` asserts the registered main/renderer runtime events in the packaged-app trace; the existing trace-infra self-check validates the trace transport.
- Both `.sh` and `.ps1` wrappers delegate to the same Node/Playwright driver. Calendar arithmetic, `Intl`, DOM time inputs and Electron resume handling are OS-neutral. File fault injection uses Node `rename/mkdir/rm`, never POSIX permissions or shell commands. Fixtures contain no Git repository or line-ending-sensitive shell data.
- The timeline revision uses the same DOM/CSS, `Intl`, keyboard keys and Node filesystem APIs on macOS, Windows and Linux. Shared fixture JSON and trace parsing tolerate CRLF; path construction uses `path.join`/file URLs. POSIX runners resolve the `.app` or Linux binary; PowerShell runners resolve the `.exe`. The shared harness owns cleanup: exact-name `pkill -x` on macOS, exact-image `taskkill /IM` on Windows, and revalidated `/proc` executable identity on Linux where `comm` truncates long product names.
- Runtime verification is on macOS arm64. Windows and Linux receive structural parity review, not native execution in this environment.

## Final verification, 2026-10-19

The clean dev package passed all five affected theme runners in three consecutive iterations (99 scenario executions, no external retry), plus trace-infrastructure self-check and all 178 unit files. The targeted theme unit run passed 222 assertions. Build, typecheck, comment lint and whitespace checks passed. Final UI screenshots were inspected at English 600px and Chinese 300px. The retained trace contains 1,669 theme events and is indexed with the exact per-run reports in `traces/theme-schedule-final-acceptance.json`; raw trace: `traces/perf/theme-schedule-20261019.json`.

## Design assessment and follow-up

This is a bounded extension of the shared resolver, rather than a second theme system. The controller owns one timeout and all cleanup; the minute backstop avoids renderer polling, while clock snapshots contain no imported palette catalogs. Existing terminal/editor instances stay mounted.

Remaining follow-up: native Windows/Linux acceptance, hands-on usability checks for overnight weekday ownership, and a future split of the large pre-existing `ThemeSelector` import/customization surfaces. The new schedule editor is already isolated. The existing trace self-check still clears the global `traces/perf` directory; retained schedule evidence is copied into its per-run artifact directory before that cleanup.

## Timeline UX verification, 2026-10-20

- Clean packaged build, typecheck, comment lint and whitespace checks passed; all 224 targeted theme unit tests passed.
- The affected core/visual suites passed three consecutive no-retry iterations: **63 scenario executions**, including 15 direct-edit/keyboard/overnight/day-change cycles. Reports: `test/full-regression-results/20261020T025232/`, `20261020T025319/`, `20261020T025403/`.
- Draft/preview regression and trace self-check passed in `test/full-regression-results/20261020T024938/`, alongside the core/visual suites. The orchestrator reports the unrelated opt-in Windows updater suite as skipped; every selected runner passed.
- Inspected actual packaged-app screenshots: normal three-region schedule, adjacent one-minute regions and contextual picker in English/Chinese at 300/600px. Final core/visual runs have no renderer console errors and clean process exits.
- The retained trace contains 208 timeline-action events, including 41 successful focus returns and rejected-save completion. Largest timeline event payload: 88 bytes. Consolidated evidence: `traces/theme-timeline-final-acceptance.json`; trace: `traces/perf/theme-timeline-20261020.json`.
- The first UI run exposed focus being requested while the saved row was still disabled. Focus now returns in a layout effect after controls re-enable; the repeated real-keyboard test confirms the fix.

Assessment: the named agenda and contextual picker form a coherent, isolated interaction component with unit-tested owner mapping. The deliberate trade-off is more vertical space for readable names and short-interval hit targets. A useful follow-up is testing high-density schedules with users, then considering a compact view if needed; native Windows/Linux acceptance and the pre-existing selector/trace-cleanup debt above remain outstanding.
