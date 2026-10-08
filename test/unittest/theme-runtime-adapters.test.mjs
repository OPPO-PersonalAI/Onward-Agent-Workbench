/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import * as pierre from '@pierre/diffs'
import xterm from '@xterm/xterm'
import { themeIcons } from 'seti-icons'

// Exercise the real adapters in Node, replacing only browser/renderer dependencies.
function loadRendererModule(relativePath, dependencies, globals = {}) {
  const filename = fileURLToPath(new URL(relativePath, import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, performance,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    ...globals
  }, { filename })
  return module.exports
}

const traces = []
const traceDependencies = {
  '../utils/perf-trace': { perfTraceDiagnostic: (name, data) => traces.push({ name, data }) },
  '../utils/perf-trace-names': { PERF_TRACE_EVENT: {
    RENDERER_THEME_EDITOR_APPLY: 'editor-applied', RENDERER_THEME_TERMINAL_APPLY: 'terminal-applied'
  } },
  '../utils/performance-trace': { performanceTrace: { summarizeText: () => ({ themeHash: 'redacted' }) } }
}
const legacy = loadRendererModule('../../src/themes/terminal-themes.ts', {})
const windowStub = {
  setInterval: () => 0,
  electronAPI: {
    platform: 'linux', debug: { autotest: false },
    terminal: { onData() {}, onExit() {}, onGetBufferRequest() {}, setBufferFastPath() {}, setOutputVisibility() {} }
  }
}
class NoopAddon { activate() {} dispose() {} }
const terminals = loadRendererModule('../../src/terminal/terminal-session-manager.ts', {
  '@xterm/xterm': xterm, '@xterm/addon-fit': { FitAddon: NoopAddon },
  '@xterm/addon-web-links': { WebLinksAddon: NoopAddon }, '@xterm/addon-search': { SearchAddon: NoopAddon },
  '../components/Terminal/oscCwdAddon': { installOscCwdAddon() {} }, '../themes/terminal-themes': legacy,
  '../utils/externalLink': {}, '../utils/perf-monitor': {}, './input-priority-lane': {},
  './terminal-output-scheduler': { TerminalOutputScheduler: class { registerTarget() {} } },
  './terminal-renderer-lifecycle': { createTerminalRendererPolicy: () => ({}), TerminalRendererLifecycle: class {} },
  './terminal-renderer-surface-policy': {}, ...traceDependencies
}, { window: windowStub, navigator: { userAgent: 'Node unit test' } })
const definitions = []
const editorAdapter = loadRendererModule('../../src/themes/editor-theme.ts', {
  'monaco-editor': { editor: {
    defineTheme: (name, definition) => definitions.push({ name, definition }), setTheme() {}
  } },
  '@pierre/diffs': pierre,
  ...traceDependencies
})
const options = theme => ({ theme, fontFamily: 'monospace', fontSize: 14 })

test('Seti rows retain live semantic CSS references across light/dark and same-ID color edits', () => {
  const seti = loadRendererModule('../../src/components/ProjectEditor/setiFileIconTheme.ts', {
    dompurify: { default: { sanitize: () => assert.fail('Palette resolution does not sanitize SVG') } },
    'seti-icons': { themeIcons },
    '../../constants/themes': { DEFAULT_THEME_SETTINGS: {} },
    '../../utils/theme-applier': { resolveThemeColors: () => ({}) }
  })
  const mappings = [
    { '--accent': '#005fb8', '--text-1': '#3b3b3b', '--text-2': '#535353', '--text-3': '#686868' },
    { '--accent': '#0078d4', '--text-1': '#cccccc', '--text-2': '#b7b7b7', '--text-3': '#999999' },
    { '--accent': '#aa3388', '--text-1': '#fefefe', '--text-2': '#dedede', '--text-3': '#bcbcbc' }
  ].map(colors => seti.buildSetiThemeFromAppColors(Object.freeze(colors)))
  for (const mapping of mappings) {
    for (const value of Object.values(mapping)) assert.match(value, /^var\(--[a-z\d-]+, #[\da-f]{6}\)$/)
    assert.match(mapping.blue, /^var\(--accent,/)
    assert.equal(mapping.green, 'var(--syntax-string, #4ade80)')
    assert.equal(mapping.pink, 'var(--syntax-keyword, #f472b6)')
    assert.equal(mapping.purple, 'var(--syntax-function, #c084fc)')
  }
  assert.notEqual(mappings[0].white, mappings[1].white, 'Fallback follows the resolved foreground too')
})

test('runtime terminal palette preserves ANSI/cursor/selection and ignores retired Task colors without mutation', () => {
  const base = Object.freeze({
    foreground: '#111111', background: '#ffffff', cursor: '#224466', selectionBackground: '#abcdef80',
    red: '#aa0000', brightRed: '#ff0000', extendedAnsi: Object.freeze(['#123456', '#654321'])
  })
  const theme = terminals.buildTheme({ ...options(base), terminalStyle: {
    foregroundColor: '#333333', backgroundColor: '#123456', fontSize: 22, fontFamily: 'Task Mono'
  } })
  assert.equal(theme.foreground, '#111111')
  assert.equal(theme.background, '#ffffff')
  assert.equal(theme.cursor, base.cursor)
  assert.equal(theme.selectionBackground, base.selectionBackground)
  assert.equal(theme.red, base.red)
  assert.equal(theme.brightRed, base.brightRed)
  assert.deepEqual(Array.from(theme.extendedAnsi), Array.from(base.extendedAnsi))
  assert.equal(base.foreground, '#111111')
  assert.equal(terminals.buildTheme(options('vscode-dark')).background, '#1e1e1e')
  assert.equal(terminals.buildTheme(options('unknown-legacy-theme')).background, '#1e1e1e')
})

test('terminal palette equality detects removal, alpha, ANSI and extended ANSI changes', () => {
  const a = { foreground: '#111111', cursor: '#222222', selectionBackground: '#33333380', red: '#444444', extendedAnsi: ['#555555'] }
  assert.equal(terminals.terminalThemesEqual(a, { ...a, extendedAnsi: [...a.extendedAnsi] }), true)
  assert.equal(terminals.terminalThemesEqual(undefined, a), false)
  for (const key of ['foreground', 'cursor', 'selectionBackground', 'red']) {
    assert.equal(terminals.terminalThemesEqual(a, { ...a, [key]: '#123456' }), false, key)
    const removed = { ...a }
    delete removed[key]
    assert.equal(terminals.terminalThemesEqual(a, removed), false, `removed ${key}`)
  }
  assert.equal(terminals.terminalThemesEqual(a, { ...a, extendedAnsi: ['#aaaaaa'] }), false)
  assert.equal(terminals.terminalThemesEqual(a, { ...a, extendedAnsi: ['#555555', '#666666'] }), false)
})

test('palette-only session update skips fonts and geometry, including invisible sessions; identical colors emit nothing', () => {
  const manager = new terminals.TerminalSessionManager()
  let geometryRefreshes = 0
  manager.scheduleGeometryRefresh = () => { geometryRefreshes += 1 }
  const writes = []
  const initial = options({ foreground: '#eeeeee', background: '#111111' })
  const terminalOptions = new Proxy({ ...initial, theme: { ...initial.theme }, minimumContrastRatio: 1 }, {
    set(target, key, value) { writes.push(key); target[key] = value; return true }
  })
  const session = { id: 'task-1', visible: false, lastOptions: initial, terminal: { options: terminalOptions } }
  manager.sessions.set(session.id, session)
  const before = traces.length
  manager.updateOptions(session.id, options({ foreground: '#111111', background: '#eeeeee' }))
  assert.deepEqual(writes, ['theme'])
  assert.equal(geometryRefreshes, 0)
  assert.equal(traces.length, before + 1)
  assert.equal(traces.at(-1).data.visible, false)
  manager.updateOptions(session.id, options({ foreground: '#111111', background: '#eeeeee' }))
  assert.deepEqual(writes, ['theme'])
  assert.equal(traces.length, before + 1)
  manager.updateOptions(session.id, { ...options(terminalOptions.theme), fontSize: 18 })
  assert.deepEqual(writes, ['theme', 'fontSize'])
  assert.equal(geometryRefreshes, 1)
  assert.equal(manager.getThemeSnapshotsForAutotest().length, 0)
  windowStub.electronAPI.debug.autotest = true
  try {
    const snapshot = manager.getThemeSnapshotsForAutotest()[0]
    assert.equal(snapshot.theme.foreground, '#111111')
    snapshot.theme.foreground = '#ff0000'
    assert.equal(terminalOptions.theme.foreground, '#111111')
  } finally {
    windowStub.electronAPI.debug.autotest = false
  }
})

test('contrast policy applies only to non-Classic light themes, independent of palette and theme ID', () => {
  for (const [kind, isClassic, expected] of [
    ['light', false, 4.5], ['dark', false, 1], ['light', true, 1], ['dark', true, 1]
  ]) {
    const resolved = Object.freeze({ kind, isClassic, id: 'imported-custom', terminal: { background: '#777777' } })
    assert.equal(terminals.resolveTerminalMinimumContrastRatio(resolved), expected)
  }
})

test('new xterm sessions receive the selected contrast before opening, including legacy defaults', t => {
  const manager = new terminals.TerminalSessionManager()
  for (const ratio of [4.5, 1, undefined]) {
    const session = manager.createSession(`contrast-${ratio}`, { ...options({ background: '#ffffff' }), minimumContrastRatio: ratio })
    t.after(() => session.terminal.dispose())
    assert.equal(session.terminal.options.minimumContrastRatio, ratio ?? 1)
    assert.equal(traces.at(-1).data.phase, 'create')
    assert.equal(traces.at(-1).data.minimumContrastRatio, ratio ?? 1)
  }
})

test('ratio-only changes reset on the same hidden session without palette writes, fonts or geometry', () => {
  const manager = new terminals.TerminalSessionManager()
  manager.scheduleGeometryRefresh = () => assert.fail('Contrast cannot schedule a fit or PTY resize')
  const writes = []
  const initial = options(Object.freeze({ background: '#ffffff', foreground: '#eeeeee', red: '#ffaaaa' }))
  const actual = { ...initial, minimumContrastRatio: 1 }
  const session = { id: 'hidden-contrast', visible: false, lastOptions: initial, terminal: { options: new Proxy(actual, {
    set(target, key, value) { writes.push(key); target[key] = value; return true }
  }) } }
  manager.sessions.set(session.id, session)
  const sequence = [4.5, 1, 4.5, undefined]
  for (const ratio of sequence) {
    const before = traces.length
    manager.updateOptions(session.id, { ...initial, minimumContrastRatio: ratio })
    assert.equal(actual.minimumContrastRatio, ratio ?? 1)
    assert.equal(actual.theme, initial.theme)
    assert.equal(traces.length, before + 1)
    assert.equal(traces.at(-1).data.minimumContrastRatio, ratio ?? 1)
    assert.equal(traces.at(-1).data.paletteChanged, false)
    assert.equal(traces.at(-1).data.contrastChanged, true)
    assert.equal(traces.at(-1).data.visible, false)
    assert.equal(typeof traces.at(-1).data.durationMs, 'number')
    manager.updateOptions(session.id, { ...initial, minimumContrastRatio: ratio })
    assert.equal(traces.length, before + 1, 'Unchanged contrast must not trigger redraws or another trace')
  }
  assert.deepEqual(writes, sequence.map(() => 'minimumContrastRatio'))
})

test('contrast roundtrips keep real xterm ANSI options and truecolor buffer cells intact on visible/hidden sessions', async t => {
  const manager = new terminals.TerminalSessionManager()
  manager.scheduleGeometryRefresh = () => assert.fail('Theme contrast must not change geometry')
  const base = Object.freeze({
    foreground: '#eeeeee', background: '#ffffff', red: '#ffaaaa', brightRed: '#ffcccc',
    extendedAnsi: Object.freeze(['#123456', '#abcdef'])
  })
  const session = manager.createSession('raw-colors', { ...options(base), minimumContrastRatio: 1 })
  const terminal = session.terminal
  t.after(() => terminal.dispose())
  const fixture = readFileSync(new URL('../autotest/fixtures/themes-ui/terminal-screen.txt', import.meta.url), 'utf8')
    .replaceAll('\\x1b', '\x1b').replace(/\r?\n/g, '\r\n')
  await new Promise(resolve => terminal.write(fixture, resolve))
  const buffer = terminal.buffer.active
  const lineIndex = Array.from({ length: buffer.length }, (_, i) => i)
    .find(i => buffer.getLine(i).translateToString(true).includes('TRUECOLOR_SAMPLE'))
  assert.notEqual(lineIndex, undefined, 'Fixture must exercise raw RGB cells, not just indexed ANSI')
  const cell = () => buffer.getLine(lineIndex).getCell(0)
  const beforeText = buffer.getLine(lineIndex).translateToString()
  const beforeViewport = buffer.viewportY
  const beforeCursor = [buffer.cursorX, buffer.cursorY]
  windowStub.electronAPI.debug.autotest = true
  t.after(() => { windowStub.electronAPI.debug.autotest = false })
  for (let trial = 0; trial < 5; trial++) {
    session.visible = trial % 2 === 0
    for (const [kind, isClassic, expected] of [['light', false, 4.5], ['dark', false, 1], ['light', false, 4.5], ['light', true, 1]]) {
      manager.updateOptions(session.id, { ...options(base), minimumContrastRatio: terminals.resolveTerminalMinimumContrastRatio({ kind, isClassic }) })
      assert.equal(manager.sessions.get(session.id).terminal, terminal)
      assert.equal(terminal.buffer.active, buffer)
      assert.equal(terminal.options.minimumContrastRatio, expected)
      assert.deepEqual({ ...terminal.options.theme }, { ...base })
      assert.equal(buffer.viewportY, beforeViewport)
      assert.deepEqual([buffer.cursorX, buffer.cursorY], beforeCursor)
      assert.equal(buffer.getLine(lineIndex).translateToString(), beforeText)
      assert.ok(cell().isFgRGB() && cell().isBgRGB())
      assert.equal(cell().getFgColor(), 0x123456)
      assert.equal(cell().getBgColor(), 0xf1e2d3)
      assert.equal(manager.getThemeSnapshotsForAutotest()[0].minimumContrastRatio, expected)
    }
  }
})

function palette(kind) {
  const light = kind === 'light'
  return {
    id: 'test-palette', kind, isClassic: false,
    colors: {
      '--bg-2': '#bbbbbb', '--text-3': '#666666', '--accent': '#0055aa', '--warning': '#998800',
      '--syntax-comment': '#009900', '--syntax-keyword': '#990099', '--syntax-string': '#aa3300',
      '--syntax-number': '#008899', '--syntax-function': '#997700', '--syntax-variable': '#225588',
      '--syntax-operator': '#777777', '--diff-add-text': '#008800', '--diff-delete-text': '#cc0000',
      '--diff-add-bg': '#00880022', '--diff-delete-bg': '#cc000022'
    },
    terminal: { red: '#bb0000', brightCyan: '#00bbbb' },
    editor: {
      base: light ? 'vs' : 'vs-dark', inherit: true, rules: [{ token: 'string', foreground: 'aa3300' }],
      colors: {
        'editor.background': light ? '#ffffff' : '#111111', 'editor.foreground': light ? '#111111' : '#eeeeee',
        'editor.selectionBackground': '#33445566'
      }
    }
  }
}

test('Pierre roles honor resolved editor surfaces, semantic syntax, diff overrides, ANSI and same-ID drafts', () => {
  const theme = palette('light')
  const style = editorAdapter.buildPierreThemeStyle(theme)
  assert.equal(style.colorScheme, 'light')
  assert.equal(style['--diffs-background'], '#ffffff')
  assert.equal(style['--diffs-foreground'], '#111111')
  assert.equal(style['--diffs-token-string'], '#aa3300')
  assert.equal(style['--diffs-token-function'], '#997700')
  assert.equal(style['--diffs-bg-context-override'], '#ffffff')
  assert.equal(style['--diffs-bg-addition-override'], '#00880022')
  assert.equal(style['--diffs-bg-selection-override'], '#33445566')
  assert.equal(style['--diffs-ansi-bright-cyan'], '#00bbbb')
  const changed = palette('dark')
  changed.colors['--syntax-string'] = '#ff00ff'
  changed.editor.colors['diffEditor.insertedTextBackground'] = '#12345678'
  changed.editor.colors['editorLineNumber.foreground'] = '#abcdef'
  const updated = editorAdapter.buildPierreThemeStyle(changed)
  assert.equal(updated.colorScheme, 'dark')
  assert.equal(updated['--diffs-background'], '#111111')
  assert.equal(updated['--diffs-token-string'], '#ff00ff')
  assert.equal(updated['--diffs-bg-addition-emphasis-override'], '#12345678')
  assert.equal(updated['--diffs-fg-number-override'], '#abcdef')
  assert.equal(style['--diffs-token-string'], '#aa3300')
})

test('registered Pierre theme consumes the exact public variable prefix supplied by the adapter', async () => {
  const theme = await pierre.getResolvedOrResolveTheme(editorAdapter.ACTIVE_PIERRE_THEME)
  assert.equal(theme.bg, 'var(--diffs-background)')
  assert.equal(theme.fg, 'var(--diffs-foreground)')
  assert.equal(theme.colorReplacements[theme.colors['terminal.ansiBrightCyan']], 'var(--diffs-ansi-bright-cyan)')
  assert.ok(Object.values(theme.colorReplacements).includes('var(--diffs-token-string)'))
  const style = editorAdapter.buildPierreThemeStyle(palette('dark'))
  for (const value of Object.values(theme.colorReplacements)) {
    const variable = /^var\((--diffs-token-[^)]+)\)$/.exec(value)?.[1]
    if (variable) assert.ok(style[variable], `Unresolved Pierre syntax variable ${variable}`)
  }
})

test('Monaco definition replacement clears previous palette entries and snapshots cannot mutate the applied colors', () => {
  const first = palette('dark')
  first.editor.colors['editor.findMatchBackground'] = '#778899'
  editorAdapter.applyEditorTheme(first)
  const next = palette('light')
  editorAdapter.applyEditorTheme(next)
  const actual = definitions.at(-1)
  assert.equal(actual.name, 'onward-active')
  assert.equal(actual.definition.base, 'vs')
  assert.equal(actual.definition.colors['editor.findMatchBackground'], undefined)
  next.editor.colors['editor.background'] = '#ff0000'
  const snapshot = editorAdapter.getAppliedEditorTheme()
  assert.equal(snapshot.colors['editor.background'], '#ffffff')
  snapshot.rules[0].foreground = '000000'
  snapshot.colors['editor.background'] = '#000000'
  assert.equal(editorAdapter.getAppliedEditorTheme().colors['editor.background'], '#ffffff')
  assert.equal(editorAdapter.getAppliedEditorTheme().rules[0].foreground, 'aa3300')
})
