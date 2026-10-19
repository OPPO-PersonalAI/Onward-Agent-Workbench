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
const SOURCE = resolve(ROOT, 'src/contexts/AppStateContext.tsx')
const CONTENT = readFileSync(resolve(ROOT, 'test/autotest/fixtures/prompt-input-settings/workspace/sample.ts'), 'utf8')
const TRIALS = 5
const compiled = new Map()
const equalDependencies = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

/** Exercise the unmodified provider callbacks, reducer, diff and persistence paths without mounting host effects. */
function createHarness(t) {
  const hooks = []
  const timers = new Map()
  const writes = []
  const traces = []
  let cursor = 0
  let dirty = true
  let context
  let timerId = 0
  let disk
  const react = {
    createContext: () => ({ Provider: {} }),
    createElement: (_type, props) => props.value,
    useContext: () => context,
    useEffect() { cursor += 1 },
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
      if (!equalDependencies(hooks[index]?.dependencies, dependencies)) hooks[index] = { value: create(), dependencies }
      return hooks[index].value
    },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) }
  }
  const window = { electronAPI: { platform: process.platform, debug: {}, appState: {
    async save(state) { disk = structuredClone(state); writes.push({ kind: 'save', state: disk }); return true },
    async savePatch(patch) { disk = { ...disk, ...structuredClone(patch) }; writes.push({ kind: 'patch', state: disk }); return true }
  } } }
  const trace = (name, data) => traces.push({ name, data })
  const boundaries = new Map([
    ['react', react],
    [resolve(ROOT, 'src/utils/perf-trace.ts'), { perfTrace: trace, perfTraceDiagnostic: trace }],
    [resolve(ROOT, 'src/telemetry/track-feature-use.ts'), { trackFeatureUse() {} }]
  ])
  const modules = new Map()
  const load = filename => {
    if (boundaries.has(filename)) return boundaries.get(filename)
    if (modules.has(filename)) return modules.get(filename).exports
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
      fileName: filename
    }).outputText)
    const module = { exports: {} }
    modules.set(filename, module)
    const require = specifier => {
      if (boundaries.has(specifier)) return boundaries.get(specifier)
      assert(specifier.startsWith('.'), `Unexpected host import: ${specifier}`)
      const dependency = resolve(dirname(filename), specifier)
      return load(existsSync(dependency) ? dependency : `${dependency}.ts`)
    }
    new Function('require', 'module', 'exports', 'window', 'setTimeout', 'clearTimeout', compiled.get(filename))(
      require, module, module.exports, window,
      callback => { timers.set(++timerId, callback); return timerId },
      id => timers.delete(id)
    )
    return module.exports
  }
  const { AppStateProvider } = load(SOURCE)
  const h = {
    timers, writes, traces,
    get value() { return context },
    get disk() { return disk },
    render() {
      if (!dirty) return
      cursor = 0
      dirty = false
      context = AppStateProvider({ children: null })
    },
    persist() {
      assert.equal(timers.size, 1, 'State updates must retain one coalesced save')
      const [id, callback] = [...timers][0]
      timers.delete(id)
      callback()
      assert.equal(timers.size, 0)
    }
  }
  t.after(() => timers.clear())
  h.render()
  return h
}

function inputRecord() {
  return { title: 'sample.ts', content: CONTENT, color: 'green', pinned: false, sendHistory: [
    { taskId: 'task-complete', taskName: 'Delivered task', sentAt: 1000, action: 'sendAndExecute',
      inputActionId: 'sendAndExecute', inputTerminalKey: 'Enter', inputResult: { ok: true, phase: 'complete', contentDelivered: true } },
    { taskId: 'task-partial', taskName: 'Content-only task', sentAt: 1000, action: 'sendAndExecute',
      inputActionId: 'sendAndExecute', inputTerminalKey: 'Enter', inputResult: { ok: false, phase: 'key', contentDelivered: true, reason: 'write-failed' } }
  ] }
}

function deferredAppend(callback, data, targetTabId) {
  let release
  const gate = new Promise(resolveGate => { release = resolveGate })
  return { release, done: gate.then(() => callback(data, targetTabId)) }
}

function historyTrace(h) {
  const events = h.traces.filter(({ data }) => data?.phase === 'history-appended' || data?.phase === 'history-tab-unavailable')
  for (const event of events) assert.equal(event.name, 'renderer:prompt-input.settle-draft')
  return events
}

test('PIAS-01: history completed after switching to B is persisted to originating A without touching B or the payload', async t => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const h = createHarness(t)
    const tabA = h.value.state.activeTabId
    const data = inputRecord()
    const unchanged = structuredClone(data)
    const pending = deferredAppend(h.value.addPrompt, data, tabA)
    assert(h.value.createTab())
    h.render()
    const tabB = h.value.state.activeTabId
    assert.notEqual(tabA, tabB)
    h.value.updateTabById(tabB, { editorDraft: { title: 'Current draft', content: CONTENT, color: 'yellow' } })
    h.render()
    h.persist()
    const beforeB = h.value.state.tabs.find(tab => tab.id === tabB)
    const globalPrompts = h.value.state.globalPrompts
    pending.release()
    await pending.done
    h.render()
    const history = h.value.state.tabs.find(tab => tab.id === tabA).localPrompts
    assert.equal(history.length, 1)
    assert.equal(history[0].content, CONTENT)
    assert.equal(history[0].title, data.title)
    assert.deepEqual(history[0].sendHistory, data.sendHistory)
    assert.equal(history[0].pinned, false)
    assert.equal(history[0].createdAt, history[0].updatedAt)
    assert.equal(history[0].updatedAt, history[0].lastUsedAt)
    assert(history[0].id)
    assert.strictEqual(h.value.state.tabs.find(tab => tab.id === tabB), beforeB)
    assert.strictEqual(h.value.state.globalPrompts, globalPrompts)
    assert.equal(h.value.state.activeTabId, tabB)
    assert.deepEqual(data, unchanged)
    h.persist()
    assert.deepEqual(h.disk.tabs.find(tab => tab.id === tabA).localPrompts, history)
    assert.deepEqual(h.disk.tabs.find(tab => tab.id === tabB), beforeB)
    assert.equal(h.disk.activeTabId, tabB)
    assert.deepEqual(historyTrace(h).map(({ data }) => data), [
      { phase: 'history-appended', tabId: tabA, explicitTab: true, records: 2 }
    ])
    assert(!JSON.stringify(h.traces).includes(JSON.stringify(CONTENT).slice(1, -1)), 'Diagnostic traces cannot carry Prompt content')
  }
})

test('PIAS-02: closing A before delivery drops its history, emits a rejection and never falls back to B', async t => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const h = createHarness(t)
    const tabA = h.value.state.activeTabId
    const pending = deferredAppend(h.value.addPrompt, inputRecord(), tabA)
    assert(h.value.createTab())
    h.render()
    const tabB = h.value.state.activeTabId
    assert(h.value.closeTab(tabA))
    h.render()
    h.persist()
    const before = h.value.state
    const written = h.writes.length
    pending.release()
    await pending.done
    h.render()
    assert.strictEqual(h.value.state, before, 'Rejected history must preserve state identity and updatedAt')
    assert.equal(h.value.state.activeTabId, tabB)
    assert.equal(h.value.state.tabs[0].localPrompts.length, 0)
    assert.equal(h.timers.size, 0, 'Missing destinations must not schedule persistence')
    assert.equal(h.writes.length, written)
    assert.deepEqual(h.disk, before)
    assert.deepEqual(historyTrace(h).map(({ data }) => data), [
      { phase: 'history-tab-unavailable', tabId: tabA, explicitTab: true, records: 2 }
    ])
  }
})

test('PIAS-03: legacy callers omitting the target use the current active tab even with an older callback', async t => {
  for (let trial = 0; trial < TRIALS; trial++) {
    const h = createHarness(t)
    const tabA = h.value.state.activeTabId
    const pending = deferredAppend(h.value.addPrompt, inputRecord())
    assert(h.value.createTab())
    h.render()
    const tabB = h.value.state.activeTabId
    pending.release()
    await pending.done
    h.render()
    assert.equal(h.value.state.tabs.find(tab => tab.id === tabA).localPrompts.length, 0)
    assert.equal(h.value.state.tabs.find(tab => tab.id === tabB).localPrompts.length, 1)
    assert.equal(h.value.state.activeTabId, tabB)
    h.persist()
    assert.equal(h.disk.tabs.find(tab => tab.id === tabB).localPrompts.length, 1)
    assert.deepEqual(historyTrace(h).map(({ data }) => data), [
      { phase: 'history-appended', tabId: tabB, explicitTab: false, records: 2 }
    ])
  }
})

test('PIAS-04: repeated explicit appends retain all records, order and unique IDs with one coalesced save', t => {
  const h = createHarness(t)
  const tabA = h.value.state.activeTabId
  const append = h.value.addPrompt
  assert(h.value.createTab())
  h.render()
  const tabB = h.value.state.activeTabId
  h.persist()
  const written = h.writes.length
  for (let index = 0; index < 50; index++) append({ ...inputRecord(), title: `Record ${index}` }, tabA)
  h.render()
  const history = h.value.state.tabs.find(tab => tab.id === tabA).localPrompts
  assert.equal(history.length, 50)
  assert.equal(new Set(history.map(prompt => prompt.id)).size, 50)
  assert.deepEqual(history.map(prompt => prompt.title), Array.from({ length: 50 }, (_, index) => `Record ${49 - index}`))
  assert.equal(h.value.state.tabs.find(tab => tab.id === tabB).localPrompts.length, 0)
  assert.equal(h.writes.length, written)
  h.persist()
  assert.equal(h.writes.length, written + 1)
  assert.deepEqual(h.disk.tabs.find(tab => tab.id === tabA).localPrompts, history)
  assert.equal(historyTrace(h).length, 50)
})
