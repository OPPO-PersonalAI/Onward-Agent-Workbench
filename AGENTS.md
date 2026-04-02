<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

For platform-related commands, always consider these three platforms:
1. macOS
2. Linux
3. Windows
- Use the development build for compilation and debugging by default (`pnpm dist:dev`), unless the user explicitly asks for a production build.
- After modifying code, trigger a build using the following command. Before building, you must fully delete the `out` and `release` directories; otherwise stale code may be packaged. `rm -rf` and `pnpm dist:dev` must be run in the same command joined with `&&`; do not run them separately.
    # Clean and package (development build)
    rm -rf out release && pnpm dist:dev


    If the user explicitly asks for a production build:
    # Clean and package (production build)
    rm -rf out release && pnpm dist
- After every code change, you must perform a startup test and confirm at minimum that the application can launch normally and enter the main UI.
- Multilingual / UI Copy Development Rules:
    - The application currently supports `en` and `zh-CN`, with English as the default language. Whenever user-visible copy is added or modified, all supported languages must be designed and implemented together. Updating only one language is not allowed.
    - User-visible copy includes, but is not limited to, page titles, buttons, settings items, menus, tray menus, dialogs, toasts, tooltips, placeholders, empty states, error messages, context menus, and status text.
    - Any new or modified UI copy must be integrated through the i18n module / dictionary and accessed by key. Do not continue hardcoding single-language strings inside components.
    - For multilingual changes that affect UI layout or interaction, you must also verify language-specific differences in text length, wrapping, truncation, alignment, button width, and dialog layout, to ensure every supported language remains usable and visually correct.
    - If a change affects language settings, persisted storage, main-process menus, the tray, system dialogs, or other non-renderer copy, you must also update the corresponding settings storage, main-process mappings, and fallback logic.
- When the user explicitly asks for automated testing after describing the task requirements:
    - You must create automated test scripts based on the user's requirements and code changes, and run them completely.
    - Ensure the functionality, new features, or bug fixes mentioned by the user are fully resolved.
    - Expand test cases from the requirements to cover different operation paths and entry points.
    - Add as complete a set of test cases as possible and run them all; only report completion after all tests pass.
    - Newly created test scripts must be stored under the `test` directory, and the relevant documentation must be updated for reuse.
- Icon sizing guidelines
    - The macOS app icon must follow the safe-area proportions from Apple Design Resources to avoid appearing oversized in the Dock / Mission Control.
    - Use `resources/icon.svg` as the single source of truth. After changes, fully regenerate `resources/icons/**`, `icon.icns`, `icon.ico`, and `icon.png`.
    - When the app icon display size looks wrong, first check the content-to-canvas ratio rather than the resolution; add more padding by scaling down the content.
    - macOS status bar icons must follow the Template convention: the filename must contain `Template`, and the code must explicitly call `setTemplateImage(true)`; avoid incorrect colors in light/dark mode.
    - After generating tray icons, update all referenced paths so the resource filenames and code stay consistent.
- After the build completes, show the current status and provide the command to run the program. Example: `open "project-dir/release/mac-arm64/Onward 2-branch-name.app"` to launch the app.
- Whenever `CLAUDE.md` is modified, automatically run `./claude-sync-to-agents.sh`.
- Git commit messages must be written in English.
- Hard rule: all code comments must use English. Do not use any Simplified Chinese in code comments.
- Copyright and license compliance:
    - Never copy or adapt code from third-party projects, Stack Overflow, blog posts, or any other external source without verifying its license compatibility with Apache-2.0. Do not reproduce substantial code blocks whose origin is unclear. When in doubt, write an original implementation instead of reusing external snippets.
    - Generated code must not introduce any dependency or code snippet licensed under GPL, LGPL, AGPL, SSPL, or any other copyleft license incompatible with Apache-2.0.
    - Before adding a new production dependency, verify its license is Apache-2.0 compatible (MIT, BSD, ISC, Apache-2.0 are safe; MPL-2.0 requires review; GPL/LGPL/AGPL are forbidden).
    - Every new source file must include the standard SPDX header: `SPDX-FileCopyrightText: 2026 OPPO` and `SPDX-License-Identifier: Apache-2.0`.
    - After adding new dependencies, run `pnpm generate-notices` to regenerate `ThirdPartyNotices.txt` and verify no incompatible licenses were introduced.
- Debugging principles (performance / lag issues):
    - Analyze the current code and the user's requirements first, and prioritize a detailed automated test plan. The test plan must include:
        1. Common paths
        2. High-frequency operation paths
        3. Stress-test paths
    - Sample first, then add logs: use `sample` / profiling to locate hot functions first, then add logs to verify causality.
    - Lock down a reliably reproducible path and time window first: fix the path, steps, and timeline to ensure stable reproduction.
    - Standardize key counters: AppState updates, Git polling, render / DOMPurify counts, etc. They must be observable at a 1-second granularity.
    - Avoid weak stress tests: editing volume and switching frequency must be high enough to surface peak load.
    - Prioritize concurrency and reentrancy checks: determine whether polling, timers, or async tasks are stacking; add throttling / deduplication first.
    - Cleanup must be complete on close / switch: cancel pending worker, timer, idle, and raf tasks to prevent leftover work.
    - Keep the evidence chain closed: profiling, logs, and code must agree, with before / after comparison.
- Context menu rules: any action available through a context menu must include an SVG icon (`width="14" height="14" viewBox="0 0 16 16" fill="currentColor"`). The menu item structure must be `<svg> + <span>text</span>`, using `display: flex; align-items: center; gap: 8px` to keep all context menus visually consistent.
- Context menu icon registry is maintained in `docs/context-menu-icon-registry.md`. Consult it on demand before adding or changing any context menu action, rather than keeping the full registry inline in `CLAUDE.md`.
- Unified context menu CSS rules (all components must follow):
    - Container: `background: var(--panel); border-radius: 10px; padding: 6px; box-shadow: var(--shadow-1); animation: *-context-fade-in 0.15s ease`
    - Menu item: `border-radius: 6px; hover background: color-mix(in srgb, var(--accent) 15%, transparent)`
    - Danger item hover: `background: rgba(239, 68, 68, 0.15)`
    - Separator: `margin: 4px 6px`
- Development principle: any subpage entered from the terminal entry point (such as Git Diff, Git History, or the Project Editor) must respond to ESC consistently and return to the terminal. Prefer reusing a shared ESC handling mechanism (for example, a common Hook) to avoid inconsistent implementations across pages.
- Process management safety: when killing or searching for processes (e.g., `taskkill`, `Get-Process`, `pkill`), always use the exact process name — never use wildcards or partial matches. Using wildcards risks terminating unrelated processes.
- Hard rule — Cross-platform development (Windows / macOS / Linux):
    - Every new feature and bug fix must be designed and validated for all three platforms from the start. Do not implement for one platform first and "port later."
    - Platform-divergent areas require explicit per-platform branching (e.g., `process.platform` checks). The most error-prone areas, based on historical experience, include:
        1. **Git operations** (Git History, Git Diff): line-ending handling (`CRLF` vs `LF`), path separators (`\` vs `/`), shell escaping, locale-dependent output, and Git executable resolution differ significantly across platforms.
        2. **Terminal / shell operations**: default shell (`cmd.exe` / `powershell` vs `bash` / `zsh`), environment variable syntax (`%VAR%` vs `$VAR`), signal handling (`SIGTERM` vs `taskkill`), and PTY implementations vary.
        3. **File-system operations**: path length limits, case sensitivity, reserved filenames (`CON`, `NUL`, etc. on Windows), symlink behavior, and file-locking semantics.
    - When writing or reviewing platform-related code, always ask: "Will this behave correctly on the other two platforms?" If unsure, add explicit handling or at minimum a `TODO(cross-platform)` comment explaining the risk.
    - Automated tests that touch any of the above areas should include platform-specific assertions or be clearly marked as platform-conditional.
- Every task completion report must include:
    1. What is the task goal of the code, and what solution / design approach was used?
    2. What changes were made to which files?
    3. Finally, how do you evaluate this round of feature iteration? Is the repository change a very good / elegant design, or only a temporary patch-style solution?
    4. What would be a better follow-up improvement direction? Check whether any technical debt remains in the current repository?

## Performance Regression Testing

When designing or running performance-related test cases, refer to `test/performance-regression-guide.md` for standard procedures, expected baselines, and the regression checklist.

## Lessons Learned

Before starting complex feature development, read `docs/lessons.md` for historical lessons learned to avoid repeating past mistakes.
