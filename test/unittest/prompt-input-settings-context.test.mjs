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

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const compiled = new Map()
const legacy = () => JSON.parse(readFileSync(resolve(ROOT, 'test/autotest/fixtures/prompt-input-settings/legacy-settings-v9.json'), 'utf8'))
const defaults = JSON.parse(readFileSync(resolve(ROOT, 'test/autotest/fixtures/prompt-input-settings/acceptance.json'), 'utf8')).defaults
const sameDependencies = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

/** The provider, normalizers and update functions are real; only host boundaries and React scheduling are replaced. */
function harness(t, platform = 'darwin', initialSettings = legacy()) {
  const hooks = []
  const effects = []
  const timers = new Map()
  const mediaListeners = new Set()
  const saves = []
  const traces = []
  let cursor = 0
  let dirty = true
  let context
  let timerId = 0
  let closed = false
  const react = {
    createContext: () => ({ Provider: {} }),
    createElement: (_type, props) => props.value,
    useContext: () => context,
    useState(initial) {
      const index = cursor++
      hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [hooks[index].value, next => {
        const value = typeof next === 'function' ? next(hooks[index].value) : next
        if (!Object.is(value, hooks[index].value)) { hooks[index].value = value; dirty = true }
      }]
    },
    useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial } },
    useMemo(create, dependencies) {
      const index = cursor++
      if (!sameDependencies(hooks[index]?.dependencies, dependencies)) hooks[index] = { value: create(), dependencies }
      return hooks[index].value
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) },
    useEffect(create, dependencies) {
      const index = cursor++
      const previous = hooks[index]
      if (sameDependencies(previous?.dependencies, dependencies)) return
      const next = { create, dependencies, cleanup: previous?.cleanup }
      hooks[index] = next
      effects.push(next)
    },
    useLayoutEffect(create, dependencies) { react.useEffect(create, dependencies) }
  }
  const window = {
    onwardThemeBootstrap: { settings: initialSettings },
    matchMedia: () => ({ matches: false,
      addEventListener: (_name, callback) => mediaListeners.add(callback),
      removeEventListener: (_name, callback) => mediaListeners.delete(callback) }),
    electronAPI: { platform, debug: { autotest: false }, settings: {
      onShortcutTriggered: () => () => {},
      save(snapshot) {
        return new Promise((resolveReply, rejectReply) => saves.push({ snapshot: structuredClone(snapshot), settled: false,
          reply(ok) { this.settled = true; resolveReply(ok) },
          fail() { this.settled = true; rejectReply(new Error('Rejected durable write')) }
        }))
      }
    } }
  }
  const boundaries = new Map([
    ['react', react],
    [resolve(ROOT, 'src/utils/theme-applier.ts'), { applyResolvedTheme() {} }],
    [resolve(ROOT, 'src/utils/perf-trace.ts'), { perfTraceDiagnostic: (name, data) => traces.push({ name, data }) }],
    [resolve(ROOT, 'src/terminal/terminal-session-manager.ts'), {}],
    [resolve(ROOT, 'src/themes/editor-theme.ts'), {}],
    [resolve(ROOT, 'src/i18n/core.ts'), { DEFAULT_LOCALE: 'en' }],
    [resolve(ROOT, 'src/telemetry/track-feature-use.ts'), { trackFeatureUse() {} }]
  ])
  const loaded = new Map()
  const load = filename => {
    if (boundaries.has(filename)) return boundaries.get(filename)
    if (loaded.has(filename)) return loaded.get(filename).exports
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
      fileName: filename
    }).outputText)
    const module = { exports: {} }
    loaded.set(filename, module)
    const require = specifier => {
      if (boundaries.has(specifier)) return boundaries.get(specifier)
      assert(specifier.startsWith('.'), `Unexpected host import: ${specifier}`)
      const filename = resolve(dirname(module.filename), specifier)
      return load(existsSync(filename) ? filename : `${filename}.ts`)
    }
    module.filename = filename
    new Function('require', 'module', 'exports', 'window', 'setTimeout', 'clearTimeout', 'console', compiled.get(filename))(
      require, module, module.exports, window,
      callback => { timers.set(++timerId, callback); return timerId },
      id => timers.delete(id), { ...console, error() {} }
    )
    return module.exports
  }
  const { SettingsProvider } = load(resolve(ROOT, 'src/contexts/SettingsContext.tsx'))
  const h = {
    saves, traces, timers, window,
    get value() { return context },
    flush() {
      for (let iteration = 0; iteration < 30; iteration++) {
        if (dirty) { cursor = 0; dirty = false; context = SettingsProvider({ children: null }) }
        for (const item of effects.splice(0)) { item.cleanup?.(); item.cleanup = item.create() }
        if (!dirty && !effects.length) return
      }
      assert.fail('Settings provider did not settle')
    },
    debounce() {
      assert.equal(timers.size, 1)
      const [id, callback] = [...timers][0]
      timers.delete(id)
      return callback()
    },
    close() {
      if (closed) return
      closed = true
      for (const hook of hooks) hook.cleanup?.()
      assert.equal(mediaListeners.size, 0)
      assert.equal(timers.size, 0)
    }
  }
  t.after(() => { for (const save of saves) if (!save.settled) save.reply(false); h.close() })
  h.flush()
  return h
}

const nextActions = h => ({ ...structuredClone(h.value.settings.promptInput), leader: 'Control+Alt+G', timeoutMs: 1750 })
const tick = () => new Promise(resolveTick => setImmediate(resolveTick))

test('PISC-01: an old bootstrap receives v10 defaults without changing unrelated preferences', t => {
  const h = harness(t)
  assert.equal(h.value.settings.version, 10)
  assert.equal(h.value.settings.promptInput.leader, null)
  assert.equal(h.value.settings.promptInput.timeoutMs, 1500)
  assert.equal(h.value.settings.promptInput.actions.length, 5)
  for (const key of ['theme', 'language', 'shortcuts', 'terminalStyles', 'globalTerminalStyle', 'settingsPanelWidth']) {
    assert.deepEqual(h.value.settings[key], legacy()[key], key)
  }
  assert.equal(h.saves.length, 0)
})

test('PISC-02: explicit Save immediately sends the snapshot and only reports success after the durable ACK', async t => {
  const h = harness(t)
  const candidate = nextActions(h)
  const original = structuredClone(candidate)
  const save = h.value.updatePromptInput(candidate)
  let settled = false
  void save.then(() => { settled = true })
  assert.equal(h.saves.length, 1)
  assert.equal(h.timers.size, 0)
  await tick()
  assert.equal(settled, false)
  assert.deepEqual(h.saves[0].snapshot.promptInput, candidate)
  h.saves[0].reply(true)
  assert.equal(await save, true)
  h.flush()
  assert.deepEqual(h.value.settings.promptInput, original)
  assert.deepEqual(candidate, original)
})

for (const reject of ['reply', 'throw']) {
  test(`PISC-03-${reject}: rejected Save rolls back only actions and defers unrelated snapshots until rollback`, async t => {
    const h = harness(t)
    const before = structuredClone(h.value.settings.promptInput)
    const save = h.value.updatePromptInput(nextActions(h))
    h.value.updateLanguage('en')
    h.value.updateTerminalStyle('concurrent-task', { fontSize: 23 })
    h.flush()
    const unrelated = h.debounce()
    assert.equal(h.saves.length, 1, 'A background write cannot leak unacknowledged action edits')
    if (reject === 'reply') h.saves[0].reply(false)
    else h.saves[0].fail()
    assert.equal(await save, false)
    await tick()
    h.flush()
    assert.deepEqual(h.value.settings.promptInput, before)
    assert.equal(h.value.settings.language, 'en')
    assert.equal(h.value.settings.terminalStyles['concurrent-task'].fontSize, 23)
    assert.equal(h.saves.length, 2)
    assert.deepEqual(h.saves[1].snapshot.promptInput, before)
    assert.equal(h.saves[1].snapshot.terminalStyles['concurrent-task'].fontSize, 23)
    h.saves[1].reply(true)
    await unrelated
    assert(h.traces.some(({ data }) => data.reason === 'rollback-applied'))
  })
}

test('PISC-04: a delayed rejected predecessor cannot undo the already acknowledged successor', async t => {
  const h = harness(t)
  const first = nextActions(h)
  const second = { ...nextActions(h), timeoutMs: 2250 }
  const a = h.value.updatePromptInput(first)
  const b = h.value.updatePromptInput(second)
  assert.equal(h.saves.length, 2)
  assert.equal(h.saves[1].snapshot.promptInput.timeoutMs, 2250)
  h.saves[1].reply(true)
  assert.equal(await b, true)
  h.saves[0].reply(false)
  assert.equal(await a, false)
  h.flush()
  assert.deepEqual(h.value.settings.promptInput, second)
  assert.equal(h.timers.size, 0)
})

test('PISC-05: delayed predecessor ACK is observed before selecting the rollback snapshot', async t => {
  const h = harness(t)
  const before = structuredClone(h.value.settings.promptInput)
  h.value.updateLanguage('en')
  const previous = h.debounce()
  const save = h.value.updatePromptInput(nextActions(h))
  let settled = false
  void save.then(() => { settled = true })
  h.saves[1].reply(false)
  await tick()
  assert.equal(settled, false)
  h.saves[0].reply(true)
  await previous
  assert.equal(await save, false)
  h.flush()
  assert.deepEqual(h.value.settings.promptInput, before)
  assert.equal(h.value.settings.language, 'en')
})

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`PISC-06-${platform}: reserved editing leaders and duplicate action bindings reject before any IPC`, async t => {
    const h = harness(t, platform)
    for (const leader of ['Control+S', 'Meta+S', 'CommandOrControl+Shift+S', 'Escape']) {
      assert.equal(await h.value.updatePromptInput({ ...nextActions(h), leader }), false)
    }
    const duplicate = nextActions(h)
    duplicate.actions[1].shortcut = duplicate.actions[0].shortcut
    assert.equal(await h.value.updatePromptInput(duplicate), false)
    assert.equal(h.saves.length, 0)
    assert.equal(h.value.settings.promptInput.leader, null)
  })
}

test('PISC-07: a theme save made during a rejected action commit keeps its own theme and restores only actions', async t => {
  const h = harness(t)
  const before = structuredClone(h.value.settings.promptInput)
  const input = h.value.updatePromptInput(nextActions(h))
  const theme = h.value.updateTheme({ ...h.value.settings.theme, mode: 'manual', themeId: 'nord' })
  assert.equal(h.saves.length, 1)
  h.saves[0].reply(false)
  assert.equal(await input, false)
  await tick()
  assert.equal(h.saves.length, 2)
  assert.equal(h.saves[1].snapshot.theme.themeId, 'nord')
  assert.deepEqual(h.saves[1].snapshot.promptInput, before)
  h.saves[1].reply(true)
  assert.equal(await theme, true)
  h.flush()
  assert.equal(h.value.settings.theme.themeId, 'nord')
  assert.deepEqual(h.value.settings.promptInput, before)
})

for (const platform of ['darwin', 'win32', 'linux']) {
  const hostAlias = platform === 'darwin' ? 'Command+J' : 'Ctrl+J'
  const aliases = [[hostAlias, 'CommandOrControl+J'], ['CommandOrControl+J', hostAlias]]
  test(`PISC-08-${platform}: visible and hidden action aliases cannot reuse the OS-global shortcut`, async t => {
    for (const [globalShortcut, actionShortcut] of aliases) {
      for (const visible of [true, false]) {
        const initial = legacy()
        initial.shortcuts.activateAndFocusPrompt = globalShortcut
        const h = harness(t, platform, initial)
        const before = h.value.settings
        const candidate = nextActions(h)
        Object.assign(candidate.actions[1], { shortcut: actionShortcut, visible })
        for (let trial = 0; trial < 5; trial++) assert.equal(await h.value.updatePromptInput(candidate), false)
        h.flush()
        assert.strictEqual(h.value.settings, before)
        assert.equal(h.saves.length, 0)
        assert.equal(h.timers.size, 0)
        const rejected = h.traces.filter(({ data }) => data.reason === 'commit-invalid')
        assert.equal(rejected.length, 5)
        assert(rejected.every(({ data }) => data.error === 'shortcut-conflict'))
      }
    }
  })

  test(`PISC-09-${platform}: editing the OS-global shortcut rejects existing action aliases without optimistic state or queued writes`, async t => {
    for (const [globalShortcut, actionShortcut] of aliases) {
      for (const visible of [true, false]) {
        const initial = { ...legacy(), version: 10, promptInput: structuredClone(defaults) }
        initial.shortcuts.activateAndFocusPrompt = 'Control+Alt+K'
        Object.assign(initial.promptInput.actions[1], { shortcut: actionShortcut, visible })
        const h = harness(t, platform, initial)
        const before = h.value.settings
        for (let trial = 0; trial < 5; trial++) h.value.updateShortcut('activateAndFocusPrompt', globalShortcut)
        h.flush()
        assert.strictEqual(h.value.settings, before)
        assert.equal(h.saves.length, 0)
        assert.equal(h.timers.size, 0)
        const rejected = h.traces.filter(({ data }) => data.reason === 'global-shortcut-invalid')
        assert.equal(rejected.length, 5)
        assert(rejected.every(({ data }) => data.error === 'shortcut-conflict'))
        h.value.updateShortcut('activateAndFocusPrompt', null)
        h.flush()
        const pending = h.debounce()
        assert.equal(h.saves[0].snapshot.shortcuts.activateAndFocusPrompt, null)
        assert.deepEqual(h.saves[0].snapshot.promptInput, before.promptInput)
        h.saves[0].reply(true)
        await pending
        assert(h.traces.some(({ data }) => data.reason === 'global-shortcut-edit' && !data.enabled))
      }
    }
  })

  test(`PISC-10-${platform}: actions may reuse window commands in both directions, while leaders still cannot`, async t => {
    const initial = legacy()
    initial.shortcuts.focusPromptEditor = 'CommandOrControl+J'
    const h = harness(t, platform, initial)
    const candidate = nextActions(h)
    Object.assign(candidate.actions[1], { shortcut: hostAlias, visible: false })
    const pending = h.value.updatePromptInput(candidate)
    assert.equal(h.saves.length, 1)
    h.saves[0].reply(true)
    assert.equal(await pending, true)
    h.flush()
    assert.deepEqual(h.value.settings.promptInput, { ...candidate,
      actions: candidate.actions.map(action => action.id === 'execute'
        ? { ...action, shortcut: platform === 'darwin' ? 'Meta+J' : 'Control+J' } : action)
    })
    h.value.updateShortcut('terminalGitDiff', 'CommandOrControl+J')
    h.flush()
    const windowSave = h.debounce()
    assert.equal(h.saves[1].snapshot.shortcuts.terminalGitDiff, 'CommandOrControl+J')
    h.saves[1].reply(true)
    await windowSave
    assert.equal(await h.value.updatePromptInput({ ...candidate, leader: hostAlias }), false)
    assert.equal(h.saves.length, 2)
  })
}
