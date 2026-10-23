/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as engine from '../../src/themes/theme-engine.ts'
import * as themes from '../../src/constants/themes.ts'
import * as presets from '../../src/themes/theme-presets.ts'
import * as schedule from '../../src/themes/theme-schedule.ts'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'
import { handlerHarness, preloadBridge } from './support/theme-import-harness.mjs'
import { importThemeFile } from '../../electron/main/theme-import-source.ts'

const filename = fileURLToPath(new URL('../../src/components/Settings/ThemeSelector.tsx', import.meta.url))
// Export private helpers only in this in-memory copy; tests execute the actual module and JSX callbacks.
const compiled = ts.transpileModule(`${readFileSync(filename, 'utf8')}\nexport { effectiveColor, pickerColor, ColorField };`, {
  fileName: filename,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText
const initialTheme = id => engine.normalizeThemeSettings({ ...themes.DEFAULT_THEME_SETTINGS, mode: 'manual', themeId: id ?? 'light-modern' })
const settled = () => new Promise(resolve => setImmediate(resolve))
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
const secret = 'PRIVATE_THEME_NAME_OR_PATH_TOKEN'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.props?.children)]
}

function createHarness(t, theme = initialTheme(), options = {}) {
  const hooks = []
  const effects = []
  const escapes = new Map()
  const traces = []
  const previews = []
  const saves = []
  let cursor = 0
  let tree
  let mounted = true
  let stateWrites = 0
  const react = {
    useState(initial) {
      const index = cursor++
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, next => {
        stateWrites++
        hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next
      }]
    },
    useRef(initial) {
      const index = cursor++
      return hooks[index] ??= { current: initial }
    },
    useId: () => 'unit-color-field',
    useMemo(create, dependencies) {
      const index = cursor++
      if (!sameDeps(hooks[index]?.dependencies, dependencies)) hooks[index] = { value: create(), dependencies }
      return hooks[index].value
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) },
    useEffect(create, dependencies) {
      const index = cursor++
      if (sameDeps(hooks[index]?.dependencies, dependencies)) return
      hooks[index]?.cleanup?.()
      const effect = { create, dependencies }
      hooks[index] = effect
      effects.push(effect)
    }
  }
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../../contexts/SettingsContext': { useSettings: () => ({
      settings: { theme }, systemDark: false,
      previewTheme: value => previews.push(value),
      updateTheme: next => { saves.push(next); return options.save ? options.save(next) : Promise.resolve(true) }
    }) },
    '../../constants/themes': themes,
    '../../themes/theme-engine': engine,
    '../../themes/theme-presets': presets,
    '../../themes/theme-schedule': schedule,
    './ThemeScheduleEditor': { ThemeScheduleEditor: () => null },
    '../../i18n/useI18n': { useI18n: () => ({ t: key => key }) },
    '../../hooks/useModalEscape': { useModalEscape: (active, callback, name) => escapes.set(name, active ? callback : null) },
    '../../utils/perf-trace': { perfTraceDiagnostic: (name, data) => traces.push({ name, data }) },
    '../../utils/perf-trace-names': { PERF_TRACE_EVENT },
    './ThemeSelector.css': {}
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'queueMicrotask', compiled)(name => {
    assert(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
    return dependencies[name]
  }, module, module.exports, { electronAPI: { themes: options.themes ?? {
    import: options.import ?? (() => Promise.resolve({ canceled: true })),
    cancelImport: options.cancelImport ?? (() => Promise.resolve({ canceled: true }))
  } } }, queueMicrotask)
  const h = {
    ...module.exports, traces, previews, saves,
    get stateWrites() { return stateWrites },
    render() {
      assert(mounted)
      cursor = 0
      tree = module.exports.ThemeSelector()
      for (const effect of effects.splice(0)) effect.cleanup = effect.create()
      return tree
    },
    find(predicate, root = tree) {
      const node = nodes(root).find(predicate)
      assert(node, 'Expected a matching element in the actual selector JSX')
      return node
    },
    byId(id) { return this.find(node => node.props?.['data-testid'] === id) },
    color(token) { return this.find(node => node.type === module.exports.ColorField && node.props.token === token) },
    escape(name) { assert(escapes.get(name)); escapes.get(name)() },
    event(name, reason) { return traces.filter(event => event.name === name && event.data.reason === reason) },
    unmount() {
      if (!mounted) return
      mounted = false
      for (const hook of hooks) hook.cleanup?.()
    }
  }
  t.after(() => {
    h.unmount()
    for (const event of traces) {
      assert(Object.values(PERF_TRACE_EVENT).includes(event.name), 'Every event uses the canonical registry')
      assert(Buffer.byteLength(JSON.stringify(event.data)) <= 1024, 'Diagnostic payloads stay bounded')
      assert(!JSON.stringify(event.data).includes(secret), 'No raw field, imported name/path or exception text is logged')
    }
  })
  h.render()
  return h
}

const CUSTOMIZE = PERF_TRACE_EVENT.RENDERER_THEME_CUSTOMIZE
const IMPORT = PERF_TRACE_EVENT.RENDERER_THEME_IMPORT_UI

test('TSD-15: importing while scheduled preserves rules and shows the import-only action', async t => {
  const theme = { ...initialTheme('nord'), mode: 'schedule' }
  const h = createHarness(t, theme, { import: async () => ({ success: true, themes: [
    { id: 'import-test', name: secret, kind: 'dark', colors: { 'editor.background': '#123456' } }
  ] }) })
  h.byId('theme-import').props.onClick()
  await settled()
  h.render()
  assert.equal(h.byId('theme-import-confirm').props.children, 'settings.themes.schedule.importConfirm')
  h.byId('theme-import-confirm').props.onClick()
  await settled()
  assert.equal(h.saves.at(-1).mode, 'schedule')
  assert.deepEqual(h.saves.at(-1).schedule, theme.schedule)
  assert.equal(h.saves.at(-1).imported[0].id, 'import-test')
})

test('TSD-01: effectiveColor maps app/editor/terminal/cursor/selection and all ANSI fields without mutation', t => {
  const h = createHarness(t)
  const theme = engine.resolveTheme(initialTheme('dracula'), false)
  const before = structuredClone(theme)
  for (const [token, key] of [
    ['onward.background', '--bg-0'], ['onward.foreground', '--text-1'], ['onward.accent', '--accent'], ['panel.border', '--border']
  ]) assert.equal(h.effectiveColor(theme, token), theme.colors[key])
  for (const [token, key] of [
    ['terminal.background', 'background'], ['terminal.foreground', 'foreground'],
    ['terminalCursor.foreground', 'cursor'], ['terminalCursor.background', 'cursorAccent'],
    ['terminal.selectionBackground', 'selectionBackground'], ['terminal.selectionForeground', 'selectionForeground']
  ]) assert.equal(h.effectiveColor(theme, token), theme.terminal[key] ?? '')
  for (const token of ['editor.foreground', 'editor.background', 'editor.selectionBackground', 'editor.missing']) {
    assert.equal(h.effectiveColor(theme, token), theme.editor.colors[token] ?? '')
  }
  for (const bright of [false, true]) {
    for (const name of ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White']) {
      const token = `terminal.ansi${bright ? 'Bright' : ''}${name}`
      const key = bright ? `bright${name}` : name.toLowerCase()
      assert.equal(h.effectiveColor(theme, token), theme.terminal[key])
    }
  }
  assert.equal(h.effectiveColor(theme, 'terminal.unknown'), '')
  assert.equal(h.effectiveColor({ ...theme, terminal: { extendedAnsi: ['#123456'] } }, 'extendedAnsi'), '')
  assert.deepEqual(theme, before)
  assert.deepEqual(h.traces, [])
})

test('TSD-02: pickerColor expands shorthand, strips alpha and rejects invalid color syntax', t => {
  const h = createHarness(t)
  for (const [input, expected] of [
    ['#abc', '#aabbcc'], ['#AbC8', '#AAbbCC'], ['#123456', '#123456'], ['#12345680', '#123456'],
    ['', '#000000'], ['#12345', '#000000'], ['red', '#000000'], ['var(--accent)', '#000000'], [secret, '#000000']
  ]) assert.equal(h.pickerColor(input), expected, input)
  assert.deepEqual(h.traces, [])
})

test('TSD-03: real color-picker callbacks preserve alpha; typing/picking are silent, inheritance and blur identify only the field', t => {
  const h = createHarness(t)
  for (const [value, expected] of [['#abc8', '#12345688'], ['#abcdef7F', '#1234567F'], ['#abc', '#123456'], ['', '#123456'], [secret, '#123456']]) {
    const changed = []
    const field = h.ColorField({ token: 'terminal.background', label: secret, value, effective: '#334455', overridden: true, onChange: color => changed.push(color) })
    const picker = h.find(node => node.type === 'input' && node.props.type === 'color', field)
    const text = h.find(node => node.props?.['data-testid'] === 'theme-override-terminal.background', field)
    picker.props.onChange({ target: { value: '#123456' } })
    assert.equal(changed.at(-1), expected)
    for (let index = 0; index < 100; index++) text.props.onChange({ target: { value: `${secret}${index}` } })
    assert.deepEqual(h.traces, [])
  }
  const changed = []
  const field = h.ColorField({ token: 'editor.foreground', label: secret, value: secret, effective: '#334455', overridden: true, onChange: color => changed.push(color) })
  h.find(node => node.props?.className === 'theme-color-inherit', field).props.onClick()
  assert.deepEqual(changed, [''])
  assert.deepEqual(h.event(CUSTOMIZE, 'inherit').map(event => event.data), [{ reason: 'inherit', field: 'editor.foreground' }])
  h.find(node => node.props?.['data-testid'] === 'theme-override-editor.foreground', field).props.onBlur()
  assert.deepEqual(h.event(CUSTOMIZE, 'error').map(event => event.data), [{ reason: 'error', operation: 'validation', field: 'editor.foreground' }])
})

test('TSD-04: draft color callbacks retain the valid preview through invalid input and delete inherited overrides immutably', t => {
  const theme = initialTheme()
  theme.overrides['light-modern'] = { 'editor.foreground': '#112233', 'terminal.background': '#445566' }
  const before = structuredClone(theme)
  const h = createHarness(t, theme)
  h.byId('theme-customize').props.onClick()
  h.render()
  const traceCount = h.traces.length
  h.color('editor.foreground').props.onChange('#abcdef80')
  h.render()
  assert.equal(h.previews.at(-1).overrides['light-modern']['editor.foreground'], '#abcdef80')
  h.color('editor.foreground').props.onChange(secret)
  h.render()
  assert.equal(h.color('editor.foreground').props.value, secret)
  assert.equal(h.previews.at(-1).overrides['light-modern']['editor.foreground'], '#abcdef80')
  h.color('editor.foreground').props.onChange('')
  h.render()
  assert.equal(h.color('editor.foreground').props.overridden, false)
  assert.deepEqual(h.previews.at(-1).overrides['light-modern'], { 'terminal.background': '#445566' })
  assert.equal(h.traces.length, traceCount, 'Preview-input transforms never add per-keystroke traces')
  assert.deepEqual(theme, before)
})

test('TSD-05: Classic controls identify preset/mode actions while shorthand, invalid accent and inheritance keep their existing semantics', async t => {
  const h = createHarness(t, initialTheme('onward-classic'))
  h.byId('classic-preset').props.onChange({ target: { value: 'starlight' } })
  await settled()
  assert.equal(h.saves[0].classic.presetId, 'starlight')
  h.render()
  h.byId('theme-customize').props.onClick()
  h.render()
  const toggle = () => h.find(node => node.type === 'input' && node.props.type === 'checkbox')
  toggle().props.onChange({ target: { checked: true } })
  h.render()
  assert.equal(h.previews.at(-1).classic.mode, 'custom')
  const count = h.traces.length
  h.color('classic-accent').props.onChange('#AbC')
  h.render()
  assert.equal(h.previews.at(-1).classic.custom.accent, '#AAbbCC')
  for (const invalid of [secret, '#abcd', '#11223344']) {
    h.color('classic-accent').props.onChange(invalid)
    h.render()
    assert.equal(h.color('classic-accent').props.value, invalid)
    assert.equal(h.previews.at(-1).classic.custom.accent, '#AAbbCC')
  }
  assert.equal(h.traces.length, count)
  const field = h.ColorField(h.color('classic-accent').props)
  h.find(node => node.props?.className === 'theme-color-inherit', field).props.onClick()
  h.render()
  assert.equal(h.previews.at(-1).classic.custom.accent, '#3b82f6')
  assert.equal(h.event(CUSTOMIZE, 'inherit').at(-1).data.field, 'classic-accent')
  toggle().props.onChange({ target: { checked: false } })
  h.render()
  h.byId('classic-preset').props.onChange({ target: { value: 'starlight' } })
  h.render()
  assert.equal(h.previews.at(-1).classic.mode, 'preset')
  assert.deepEqual(h.event(CUSTOMIZE, 'classic-mode').map(event => event.data.mode), ['custom', 'preset'])
  assert.deepEqual(h.event(CUSTOMIZE, 'classic-preset').map(event => event.data.source), ['selection', 'draft'])
})

test('TSD-06: busy persistence is skipped, unexpected catches are diagnosed and selection identity contains no imported text', async t => {
  const save = deferred()
  const h = createHarness(t, initialTheme(), { save: () => save.promise })
  const select = h.byId('theme-more').props.onChange
  select({ target: { value: secret } })
  select({ target: { value: 'nord' } })
  assert.equal(h.saves.length, 1)
  assert.deepEqual(h.event(CUSTOMIZE, 'skip').map(event => event.data), [{ reason: 'skip', operation: 'persist', cause: 'busy' }])
  save.reject(new Error(secret))
  await settled()
  h.render()
  assert.equal(h.event(CUSTOMIZE, 'select').length, 2)
  assert.deepEqual(h.event(CUSTOMIZE, 'error').at(-1).data, { reason: 'error', operation: 'persist', code: 'unexpected', mounted: true })
  assert.equal(h.find(node => node.props?.role === 'alert').props.children, 'settings.themes.saveError')
})

test('TSD-07: persistence rejected after unmount emits an error without writing React state', async t => {
  const save = deferred()
  const h = createHarness(t, initialTheme(), { save: () => save.promise })
  h.byId('theme-mode').props.onChange({ target: { value: 'system' } })
  h.unmount()
  const writes = h.stateWrites
  save.reject(new Error(secret))
  await settled()
  assert.equal(h.stateWrites, writes)
  assert.equal(h.event(CUSTOMIZE, 'error').at(-1).data.mounted, false)
  assert.equal(h.event(CUSTOMIZE, 'mode').at(-1).data.mode, 'system')
})

test('TSD-08: system-pair selection identifies the kind without logging its imported ID', async t => {
  const h = createHarness(t, { ...initialTheme(), mode: 'system' })
  for (const kind of ['light', 'dark']) {
    h.byId(`theme-pair-${kind}`).props.onChange({ target: { value: secret } })
    await settled()
    h.render()
  }
  assert.deepEqual(h.event(CUSTOMIZE, 'pair').map(event => event.data.kind), ['light', 'dark'])
  assert.equal(h.saves[0].lightThemeId, secret)
  assert.equal(h.saves[1].darkThemeId, secret)
})

for (const outcome of ['resolved', 'rejected']) {
  test(`TSD-09-${outcome}: pending import unmount and its late outcome both leave diagnostic evidence`, async t => {
    const pending = deferred()
    const h = createHarness(t, initialTheme(), { import: () => pending.promise })
    h.byId('theme-import').props.onClick()
    // Unmount before a re-render: diagnostic ownership must be synchronous with the import request.
    h.unmount()
    assert.deepEqual(h.event(IMPORT, 'cancel').at(-1).data, { reason: 'cancel', source: 'unmount', pending: true, candidates: false })
    const writes = h.stateWrites
    if (outcome === 'resolved') pending.resolve({ success: true, themes: [{ id: secret, name: secret }] })
    else pending.reject(new Error(secret))
    await settled()
    assert.equal(h.stateWrites, writes)
    assert.deepEqual(h.event(IMPORT, 'stale-result').at(-1).data, { reason: 'stale-result', source: 'unmount', outcome, request: 1 })
  })

  test(`TSD-10-${outcome}: a superseded import cannot reset the newer request's pending ownership or UI`, async t => {
    const first = deferred()
    const second = deferred()
    let calls = 0
    const h = createHarness(t, initialTheme(), { import: () => (++calls === 1 ? first : second).promise })
    h.byId('theme-import').props.onClick()
    h.render()
    h.escape('theme-import')
    h.render()
    h.byId('theme-import').props.onClick()
    h.render()
    if (outcome === 'resolved') first.resolve({ success: true, themes: [{ id: secret, name: secret }] })
    else first.reject(new Error(secret))
    await settled()
    h.render()
    assert.equal(h.byId('themes-root').props['aria-busy'], true)
    assert.deepEqual(h.event(IMPORT, 'stale-result').at(-1).data, { reason: 'stale-result', source: 'superseded', outcome, request: 1 })
    assert.equal(h.event(IMPORT, 'selection').length, 0)
    h.unmount()
    assert.equal(h.event(IMPORT, 'cancel').at(-1).data.pending, true)
    second.resolve({ canceled: true })
    await settled()
  })
}

test('TSD-11: current import exception is sanitized, completed chooser cancellation clears pending diagnostics', async t => {
  for (const fails of [true, false]) {
    const h = createHarness(t, initialTheme(), { import: () => fails ? Promise.reject(new Error(secret)) : Promise.resolve({ canceled: true }) })
    h.byId('theme-import').props.onClick()
    await settled()
    h.render()
    assert.equal(h.byId('themes-root').props['aria-busy'], false)
    if (fails) {
      assert.equal(h.byId('theme-import-error').props.children, 'settings.themes.importError.generic')
      assert.deepEqual(h.event(IMPORT, 'error').at(-1).data, { reason: 'error', code: 'unknown', operation: 'import', request: 1 })
    }
    h.unmount()
    assert.equal(h.event(IMPORT, 'cancel').filter(event => event.data.source === 'unmount').length, 0)
  }
})

test('TSD-12: completed candidate selection unmount is distinct from a pending import', async t => {
  const h = createHarness(t, initialTheme(), { import: () => Promise.resolve({ success: true, themes: [{ id: secret, name: secret, kind: 'light', colors: {} }] }) })
  h.byId('theme-import').props.onClick()
  await settled()
  h.render()
  assert.equal(h.event(IMPORT, 'selection').at(-1).data.count, 1)
  h.unmount()
  assert.deepEqual(h.event(IMPORT, 'cancel').at(-1).data, { reason: 'cancel', source: 'unmount', pending: false, candidates: true })
})

for (const cause of ['escape', 'unmount']) {
  test(`TSD-13-${cause}: actual selector → preload → handler aborts and joins before immediate retry, five trials`, async t => {
    const fixture = fileURLToPath(new URL('../autotest/fixtures/themes-import/standalone/entry.jsonc', import.meta.url))
    const imported = await importThemeFile(fixture)
    for (let trial = 0; trial < 5; trial++) {
      const main = await handlerHarness('1')
      const bridge = await preloadBridge(main)
      const joining = deferred()
      let h = createHarness(t, initialTheme(), { themes: bridge })
      try {
        await bridge.setImportPathForAutotest(fixture)
        const baselineListeners = main.sender.listenerCount('destroyed')
        h.byId('theme-import').props.onClick()
        h.render()
        await settled()
        assert.equal(main.workers.length, 1)
        main.workers[0].termination = () => joining.promise
        if (cause === 'escape') { h.escape('theme-import'); h.render() }
        else { h.unmount(); h = createHarness(t, initialTheme(), { themes: bridge }) }
        assert.equal(main.workers[0].terminated, 1, 'Dismissal actually terminates the owned worker')
        h.byId('theme-import').props.onClick()
        h.render()
        await settled()
        h.render()
        assert.equal(main.workers.length, 1, 'Retry cannot spawn until the prior worker joins')
        assert.equal(h.byId('themes-root').props['aria-busy'], true, 'Retry waits instead of displaying false busy')
        assert.equal(main.traces.some(event => event.data.stage === 'cancel-handler-result'), false, 'No cleanup ACK before join')
        joining.resolve(0)
        await settled()
        assert.equal(main.workers.length, 2)
        main.workers[1].emit('message', { type: 'result', result: { success: true, themes: imported } })
        await settled()
        h.render()
        assert.equal(h.byId('themes-root').props['aria-busy'], false)
        assert(h.byId('theme-import-confirm'))
        assert.equal(h.event(IMPORT, 'error').length, 0)
        assert.equal(h.saves.length, 0, 'Cancel/retry never persists candidates implicitly')
        assert.equal(main.sender.listenerCount('did-start-navigation'), 0)
        assert.equal(main.sender.listenerCount('destroyed'), baselineListeners)
        for (const worker of main.workers) { assert.equal(worker.terminated, 1); assert.equal(worker.eventNames().length, 0) }
        for (const stage of ['cancel-ipc-send', 'cancel-handler-received', 'cancel-requested', 'worker-aborted', 'worker-settled', 'cancel-handler-result', 'cancel-ipc-received', 'retry-wait']) {
          assert(main.traces.some(event => event.data.stage === stage), stage)
        }
      } finally {
        joining.resolve(0)
        h.unmount()
        await main.cleanupThemeImportHandlers()
      }
    }
  })
}
