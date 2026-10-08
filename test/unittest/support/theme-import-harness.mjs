/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { IPC } from '../../../electron/shared/ipc-channels.ts'
import { PERF_TRACE_EVENT } from '../../../src/utils/perf-trace-names.ts'
import { runThemeImportWorker } from '../../../electron/main/theme-import-worker-client.ts'
import * as themeImportTypes from '../../../electron/main/theme-import-types.ts'
import * as themeImportTrace from '../../../electron/main/theme-import-trace.ts'

export class FakeWorker extends EventEmitter {
  terminated = 0
  termination = null
  async terminate() { this.terminated++; return this.termination ? this.termination() : 0 }
}

// Electron is replaced at the transport boundary; the handler, preload and worker lifecycle are real.
export async function handlerHarness(autotest, choose) {
  const require = createRequire(import.meta.url)
  const handlers = new Map()
  const traces = []
  const workers = []
  const dialogCalls = []
  const sender = Object.assign(new EventEmitter(), { id: 17, isDestroyed: () => false })
  const source = await readFile(new URL('../../../electron/main/theme-import-handlers.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const module = { exports: {} }
  const mocks = {
    electron: {
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showOpenDialog: async (...args) => { dialogCalls.push(args); return choose ? choose() : { canceled: true, filePaths: [] } } },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: name => handlers.delete(name) }
    },
    'node:worker_threads': { Worker: class extends FakeWorker { constructor() { super(); workers.push(this) } } },
    '../shared/ipc-channels': { IPC },
    '../../src/utils/perf-trace-names': { PERF_TRACE_EVENT },
    './performance-trace': { performanceTrace: { record: (event, data) => traces.push({ event, data }) } },
    './theme-import-worker-client': { runThemeImportWorker },
    './theme-import-types': themeImportTypes,
    './theme-import-trace': themeImportTrace
  }
  runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    __dirname: dirname(fileURLToPath(import.meta.url)),
    process: { env: { ONWARD_AUTOTEST: autotest } }, console: { info() {} }, performance, AbortController
  })
  module.exports.registerThemeImportHandlers()
  const event = { sender }
  return {
    ...module.exports, handlers, traces, workers, dialogCalls, sender, event,
    import: (id = randomUUID(), source = event) => handlers.get(IPC.THEMES_IMPORT)(source, id),
    cancel: (id, cause = 'escape', source = event) => handlers.get(IPC.THEMES_CANCEL_IMPORT)(source, id, cause)
  }
}

export async function preloadBridge(h, sender = h.sender) {
  const source = await readFile(new URL('../../../electron/preload/index.ts', import.meta.url), 'utf8')
  const wrapper = source.slice(source.indexOf('async function traceIpc<'), source.indexOf('export interface TerminalOptions'))
  const block = source.slice(source.indexOf('const themesAPI: ThemesAPI ='), source.indexOf('const settingsAPI: SettingsAPI ='))
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(wrapper + block + '\nmodule.exports = themesAPI', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText, {
    module, exports: module.exports, performance, IPC, PERF_TRACE_EVENT,
    preloadPerfTraceEnabled: true, preloadAutotestEnabled: true,
    ipcRenderer: {
      send: (_channel, value) => h.traces.push(value),
      invoke: async (channel, ...args) => h.handlers.get(channel)({ sender }, ...args)
    }
  })
  return module.exports
}
