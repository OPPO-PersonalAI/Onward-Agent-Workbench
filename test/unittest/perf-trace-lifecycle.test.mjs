/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)
function compile(relative) {
  return ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
}
const implementation = compile('../../electron/main/performance-trace.ts')
const modules = new Map()
function loadPure(url) {
  const key = url.href
  if (modules.has(key)) return modules.get(key)
  const exports = {}
  modules.set(key, exports)
  new Function('exports', 'require', compile(url))(exports, id => id.startsWith('.') ? loadPure(new URL(id, url)) : require(id))
  return exports
}
const names = loadPure(new URL('../../src/utils/perf-trace-names.ts', import.meta.url))

function harness() {
  const app = Object.assign(new EventEmitter(), { getVersion: () => 'test', isPackaged: true })
  const process = Object.assign(new EventEmitter(), { env: {}, pid: 1, platform: 'darwin' })
  const events = []
  const store = {
    initialize() {}, getDir: () => 'fixture-label', getRootKind: () => 'repo',
    writeEvent: event => { events.push(event); return true }
  }
  const imports = {
    electron: { app }, worker_threads: { isMainThread: true, parentPort: null },
    './trace-store': { traceStore: store, TRACE_STORE_ENABLED: true },
    './trace-clock': { wallNowUs: () => 0 },
    './perf-trace-signal-policy': { shouldReRaiseSignalAfterTraceFlush: () => false },
    './app-info': { getAppInfo: () => ({ version: 'test', buildChannel: 'dev' }) },
    '../../src/utils/perf-trace-names': names,
    crypto: require('node:crypto')
  }
  const exports = {}
  new Function('require', 'exports', 'process', 'console', implementation)(id => {
    assert.ok(id in imports, `Unexpected dependency ${id}`)
    return imports[id]
  }, exports, process, { log() {}, warn() {}, error() {} })
  return { app, process, trace: exports.performanceTrace, events }
}

test('PTL-01 deferred native quit does not accumulate app or signal listeners', () => {
  const { app, process, trace } = harness()
  app.on('before-quit', () => trace.record('main:test.quit'))
  trace.start()
  const baseline = app.listenerCount('will-quit')
  for (let i = 0; i < 100; i++) {
    app.emit('before-quit')
    trace.record('main:test.deferred')
  }
  assert.equal(app.listenerCount('will-quit'), baseline)
  assert.equal(process.listenerCount('SIGTERM'), 1)
  assert.equal(process.listenerCount('SIGINT'), 1)
  trace.stop()
})

test('PTL-02 stop/start cycles keep recording without rearming consumed lifecycle hooks', () => {
  const { app, trace, events } = harness()
  trace.start()
  app.emit('will-quit')
  for (let i = 0; i < 100; i++) {
    trace.start()
    trace.record('main:test.marker')
    trace.stop()
  }
  assert.equal(app.listenerCount('will-quit'), 0)
  assert.equal(events.filter(event => event.name === 'main:test.marker').length, 100)
})
