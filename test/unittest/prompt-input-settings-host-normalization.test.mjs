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
const LEGACY = JSON.parse(readFileSync(path.join(FIXTURES, 'legacy-settings-v9.json'), 'utf8'))
const ACCEPTANCE = JSON.parse(readFileSync(path.join(FIXTURES, 'acceptance.json'), 'utf8'))
const compiled = new Map()

/** Execute real storage and shared normalization with isolated host, filesystem and trace boundaries. */
function storageHarness(platform, initialText) {
  const directory = path.join(ROOT, 'test/autotest/results/prompt-input-settings/virtual-profile')
  const filename = path.join(directory, 'settings.json')
  let contents = initialText
  const writes = []
  const traces = []
  const boundaries = new Map([
    ['electron', { app: { getPath(key) { assert.equal(key, 'userData'); return directory } } }],
    ['path', path],
    ['fs', {
      existsSync(name) { assert([directory, filename].includes(name)); return true },
      readFileSync(name, encoding) { assert.equal(name, filename); assert.equal(encoding, 'utf-8'); return contents },
      mkdirSync(name) { assert.equal(name, directory) },
      writeFileSync(name, text, encoding) {
        assert.equal(name, filename)
        assert.equal(encoding, 'utf-8')
        writes.push(text)
        contents = text
      }
    }],
    [path.join(ROOT, 'electron/main/performance-trace.ts'), {
      performanceTrace: { record(name, data) { traces.push({ name, data }) } }
    }]
  ])
  const modules = new Map()
  const load = filename => {
    if (boundaries.has(filename)) return boundaries.get(filename)
    if (modules.has(filename)) return modules.get(filename).exports
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename
    }).outputText)
    const module = { exports: {} }
    modules.set(filename, module)
    const require = specifier => {
      if (boundaries.has(specifier)) return boundaries.get(specifier)
      assert(specifier.startsWith('.'), `Unexpected dependency: ${specifier}`)
      const dependency = path.resolve(path.dirname(filename), specifier)
      return load(existsSync(dependency) ? dependency : `${dependency}.ts`)
    }
    new Function('require', 'module', 'exports', 'process', compiled.get(filename))(
      require, module, module.exports, { platform }
    )
    return module.exports
  }
  return {
    storage: load(path.join(ROOT, 'electron/main/settings-storage.ts')).getSettingsStorage(),
    writes, traces, text: () => contents
  }
}

const scenarios = [
  {
    id: 'PIHN-01', name: 'portable first binding wins only against aliases on the current host', leader: null,
    shortcuts: ['CommandOrControl+J', 'Control+J', 'Meta+J', null],
    mac: ['CommandOrControl+J', 'Control+J', null, null],
    other: ['CommandOrControl+J', null, 'Meta+J', null], changedMac: 1, changedOther: 1
  },
  {
    id: 'PIHN-02', name: 'earlier explicit bindings win against a later portable binding', leader: null,
    shortcuts: ['Control+J', 'Meta+J', 'CommandOrControl+J'],
    mac: ['Control+J', 'Meta+J', null], other: ['Control+J', 'Meta+J', null], changedMac: 1, changedOther: 1
  },
  {
    id: 'PIHN-03', name: 'portable leader clears only its current-host action collision', leader: 'CommandOrControl+J',
    shortcuts: ['Control+J', 'Meta+J'],
    mac: ['Control+J', null], other: [null, 'Meta+J'], changedMac: 1, changedOther: 1
  },
  {
    id: 'PIHN-04', name: 'Control leader preserves a distinct portable action on macOS', leader: 'Control+J',
    shortcuts: ['CommandOrControl+J'],
    mac: ['CommandOrControl+J'], other: [null], changedMac: 0, changedOther: 1
  },
  {
    id: 'PIHN-05', name: 'Meta leader preserves a distinct portable action on Windows and Linux', leader: 'Meta+J',
    shortcuts: ['CommandOrControl+J'],
    mac: [null], other: ['CommandOrControl+J'], changedMac: 1, changedOther: 0
  },
  {
    id: 'PIHN-06', name: 'compound portable modifiers retain their saved spelling', leader: null,
    shortcuts: ['Control+CommandOrControl+J', 'Control+Meta+J', 'Control+J'],
    mac: ['Control+CommandOrControl+J', null, 'Control+J'],
    other: ['Control+CommandOrControl+J', 'Control+Meta+J', null], changedMac: 1, changedOther: 1
  },
  {
    id: 'PIHN-07', name: 'many host collisions produce one aggregate diagnostic event', leader: null,
    shortcuts: Array.from({ length: 26 }, (_, index) => {
      const key = String.fromCharCode(65 + index)
      return [`CommandOrControl+${key}`, `Control+${key}`, `Meta+${key}`]
    }).flat(),
    mac: Array.from({ length: 26 }, (_, index) => {
      const key = String.fromCharCode(65 + index)
      return [`CommandOrControl+${key}`, `Control+${key}`, null]
    }).flat(),
    other: Array.from({ length: 26 }, (_, index) => {
      const key = String.fromCharCode(65 + index)
      return [`CommandOrControl+${key}`, null, `Meta+${key}`]
    }).flat(), changedMac: 26, changedOther: 26
  },
  {
    id: 'PIHN-08', name: 'OS-global aliases clear colliding hidden action bindings only', leader: null,
    globalShortcut: 'CommandOrControl+J', hidden: true,
    shortcuts: ['Control+J', 'Meta+J', 'CommandOrControl+J'],
    mac: ['Control+J', null, null], other: [null, 'Meta+J', null], changedMac: 2, changedOther: 2
  },
  {
    id: 'PIHN-09', name: 'Control global shortcut preserves a distinct portable action on macOS', leader: null,
    globalShortcut: 'Control+J', hidden: true, shortcuts: ['CommandOrControl+J'],
    mac: ['CommandOrControl+J'], other: [null], changedMac: 0, changedOther: 1
  },
  {
    id: 'PIHN-10', name: 'Meta global shortcut preserves a distinct portable action on Windows and Linux', leader: null,
    globalShortcut: 'Meta+J', hidden: true, shortcuts: ['CommandOrControl+J'],
    mac: [null], other: ['CommandOrControl+J'], changedMac: 1, changedOther: 0
  }
]

function normalizationTraces(h) {
  return h.traces.filter(({ data }) => data.reason === 'host-shortcuts-normalized')
}

function withoutTimestamp(state) {
  const { updatedAt, ...rest } = state
  return rest
}

for (const platform of ['darwin', 'win32', 'linux']) {
  for (const scenario of scenarios) {
    test(`${scenario.id}-${platform}: ${scenario.name}; unrelated saves and reload succeed`, () => {
      const promptInput = {
        leader: scenario.leader, timeoutMs: ACCEPTANCE.timeoutMs,
        actions: scenario.shortcuts.map((shortcut, index) => ({
          ...ACCEPTANCE.actions[index % ACCEPTANCE.actions.length], id: `host-action-${index}`, shortcut,
          ...(scenario.hidden ? { visible: false } : {})
        }))
      }
      const expectedShortcuts = platform === 'darwin' ? scenario.mac : scenario.other
      const changedCount = platform === 'darwin' ? scenario.changedMac : scenario.changedOther
      const expected = {
        ...promptInput,
        targetModifier: null,
        actions: promptInput.actions.map((action, index) => ({ ...action, shortcut: expectedShortcuts[index] }))
      }
      const original = JSON.stringify({ ...LEGACY, version: 10, promptInput,
        shortcuts: { ...LEGACY.shortcuts, activateAndFocusPrompt: scenario.globalShortcut ?? null }
      }, null, 2).replace(/\n/g, '\r\n')
      const h = storageHarness(platform, original)
      const loaded = h.storage.get()
      assert.deepEqual(loaded.promptInput, expected, 'Keep every action field and its order, clearing only colliding bindings')
      assert.equal(h.writes.length, 0, 'Loading must not write the settings file')
      assert.equal(h.text(), original)
      assert.deepEqual(normalizationTraces(h), changedCount ? [{
        name: 'main:prompt-input.settings-changed', data: { reason: 'host-shortcuts-normalized', changedCount }
      }] : [], 'Emit at most one bounded count-only event, without names or bindings')

      const requested = { ...loaded, language: 'zh-CN', globalTerminalStyle: { ...loaded.globalTerminalStyle, fontSize: 20 } }
      const unchanged = structuredClone(requested)
      assert.equal(h.storage.save(requested), true, 'Normalized settings must not block unrelated full saves')
      assert.deepEqual(requested, unchanged, 'Saving must not mutate the caller snapshot')
      assert.equal(h.writes.length, 1)
      assert.deepEqual(withoutTimestamp(JSON.parse(h.text())), withoutTimestamp(requested))
      assert.equal(h.storage.update({ gitDiffFontSize: 24 }), true)
      const restarted = storageHarness(platform, h.text())
      assert.deepEqual(restarted.storage.get(), h.storage.get())
      assert.deepEqual(restarted.storage.get().promptInput, expected)
      assert.deepEqual(withoutTimestamp(restarted.storage.get()), withoutTimestamp({ ...requested, gitDiffFontSize: 24 }))
      assert.equal(normalizationTraces(h).length, changedCount ? 1 : 0, 'Saving normalized settings is idempotent')
      assert.deepEqual(normalizationTraces(restarted), [], 'Reloading normalized settings needs no further repair')
    })
  }
}

for (const platform of ['darwin', 'win32', 'linux']) {
  const hostAlias = platform === 'darwin' ? 'Command+J' : 'Ctrl+J'
  for (const operation of ['save', 'update']) {
    test(`PIHN-11-${platform}-${operation}: OS-global conflicts reject atomically in both configuration directions, including hidden aliases`, () => {
      for (const [globalShortcut, actionShortcut] of [[hostAlias, 'CommandOrControl+J'], ['CommandOrControl+J', hostAlias]]) {
        for (const visible of [true, false]) {
          for (const direction of ['action', 'global']) {
            const promptInput = {
              leader: 'F6', timeoutMs: ACCEPTANCE.timeoutMs,
              actions: [{ ...ACCEPTANCE.actions[2], id: 'global-conflict-action', visible,
                shortcut: direction === 'global' ? actionShortcut : null }]
            }
            const h = storageHarness(platform, JSON.stringify({ ...LEGACY, version: 10, promptInput,
              shortcuts: { ...LEGACY.shortcuts, activateAndFocusPrompt: direction === 'action' ? globalShortcut : null }
            }))
            const before = h.storage.get()
            const diskBefore = h.text()
            const patch = direction === 'action'
              ? { promptInput: { ...before.promptInput, actions: [{ ...before.promptInput.actions[0], shortcut: actionShortcut }] } }
              : { shortcuts: { ...before.shortcuts, activateAndFocusPrompt: globalShortcut } }
            const input = { ...(operation === 'save' ? before : {}), ...patch, language: 'zh-CN' }
            const unchanged = structuredClone(input)
            assert.equal(h.storage[operation](input), false)
            assert.deepEqual(input, unchanged)
            assert.deepEqual(h.storage.get(), before)
            assert.equal(h.text(), diskBefore)
            assert.equal(h.writes.length, 0)
            assert(h.traces.some(({ name, data }) => name === 'main:prompt-input.settings-changed'
              && data.reason === `${operation}-invalid` && data.error === 'shortcut-conflict'))

            const allowed = { ...before, shortcuts: { ...before.shortcuts, activateAndFocusPrompt: null, focusPromptEditor: globalShortcut },
              promptInput: { ...before.promptInput, actions: [{ ...before.promptInput.actions[0], shortcut: actionShortcut }] } }
            assert.equal(h.storage[operation](allowed), true, 'Action keys may reuse a window-level shortcut')
            assert.deepEqual(storageHarness(platform, h.text()).storage.get().promptInput, h.storage.get().promptInput)
          }
        }
      }
    })
  }
}
