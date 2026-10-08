/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITheme } from '@xterm/xterm'
import type { ThemeDefinition, ThemeTokenRule } from '../types/theme'

// Palette adaptations and upstream MIT notices are documented in resources/themes/README.md.
export const FEATURED_THEME_IDS = ['dark-modern', 'light-modern', 'dracula', 'one-dark-pro', 'nord', 'solarized-light'] as const
export const CLASSIC_THEME_ID = 'onward-classic'
export const ANSI_COLOR_NAMES = [
  'Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
  'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'
] as const

const DARK_ANSI = '#000000 #cd3131 #0dbc79 #e5e510 #2472c8 #bc3fbc #11a8cd #e5e5e5 #666666 #f14c4c #23d18b #f5f543 #3b8eea #d670d6 #29b8db #e5e5e5'
const LIGHT_ANSI = '#000000 #cd3131 #107c10 #949800 #0451a5 #bc05bc #0598bc #555555 #666666 #cd3131 #14ce14 #b5ba00 #0451a5 #bc05bc #0598bc #a5a5a5'
const SOLARIZED_ANSI = '#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3'
const SYNTAX_SCOPES = ['comment', 'keyword', 'string', 'constant.numeric', 'entity.name.function', 'entity.name.type', 'variable', 'keyword.operator']

interface Palette {
  id: string
  name: string
  kind: ThemeDefinition['kind']
  background: string
  foreground: string
  surface: string
  panel: string
  border: string
  accent: string
  selection: string
  ansi: string
  syntax: string
  source: string
}

function makeTheme(palette: Palette): ThemeDefinition {
  const colors: Record<string, string> = {
    'editor.background': palette.background,
    'editor.foreground': palette.foreground,
    'foreground': palette.foreground,
    'sideBar.background': palette.surface,
    'panel.background': palette.panel,
    'panel.border': palette.border,
    'focusBorder': palette.accent,
    'textLink.foreground': palette.accent,
    'editor.selectionBackground': palette.selection,
    'terminal.background': palette.background,
    'terminal.foreground': palette.foreground,
    'terminalCursor.foreground': palette.foreground,
    'terminalCursor.background': palette.background,
    'terminal.selectionBackground': palette.selection,
    'terminal.selectionForeground': palette.foreground
  }
  palette.ansi.split(' ').forEach((color, index) => { colors[`terminal.ansi${ANSI_COLOR_NAMES[index]}`] = color })
  const tokenColors: ThemeTokenRule[] = palette.syntax.split(' ').map((foreground, index) => ({
    scope: SYNTAX_SCOPES[index], settings: { foreground }
  }))
  return { id: palette.id, name: palette.name, kind: palette.kind, colors, tokenColors, source: palette.source }
}

export const CLASSIC_TERMINAL_THEME: Readonly<ITheme> = Object.freeze({
  background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#000000',
  selectionBackground: '#264f78', selectionForeground: '#ffffff', selectionInactiveBackground: '#3a3d41',
  ...Object.fromEntries(DARK_ANSI.split(' ').map((color, index) => {
    const name = ANSI_COLOR_NAMES[index]
    return [name[0].toLowerCase() + name.slice(1), color]
  }))
})

export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  makeTheme({
    id: 'dark-modern', name: 'Dark Modern', kind: 'dark',
    background: '#1f1f1f', foreground: '#cccccc', surface: '#181818', panel: '#181818', border: '#2b2b2b',
    accent: '#0078d4', selection: '#264f78', ansi: DARK_ANSI,
    syntax: '#6a9955 #c586c0 #ce9178 #b5cea8 #dcdcaa #4ec9b0 #9cdcfe #d4d4d4',
    source: 'https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults'
  }),
  makeTheme({
    id: 'light-modern', name: 'Light Modern', kind: 'light',
    background: '#ffffff', foreground: '#3b3b3b', surface: '#f8f8f8', panel: '#f8f8f8', border: '#e5e5e5',
    accent: '#005fb8', selection: '#add6ff', ansi: LIGHT_ANSI,
    syntax: '#008000 #af00db #a31515 #098658 #795e26 #267f99 #001080 #000000',
    source: 'https://github.com/microsoft/vscode/tree/main/extensions/theme-defaults'
  }),
  makeTheme({
    id: 'dracula', name: 'Dracula', kind: 'dark',
    background: '#282a36', foreground: '#f8f8f2', surface: '#21222c', panel: '#343746', border: '#44475a',
    accent: '#bd93f9', selection: '#44475a',
    ansi: '#21222c #ff5555 #50fa7b #f1fa8c #bd93f9 #ff79c6 #8be9fd #f8f8f2 #6272a4 #ff6e6e #69ff94 #ffffa5 #d6acff #ff92df #a4ffff #ffffff',
    syntax: '#6272a4 #ff79c6 #f1fa8c #bd93f9 #50fa7b #8be9fd #f8f8f2 #ff79c6',
    source: 'https://github.com/dracula/visual-studio-code/blob/master/src/dracula.yml'
  }),
  makeTheme({
    id: 'one-dark-pro', name: 'One Dark Pro', kind: 'dark',
    background: '#282c34', foreground: '#abb2bf', surface: '#21252b', panel: '#282c34', border: '#3e4452',
    accent: '#61afef', selection: '#67769660',
    ansi: '#3f4451 #e05561 #8cc265 #d18f52 #4aa5f0 #c162de #42b3c2 #d7dae0 #4f5666 #ff616e #a5e075 #f0a45d #4dc4ff #de73ff #4cd1e0 #e6e6e6',
    syntax: '#7f848e #c678dd #98c379 #d19a66 #61afef #e5c07b #e06c75 #56b6c2',
    source: 'https://github.com/Binaryify/OneDark-Pro/blob/master/themes/OneDark-Pro.json'
  }),
  makeTheme({
    id: 'nord', name: 'Nord', kind: 'dark',
    background: '#2e3440', foreground: '#d8dee9', surface: '#2e3440', panel: '#3b4252', border: '#434c5e',
    accent: '#88c0d0', selection: '#434c5ecc',
    ansi: '#3b4252 #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #88c0d0 #e5e9f0 #4c566a #bf616a #a3be8c #ebcb8b #81a1c1 #b48ead #8fbcbb #eceff4',
    syntax: '#7b88a1 #81a1c1 #a3be8c #b48ead #88c0d0 #8fbcbb #d8dee9 #81a1c1',
    source: 'https://github.com/nordtheme/visual-studio-code/blob/develop/themes/nord-color-theme.json'
  }),
  makeTheme({
    id: 'solarized-light', name: 'Solarized Light', kind: 'light',
    background: '#fdf6e3', foreground: '#586e75', surface: '#eee8d5', panel: '#eee8d5', border: '#d3cbb7',
    accent: '#268bd2', selection: '#d8d2c0', ansi: SOLARIZED_ANSI,
    syntax: '#657b83 #859900 #2aa198 #d33682 #268bd2 #b58900 #586e75 #859900',
    source: 'https://github.com/altercation/solarized'
  }),
  makeTheme({
    id: 'solarized-dark', name: 'Solarized Dark', kind: 'dark',
    background: '#002b36', foreground: '#839496', surface: '#00212b', panel: '#073642', border: '#28505a',
    accent: '#268bd2', selection: '#073642', ansi: SOLARIZED_ANSI,
    syntax: '#657b83 #859900 #2aa198 #d33682 #268bd2 #b58900 #839496 #859900',
    source: 'https://github.com/altercation/solarized'
  }),
  makeTheme({
    id: 'github-light', name: 'GitHub Light', kind: 'light',
    background: '#ffffff', foreground: '#1f2328', surface: '#f6f8fa', panel: '#f6f8fa', border: '#d0d7de',
    accent: '#0969da', selection: '#0969da33',
    ansi: '#24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #1a7f37 #633c01 #218bff #a475f9 #3192aa #8c959f',
    syntax: '#6e7781 #cf222e #0a3069 #0550ae #8250df #953800 #1f2328 #cf222e',
    source: 'https://github.com/primer/github-vscode-theme'
  }),
  makeTheme({
    id: 'github-dark', name: 'GitHub Dark', kind: 'dark',
    background: '#0d1117', foreground: '#e6edf3', surface: '#010409', panel: '#161b22', border: '#30363d',
    accent: '#2f81f7', selection: '#388bfd40',
    ansi: '#484f58 #ff7b72 #3fb950 #d29922 #58a6ff #bc8cff #39c5cf #b1bac4 #6e7681 #ffa198 #56d364 #e3b341 #79c0ff #d2a8ff #56d4dd #f0f6fc',
    syntax: '#8b949e #ff7b72 #a5d6ff #79c0ff #d2a8ff #ffa657 #e6edf3 #ff7b72',
    source: 'https://github.com/primer/github-vscode-theme'
  }),
  makeTheme({
    id: 'monokai', name: 'Monokai', kind: 'dark',
    background: '#272822', foreground: '#f8f8f2', surface: '#1e1f1c', panel: '#272822', border: '#414339',
    accent: '#a6e22e', selection: '#878b9180',
    ansi: '#333333 #c4265e #86b42b #b3b42b #6a7ec8 #8c6bc8 #56adbc #e3e3dd #666666 #f92672 #a6e22e #e2e22e #819aff #ae81ff #66d9ef #f8f8f2',
    syntax: '#88846f #f92672 #e6db74 #ae81ff #a6e22e #66d9ef #f8f8f2 #f92672',
    source: 'https://github.com/microsoft/vscode/tree/main/extensions/theme-monokai'
  }),
  makeTheme({
    id: CLASSIC_THEME_ID, name: 'Onward Classic', kind: 'dark',
    background: '#1e1e1e', foreground: '#cccccc', surface: '#141821', panel: '#1f2430', border: '#2a303c',
    accent: '#3b82f6', selection: '#264f78', ansi: DARK_ANSI,
    syntax: '#6a9955 #c586c0 #ce9178 #b5cea8 #dcdcaa #4ec9b0 #9cdcfe #d4d4d4',
    source: 'Onward'
  })
]

// Consumers receive copies through getAvailableThemes; protect the shared palette data too.
for (const theme of BUILTIN_THEMES) {
  Object.freeze(theme.colors)
  for (const rule of theme.tokenColors ?? []) {
    Object.freeze(rule.settings)
    Object.freeze(rule)
  }
  Object.freeze(theme.tokenColors)
  Object.freeze(theme)
}
Object.freeze(BUILTIN_THEMES)
