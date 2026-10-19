/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createDefaultPromptInputSettings } from '../../src/utils/prompt-input.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const compiledModules = new Map()
const initialTheme = () => ({
  version: 3, mode: 'manual', themeId: 'dracula', lightThemeId: 'light-modern', darkThemeId: 'dark-modern',
  classic: { mode: 'preset', presetId: 'graphite', custom: null }, overrides: {}, imported: []
})
const equalDependencies = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]))

/** Run the real provider and pure theme modules; only React, browser, IPC and timers are replaced. */
function createHarness(t, theme = initialTheme()) {
  const hooks = []
  const timers = new Map()
  const listeners = new Set()
  const layoutEffects = []
  const passiveEffects = []
  const saves = []
  const traces = []
  let cursor = 0
  let dirty = true
  let context
  let timerId = 0
  let mounted = true
  const media = {
    matches: true,
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener)
  }

  function effect(create, dependencies, queue) {
    const index = cursor++
    const previous = hooks[index]
    if (previous && equalDependencies(previous.dependencies, dependencies)) return
    const next = { create, dependencies, cleanup: previous?.cleanup }
    hooks[index] = next
    queue.push(next)
  }
  const react = {
    createContext: () => ({ Provider: {} }),
    createElement: (_type, props) => props.value,
    useContext: () => context,
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, next => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next
        if (!Object.is(value, hooks[index].value)) {
          hooks[index].value = value
          dirty = true
        }
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo(create, dependencies) {
      const index = cursor++
      if (!hooks[index] || !equalDependencies(hooks[index].dependencies, dependencies)) {
        hooks[index] = { value: create(), dependencies }
      }
      return hooks[index].value
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) },
    useEffect: (create, dependencies) => effect(create, dependencies, passiveEffects),
    useLayoutEffect: (create, dependencies) => effect(create, dependencies, layoutEffects)
  }
  const window = {
    onwardThemeBootstrap: { settings: {
      version: 9, theme: structuredClone(theme), shortcuts: {}, terminalStyles: {},
      globalTerminalStyle: { fontFamily: null, fontSize: null, gitDiffFontSize: null }, language: 'en'
    } },
    matchMedia: () => media,
    electronAPI: {
      debug: { autotest: false },
      settings: {
        onShortcutTriggered: () => () => {},
        save(snapshot) {
          let resolveReply
          let rejectReply
          const pending = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject })
          saves.push({
            snapshot: structuredClone(snapshot), settled: false,
            reply(ok) { this.settled = true; resolveReply(ok) },
            fail() { this.settled = true; rejectReply(new Error('Injected settings write failure')) }
          })
          return pending
        }
      }
    }
  }
  const mockModules = new Map([
    ['react', react],
    [resolve(ROOT, 'src/utils/theme-applier.ts'), { applyResolvedTheme() {} }],
    [resolve(ROOT, 'src/utils/perf-trace.ts'), { perfTraceDiagnostic: (name, data) => traces.push({ name, data }) }],
    [resolve(ROOT, 'src/terminal/terminal-session-manager.ts'), {}],
    [resolve(ROOT, 'src/themes/editor-theme.ts'), {}],
    [resolve(ROOT, 'src/i18n/core.ts'), { DEFAULT_LOCALE: 'en' }],
    [resolve(ROOT, 'src/telemetry/track-feature-use.ts'), { trackFeatureUse() {} }]
  ])
  const loaded = new Map()
  function load(filename) {
    if (mockModules.has(filename)) return mockModules.get(filename)
    if (loaded.has(filename)) return loaded.get(filename).exports
    if (!compiledModules.has(filename)) {
      let source = readFileSync(filename, 'utf8')
      if (filename === resolve(ROOT, 'src/contexts/SettingsContext.tsx')) {
        // Expose the real updater only in this in-memory module. Its debounce, refs,
        // persistence and ACK ordering remain production code, with no cloned logic.
        const marker = 'const value: SettingsContextValue = useMemo(() => ({'
        assert.equal(source.split(marker).length, 2, 'Provider updater extraction must match exactly once')
        source = source.replace(marker, `${marker}\n    __updateSettingsForTest: updateSettings,`)
      }
      compiledModules.set(filename, ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.React, esModuleInterop: true
        }, fileName: filename
      }).outputText)
    }
    const module = { exports: {} }
    loaded.set(filename, module)
    const require = specifier => {
      if (mockModules.has(specifier)) return mockModules.get(specifier)
      assert.ok(specifier.startsWith('.'), `Unexpected external dependency: ${specifier}`)
      const path = resolve(dirname(filename), specifier)
      return load(existsSync(path) ? path : `${path}.ts`)
    }
    // Same realm is intentional: the real normalizer validates plain-object prototypes.
    const evaluate = new Function('require', 'module', 'exports', 'window', 'setTimeout', 'clearTimeout', 'console', compiledModules.get(filename))
    evaluate(require, module, module.exports, window,
      callback => { timers.set(++timerId, callback); return timerId },
      id => timers.delete(id), { ...console, error() {} })
    return module.exports
  }
  const { SettingsProvider } = load(resolve(ROOT, 'src/contexts/SettingsContext.tsx'))
  const harness = {
    get value() { return context }, saves, traces, media, timers, listeners,
    render() {
      cursor = 0
      dirty = false
      context = SettingsProvider({ children: null })
    },
    flush() {
      for (let turn = 0; turn < 30; turn++) {
        if (dirty) this.render()
        for (const queue of [layoutEffects, passiveEffects]) {
          for (const item of queue.splice(0)) {
            item.cleanup?.()
            item.cleanup = item.create()
          }
        }
        if (!dirty && !layoutEffects.length && !passiveEffects.length) return
      }
      assert.fail('Provider did not settle')
    },
    runDebounce() {
      assert.equal(timers.size, 1, 'Expected one coalesced settings save')
      const [id, callback] = [...timers][0]
      timers.delete(id)
      return callback()
    },
    changeAppearance(dark) {
      media.matches = dark
      for (const listener of listeners) listener()
      this.flush()
    },
    unmount() {
      if (!mounted) return
      mounted = false
      for (const hook of hooks) hook.cleanup?.()
      assert.equal(listeners.size, 0)
      assert.equal(timers.size, 0)
    }
  }
  t.after(() => {
    for (const save of saves) if (!save.settled) save.reply(false)
    harness.unmount()
  })
  return harness
}

function patchTheme(h, color) {
  h.value.__updateSettingsForTest(previous => ({
    ...previous,
    theme: {
      ...previous.theme,
      overrides: {
        ...previous.theme.overrides,
        [previous.theme.themeId]: {
          ...previous.theme.overrides[previous.theme.themeId], 'terminal.foreground': color
        }
      }
    }
  }))
  h.flush()
}
function select(h, id) {
  const pending = h.value.updateTheme({ ...h.value.settings.theme, mode: 'manual', themeId: id })
  h.flush()
  return pending
}
async function rejectSelection(h, id = 'nord') {
  const pending = select(h, id)
  h.saves.at(-1).reply(false)
  assert.equal(await pending, false)
  h.flush()
}
const themeForeground = (h, id = 'dracula') => h.value.settings.theme.overrides[id]?.['terminal.foreground']

test('TSL-01: a rejected selection retains a successfully persisted theme override in later saves', async t => {
  const h = createHarness(t)
  h.flush()
  patchTheme(h, '#abcdef')
  const saved = h.runDebounce()
  h.saves[0].reply(true)
  await saved
  await rejectSelection(h)
  assert.equal(h.value.settings.theme.themeId, 'dracula')
  assert.equal(themeForeground(h), '#abcdef')
  h.value.updateLanguage('zh-CN')
  h.flush()
  const later = h.runDebounce()
  assert.equal(h.saves[2].snapshot.theme.overrides.dracula['terminal.foreground'], '#abcdef')
  h.saves[2].reply(true)
  await later
})

test('TSL-02: rejection waits for an earlier persisted theme override save whose ACK is delayed', async t => {
  const h = createHarness(t)
  h.flush()
  patchTheme(h, '#123456')
  const saved = h.runDebounce()
  const selection = select(h, 'nord')
  let settled = false
  void selection.then(() => { settled = true })
  h.saves[1].reply(false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'Rollback must wait for the actual persisted predecessor')
  h.saves[0].reply(true)
  await saved
  assert.equal(await selection, false)
  h.flush()
  assert.equal(themeForeground(h), '#123456')
  assert.equal(h.value.settings.theme.themeId, 'dracula')
})

test('TSL-03: an ACK remembers the sent snapshot, not unsaved edits made while it was pending', async t => {
  const h = createHarness(t)
  h.flush()
  patchTheme(h, '#112233')
  const saved = h.runDebounce()
  patchTheme(h, '#445566')
  h.saves[0].reply(true)
  await saved
  await rejectSelection(h)
  assert.equal(themeForeground(h), '#112233')
  assert.equal(h.saves.length, 2, 'The unsent second debounce was canceled by selection')
})

test('TSL-04: an old debounce ACK cannot replace a newer successful selection snapshot', async t => {
  const h = createHarness(t)
  h.flush()
  patchTheme(h, '#123456')
  const oldSave = h.runDebounce()
  const newerSelection = select(h, 'nord')
  h.saves[1].reply(true)
  assert.equal(await newerSelection, true)
  h.saves[0].reply(true)
  await oldSave
  await rejectSelection(h, 'light-modern')
  assert.equal(h.value.settings.theme.themeId, 'nord')
  assert.equal(themeForeground(h), '#123456')
})

test('TSL-05: an old selection ACK cannot replace a newer successful debounced theme snapshot', async t => {
  const h = createHarness(t)
  h.flush()
  const oldSelection = select(h, 'nord')
  patchTheme(h, '#654321')
  const newSave = h.runDebounce()
  h.saves[1].reply(true)
  await newSave
  h.saves[0].reply(true)
  assert.equal(await oldSelection, true)
  await rejectSelection(h, 'light-modern')
  assert.equal(h.value.settings.theme.themeId, 'nord')
  assert.equal(themeForeground(h, 'nord'), '#654321')
})

for (const failure of ['nack', 'exception']) {
  test(`TSL-06-${failure}: failed debounced writes never advance the rollback snapshot`, async t => {
    const h = createHarness(t)
    h.flush()
    patchTheme(h, '#123456')
    const saved = h.runDebounce()
    h.saves[0].reply(true)
    await saved
    patchTheme(h, '#654321')
    const failed = h.runDebounce()
    if (failure === 'nack') h.saves[1].reply(false)
    else h.saves[1].fail()
    await failed
    await rejectSelection(h)
    assert.equal(themeForeground(h), '#123456')
    assert.ok(h.traces.some(({ data }) => data.reason === (failure === 'nack' ? 'settings-save' : 'settings-save-error')))
  })
}

test('TSL-07: an older rejected selection cannot roll back a newer successful selection', async t => {
  const h = createHarness(t)
  h.flush()
  const older = select(h, 'nord')
  const newer = select(h, 'light-modern')
  h.saves[1].reply(true)
  assert.equal(await newer, true)
  h.saves[0].reply(false)
  assert.equal(await older, false)
  h.flush()
  assert.equal(h.value.settings.theme.themeId, 'light-modern')
})

test('TSL-08: subscribe-time resampling closes the initial OS snapshot gap', t => {
  const h = createHarness(t, { ...initialTheme(), mode: 'system' })
  h.render()
  assert.equal(h.value.systemDark, true)
  assert.equal(h.listeners.size, 0)
  h.media.matches = false
  h.flush()
  assert.equal(h.value.systemDark, false)
  assert.equal(h.value.resolvedTheme.id, 'light-modern')
  assert.equal(h.listeners.size, 1)
  assert.ok(h.traces.some(({ data }) => data.dark === false && data.mode === 'system'))
  for (let trial = 0; trial < 5; trial++) {
    h.changeAppearance(true)
    assert.equal(h.value.resolvedTheme.id, 'dark-modern')
    h.changeAppearance(false)
    assert.equal(h.value.resolvedTheme.id, 'light-modern')
  }
  assert.equal(h.listeners.size, 1, 'Rerenders must not accumulate media listeners')
  h.unmount()
})

test('TSL-09: same-ID previews and Cancel remain separate from persisted provider state', async t => {
  const h = createHarness(t)
  h.flush()
  const committed = structuredClone(h.value.settings.theme)
  h.value.previewTheme({ ...committed, overrides: { dracula: { 'terminal.background': '#112233' } } })
  h.flush()
  assert.equal(h.value.resolvedTheme.terminal.background, '#112233')
  assert.deepEqual(h.value.settings.theme, committed)
  h.value.updateLanguage('zh-CN')
  h.flush()
  const saved = h.runDebounce()
  assert.deepEqual(h.saves[0].snapshot.theme, committed)
  h.saves[0].reply(true)
  await saved
  h.value.previewTheme(null)
  h.flush()
  assert.equal(h.value.resolvedTheme.terminal.background, '#282a36')
  assert.equal(h.value.settings.language, 'zh-CN')
  assert.deepEqual(h.value.settings.theme, committed)
})

test('TSL-10: public Task font edits, apply-all and deletion preserve the theme and coalesce saves', async t => {
  const h = createHarness(t)
  h.flush()
  const theme = structuredClone(h.value.settings.theme)
  h.value.updateTerminalStyle('task-a', { fontFamily: 'Task Mono', fontSize: 22, gitDiffFontSize: 17 })
  h.value.updateTerminalStyle('task-b', { fontFamily: 'Other Mono', fontSize: 24 })
  h.flush()
  h.value.applyStyleGlobally('fontSize', 20)
  h.flush()
  assert.deepEqual(h.value.getTerminalStyle('task-a'), { terminalId: 'task-a', fontFamily: 'Task Mono', fontSize: 20, gitDiffFontSize: 17 })
  assert.deepEqual(h.value.getTerminalStyle('task-b'), { terminalId: 'task-b', fontFamily: 'Other Mono', fontSize: 20, gitDiffFontSize: null })
  assert.deepEqual(h.value.getTerminalStyle('new'), { terminalId: 'new', fontFamily: null, fontSize: 20, gitDiffFontSize: null })
  h.value.updateTerminalStyle('task-a', { fontSize: null, foregroundColor: '#abcdef', backgroundColor: '#123456' })
  h.flush()
  assert.deepEqual(h.value.getTerminalStyle('task-a'), { terminalId: 'task-a', fontFamily: 'Task Mono', fontSize: null, gitDiffFontSize: 17 })
  h.value.deleteTerminalStyle('task-b')
  h.flush()
  assert.equal(Object.hasOwn(h.value.settings.terminalStyles, 'task-b'), false)
  assert.deepEqual(h.value.getTerminalStyle('task-b'), { terminalId: 'task-b', fontFamily: null, fontSize: 20, gitDiffFontSize: null })
  assert.deepEqual(h.value.settings.theme, theme)
  const saved = h.runDebounce()
  assert.equal(h.saves.length, 1)
  assert.deepEqual(h.saves[0].snapshot.theme, theme)
  assert.deepEqual(h.saves[0].snapshot.terminalStyles, { 'task-a': h.value.getTerminalStyle('task-a') })
  h.saves[0].reply(true)
  await saved
})

test('PIS-L01: Prompt action save acknowledges durable success and preserves unrelated settings', async t => {
  const h = createHarness(t)
  h.flush()
  const theme = structuredClone(h.value.settings.theme)
  const configured = { ...createDefaultPromptInputSettings(), leader: 'Control+X' }
  configured.actions[4].name = 'Native queue'
  configured.actions[4].visible = false
  const pending = h.value.updatePromptInput(configured)
  h.flush()
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'The user must not see saved before the persistence ACK')
  assert.equal(h.saves.length, 1)
  assert.deepEqual(h.saves[0].snapshot.promptInput, configured)
  h.saves[0].reply(true)
  assert.equal(await pending, true)
  h.flush()
  assert.deepEqual(h.value.settings.promptInput, configured)
  assert.deepEqual(h.value.settings.theme, theme)
  configured.actions[4].name = 'Caller later edited its local draft'
  assert.equal(h.value.settings.promptInput.actions[4].name, 'Native queue', 'Persisted action configuration must not alias the caller draft')
})

for (const failure of ['nack', 'exception']) {
  test(`PIS-L02-${failure}: rejected Prompt save rolls back only its section, retaining newer language and font edits`, async t => {
    const h = createHarness(t)
    h.flush()
    const before = structuredClone(h.value.settings.promptInput)
    const next = { ...createDefaultPromptInputSettings(), leader: 'Control+X' }
    const pending = h.value.updatePromptInput(next)
    h.flush()
    h.value.updateLanguage('zh-CN')
    h.value.updateTerminalStyle('task-a', { fontSize: 23 })
    h.flush()
    if (failure === 'nack') h.saves[0].reply(false)
    else h.saves[0].fail()
    assert.equal(await pending, false)
    h.flush()
    assert.deepEqual(h.value.settings.promptInput, before)
    assert.equal(h.value.settings.language, 'zh-CN')
    assert.equal(h.value.getTerminalStyle('task-a').fontSize, 23)
    const later = h.runDebounce()
    assert.deepEqual(h.saves.at(-1).snapshot.promptInput, before, 'A later unrelated save must not resurrect the rejected actions')
    assert.equal(h.saves.at(-1).snapshot.language, 'zh-CN')
    h.saves.at(-1).reply(true)
    await later
  })
}

test('PIS-L03: an older rejected action configuration cannot revert a newer acknowledged one', async t => {
  const h = createHarness(t)
  h.flush()
  const old = { ...createDefaultPromptInputSettings(), leader: 'Control+X' }
  const newer = { ...createDefaultPromptInputSettings(), leader: 'Control+G' }
  newer.actions.reverse()
  const first = h.value.updatePromptInput(old)
  h.flush()
  const second = h.value.updatePromptInput(newer)
  h.flush()
  assert.equal(h.saves.length, 2, JSON.stringify(h.traces.filter(({ name }) => name.includes('prompt-input'))))
  h.saves[1].reply(true)
  assert.equal(await second, true)
  h.saves[0].reply(false)
  assert.equal(await first, false)
  h.flush()
  assert.deepEqual(h.value.settings.promptInput, newer)
})
