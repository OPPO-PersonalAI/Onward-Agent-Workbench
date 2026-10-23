/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OPTIONS = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
const DEFAULTS = JSON.parse(readFileSync(resolve(ROOT, 'test/autotest/fixtures/prompt-input-settings/acceptance.json'), 'utf8')).defaults
const modules = new Map()

function loadPure(relative) {
  const filename = resolve(ROOT, relative)
  if (modules.has(filename)) return modules.get(filename)
  const exports = {}
  modules.set(filename, exports)
  const text = readFileSync(filename, 'utf8')
  new Function('exports', 'require', ts.transpileModule(text, { compilerOptions: OPTIONS }).outputText)(exports, specifier => {
    assert(specifier.startsWith('.'), `Unexpected host import: ${specifier}`)
    return loadPure(resolve(dirname(filename), specifier))
  })
  return exports
}

const core = loadPure('src/utils/prompt-input.ts')
const { PERF_TRACE_EVENT } = loadPure('src/utils/perf-trace-names.ts')
const { en, zhCN } = loadPure('src/i18n/prompt-input.ts')

/** Compile the original callback unchanged, isolating it from unrelated Electron and DOM imports. */
function sourceNode(relative, matches) {
  const filename = resolve(ROOT, relative)
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const found = []
  const walk = node => { if (matches(node)) found.push(node); ts.forEachChild(node, walk) }
  walk(source)
  assert.equal(found.length, 1, `Expected one source node in ${relative}`)
  return found[0].getText(source)
}

const actionValidator = sourceNode('src/components/Settings/PromptInputSettings.tsx', node =>
  ts.isVariableDeclaration(node) && node.name.getText() === 'validateActionKey')
const conflictRegistration = sourceNode('electron/main/ipc-handlers.ts', node =>
  ts.isCallExpression(node) && node.expression.getText() === 'ipcMain.handle'
  && node.arguments[0]?.getText() === 'IPC.SETTINGS_CHECK_SHORTCUT_CONFLICT')
const labelFunction = sourceNode('src/components/Settings/ShortcutInput.tsx', node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'getShortcutLabel')

function evaluate(text, bindings, result) {
  const javascript = ts.transpileModule(text, { compilerOptions: OPTIONS }).outputText
  return new Function(...Object.keys(bindings), `${javascript}\nreturn ${result}`)(...Object.values(bindings))
}

function ipcHarness(platform, promptInput) {
  const traces = []
  let handler
  let existing = null
  let reads = 0
  evaluate(conflictRegistration, {
    ipcMain: { handle(_name, callback) { handler = callback } },
    IPC: { SETTINGS_CHECK_SHORTCUT_CONFLICT: 'settings:check-shortcut-conflict' },
    shortcutManager: { checkConflict() { return existing } },
    settingsStorage: { get() { reads += 1; return { promptInput } } },
    process: { platform }, normalizePromptShortcut: core.normalizePromptShortcut, promptTargetSlot: core.promptTargetSlot, PERF_TRACE_EVENT,
    performanceTrace: { record(name, data) { traces.push({ name, data }) } }
  }, 'undefined')
  return { traces, check: (key, field) => handler({}, key, field), existing: value => { existing = value }, reads: () => reads }
}

for (const platform of ['darwin', 'win32', 'linux']) {
  const hostAlias = platform === 'darwin' ? 'Command+J' : 'Ctrl+J'
  test(`PIGC-01-${platform}: the real action recorder rejects canonical OS-global aliases, including hidden actions`, () => {
    for (const visible of [true, false]) {
      for (const [globalShortcut, key] of [[hostAlias, 'CommandOrControl+J'], ['CommandOrControl+J', hostAlias]]) {
        const draft = structuredClone(DEFAULTS)
        draft.leader = 'F6'
        draft.actions[1].visible = visible
        const validate = evaluate(`const ${actionValidator}`, { draft, globalShortcut, platform,
          normalizePromptShortcut: core.normalizePromptShortcut, promptTargetSlot: core.promptTargetSlot
        }, 'validateActionKey')
        assert.equal(validate('execute', key), 'promptInput.settings.globalShortcutConflict')
        assert.equal(validate('execute', 'Control+Shift+P'), null, 'A window command remains a usable continuation key')
        assert.equal(validate('execute', platform === 'darwin' ? 'Control+J' : 'Meta+J'), null)
      }
    }
  })

  test(`PIGC-02-${platform}: the real IPC conflict callback blocks only global-field edits against visible or hidden action aliases`, () => {
    for (const visible of [true, false]) {
      for (const [globalShortcut, actionShortcut] of [[hostAlias, 'CommandOrControl+J'], ['CommandOrControl+J', hostAlias]]) {
        const settings = structuredClone(DEFAULTS)
        Object.assign(settings.actions[1], { shortcut: actionShortcut, visible })
        const h = ipcHarness(platform, settings)
        assert.equal(h.check(globalShortcut, 'activateAndFocusPrompt'), 'promptInputAction')
        assert.equal(h.reads(), 1)
        assert.deepEqual(h.traces, [{ name: 'main:prompt-input.settings-changed',
          data: { reason: 'shortcut-conflict-checked', globalEdit: true, actionConflict: true, selectorConflict: false, conflict: true } }])
        assert.equal(h.check(globalShortcut, 'focusPromptEditor'), null)
        assert.equal(h.reads(), 1, 'Window shortcut editing must not inspect action bindings')
        assert.equal(h.check(null, 'activateAndFocusPrompt'), null)
        assert.equal(h.check(platform === 'darwin' ? 'Control+J' : 'Meta+J', 'activateAndFocusPrompt'), null)
        h.existing('focusPromptEditor')
        assert.equal(h.check(globalShortcut, 'activateAndFocusPrompt'), 'focusPromptEditor', 'Keep the existing conflict result precedence')
        assert.equal(h.traces.length, 5, 'Exactly one bounded diagnostic per request')
      }
    }
  })

  test(`PIGC-04-${platform}: global recorder names a held-selector collision without blocking window-local shortcuts`, () => {
    for (const targetModifier of ['Alt', 'Control', 'Shift']) {
      const h = ipcHarness(platform, { ...structuredClone(DEFAULTS), targetModifier })
      for (let digit = 1; digit <= 8; digit++) {
        assert.equal(h.check(`${targetModifier}+${digit}`, 'activateAndFocusPrompt'), 'promptInputTarget')
        assert.equal(h.traces.at(-1).data.selectorConflict, true)
        assert.equal(h.check(`${targetModifier}+${digit}`, 'focusPromptEditor'), null)
      }
      assert.equal(h.check(`${targetModifier}+9`, 'activateAndFocusPrompt'), null)
    }
    assert.equal(ipcHarness(platform, { ...structuredClone(DEFAULTS), targetModifier: null }).check('Alt+3', 'activateAndFocusPrompt'), null)
  })
}

test('PIGC-03: the action conflict label and generic conflict copy are localized in both dictionaries', () => {
  const label = evaluate(labelFunction, {}, 'getShortcutLabel')
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zhCN).sort())
  for (const dictionary of [en, zhCN]) {
    const translate = key => dictionary[key] ?? key
    assert.equal(label('promptInputAction', translate), dictionary['promptInput.settings.actionShortcutLabel'])
    assert.equal(label('promptInputTarget', translate), dictionary['promptInput.settings.selector'])
    assert(dictionary['promptInput.settings.globalShortcutConflict'])
    for (const key of Object.keys(en)) {
      assert.deepEqual(dictionary[key].match(/\{\{\w+\}\}/g) ?? [], en[key].match(/\{\{\w+\}\}/g) ?? [])
    }
  }
  assert(!en['promptInput.settings.shortcutConflict'].includes('This leader'))
})
