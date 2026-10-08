<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Unified themes

## User contract

- New profiles follow the system with Dark Modern and Light Modern. A user can choose either member of the pair independently. Clicking a theme card selects manual mode.
- Six featured palettes: Dark Modern, Light Modern, Dracula, One Dark Pro, Nord, Solarized Light. Additional palettes, Onward Classic and imported themes appear in More themes.
- Existing profiles migrate to Onward Classic. The old six app palettes/custom accent and global terminal colors are preserved. On 2026-10-07 the user explicitly retired per-Task colors; their legacy fields and v2 theme buckets are discarded, rather than left as hidden overrides.
- Color precedence is theme defaults → that theme's saved overrides. All Tasks share that palette. Fonts retain their per-Task and apply-to-all scope independently of theme selection.
- Customization is a pinned, live-preview draft. Save persists it; Cancel/Escape, closing Settings or leaving Appearance discards it. Restore Defaults clears that theme's color overrides. Cancel resolves the committed selection against the current system appearance.
- Webpage content, image pixels and PDF page colors are not recolored by the app theme. PDF page recoloring remains an explicit reader action; fresh readers use original colors. EPUB retains its existing themed reading behavior.

## Data flow and persistence

`ThemeSettings` version 3 is shared by main and renderer; enclosing settings version 9 retires Task colors. `theme-engine.ts` owns validation, named-theme selection, Classic migration and color resolution. `task-fonts.ts` owns font-only Task patches. Storage validation removes retired color fields on load/save/update; old global colors migrate only once into Classic's theme-level colors.

One resolved snapshot feeds root semantic CSS variables, xterm options, Monaco's stable `onward-active` definition, Pierre's CSS-variable syntax theme and preview adapters. Existing terminal sessions and editor models stay mounted. `onward:theme-applied` fires after the root tokens are ready, including same-ID customization changes.

The user approved a one-shot synchronous preload bootstrap on 2026-10-07: it reads the already-loaded main-process memory snapshot, performs no filesystem access in the handler, and installs CSS before first paint. Subsequent settings operations remain asynchronous. Native window backgrounds use the same resolver.

Preview drafts live outside persisted settings. Saves acknowledge success before dismissing customization; rejected theme saves restore the last acknowledged theme without rolling back unrelated preferences.

## Import compatibility

The native chooser accepts JSON, JSONC and VSIX files. A main-process Worker performs file/ZIP reads, JSONC parsing, relative include resolution and normalization. Extensions are treated as data and never executed. VSIX contributions are shown as selectable candidates before committing the import.

- Includes merge parent-first. Referenced files must remain inside the selected JSON's parent directory or the VSIX extension root. Cycles, missing files, unsafe paths, invalid archives and size/depth limits produce localized errors without changing the current catalog.
- Imported definitions are flattened, application-owned snapshots in settings. Rendering and restart do not require the original source files.
- IDs derive from normalized content. Identical content is idempotent; changed content is a new theme. Duplicate names do not replace another theme's overrides.
- Workbench/terminal colors and common TextMate syntax roles are adapted. Exact VS Code highlighting is not promised: semantic selectors, unsupported scopes/workbench tokens and external `.tmTheme` references appear in the compatibility report.
- Parser capacities and persisted capacities are checked together to avoid silently truncating a candidate when saving. The imported catalog is capped at 32 themes; candidate discovery is separately bounded.
- Escape or closing Settings cancels the owned import by request ID and joins its Worker. Immediate retries wait for canceled work to settle; stale cancellation cannot affect a later request. Native chooser results are ignored after cancellation, and a replacement chooser waits for the original native dialog to close.

Upstream palette attribution and licenses are in `resources/themes/`. The import parser dependency (`jsonc-parser`) is MIT; the Playwright development dependency is Apache-2.0.

## Settings navigation and export

- Settings uses independent General, Themes (Appearance), Fonts, Shortcuts and About pages. At 500–600px it has left category tabs; at 300–499px a compact category selector reserves space for content. Arrow Up/Down and Home/End move tab focus; Enter/Space activates. Search indexes translated setting labels and jumps to a focused target. Queries never enter traces.
- The left-anchored panel resizes from its right edge using the initial drag width, including exact 499/500px breakpoint crossings without cumulative drift. Search includes numbered Task-focus and Tab-switch shortcut labels.
- Fonts prioritizes terminal and editor/diff sizes, then font family. Apply-to-all updates current Tasks and the default for new Tasks; theme changes do not change fonts.
- Export uses **VS Code color-theme JSON**, explicitly chosen over an Onward-only format. It contains the current saved palette, saved adjustments and syntax rules, flattened without source-file dependencies. Drafts must be saved or canceled first. Import the exported JSON through the existing theme importer on another machine.
- Main captures the selected saved theme only, a Worker resolves/serializes it, and the native Save dialog chooses the destination. A temporary sibling file is atomically renamed only after the complete write, protecting an existing export during cancellation or failure. No Task IDs, directories, fonts, shortcuts, language, imported catalog or System light/dark pair are exported. Error/cancel results do not modify settings.
- Common editor/terminal colors, ANSI16, cursor, selections and syntax are portable. Onward-only foreground/accent map to standard workbench colors; its independent canvas background maps to surrounding chrome while retaining editor colors. Classic's bespoke derived surfaces and contrast policy are approximate after export/reimport, as stated next to Export.
- Exported files stay inside importer color-count and file-size limits; oversized exports fail rather than truncate. Escape, leaving Appearance or closing Settings cancels the owned export request; an immediate retry joins the canceled predecessor. Worker/sender/navigation/shutdown cleanup is joined, temporary files are removed, and canceled native-dialog results cannot write later. Suggested filenames avoid Windows reserved device prefixes, including names such as `CON.theme`.
- Research: [VS Code settings](https://code.visualstudio.com/docs/configure/settings#_settings-editor), [narrow settings layouts](https://code.visualstudio.com/updates/v1_97#_settings-editor-search-fixes), [JetBrains settings](https://www.jetbrains.com/help/idea/settings-preferences-dialog.html), [WAI-ARIA tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). Visual proposal and user decisions: `docs/html/settings-navigation-theme-export.html`.

### Cross-platform boundary

The navigation/font logic uses browser/React APIs without OS assumptions. Export uses Node Worker, `path.join`/`dirname`, `fs/promises` and Electron's platform-native Save dialog. Atomic rename shares the destination directory, avoiding cross-device moves; errors retain the old destination. Suggested filenames sanitize Windows punctuation and reserved device prefixes. Shared test drivers use platform-neutral file APIs and exact process identity with POSIX/Windows runner parity. Runtime acceptance is performed on macOS; Windows/Linux are structurally reviewed, not natively executed in this environment.

### Independent review

Read-only review identified export overwrite cancellation, export unmount cancellation, missing individual/numbered shortcut search labels and Windows dotted device names. Each was corrected and re-reviewed. Packaged testing additionally found the old right-panel drag calculation in the actual left-anchored Settings layout; the correction and scoped listener cleanup passed independent review. No actionable findings remained in the final targeted review. The remaining structural improvement is splitting the large Settings component into per-page components as page-specific behavior grows.

Test-boundary note: the draft-isolation scenario originally used an early CDP no-op drag to trigger an unrelated settings save. Two stability runs recorded a 400px drag start but a 440/508px end; adding input capture changed its timing and produced three clean runs, so the precise external input cause was not established. The draft scenario now drives the actual Settings state setter directly, as its assertion concerns draft/persistence isolation. Actual pointer resizing remains covered independently in `TH-UX-03`, with five rounds through all five widths. Captured evidence is retained under `traces/retained/settings-drag-diagnostics/` and `traces/test-logs/settings-drag-evidence.log`.

## Verification

Pure tests cover migration/retirement decision tables, resolution, syntax approximation, Task fonts, category search, export serialization/lifecycle, importer confinement/limits/cancellation, runtime adapters and preview decisions. Playwright tests operate on isolated packaged-app profiles and real files, with independent expected palette fixtures.

Acceptance groups cover selection/System, transactional drafts, Task fonts, imports/exports, category navigation, bilingual/narrow layouts, six-Task latency, real restart/migration and cross-surface state preservation. Timing-dependent correctness repeats five times. The product-approved loaded-theme switching budget is 200 ms with six visible Tasks: three trials, at least one within budget, and correct final state for every trial. Import parsing is outside this switching metric.

The PDF reader and both Git comparison panes share the complete viewer dictionary. Live English/Chinese changes preserve the loaded PDF and reading state; packaged checks also verify the translated toolbar fits each pane.

Diagnostic events and their call sites are indexed in `infra/trace.md`; runtime artifacts belong under `traces/`.

The detailed control-flow audit and closed findings are in `docs/themes-trace-audit.md`. The external acceptance driver is shared by the POSIX/PowerShell runners; Linux pre-launch cleanup verifies the exact executable and main-process arguments because Linux truncates process names to 15 characters.

```sh
pnpm test:unit
python3 test/autotest/run-full-regression.py --only run-themes --repeat 3 --no-flake-retry
```

Each theme runner stays below the independent five-minute ceiling. Artifacts include `results.json`, per-case logs and screenshots under `traces/test-logs/themes-ui/<group>-<timestamp>/`; the orchestrator also retains its standard summary under `test/full-regression-results/`.

### Settings/font/export acceptance, 2026-10-07

- Clean development build: `traces/test-logs/settings-theme-final-build.log`; packaged startup reached the main UI through the isolated Playwright harness.
- Latest results across the affected **12 runners are green**: source runs `20261007T204541`, `20261007T205640` and the final stability runs below. The earlier run's three failed draft/font/layout cases are retained in its log and superseded by the corrected passing runs, not hidden by a retry.
- **160/160 unit files passed**; the subsequent pure resize boundary assertion passed in `traces/test-logs/settings-resize-unit.log`. Typecheck, comment lint and diff whitespace checks passed.
- Final stability: **3/3 iterations, 4/4 runners each**, with external retries disabled. Runs: `20261007T211243`, `20261007T211416`, `20261007T211544`. Draft, fonts/migration, imports/exports and bilingual navigation/geometry all passed. Every timing-sensitive correctness case aggregates five trials internally.
- Theme acceptance reports cover nine groups: core 7, draft 6, fonts 4, imports/exports 16, visual/navigation 6, latency 3, persistence 2, migration 2 and cross-surface 26 scenarios plus its suite aggregate. No renderer page errors were recorded.
- Inspected actual 300px Chinese and 600px English screenshots. All five pages, search targets, numbered shortcuts, real xterm/Monaco font values, retired v8 Task colors and fresh-profile export reimport are covered.
- Consolidated local evidence: `traces/settings-theme-final-acceptance.json`. The trace `traces/perf/settings-theme-final-20261007.json` contains 8,601 events from the final draft/font/import/visual runs, with process identities remapped per app launch. Detailed trace coverage and exemptions are in `docs/themes-trace-audit.md`.
- macOS arm64 executed. Windows/Linux validation is structural; native runs remain outside this environment.

### Earlier unified-theme acceptance, 2026-10-07 (before the settings/export iteration)

- Development package built cleanly and repeatedly entered the working main UI.
- All nine theme groups pass: 61 functional scenarios, excluding the surface suite's summary row. Import cancellation and all 26 surface scenarios passed three consecutive final integration runs (`20261007T121416`, `20261007T121527`, `20261007T121633`).
- The final affected regression (`20261007T121807`) passed all 16 runners, including the other seven theme groups, PDF/EPUB preview and compare, Mermaid pan/zoom, Markdown math/session restoration, trace self-check and the unit suite. All 157 unit files passed; TypeScript, comment lint and whitespace checks passed.
- Narrow Settings was verified at 300px in English/Chinese; screenshots were inspected for featured palettes, Markdown/Mermaid and reader/Git surfaces. Reader language round trips preserve the actual PDF document and reading state.
- Runtime execution was on macOS. Windows/Linux received structural checks of shared behavior, runner parity, paths/line endings and exact process ownership, not native execution.
- Latest measurements and artifact pointers are written to `traces/themes-final-acceptance.json`. The captured trace and full diagnostic coverage audit complement assertions, rather than substituting for them.
- Final six-visible-Task switching measurements: 24.5, 32.4 and 22.0 ms; all three outcomes were correct and under the approved 200 ms budget. Post-self-check capture run `20261007T122434` passed imports, latency and surfaces; view `traces/perf/themes-final-{imports,latency,surfaces}.json` in Perfetto.

## Deliberate limits / follow-up

- ANSI/default colors follow the selected palette. The user approved `minimumContrastRatio=4.5` for non-Classic light themes on 2026-10-07; dark themes and Classic retain `1`. xterm adjusts rendered low-contrast text (including truecolor) while preserving the original ANSI palette. See `docs/html/theme-terminal-contrast.html` for the evidence and decision; dim and box/Powerline glyphs have xterm-specific exceptions.
- Common-role syntax adaptation is approximate. Full TextMate/semantic fidelity would require a separate tokenizer integration.
- Custom colors can reduce contrast; bundled palettes and real light/dark surfaces are verified, but user-selected values are not silently rewritten.
- Import compatibility mappings should be extended alongside new supported workbench tokens. The importer-to-normalizer round-trip test guards drift.
- Existing trace-self-check infrastructure clears `traces/perf/` before capturing. Run it before recording evidence that must be retained; isolating that runner's output is a follow-up infrastructure improvement. Final acceptance traces are captured after the self-check.

References: [VS Code themes](https://code.visualstudio.com/docs/configure/themes), [Color theme extension guide](https://code.visualstudio.com/api/extension-guides/color-theme), [Terminal appearance](https://code.visualstudio.com/docs/terminal/appearance).
