/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { IPC } from '../../electron/shared/ipc-channels.ts'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'
import { DEFAULT_THEME_SETTINGS } from '../../src/constants/themes.ts'
import { createThemeExport } from '../../src/themes/theme-export.ts'
import { isThemeImportRequestId } from '../../electron/main/theme-import-types.ts'

const filename = fileURLToPath(new URL('../../electron/main/theme-export-handlers.ts', import.meta.url))
const compiled = ts.transpileModule(await readFile(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const require = createRequire(import.meta.url)
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(accept => { resolve = accept })
  return { promise, resolve }
}

function harness(t, options = {}) {
  const handlers = new Map(), traces = [], workers = [], writes = [], snapshots = []
  const sender = Object.assign(new EventEmitter(), { id: 17, isDestroyed: () => false })
  const destination = join(dirname(filename), '../../test/autotest/results/theme-export-virtual/file.json')
  const files = new Map([[destination, 'original-export']])
  const module = { exports: {} }
  class FakeWorker extends EventEmitter {
    terminated = 0
    constructor(_path, { workerData }) {
      super()
      workers.push(this)
      snapshots.push(workerData)
      if (!options.pauseWorker) queueMicrotask(() => {
        this.emit('message', { type: 'started' })
        this.emit('message', { type: 'result', success: true, durationMs: 1, ...createThemeExport(workerData.settings, workerData.themeId) })
      })
    }
    async terminate() { this.terminated++; this.emit('exit', 0); return 0 }
  }
  const mocks = {
    electron: {
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showSaveDialog: () => options.choose ? options.choose() : Promise.resolve({ canceled: false, filePath: destination }) },
      ipcMain: { handle: (id, fn) => handlers.set(id, fn), removeHandler: id => handlers.delete(id) }
    },
    'node:fs/promises': {
      writeFile: async (...args) => {
        if (options.writeError) throw new Error('PRIVATE_PATH')
        writes.push(args)
        files.set(args[0], args[1])
        if (options.pauseWrite) await options.pauseWrite.promise
      },
      rename: async (from, to) => { assert(files.has(from)); files.set(to, files.get(from)); files.delete(from) },
      rm: async path => { files.delete(path) }
    },
    'node:worker_threads': { Worker: FakeWorker },
    '../shared/ipc-channels': { IPC },
    '../../src/utils/perf-trace-names': { PERF_TRACE_EVENT },
    './settings-storage': { getSettingsStorage: () => ({ getThemeExportSnapshot: () => DEFAULT_THEME_SETTINGS }) },
    './theme-import-types': { isThemeImportRequestId },
    './performance-trace': { performanceTrace: { record: (event, data) => traces.push({ event, data }) } }
  }
  new Function('require', 'module', 'exports', '__dirname', 'process', compiled)(
    name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), module, module.exports, dirname(filename),
    { env: { ONWARD_AUTOTEST: options.production ? '0' : '1' } }
  )
  module.exports.registerThemeExportHandlers()
  t.after(async () => {
    await module.exports.cleanupThemeExportHandlers()
    assert(workers.every(worker => worker.terminated === 1), 'Every worker is joined exactly once')
    assert.equal(sender.listenerCount('destroyed'), 0)
    assert.equal(sender.listenerCount('did-start-navigation'), 0)
    assert(traces.every(trace => JSON.stringify(trace.data).length < 1024))
    assert(!JSON.stringify(traces).includes('PRIVATE_PATH'))
    assert(!JSON.stringify(traces).includes(destination))
    assert.deepEqual([...files.keys()], [destination], 'No sibling scratch file leaks')
  })
  let requestId
  return { workers, writes, traces, snapshots, sender, destination, handlers, files, ...module.exports,
    export: id => { requestId = randomUUID(); return handlers.get(IPC.THEMES_EXPORT)({ sender }, requestId, id ?? 'dracula') },
    cancel: (id = requestId, source = sender) => handlers.get(IPC.THEMES_CANCEL_EXPORT)({ sender: source }, id),
    select: path => handlers.get(IPC.THEMES_AUTOTEST_EXPORT_FILE)({ sender }, path) }
}

test('TEL-01: production snapshot crosses Worker, chooser and write boundaries with all diagnostics', async t => {
  const h = harness(t)
  assert.deepEqual(await h.export(), { success: true })
  assert.equal(h.writes.length, 1)
  assert.notEqual(h.writes[0][0], h.destination, 'An existing destination is never opened for truncation')
  assert.equal(h.files.get(h.destination), h.writes[0][1])
  assert.equal(JSON.parse(h.writes[0][1]).name, 'Dracula')
  assert.equal(h.snapshots[0].themeId, 'dracula')
  for (const stage of ['received', 'worker-dispatch', 'entered', 'serialized', 'worker-cleanup', 'chooser-open', 'chooser-closed', 'write-start', 'write-complete', 'complete']) {
    assert(h.traces.some(trace => trace.data.stage === stage), stage)
  }
})

test('TEL-02: cancel, invalid request, busy request and retry have no stale writes', async t => {
  const chooser = deferred()
  const h = harness(t, { choose: () => chooser.promise })
  assert.equal((await h.export(42)).success, false)
  const pending = h.export()
  assert.equal((await h.export()).success, false)
  await turn()
  chooser.resolve({ canceled: true })
  assert.deepEqual(await pending, { success: false, canceled: true })
  assert.equal(h.writes.length, 0)
  h.select(h.destination)
  assert.equal((await h.export()).success, true)
  assert.equal(h.writes.length, 1)
})

test('TEL-03: five sender-disposal cycles terminate Workers before returning and leave no listeners', async t => {
  const h = harness(t, { pauseWorker: true })
  for (let trial = 0; trial < 5; trial++) {
    const pending = h.export()
    await turn()
    h.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    assert.deepEqual(await pending, { success: false, canceled: true })
    assert.equal(h.sender.listenerCount('did-start-navigation'), 0)
    assert.equal(h.sender.listenerCount('destroyed'), 0)
  }
  assert.equal(h.workers.length, 5)
  assert.equal(h.writes.length, 0)
})

test('TEL-04: shutdown cancels a pending native chooser and ignores its late save result', async t => {
  const chooser = deferred()
  const h = harness(t, { choose: () => chooser.promise })
  const pending = h.export()
  await turn()
  await h.cleanupThemeExportHandlers()
  assert.deepEqual(await pending, { success: false, canceled: true })
  chooser.resolve({ canceled: false, filePath: h.destination })
  await turn()
  assert.equal(h.writes.length, 0)
})

test('TEL-05: worker and filesystem failures return localized UI-safe outcomes', async t => {
  const worker = harness(t, { pauseWorker: true })
  const pending = worker.export()
  await turn()
  worker.workers[0].emit('error', new Error('PRIVATE_PATH'))
  assert.deepEqual(await pending, { success: false })
  const file = harness(t, { writeError: true })
  assert.deepEqual(await file.export(), { success: false })
  assert(file.traces.some(trace => trace.data.stage === 'failed'))
})

test('TEL-06: native-dialog injection is disabled in production', t => {
  const h = harness(t, { production: true })
  assert.throws(() => h.select(null), /autotest-disabled/)
})

test('TEL-07: cancellation during a partial write preserves the destination and removes the temporary file', async t => {
  const gate = deferred()
  const h = harness(t, { pauseWrite: gate })
  const pending = h.export()
  await turn()
  assert.equal(h.writes.length, 1)
  assert.equal(h.files.get(h.destination), 'original-export')
  const cancellation = h.cancel()
  gate.resolve()
  assert.deepEqual(await pending, { success: false, canceled: true })
  assert.deepEqual(await cancellation, { canceled: true })
  assert.equal(h.files.get(h.destination), 'original-export')
  assert.deepEqual([...h.files.keys()], [h.destination])
})

test('TEL-08: stale/wrong-sender cancellation cannot abort another request', async t => {
  const h = harness(t, { pauseWorker: true })
  const pending = h.export()
  await turn()
  assert.deepEqual(await h.cancel(randomUUID()), { canceled: false })
  assert.deepEqual(await h.cancel(undefined, { id: 99 }), { canceled: false })
  assert.equal(h.workers[0].terminated, 0)
  assert.deepEqual(await h.cancel(), { canceled: true })
  assert.equal((await pending).canceled, true)
})
