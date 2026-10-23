/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import * as contract from '../../src/utils/prompt-input.ts'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names.ts'
import { IPC } from '../../electron/shared/ipc-channels.ts'
import type { PromptInputPayload, PromptInputResult } from '../../src/utils/prompt-input.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const COMPILED = new Map<string, string>()
const KEY_BYTES: Array<[string, string]> = [
  ['None', ''], ['Enter', '\r'], ['Tab', '\t'], ['Shift+Tab', '\x1b[Z'],
  ['Escape', '\x1b'], ['Backspace', '\x7f'], ['Delete', '\x1b[3~'],
  ['Up', '\x1b[A'], ['Down', '\x1b[B'], ['Left', '\x1b[D'], ['Right', '\x1b[C'],
  ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PageUp', '\x1b[5~'], ['PageDown', '\x1b[6~'],
  ...Array.from({ length: 26 }, (_, index): [string, string] =>
    [`Control+${String.fromCharCode(65 + index)}`, String.fromCharCode(index + 1)])
]

interface RecordProbe {
  pty: { write(data: string): void; kill(): void }
  writes: Buffer[]
  beforeWrite?: (data: string) => void
  shellKind: string
  integrationMode: string
  externalDisposables: Array<{ dispose(): void }>
  exitDisposable: { dispose(): void }
  exitPromise: Promise<unknown>
  exited: boolean
  disposed: boolean
  writeQueue: Promise<void>
  queuedWrites: number
  inputWaits: Set<() => void>
}

interface Manager {
  instances: Map<string, RecordProbe>
  write(id: string, data: string): boolean | Promise<boolean>
  sendInputSequence(id: string, content: string, enterDelayMs?: number): Promise<{ ok: boolean }>
  sendPromptInput(id: string, payload: PromptInputPayload, bracketed: () => boolean): Promise<PromptInputResult>
  dispose(id: string): boolean
}

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** Run the actual manager and IPC handler, replacing only native/OS boundaries.
 * Timers are deterministic and local to these modules. No global timer, native
 * PTY, Electron launch, filesystem write or real userData is involved.
 */
function harness(platform: typeof PLATFORMS[number]) {
  let clock = 0
  let nextTimer = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const handlers = new Map<string, Handler>()
  const ownedIds = new Set<string>()
  const modes = new Map<string, boolean>()
  const records: RecordProbe[] = []
  const traces: unknown[] = []
  const forbidden = () => { throw new Error('Unit test crossed an unmocked OS boundary') }
  const trace = {
    nowUs: () => clock * 1000,
    summarizeText: (_name: string, content: string) => ({ length: content.length }),
    record: (...args: unknown[]) => { traces.push(args) },
    recordComplete: (...args: unknown[]) => { traces.push(args) },
    markTaskIdle() {},
    markTaskRunning() {}
  }
  const mocks = new Map<string, unknown>([
    ['node-pty', { spawn: forbidden }],
    ['os', { platform: () => platform, homedir: forbidden, tmpdir: forbidden }],
    ['path', path],
    ['child_process', { execFileSync: forbidden }],
    ['fs', { mkdirSync: forbidden, writeFileSync: forbidden, existsSync: forbidden }],
    ['electron', { app: { getPath: forbidden }, ipcMain: {
      handle(name: string, callback: Handler) { assert(!handlers.has(name)); handlers.set(name, callback) },
      removeHandler(name: string) { handlers.delete(name) }
    } }],
    ['./api-server', { getApiPort: forbidden }],
    ['./performance-trace', { performanceTrace: trace }],
    ['./terminal-env', {}], ['./terminal-cwd-validation', {}], ['./powershell-inline-integration', {}],
    ['../../src/utils/terminal-cwd-osc', {}],
    ['../../src/utils/prompt-input', contract],
    ['../../src/utils/perf-trace-names', { PERF_TRACE_EVENT }],
    ['../shared/ipc-channels', { IPC }],
    ['./prompt-input-shortcuts', { isPromptShortcutContext: forbidden, promptInputShortcuts: {} }]
  ])

  function load(relativePath: string): Record<string, unknown> {
    const filename = path.join(ROOT, relativePath)
    if (!COMPILED.has(filename)) {
      COMPILED.set(filename, ts.transpileModule(readFileSync(filename, 'utf8'), {
        fileName: filename,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
      }).outputText)
    }
    const module = { exports: {} }
    const require = (specifier: string) => {
      assert(mocks.has(specifier), `Unexpected module dependency: ${specifier}`)
      return mocks.get(specifier)
    }
    new Function('require', 'module', 'exports', 'process', 'setTimeout', 'clearTimeout', 'console', COMPILED.get(filename)!)(
      require, module, module.exports, { platform, env: {} },
      (callback: () => void, delay: number) => {
        const id = ++nextTimer
        timers.set(id, { callback, at: clock + delay })
        return id
      },
      (id: number) => { timers.delete(id) },
      { ...console, warn() {} }
    )
    return module.exports
  }

  const managerExports = load('electron/main/pty-manager.ts')
  const manager = managerExports.ptyManager as Manager
  mocks.set('./pty-manager', managerExports)
  const handlerExports = load('electron/main/prompt-input-handlers.ts') as {
    registerPromptInputHandlers(window: unknown, owns: (id: string) => boolean, bracketed: (id: string) => boolean): void
  }
  const mainFrame = {}
  const contents = { mainFrame, isDestroyed: () => false }
  const window = { webContents: contents, isDestroyed: () => false }
  const event = { sender: contents, senderFrame: mainFrame }
  handlerExports.registerPromptInputHandlers(window, id => ownedIds.has(id), id => modes.get(id) ?? false)

  function add(id: string, bracketed = false): RecordProbe {
    const writes: Buffer[] = []
    const record: RecordProbe = {
      pty: {
        write(data) {
          record.beforeWrite?.(data)
          // Encode EACH native write independently: joining JS strings first
          // would hide a surrogate pair split between two ConPTY writes.
          writes.push(Buffer.from(data, 'utf8'))
        },
        kill() {}
      },
      writes, shellKind: platform === 'win32' ? 'powershell' : 'posix', integrationMode: 'none',
      externalDisposables: [], exitDisposable: { dispose() {} }, exitPromise: new Promise(() => {}),
      exited: false, disposed: false, writeQueue: Promise.resolve(), queuedWrites: 0, inputWaits: new Set()
    }
    records.push(record)
    manager.instances.set(id, record)
    ownedIds.add(id)
    modes.set(id, bracketed)
    return record
  }

  async function microtasks() {
    for (let index = 0; index < 16; index++) await Promise.resolve()
  }

  async function settle<T>(promise: Promise<T>): Promise<T> {
    let done = false
    let value: T | undefined
    let failure: unknown
    promise.then(result => { value = result; done = true }, error => { failure = error; done = true })
    for (let step = 0; step < 10000 && !done; step++) {
      await microtasks()
      if (done) break
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (next) {
        timers.delete(next[0])
        clock = next[1].at
        next[1].callback()
      }
    }
    assert(done, 'Production transaction failed to settle under deterministic timer advancement')
    await microtasks()
    if (failure) throw failure
    return value as T
  }

  const send = (id: string, payload: unknown, source: unknown = event) => Promise.resolve(
    handlers.get(IPC.PROMPT_INPUT_SEND)!(source, id, payload) as PromptInputResult | Promise<PromptInputResult>
  )
  function clean() {
    assert.equal(timers.size, 0, 'An input timer leaked')
    for (const record of records) {
      assert.equal(record.queuedWrites, 0, 'An input queue slot leaked')
      assert.equal(record.inputWaits.size, 0, 'An input-wait cancellation callback leaked')
    }
  }
  return { manager, add, send, settle, microtasks, clean, modes, event, traces }
}

const bytes = (record: RecordProbe) => Buffer.concat(record.writes)
const payload = (content: string, terminalKey = 'Tab', includePrompt = true): PromptInputPayload => ({ content, terminalKey, includePrompt })
const frame = (content: string) => '\x1b[200~' + content.replace(/\r\n|\n/g, '\r') + '\x1b[201~'
const complete = (contentDelivered: boolean): PromptInputResult => ({ ok: true, phase: 'complete', contentDelivered })

for (const platform of PLATFORMS) {
  test(`PIT-U01 ${platform}: every allowed suffix has exactly the specified terminal bytes`, async () => {
    const h = harness(platform)
    const receiver = h.add('task')
    let expected = ''
    for (const [terminalKey, suffix] of KEY_BYTES) {
      assert.deepEqual(await h.settle(h.send('task', payload('Q means text, not Queue', terminalKey))), complete(true))
      expected += 'Q means text, not Queue' + suffix
    }
    assert.deepEqual(bytes(receiver), Buffer.from(expected))
    h.clean()
  })

  test(`PIT-U02 ${platform}: public IPC rejects invalid content before content OR suffix`, async () => {
    const h = harness(platform)
    const receiver = h.add('task', true)
    const invalid: unknown[] = [null, [], {}, payload('valid', 'Unknown'), payload('valid', 'None', false),
      { ...payload('valid'), includePrompt: 'true' }, { ...payload('valid'), content: null }]
    const invalidTexts = ['', ' \t\r\n ', 'a\x1b[201~b\nexecute', 'a\x1b[200~b',
      ...Array.from({ length: 32 }, (_, code) => code).filter(code => ![9, 10, 13].includes(code))
        .map(code => `before${String.fromCharCode(code)}after`),
      ...Array.from({ length: 33 }, (_, index) => `before${String.fromCharCode(127 + index)}after`)]
    for (const content of invalidTexts) invalid.push(payload(content, 'Enter'))
    for (const value of invalid) {
      assert.deepEqual(await h.settle(h.send('task', value)), {
        ok: false, phase: 'content', contentDelivered: false, reason: 'invalid-input'
      })
      assert.equal(bytes(receiver).length, 0)
    }
    // Internal callers must not be able to bypass the main transport guard.
    for (const content of invalidTexts) {
      assert.deepEqual(await h.settle(h.manager.sendPromptInput('task', payload(content, 'Tab'), () => true)), {
        ok: false, phase: 'content', contentDelivered: false, reason: 'invalid-input'
      })
      assert.equal(bytes(receiver).length, 0)
    }
    h.clean()
  })

  test(`PIT-U03 ${platform}: all newline forms require paste mode and have one external suffix`, async () => {
    const h = harness(platform)
    const receiver = h.add('task')
    let expected = ''
    for (const separator of ['\n', '\r\n', '\r']) {
      const content = `first${separator}last`
      h.modes.set('task', false)
      assert.deepEqual(await h.settle(h.send('task', payload(content))), {
        ok: false, phase: 'content', contentDelivered: false, reason: 'unsafe-multiline-send'
      })
      assert.deepEqual(bytes(receiver), Buffer.from(expected))
      h.modes.set('task', true)
      assert.deepEqual(await h.settle(h.send('task', payload(content))), complete(true))
      expected += frame(content) + '\t'
      assert.deepEqual(bytes(receiver), Buffer.from(expected))
    }
    h.clean()
  })

  test(`PIT-U04 ${platform}: shared FIFO fences interactive and legacy writes; other Tasks remain independent`, async () => {
    const h = harness(platform)
    const a = h.add('a', true)
    const b = h.add('b')
    const content = 'x'.repeat(8185) + '\u{1f642}\n' + 'y'.repeat(18000)
    const first = h.send('a', payload(content))
    await h.microtasks()
    assert(a.writes.length > 0, 'The first transaction must actually have begun')
    const interactive = Promise.resolve(h.manager.write('a', 'typed'))
    const legacy = h.manager.sendInputSequence('a', 'legacy', 5)
    const last = h.send('a', payload('', 'Control+A', false))
    assert.equal(h.manager.write('b', 'independent'), true)
    assert.deepEqual(bytes(b), Buffer.from('independent'))
    assert.equal(bytes(a).includes(Buffer.from('typed')), false)
    const [firstResult, interactiveResult, legacyResult, lastResult] = await h.settle(Promise.all([first, interactive, legacy, last]))
    assert.deepEqual(firstResult, complete(true))
    assert.equal(interactiveResult, true)
    assert.equal(legacyResult.ok, true)
    assert.deepEqual(lastResult, complete(false))
    assert.deepEqual(bytes(a), Buffer.from(frame(content) + '\ttypedlegacy\r\x01'))
    h.clean()
  })

  test(`PIT-U05 ${platform}: paste capability is rechecked when its queued transaction starts`, async () => {
    const h = harness(platform)
    const receiver = h.add('task', true)
    const first = h.send('task', payload('prefix'))
    await h.microtasks()
    const later = h.send('task', payload('first\nlast', 'Enter'))
    h.modes.set('task', false)
    const [firstResult, laterResult] = await h.settle(Promise.all([first, later]))
    assert.deepEqual(firstResult, complete(true))
    assert.deepEqual(laterResult, { ok: false, phase: 'content', contentDelivered: false, reason: 'unsafe-multiline-send' })
    assert.deepEqual(bytes(receiver), Buffer.from('prefix\t'))
    h.clean()
  })

  test(`PIT-U06 ${platform}: content failure sends no suffix and cannot poison later writes`, async () => {
    const h = harness(platform)
    const receiver = h.add('task')
    receiver.beforeWrite = data => { if (data === 'fail-content') throw new Error('Injected content write failure') }
    const first = h.send('task', payload('fail-content', 'Enter'))
    const interactive = Promise.resolve(h.manager.write('task', 'next-typed'))
    const next = h.send('task', payload('next-action', 'None'))
    const [failure, typed, recovery] = await h.settle(Promise.all([first, interactive, next]))
    assert.deepEqual(failure, { ok: false, phase: 'content', contentDelivered: false, reason: 'write-failed' })
    assert.equal(typed, true)
    assert.deepEqual(recovery, complete(true))
    assert.deepEqual(bytes(receiver), Buffer.from('next-typednext-action'))
    h.clean()
  })

  test(`PIT-U07 ${platform}: suffix failure reports content-only and never replays content`, async () => {
    const h = harness(platform)
    const receiver = h.add('task', true)
    receiver.beforeWrite = data => { if (data === '\t') throw new Error('Injected suffix write failure') }
    assert.deepEqual(await h.settle(h.send('task', payload('first\nlast'))), {
      ok: false, phase: 'key', contentDelivered: true, reason: 'write-failed'
    })
    assert.deepEqual(bytes(receiver), Buffer.from(frame('first\nlast')))
    assert.deepEqual(await h.settle(h.send('task', payload('recovered', 'None'))), complete(true))
    assert.deepEqual(bytes(receiver), Buffer.from(frame('first\nlast') + 'recovered'))
    h.clean()
  })

  test(`PIT-U08 ${platform}: disposal cancels pending input and same-ID replacement receives no old transaction`, async () => {
    const h = harness(platform)
    const old = h.add('task', true)
    const content = 'x'.repeat(25000) + '\nlast'
    const first = h.send('task', payload(content, 'Enter'))
    const queued = h.send('task', payload('', 'Tab', false))
    await h.microtasks()
    assert(old.writes.length > 0)
    assert.equal(h.manager.dispose('task'), true)
    const replacement = h.add('task', true)
    const [firstResult, queuedResult] = await h.settle(Promise.all([first, queued]))
    assert.equal(firstResult.ok, false)
    assert.equal(firstResult.reason, 'unavailable')
    assert.equal(firstResult.contentDelivered, platform !== 'win32')
    assert.equal(firstResult.phase, platform === 'win32' ? 'content' : 'key')
    assert.deepEqual(queuedResult, { ok: false, phase: 'key', contentDelivered: false, reason: 'unavailable' })
    assert.equal(bytes(replacement).length, 0)
    assert.equal(bytes(old).includes(Buffer.from('\t')), false)
    assert.deepEqual(await h.settle(h.send('task', payload('new-session', 'None'))), complete(true))
    assert.deepEqual(bytes(replacement), Buffer.from('new-session'))
    h.clean()
  })

  test(`PIT-U09 ${platform}: chunk boundaries preserve Unicode and full transaction framing`, async () => {
    const h = harness(platform)
    const receiver = h.add('task', true)
    let expected = ''
    for (const length of [1023, 1024, 1025, 8185, 8191, 8192, 16377]) {
      const content = 'x'.repeat(length) + '\u{1f642}e\u0301\n\u4e2d\u6587-last'
      assert.deepEqual(await h.settle(h.send('task', payload(content))), complete(true))
      expected += frame(content) + '\t'
    }
    assert.deepEqual(bytes(receiver), Buffer.from(expected))
    h.clean()
  })

  test(`PIT-U10 ${platform}: repeated bursts preserve every transaction and drain all queue state`, async () => {
    const h = harness(platform)
    const receiver = h.add('task')
    let expected = ''
    for (let trial = 0; trial < 5; trial++) {
      const pending: Array<Promise<PromptInputResult | boolean>> = []
      for (let index = 0; index < 20; index++) {
        const content = `burst-${trial}-${index}`
        pending.push(h.send('task', payload(content, 'Tab')))
        pending.push(Promise.resolve(h.manager.write('task', '|')))
        expected += content + '\t|'
      }
      const completed = await h.settle(Promise.all(pending))
      assert(completed.every(result => result === true || typeof result === 'object' && result.ok))
      assert.deepEqual(bytes(receiver), Buffer.from(expected))
      h.clean()
    }
  })

  test(`PIT-U11 ${platform}: foreign senders, frames and unowned IDs cannot write or fall back`, async () => {
    const h = harness(platform)
    const receiver = h.add('task')
    for (const source of [{ ...h.event, sender: {} }, { ...h.event, senderFrame: {} }]) {
      assert.deepEqual(await h.settle(h.send('task', payload('blocked'), source)), {
        ok: false, phase: 'content', contentDelivered: false, reason: 'invalid-input'
      })
    }
    assert.deepEqual(await h.settle(h.send('missing', payload('blocked'))), {
      ok: false, phase: 'content', contentDelivered: false, reason: 'unavailable'
    })
    assert.equal(bytes(receiver).length, 0)
    h.clean()
  })

  test(`PIT-U12 ${platform}: key-only ignores draft text and needs no paste capability`, async () => {
    const h = harness(platform)
    const receiver = h.add('task', false)
    for (const [key] of KEY_BYTES.filter(([key]) => key !== 'None')) {
      assert.deepEqual(await h.settle(h.send('task', payload('UNSENT\nDRAFT', key, false))), complete(false))
    }
    assert.deepEqual(bytes(receiver), Buffer.from(KEY_BYTES.map(([, sequence]) => sequence).join('')))
    h.clean()
  })

  test(`PIT-U13 ${platform}: per-target failure does not block independent successful recipients`, async () => {
    const h = harness(platform)
    const safe = h.add('safe', true)
    const unsafe = h.add('unsafe', false)
    const exited = h.add('exited', true)
    exited.exited = true
    const result = await h.settle(Promise.all(['safe', 'unsafe', 'exited'].map(id => h.send(id, payload('first\nlast', 'Enter')))))
    assert.deepEqual(result, [complete(true),
      { ok: false, phase: 'content', contentDelivered: false, reason: 'unsafe-multiline-send' },
      { ok: false, phase: 'content', contentDelivered: false, reason: 'unavailable' }])
    assert.deepEqual(bytes(safe), Buffer.from(frame('first\nlast') + '\r'))
    assert.equal(bytes(unsafe).length, 0)
    assert.equal(bytes(exited).length, 0)
    h.clean()
  })
}
