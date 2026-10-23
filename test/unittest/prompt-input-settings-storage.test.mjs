/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURES = path.join(ROOT, 'test/autotest/fixtures/prompt-input-settings')
const LEGACY_TEXT = readFileSync(path.join(FIXTURES, 'legacy-settings-v9.json'), 'utf8').replace(/\r?\n/g, '\r\n')
const ACCEPTANCE = JSON.parse(readFileSync(path.join(FIXTURES, 'acceptance.json'), 'utf8'))
const compiled = new Map()

/** Run the actual storage class; only its Electron, filesystem, and trace boundaries are replaced. */
function storageHarness(initialText) {
  const directory = path.join(ROOT, 'test/autotest/results/prompt-input-settings/virtual-profile')
  const filename = path.join(directory, 'settings.json')
  let contents = initialText
  let writeFailure = false
  const writes = []
  const traces = []
  const fs = {
    existsSync(name) {
      assert([directory, filename].includes(name), `Unexpected mock path: ${name}`)
      return name === directory || contents !== undefined
    },
    readFileSync(name, encoding) {
      assert.equal(name, filename)
      assert.equal(encoding, 'utf-8')
      return contents
    },
    mkdirSync(name) { assert.equal(name, directory) },
    writeFileSync(name, value, encoding) {
      assert.equal(name, filename)
      assert.equal(encoding, 'utf-8')
      writes.push(value)
      if (writeFailure) throw Object.assign(new Error('Owned settings path is a directory'), { code: 'EISDIR' })
      contents = value
    }
  }
  const boundaries = new Map([
    ['electron', { app: { getPath(key) { assert.equal(key, 'userData'); return directory } } }],
    ['fs', fs], ['path', path],
    [path.join(ROOT, 'electron/main/performance-trace.ts'), {
      performanceTrace: { record(name, data) { traces.push({ name, data }) } }
    }]
  ])
  const modules = new Map()
  const load = name => {
    if (boundaries.has(name)) return boundaries.get(name)
    if (modules.has(name)) return modules.get(name).exports
    if (!compiled.has(name)) compiled.set(name, ts.transpileModule(readFileSync(name, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: name
    }).outputText)
    const module = { exports: {} }
    modules.set(name, module)
    const require = specifier => {
      if (boundaries.has(specifier)) return boundaries.get(specifier)
      assert(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`)
      const resolved = path.resolve(path.dirname(name), specifier)
      return load(existsSync(resolved) ? resolved : `${resolved}.ts`)
    }
    new Function('require', 'module', 'exports', 'console', compiled.get(name))(
      require, module, module.exports, { ...console, error() {} }
    )
    return module.exports
  }
  return {
    storage: load(path.join(ROOT, 'electron/main/settings-storage.ts')).getSettingsStorage(),
    writes, traces, text: () => contents,
    disk: () => contents === undefined ? undefined : JSON.parse(contents),
    rejectWrites(value) { writeFailure = value }
  }
}

function configuredActions() {
  const settings = structuredClone(ACCEPTANCE.defaults)
  settings.leader = ACCEPTANCE.leader
  settings.timeoutMs = ACCEPTANCE.timeoutMs
  const execute = settings.actions.find(action => action.id === 'execute')
  Object.assign(execute, { name: ACCEPTANCE.executeName, visible: false, terminalKey: 'Tab' })
  settings.actions = [execute, ...settings.actions.filter(action => !['execute', 'send'].includes(action.id))]
  settings.actions.push(...ACCEPTANCE.actions.map((action, index) => ({
    id: `fixture-${index + 1}`, ...action, shortcut: null
  })))
  return settings
}

function unrelated(state) {
  const { promptInput, updatedAt, ...rest } = state
  return rest
}

test('PISU-01: actual v9 storage reads Unicode CRLF and migrates missing actions exactly once', () => {
  assert(LEGACY_TEXT.includes('\r\n'))
  const legacy = JSON.parse(LEGACY_TEXT)
  const h = storageHarness(LEGACY_TEXT)
  const migrated = h.storage.get()
  assert(migrated.version >= 10)
  assert.deepEqual(migrated.promptInput, ACCEPTANCE.defaults)
  for (const field of ['terminalStyles', 'globalTerminalStyle', 'gitDiffFontSize', 'settingsPanelWidth',
    'language', 'telemetryConsent', 'telemetryInstanceId', 'autoFollowGitBranchForTaskName', 'performanceDiagnosticsEnabled']) {
    assert.deepEqual(migrated[field], legacy[field], field)
  }
  assert.equal(migrated.theme.imported[0].name, legacy.theme.imported[0].name)
  assert.deepEqual(migrated.theme.overrides, legacy.theme.overrides)
  for (const [key, value] of Object.entries(legacy.shortcuts)) assert.equal(migrated.shortcuts[key], value)
  assert.equal(h.storage.save(migrated), true)
  const restarted = storageHarness(h.text())
  assert.deepEqual(restarted.storage.get(), h.storage.get())
  assert(h.traces.some(({ name, data }) => name === 'main:prompt-input.settings-changed' && data.reason === 'migrated'))
  assert(restarted.traces.some(({ name, data }) => name === 'main:prompt-input.settings-changed' && data.reason === 'loaded'))
  assert(!restarted.traces.some(({ name, data }) => name === 'main:prompt-input.settings-changed' && data.reason === 'migrated'))
})

test('PISU-02: full save and new class instance preserve every field, order, hidden action and 20+ custom actions', () => {
  const h = storageHarness(LEGACY_TEXT)
  const before = h.storage.get()
  const promptInput = configuredActions()
  const input = { ...before, promptInput }
  const untouched = structuredClone(input)
  assert.equal(h.storage.save(input), true)
  assert.deepEqual(input, untouched, 'The caller snapshot is not mutated')
  assert.deepEqual(h.disk().promptInput, promptInput)
  const reloaded = storageHarness(h.text()).storage.get()
  assert.deepEqual(reloaded.promptInput, promptInput)
  assert.deepEqual(unrelated(reloaded), unrelated(before))
  assert.equal(reloaded.promptInput.actions[0].shortcut, 'E', 'A hidden button retains its shortcut')
  assert(!reloaded.promptInput.actions.some(action => action.id === 'send'), 'A deleted preset is not recreated')
})

test('PISU-03: partial updates and older full snapshots without promptInput preserve acknowledged input settings', () => {
  const h = storageHarness(LEGACY_TEXT)
  const promptInput = configuredActions()
  assert.equal(h.storage.update({ promptInput }), true)
  const baseline = h.storage.get()
  assert.deepEqual(h.disk().promptInput, promptInput)
  assert.equal(h.storage.update({ gitDiffFontSize: 22 }), true)
  assert.deepEqual(h.storage.get().promptInput, promptInput)
  const oldSnapshot = { ...baseline, language: 'zh-CN' }
  delete oldSnapshot.promptInput
  assert.equal(h.storage.save(oldSnapshot), true)
  const reloaded = storageHarness(h.text()).storage.get()
  assert.deepEqual(reloaded.promptInput, promptInput)
  assert.equal(reloaded.language, 'zh-CN')
})

for (const operation of ['save', 'update']) {
  test(`PISU-04-${operation}: filesystem rejection restores the acknowledged state and retry persists`, () => {
    const h = storageHarness(LEGACY_TEXT)
    assert.equal(h.storage.update({ promptInput: configuredActions() }), true)
    const before = h.storage.get()
    const diskBefore = h.text()
    const promptInput = structuredClone(before.promptInput)
    promptInput.actions[0].name += ' revised'
    const patch = { promptInput, gitDiffFontSize: 25, terminalStyles: { added: { fontSize: 23 } } }
    const input = operation === 'save' ? { ...before, ...patch } : patch
    h.rejectWrites(true)
    const writesBeforeFailure = h.writes.length
    assert.equal(h.storage[operation](input), false)
    assert.equal(h.writes.length, writesBeforeFailure + 1, 'The rejected transaction reaches the actual filesystem boundary')
    assert.deepEqual(h.storage.get(), before)
    assert.equal(h.text(), diskBefore)
    assert(h.traces.some(({ name, data }) => name === 'main:prompt-input.settings-changed' && data.reason === `${operation}-rejected`))
    h.rejectWrites(false)
    assert.equal(h.storage[operation](input), true)
    assert.deepEqual(storageHarness(h.text()).storage.get().promptInput, promptInput)
  })
}

test('PISU-05: invalid bindings reject the whole requested write without changing unrelated fields', () => {
  const h = storageHarness(LEGACY_TEXT)
  assert.equal(h.storage.update({ promptInput: configuredActions() }), true)
  const before = h.storage.get()
  const diskBefore = h.text()
  const invalid = structuredClone(before.promptInput)
  invalid.actions[0].shortcut = 'Q'
  assert.equal(h.storage.update({ promptInput: invalid, gitDiffFontSize: 26 }), false)
  assert.deepEqual(h.storage.get(), before)
  assert.equal(h.text(), diskBefore)
  invalid.actions[0].shortcut = 'E'
  invalid.leader = 'Control+S'
  assert.equal(h.storage.save({ ...before, promptInput: invalid, language: 'zh-CN' }), false)
  assert.deepEqual(h.storage.get(), before)
  assert.equal(h.text(), diskBefore)
})

test('PISU-06: cleared Leader and intentional empty actions survive save/reload without default resurrection', () => {
  const h = storageHarness(LEGACY_TEXT)
  const promptInput = { leader: null, targetModifier: null, timeoutMs: 500, actions: [] }
  assert.equal(h.storage.update({ promptInput }), true)
  assert.deepEqual(storageHarness(h.text()).storage.get().promptInput, promptInput)
  const snapshot = h.storage.get()
  snapshot.promptInput.actions.push({ id: 'outside-mutation' })
  assert.deepEqual(h.storage.get().promptInput, promptInput, 'Read snapshots cannot mutate storage')
})

test('PISU-07: persisted selectors survive restart; conflicting loaded selectors preserve legacy bindings', () => {
  for (const targetModifier of [null, 'Alt', 'Control', 'Shift']) {
    const h = storageHarness(LEGACY_TEXT)
    const settings = { ...configuredActions(), targetModifier }
    assert.equal(h.storage.update({ promptInput: settings }), true)
    assert.deepEqual(storageHarness(h.text()).storage.get().promptInput, settings)
  }
  const settings = { ...configuredActions(), targetModifier: 'Alt' }
  settings.actions[0].shortcut = 'Alt+3'
  const h = storageHarness(JSON.stringify({ ...JSON.parse(LEGACY_TEXT), version: 10, promptInput: settings }))
  assert.equal(h.storage.get().promptInput.targetModifier, null)
  assert.equal(h.storage.get().promptInput.actions[0].shortcut, 'Alt+3')
  assert(h.traces.some(({ data }) => data.reason === 'selector-conflict-recovered'))
  const valid = h.storage.get()
  assert.equal(h.storage.update({ promptInput: { ...valid.promptInput, targetModifier: 'Alt' } }), false)
  assert.deepEqual(h.storage.get(), valid)
})
