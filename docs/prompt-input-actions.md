<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configurable Prompt input actions

## User contract

An action describes **what to send** independently of **how to invoke it**.
Settings → Shortcuts contains the Leader and ordered action configuration.
The section follows the existing shortcut groups and starts collapsed. Settings
search expands it. A horizontal emoji preview selects one action for a three-row
editor; horizontal drag or Alt+Left/Right reorders stable action identities.
The Leader starts disabled; the user chooses a modified key or function key.
It belongs to the focused Onward window, not to an operating-system shortcut.

| Preset | Include Prompt | Terminal suffix | Targets | Action key |
|---|---|---|---|---|
| Send and execute | Yes | Enter (`CR`) | Default | Enter |
| Execute | No | Enter (`CR`) | Default | E |
| Send | Yes | None | Default | S |
| Send all and execute | Yes | Enter (`CR`) | All visible | A |
| Queue | Yes | Tab (`HT`) | Default | Q |

Users can add, duplicate, rename, reorder, hide, remove and reconfigure actions.
Each action may store an optional six-digit `#RRGGBB` color. Missing or malformed
loaded colors fall back to theme-aware defaults; the v10 settings remain compatible.
The appearance reset removes color and emoji overrides. Duplicates inherit both.
Each action may also store a supported Unicode `emoji` sequence. Missing/invalid
loaded values use preset defaults (rocket, bolt, outbox, megaphone, hourglass);
custom actions default to a robot. Full ZWJ/skin-tone sequences are preserved,
and optional presentation selectors canonicalize to the bundled catalog.
Hiding affects the toolbar only; a hidden action's shortcut remains available.
Preset names localize unless overridden by a user-authored name.
Saving validates the entire edited section and reports success only after the
main-process write acknowledgement. Rejected edits remain available for retry.
Loading older or malformed settings preserves unrelated preferences, keeps the
first valid action identity/binding, and clears later host-equivalent bindings
or bindings that collide with the Leader. Surviving portable bindings stay
portable on disk; intentionally removed actions do not reappear.
Action continuations can reuse window-local commands, but cannot reuse the
OS-global Wake/Hide shortcut, whose callback bypasses window chord routing.
Queue is terminal input: whether it queues a message depends on the receiving
program. A successful transport result does not prove execution or enqueueing.

## Compact presentation and preview

The toolbar and settings preview share 24px-high, equal-width, equally spaced
emoji buttons with subtle color backgrounds. Names, terminal behavior and shortcut sequences appear in hover
titles and visible keyboard-focus tooltips; accessible names remain available. Large action counts stay on one row
with horizontal scrolling and a minimum 24px width. Neither the permanent
Prompt target row nor successful-send text occupies space. Delivery errors remain
visible; a hidden Prompt uses a dismissible error overlay.

Settings preview is local to its focused test area. It acknowledges the existing
main-process shortcut suspension before accepting input, then runs the shared
Leader reducer against the unsaved draft and eight sample Task identities.
Matches highlight the corresponding visible block and describe hidden matches.
Preview never invokes the live action dispatcher or sends PTY input. Blur,
collapse, composition, draft replacement and unmount clear pending state;
leaving resumes live routing. The recorder and preview share the suspension
queue so late acknowledgements cannot overtake a newer owner.
Focus-scoped window capture prevents preview keys from reaching document-level
editor save/ESC handlers. Native ingress and preview share IME/AltGr classification;
unknown nonmodifier strokes cancel an armed preview. An unarmed Tab retains native
focus traversal. Repeated shortcut errors have separate occurrence identities,
so dismissing one cannot suppress a later identical failure.

The user approved this layout, optional-color schema and local preview on
2026-10-19; see `docs/html/prompt-actions-compact-design.html` for the visual
proposal and trade-offs.

## Emoji appearance (approved 2026-10-19)

The first row's appearance button opens an offline, bilingual picker; its color
and reset controls share that dialog. English and Chinese labels/keywords can
both be searched regardless of UI language, including single-character Chinese
queries. Categories, arrow/Home/End/Page navigation, Enter/Space selection, Tab
focus containment, IME-aware Escape and focus restoration are supported.
Selection changes only the Settings draft and shared preview. The existing
acknowledged Save/Cancel flow owns persistence. The picker blocks live Leader
routing and document-level editor/save shortcuts using the existing modal registry,
acknowledged native shortcut suspension and scoped window capture. Focus regain
re-acquires suspension, while closing resumes native shortcuts. Owner unmount
closes the dialog and terminates work. Retry resets the virtual viewport; entering
the grid after wheel scrolling selects a visible keyboard option. Modified Down
remains a native text-editing gesture. The existing suspension IPC accepts an
optional `preserveNativeMenus` flag for text-entry dialogs. It still skips Onward
window actions while retaining Electron's standard Edit menu and OS app-menu
commands; recorders and shortcut previews keep their default raw-key behavior.

`scripts/import-prompt-emoji.py` pins Microsoft Fluent Emoji commit
`1ffb34c752ecf5d402f04cfb4b392c77f57c54bc` and Emojibase data 18.0.0.
All 3,145 Flat SVGs (including variants; 17,244,387 original bytes) are bundled
under `public/prompt-emoji/flat/`. Bilingual labels/search metadata are compiled
only into `promptEmojiWorker`; the main/renderer share a compact identity list.
The picker creates one Worker on entry, with one in-flight search and one latest
pending request, and renders at most 48 options. Closing or retrying terminates
the old Worker; stale replies cannot replace the current result. No runtime CDN,
IndexedDB, persistent search cache or OS-emoji dependency is used for normal
rendering. Broken artwork uses a diagnostic-traced Unicode fallback.

Upstream byte hashes and original paths are in `resources/emoji/provenance.json`.
MIT artwork/data licenses and Unicode/CLDR notices ship in
`resources/emoji/ThirdPartyNotices.txt`, referenced by `NOTICE.txt`.
Regeneration is maintenance-only: `python3 scripts/import-prompt-emoji.py`
(macOS/Linux) or `py -3 scripts/import-prompt-emoji.py` (Windows). Builds use the
checked-in files without fetching data. See `docs/html/prompt-actions-emoji-design.html`
for the approved visual comparison and package-size/maintenance trade-offs.

## Execution boundary

```text
button ────────────────────────────────┐
focused host/guest → Leader state ─────┤
                                      ▼
current Tab's live editor draft + frozen target IDs
                  │
                  ▼
unified action dispatch → per-terminal atomic text + suffix
                  │
                  ▼
per-target results → captured history + revision-aware draft completion
```

Renderer work is bounded input/focus/DOM state. Terminal framing and ordering
belong to main's existing PTY boundary; ordinary typing has no per-keystroke
settings clone or new persistence round trip. No scheduler priority or cache
policy is changed for this feature.

## Leader grammar and ownership

`L → Q` invokes Queue with default targeting. `L → 3 → Q` invokes Queue on the
Task in visible slot 3 **without moving focus**. Bare digits 1–8 and Escape
are reserved within a sequence. An action cannot use the Leader itself.

- Default timeout is 1,500 ms; configurable range is 500–10,000 ms. Arming or
  choosing a slot restarts the timeout. Held-key repeats never extend it or
  dispatch an action.
- Escape and unmatched continuations are consumed and cancel the sequence.
  Timeout cancels; subsequent ordinary input follows its native route.
- `L → L` cancels and lets the second physical Leader key reach the original
  focused surface normally. It does not inject anything into the Prompt's
  selected destination.
- Tab change, window blur, composition, settings replacement, recording or
  owner destruction cancels pending input. A Tab-activation generation rejects
  delayed events even after switching A → B → A; no stale sequence revives later.
- Latin letters and top-row digits use physical `code`; named keys and
  punctuation use `key`. Numpad digits follow their reported key, so NumLock-off
  navigation remains navigation. Dead/composition keys are never shortcuts.
- Command/Meta and physical Control stay distinct. `CommandOrControl` resolves
  on the current host and remains portable when persisted.
- Recording acknowledges main-process suppression before accepting input.
  A recorded key must not also invoke an existing action or navigation shortcut.

## Destination and draft rules

```text
explicit numbered ID → manual selected visible IDs → active visible ID
all-visible action  → all layout-visible IDs in the current Tab
```

The numbered ID is captured when the digit is pressed. Reordering keeps that
identity; removing or parking the Task rejects the action without retargeting.
The interactive drag-rearrange mode is modal, so entering it cancels a pending
sequence; a fresh sequence uses the resulting slot order. Order-only state
updates that keep the same input owner retain the already captured Task ID.
An explicit number combined with an all-visible action is a conflict. An open
subpage does not change which Tasks belong to the layout. Other Tabs and
independent windows are excluded. Manual selection survives completion.

All configurable action buttons and shortcuts read only their current Tab's
editor draft, including when Prompt is hidden. Selected Prompt history is
never an implicit source. Explicit history context-menu commands retain their
own source semantics. Whitespace-only drafts block text actions; key-only
actions remain available and never save, clear or touch the draft/history.

Each invocation captures content, title, source identity and revision before
awaiting delivery. A second invocation while that notebook is sending is
rejected visibly. Complete success clears only that unchanged originating
revision. Any failure, title edit, replacement, edit→undo cycle or later draft
preserves the editor. Partial delivery records the sent snapshot and target
outcomes once; there is no automatic resend to successful targets.

## Transport rules

Terminal keys are explicitly encoded: None, Enter, Tab, Shift+Tab, Escape,
Backspace, Delete, arrows, Home/End, PageUp/PageDown, and Control+A–Z.

Each target receives one ordered transaction. The suffix follows the end of
the paste frame, never its body. Competing writes cannot interleave with that
transaction; different terminals remain independent. Multiline input, including
LF/CRLF/lone CR, requires confirmed bracketed-paste support. Otherwise the
target receives neither text nor suffix. Embedded terminal control sequences
cannot terminate the frame early. Outcomes distinguish failure before content
from failure after content/before suffix.

## Verification

| Layer | Coverage |
|---|---|
| Pure unit | Defaults/migration, aliases/conflicts, key bytes, Leader transitions, target precedence/identity, revision completion |
| Sender/integrity | Five presets and custom actions, layout-visible scope, exact child stdin framing/suffix, partial failures, retained draft |
| Trusted keyboard | Native interception, no leaked keys, hidden live drafts, IME, repeat/cancel/passthrough, stable destinations and focus |
| Settings restart | UI edits → acknowledged durable save → new process; migration, bilingual narrow controls, failed save |
| Existing performance | Prompt input/longtail/IME gates with their existing workloads and thresholds |
| Diagnostics | Main/renderer send and receive, state/cancel/reject/results, clear/preserve, settings lifecycle; no raw drafts |

The existing Sender and Integrity runners cover toolbar and transport behavior.
`run-prompt-input-settings` covers durable edits. Native keyboard coverage is
split into four independent process scopes: `run-prompt-input-shortcuts`,
`run-prompt-input-boundaries`, `run-prompt-input-guests`, and
`run-prompt-input-readers`. See `test/README.md` for assertion IDs and unit pairs.

Timing-sensitive correctness repeats five times within a case. Deterministic,
autotest-only barriers cover stale parent synchronization, delayed delivery and
Tab-generation races without weakening the real dispatch/byte assertions.
External drivers own their setup and bypass internal Phase 0 initialization.
All fixtures and profiles are isolated; diagnostic artifacts remain under
`traces/`. Historical investigation artifacts are local-only.

Packaged Electron tests use Playwright and a focused-owner, autotest-only
`WebContents.sendInputEvent` bridge. CDP raw key-down events include explicit
platform-native key codes: Chromium otherwise bypasses Electron's interception.
HTML out-of-process iframes use the focused-widget CDP route. PDF, EPUB and
OpenBrowser exercise their own focused input surfaces. Tests check native window
focus independently of DOM focus and retain actual child stdin bytes.

These routes follow [Chromium 150 CDP input flags](https://github.com/chromium/chromium/blob/150.0.7871.129/content/browser/devtools/protocol/input_handler.cc#L1232-L1270),
[Electron 43 interception](https://github.com/electron/electron/blob/v43.2.0/shell/browser/api/electron_api_web_contents.cc#L1570-L1589)
and [Chromium's handled-key lifecycle](https://github.com/chromium/chromium/blob/150.0.7871.129/content/browser/renderer_host/render_widget_host_impl.cc#L1734-L1786).
A fresh same-key press retires stale consumed-release suppression, while held
repeats and other held keys remain suppressed.

## Diagnostic trace coverage audit

Event constants are registered in `src/utils/perf-trace-names.ts` and indexed
in `infra/trace.md`. Related branches share an event with a phase/reason;
ordinary typing does not emit a new event for each keystroke.

| Control-flow nodes | Event or exemption | Implementation |
|---|---|---|
| Settings migration/load repair, validation, commit, write rejection and rollback | `MAIN_PROMPT_INPUT_SETTINGS` | `electron/main/settings-storage.ts:197–558`; `electron/main/ipc-handlers.ts:3076` |
| Settings acknowledgement, stale-result protection and section-scoped rollback | `RENDERER_PROMPT_INPUT_SETTINGS`; existing `RENDERER_THEME_STATE` for generic snapshot ACKs | `src/contexts/SettingsContext.tsx:189–385` |
| Collapse/search reveal, selected-action/hidden-action changes, horizontal reveal/resize, colors/default colors, create/duplicate/delete, validation/save/cancel and lifecycle | `RENDERER_PROMPT_INPUT_SETTINGS` | `src/components/Settings/PromptInputSettings.tsx:80–382`; search navigation uses `RENDERER_SETTINGS_NAVIGATION` in `src/components/Settings/Settings.tsx:189–206` |
| Drag/keyboard reorder start/commit, boundary/foreign-drop rejection, cancel/disposal | `RENDERER_PROMPT_INPUT_REORDER` | `src/components/Settings/PromptInputSettings.tsx:125,185–215,299–316` |
| Local preview window-capture mount/disposal, enter/ready/stale/rejection, chord/target match/cancel, timeout, IME/AltGr/unknown-key cancellation, draft replacement, blur/direct-unmount and resume failure | `RENDERER_PROMPT_INPUT_PREVIEW`; suspension send/ACK/rejection uses `RENDERER_PROMPT_INPUT_SETTINGS`, receive uses existing `MAIN_PROMPT_SHORTCUT` | `src/components/Settings/PromptShortcutPreview.tsx:24–164`; shared queue in `src/components/Settings/ShortcutInput.tsx:29–49` |
| Shortcut recording/suspension/conflicts | `RENDERER_PROMPT_INPUT_SETTINGS` | `src/components/Settings/ShortcutInput.tsx:29–331` |
| Shared color-block first mount, keyboard-focus label show/hide/disposal, relevant-scroll/resize repositioning, window-blur dismissal, and success-muted/error-visible presentation | `RENDERER_PROMPT_ACTION`; positioning cost and unrelated scrolls are aggregated until label disposal. Ancestor classification reuses the pure, unit-tested `shouldDismissMenuOnScroll` helper | `src/components/PromptNotebook/PromptActionButton.tsx:22–86`; `src/components/PromptNotebook/PromptSender.tsx:106–111,457–481` |
| Host/guest attachment, Leader transitions, cancellation, consumed-release recovery, context generations and cleanup | `MAIN_PROMPT_SHORTCUT` | `electron/main/prompt-input-shortcuts.ts:54–110,140–322`; attachment/routing in `electron/main/index.ts:733,765`, `electron/main/browser-view-manager.ts:700`, `electron/main/ipc-handlers.ts:3092` |
| Context/suspend/cancel IPC, ownership rejection, action receive/result and handler cleanup | `MAIN_PROMPT_SHORTCUT`, `MAIN_PROMPT_INPUT` | `electron/main/prompt-input-handlers.ts:33–54,70–103` |
| Preload requests/results and shortcut subscription lifecycle | `RENDERER_PROMPT_INPUT_IPC` | `electron/preload/index.ts:1580–1622` |
| Terminal ownership and paste-capability changes; transaction queue/start/result/disposal | `MAIN_PROMPT_INPUT`, existing PTY spans | `electron/main/ipc-handlers.ts:184,1477,1882`; `electron/main/pty-manager.ts:297–552,675–687,978` |
| Per-Tab draft/dispatcher lifecycle, active owner and input blocking | `RENDERER_PROMPT_DRAFT`, `RENDERER_PROMPT_ACTION`, `RENDERER_PROMPT_SHORTCUT` | `src/contexts/PromptActionsContext.tsx:72–116` |
| Modal/focus/composition cancellation, IPC failure, stale owner rejection, shortcut dispatch and each distinct error occurrence show/dismiss | `RENDERER_PROMPT_SHORTCUT` | `src/components/PromptNotebook/PromptInputShortcuts.tsx:60–81,133–239,249–259`; modal registry transitions are observed at its consumer |
| Selection pending/flush/cancel/dispose and unavailable destinations | `RENDERER_PROMPT_ACTION` | `src/components/PromptNotebook/PromptSender.tsx:175–264`; `src/components/PromptNotebook/PromptNotebook.tsx:211–230` |
| Invocation validation, immutable snapshot, delivery/result, history and revision-aware completion | `RENDERER_PROMPT_ACTION`, `RENDERER_PROMPT_DRAFT`, existing `ui.prompt.action` / `ui.prompt.action.done` | `src/components/PromptNotebook/PromptNotebook.tsx:329–471,1235–1277,1934–2007,2047–2059`; `src/contexts/AppStateContext.tsx:1044–1060` |
| Pure normalization, validation, encoding, Leader/target/revision decisions, labels/history and capability scanning | Exempt: side-effect-free transforms covered by `prompt-input*` / `prompt-task-history` units | `src/utils/prompt-input.ts`, `src/utils/prompt-input-labels.ts`, `src/utils/prompt-io.ts:195`; `src/components/PromptNotebook/promptTaskHistory.ts:37`; `electron/main/pty-manager.ts:64–84`; native context/payload validators in `electron/main/prompt-input-shortcuts.ts:25–37`, `electron/main/prompt-input-handlers.ts:19–26` |
| Native input/focus adapters, deterministic barriers, fixture/driver setup and cleanup | Exempt: autotest-only; product adapters require `ONWARD_AUTOTEST=1`. Shared focus-result declaration is type-only. | `electron/main/prompt-input-handlers.ts:55–69`; `electron/main/prompt-input-shortcuts.ts:114–137`; `electron/preload/index.ts:2475–2486`; `electron/shared/autotest-input-focus.ts:6–10`; gated controls in `src/App.tsx` and Prompt components; `src/autotest/**`, `test/**` |
| Optional-color normalization/validation, stable-ID reordering and shared native/DOM IME/AltGr classification | Exempt: side-effect-free, covered by `prompt-input.test.mts` PI-U17..20; the preview reuses the existing unit-tested reducer. Native cancellation still emits `MAIN_PROMPT_SHORTCUT` | `src/utils/prompt-input.ts:126–133,179,216,302–315`; `electron/main/prompt-input-shortcuts.ts:218–220` |
| Appearance trigger, modal entry/exit, focus restoration/native suspension ACK/failure, post-commit focus outcome, category/selection/color/reset draft changes, save-shortcut containment, viewport retry and grid-focus repair | `RENDERER_PROMPT_EMOJI_PICKER`; suspension IPC remains `RENDERER_PROMPT_INPUT_SETTINGS` / `MAIN_PROMPT_SHORTCUT`; persistence remains `RENDERER_PROMPT_INPUT_SETTINGS` / `MAIN_PROMPT_INPUT_SETTINGS` | `src/components/Settings/PromptActionAppearance.tsx:27–151,239–345` |
| Worker creation, catalog ready/index duration, initialization/message/search failures and owner cleanup | `RENDERER_PROMPT_EMOJI_CATALOG`, `WORKER_PROMPT_EMOJI_CATALOG` | `src/components/Settings/PromptActionAppearance.tsx:153–233`; `src/workers/promptEmojiWorker.ts:10–20` |
| Query send/receive, latest-only coalescing, stale reply rejection, Worker search, visible-window apply and focused-scroll active-index reconciliation | `RENDERER_PROMPT_EMOJI_SEARCH`, `WORKER_PROMPT_EMOJI_SEARCH`; aggregated once per second and on disposal, no raw queries or per-frame emission; Worker spans measure only the interval since the last report | `src/components/Settings/PromptActionAppearance.tsx:162–221,307–319`; `src/workers/promptEmojiWorker.ts:13–20` |
| Artwork module first use, broken local resource fallback and fallback reset on source change | `RENDERER_PROMPT_EMOJI_ASSET` | `src/components/PromptNotebook/PromptActionEmoji.tsx:14–33` |
| Text-dialog suspension flag send/receive/validation, ACK, menu state on attach and reset | `RENDERER_PROMPT_INPUT_SETTINGS`, `RENDERER_PROMPT_INPUT_IPC`, `MAIN_PROMPT_SHORTCUT`; PIMS-U21 / PIH-U05 test state transitions | `src/components/Settings/ShortcutInput.tsx:31–48`, `electron/preload/index.ts:1585–1608`, `electron/main/prompt-input-handlers.ts:46–50`, `electron/main/prompt-input-shortcuts.ts:111,170–177,277–284` |
| Emoji normalization/defaults/resource identity, search/ranking/paging and keyboard movement | Exempt: side-effect-free, unit-tested by PE-U01..04 and PI-U21 | `src/utils/prompt-emoji.ts`, `src/utils/prompt-emoji-search.ts`, `src/utils/prompt-input.ts` |
| Pinned asset importer and generated catalogs/licenses | Build-time data tooling, not a product-runtime node; shipped data/hash/identity coverage in PE-U02 | `scripts/import-prompt-emoji.py`, `src/data/prompt-emoji-*`, `public/prompt-emoji/`, `resources/emoji/` |
| Emoji layout, native-dialog centering and bilingual copy | Exempt: presentation/data only, no runtime control-flow node; PIS-05 checks centered unclipped layout in both languages and five Settings widths | `src/components/Settings/PromptActionAppearance.css:7`, `src/components/PromptNotebook/PromptActionButton.css:15`, `src/i18n/prompt-input.ts:6` |
| Emoji test drivers and fixtures | Exempt: autotest-only code under isolated ONWARD_AUTOTEST profiles; no product-runtime node | `test/autotest/prompt-input-settings-driver.mjs`, `src/autotest/test-prompt-sender.ts`, `test/unittest/prompt-emoji.test.mts` |
| Renderer owner-state readout replacing the removed status-row test witness | Exempt: autotest-only, under the existing `ONWARD_AUTOTEST=1` gate | `src/components/PromptNotebook/PromptInputShortcuts.tsx:212–226` |

CSS, locale dictionaries, trace registry entries and the standalone design
document are presentation/data, without a product control-flow node to emit from.
All new event payloads are bounded metadata; action names and draft text are not recorded.

## Peer-product rationale

[OpenCode V2](https://opencode.ai/v2/docs/cli/keybinds) separates Leader actions
from native prompt input; its queue binding demonstrates why gesture and terminal
key need independent configuration. [VS Code chords](https://code.visualstudio.com/docs/configure/keybindings)
and [terminal interception](https://code.visualstudio.com/docs/terminal/advanced#_chords)
make keyboard ownership contextual rather than registering every chord globally.
[tmux send-keys](https://man.openbsd.org/tmux.1#send-keys) and
[WezTerm send-text](https://wezterm.org/cli/cli/send-text.html) address an explicit
destination independently of focus. These precedents support a window-owned
Leader, stable destination IDs and a separate transport contract.

For compact customization, [JetBrains New UI](https://www.jetbrains.com/help/idea/new-ui.html)
uses progressive disclosure, compact spacing and hover names; [VS Code themes](https://code.visualstudio.com/docs/configure/themes)
preview appearance before selection. VS Code's keybinding capture and live
command troubleshooting are separate workflows. The local preview here makes
that distinction explicit while keeping configuration and visual feedback together.

[Notion buttons](https://www.notion.com/help/buttons) pair an action name with a
user-chosen emoji. [VS Code terminal profiles](https://code.visualstudio.com/docs/terminal/profiles)
configure icon and color independently. This iteration adopts those recognition
cues using [MIT Fluent artwork](https://github.com/microsoft/fluentui-emoji/blob/main/LICENSE)
so the small icons have the same appearance on all three supported platforms.

On macOS, [Electron's menu fallback](https://github.com/electron/electron/blob/v43.2.0/shell/browser/api/electron_api_web_contents_mac.mm#L38-L69)
and [Chromium's platform-specific editing bindings](https://github.com/chromium/chromium/blob/150.0.7871.129/third_party/blink/renderer/core/editing/editing_behavior.cc#L168-L182)
explain why text-entry dialogs must retain the native Edit menu while shortcut
recorders suppress it. The picker therefore opts into native-menu preservation
on the existing suspension channel. Automated editing checks use CDP-provided
editing commands; native `sendInputEvent` separately verifies Onward window
shortcut containment, since it does not reproduce Cocoa's editing-command path.
