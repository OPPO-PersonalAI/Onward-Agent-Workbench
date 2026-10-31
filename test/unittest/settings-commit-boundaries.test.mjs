/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

function load(name, boundaries) {
  const source = readFileSync(new URL(`../../electron/main/${name}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  const traces = []
  new Function('require', 'exports', compiled)(specifier => {
    if (boundaries[specifier]) return boundaries[specifier]
    if (specifier === 'crypto') return { randomUUID }
    if (specifier === './performance-trace') return { performanceTrace: { record: (name, data) => traces.push({ name, data }) } }
    if (specifier.endsWith('perf-trace-names')) return { PERF_TRACE_EVENT: new Proxy({}, { get: (_, key) => key }) }
    if (specifier.endsWith('ipc-channels')) return { IPC: new Proxy({}, { get: (_, key) => key }) }
    if (specifier === './reserved-shortcuts') return { normalizeAccelerator: key => key, findReservedShortcutKey: () => null }
    throw new Error(`Unexpected dependency: ${specifier}`)
  }, exports)
  return { ...exports, traces }
}

test('SP-B01: reserve new global shortcut before releasing old; reject and rollback preserve old binding', () => {
  const bindings = new Map()
  const boundary = load('shortcut-manager', {
    electron: { app: { focus() {}, dock: { show() {} } }, globalShortcut: {
      register: (key, callback) => {
        if (bindings.has(key)) return false
        bindings.set(key, callback)
        return true
      },
      unregister: key => bindings.delete(key)
    } },
    './settings-storage': { getSettingsStorage: () => ({ get: () => ({ shortcuts: { activateAndFocusPrompt: 'Control+F10' } }) }) }
  })
  const manager = boundary.getShortcutManager()
  const actions = []
  manager.setMainWindow({ isDestroyed: () => false, isVisible: () => true, isFocused: () => false,
    isMinimized: () => false, show: () => actions.push('show'), focus() {} })
  assert.equal(manager.registerFromSettings(), true)
  const original = bindings.get('Control+F10')
  bindings.set('Control+F11', () => {})
  assert.equal(manager.reserveGlobalShortcut('Control+F11'), null)
  assert.deepEqual(manager.getRegisteredShortcuts(), ['Control+F10'])
  const pending = manager.reserveGlobalShortcut('Control+F12')
  assert(bindings.has('Control+F10') && bindings.has('Control+F12'))
  bindings.get('Control+F12')()
  assert.equal(actions.length, 0, 'An uncommitted reservation cannot dispatch')
  original()
  assert.equal(actions.length, 1, 'The saved accelerator remains active during reservation')
  pending.rollback()
  assert(!bindings.has('Control+F12') && bindings.has('Control+F10'))
  manager.reserveGlobalShortcut('Control+F12').commit()
  assert(!bindings.has('Control+F10') && bindings.has('Control+F12'))
  original()
  assert.equal(actions.length, 1, 'A late callback from a released binding cannot dispatch')
  bindings.get('Control+F12')()
  assert.equal(actions.length, 2, 'The committed accelerator dispatches')
  manager.reserveGlobalShortcut('Control+F12').commit()
  assert(bindings.has('Control+F12'), 'An unchanged accelerator is never re-registered')
  manager.reserveGlobalShortcut(null).commit()
  assert.deepEqual(manager.getRegisteredShortcuts(), [])
})

test('SP-B02: interactive exits deduplicate, verify sender and retain draft after veto', async () => {
  const ipcMain = new EventEmitter()
  const window = new EventEmitter()
  const contents = new EventEmitter()
  const requests = []
  Object.assign(contents, { isDestroyed: () => false, send: (...args) => requests.push(args) })
  Object.assign(window, { webContents: contents, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} })
  const guard = load('settings-exit-guard', { electron: { ipcMain } })
  guard.installSettingsExitGuard(window)
  assert.equal(await guard.confirmSettingsExit(), true)
  for (let trial = 0; trial < 5; trial++) {
    ipcMain.emit('SETTINGS_DRAFT_STATE', { sender: contents }, true)
    const confirmation = guard.confirmSettingsExit()
    assert.equal(guard.confirmSettingsExit(), confirmation)
    const request = requests.at(-1)[1]
    ipcMain.emit('SETTINGS_CONFIRM_EXIT_REPLY', { sender: {} }, request, true)
    assert.equal(guard.confirmSettingsExit(), confirmation, 'Wrong sender cannot settle a request')
    ipcMain.emit('SETTINGS_CONFIRM_EXIT_REPLY', { sender: contents }, request, false)
    assert.equal(await confirmation, false)
    const next = guard.confirmSettingsExit()
    ipcMain.emit('SETTINGS_CONFIRM_EXIT_REPLY', { sender: contents }, requests.at(-1)[1], true)
    assert.equal(await next, true)
  }
  const pending = guard.confirmSettingsExit()
  contents.emit('render-process-gone')
  assert.equal(await pending, false)
  window.emit('closed')
  assert.equal(ipcMain.listenerCount('SETTINGS_DRAFT_STATE'), 0)
  assert.equal(ipcMain.listenerCount('SETTINGS_CONFIRM_EXIT_REPLY'), 0)
})
