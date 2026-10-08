<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Theme palette attribution

Onward's builtin themes are **palette adaptations**, not the complete upstream VS Code extensions. Palette values, theme names and source URLs are recorded in `src/themes/theme-presets.ts`. The engine and adapters are original Onward code. No logos, commercial themes, extension executables, fonts or other assets are bundled.

| Onward IDs | Palette source | Upstream license (included here) |
| --- | --- | --- |
| `dark-modern`, `light-modern` | [Microsoft VS Code default themes](https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults/themes) | [MIT — Microsoft](licenses/vscode.txt) |
| `monokai` | [Microsoft VS Code Monokai](https://github.com/microsoft/vscode/blob/main/extensions/theme-monokai/themes/monokai-color-theme.json) | [MIT — Microsoft](licenses/vscode.txt) |
| `dracula` | [Dracula for Visual Studio Code](https://github.com/dracula/visual-studio-code/blob/master/src/dracula.yml) | [MIT — Dracula Theme](licenses/dracula.txt) |
| `one-dark-pro` | [Binaryify One Dark Pro](https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json) | [MIT — Binaryify](licenses/one-dark-pro.txt) |
| `nord` | [Nord for Visual Studio Code](https://github.com/nordtheme/visual-studio-code/blob/develop/themes/nord-color-theme.json) | [MIT — Sven Greb](licenses/nord.txt) |
| `solarized-light`, `solarized-dark` | [Ethan Schoonover's Solarized](https://github.com/altercation/solarized/blob/master/README.md) | [MIT — Ethan Schoonover](licenses/solarized.txt) |
| `github-light`, `github-dark` | [Primer's GitHub VS Code Theme](https://github.com/primer/github-vscode-theme/blob/main/src/theme.js), [color definitions](https://github.com/primer/github-vscode-theme/blob/main/src/colors.js) | [MIT — Primer](licenses/github.txt) |
| `onward-classic` | Onward's original six presets/custom-accent generator and original default terminal palette | Apache-2.0 (repository license); default terminal colors follow VS Code |

The upstream license files were verified on 2026-10-07. Their full copyright and permission notices are retained verbatim in `licenses/`. This directory ships through the existing `resources` packaging rule on macOS, Windows and Linux. It introduces no runtime dependency.

## Adaptation details

- Each builtin supplies all 16 ANSI terminal colors. Terminal, workbench, editor and syntax colors are independent outputs of a single resolved theme.
- Workbench foreground levels and semantic success/warning/danger/diff colors are Onward adaptations for readable light and dark surfaces. Solarized Light uses its emphasized `base01` foreground (`#586e75`) for body text. Some comment colors are lifted for readability.
- Classic retains the existing twelve CSS values byte-for-byte, including the custom accent generator. Its default terminal palette is retained byte-for-byte as well. Overrides are applied only when explicitly selected or migrated.
- TextMate scopes are approximately adapted to Monaco's common token names and preview syntax CSS. Onward does not ship a TextMate grammar engine. Missing or blank scopes retain the default token style, including explicit empty `fontStyle` resets. Collapsed scopes emit `approximation:` diagnostics; a per-property scope-depth heuristic keeps more-specific colors/styles over later broad rules, with last-wins ties. This cannot preserve distinctions between line/block comments or language-specific scopes once they share one common category. Complex parent/exclusion selectors, unknown scopes, token backgrounds and token foreground alpha are also reported by `adaptThemeTokenRules`. Token alpha is dropped for Monaco's six-digit foreground format; workbench/editor selection and terminal colors preserve supported alpha hex values.
- Imported theme normalization accepts only hexadecimal colors (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`), reserves builtin IDs, strips prototype keys and limits themes, colors, scopes, rules and per-task overrides. Persistence and file parsing belong to the callers.
- New users follow the OS with Light/Dark Modern and retain Graphite as their Classic preset. Unversioned legacy settings migrate once into Classic, including exact legacy per-task replacement semantics. Only a falsy legacy theme with `legacyPreV2: true` selects Starlight; missing/invalid themes in settings schemas v2–v7, and truthy invalid themes even in older schemas, select Graphite. Classic custom accents retain the historical six-digit-hex validation. Explicit versioned theme input never reimports obsolete terminal color fields.

## Shared API

`theme-engine.ts` exports `resolveTheme`, `getActiveThemeId`, `getAvailableThemes`, `normalizeThemeSettings`, `isThemeColor`, `normalizeThemeDefinition`, `adaptThemeTokenRules`, `THEME_LIMITS` and `FEATURED_THEME_IDS`. `theme-presets.ts` exports the featured list, `BUILTIN_THEMES`, `CLASSIC_THEME_ID`, `CLASSIC_TERMINAL_THEME` and `ANSI_COLOR_NAMES`. No metadata fields beyond the agreed `ThemeDefinition` contract were added.

The functions are deterministic, side-effect-free transforms and have unit coverage in `test/unittest/theme-engine.test.mts`; they are exempt from diagnostic trace instrumentation. Callers own traceable persistence, system-appearance events and theme application. Monaco is always registered/applied under the central `onward-active` ID by the application layer.
