/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../../src/autotest/autotest-runner.ts', import.meta.url), 'utf8')
const commandSource = readFileSync(new URL('../../src/utils/terminal-command.ts', import.meta.url), 'utf8')
const compile = text => ts.transpileModule(text, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const compiled = compile(source)
// Restore the known pre-fix entry path in memory only. Real terminal APIs are
// mocked below; the checkout and its real PTYs never receive this command.
const guard = 'if (isExternalDriverSuite(suiteFilter)) {'
assert.equal(source.split(guard).length, 2, 'The mutation must disable exactly the actual runner entry guard')
const unguarded = compile(source.replace(guard, 'if (false) {'))
const commandExports = {}
new Function('exports', compile(commandSource))(commandExports)

const MODES = ['themes-ui-external', 'prompt-input-settings-external']
// These paths are opaque command labels; no test reads or changes these paths.
const PLATFORMS = [
  { platform: 'darwin', shellKind: 'posix', cwd: '/fixture/workspace with spaces', command: "cd '/fixture/workspace with spaces'\r" },
  { platform: 'linux', shellKind: 'posix', cwd: '/fixture/workspace with spaces', command: "cd '/fixture/workspace with spaces'\r" },
  { platform: 'win32', shellKind: 'powershell', cwd: 'C:\\fixture\\workspace with spaces', command: "Set-Location -LiteralPath 'C:\\fixture\\workspace with spaces'\r" },
  { platform: 'win32', shellKind: 'cmd', cwd: 'C:\\fixture\\workspace with spaces', command: 'cd /d "C:\\fixture\\workspace with spaces"\r' }
]

function deferred() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

function loadRunner({ mode = MODES[0], target = PLATFORMS[0], strict = false, mutation = false, cancelled = false } = {}) {
  const accesses = []
  const writes = []
  const activities = []
  const calls = []
  const logs = []
  const listeners = new Map()
  let rawReady = false
  const touch = name => {
    accesses.push(name)
    if (strict) throw new Error(`External driver touched forbidden initialization: ${name}`)
  }
  const api = {
    debug: { autotestSuite: mode },
    get platform() { touch('platform'); return target.platform },
    get terminal() {
      touch('terminal-api')
      return {
        async getInputCapabilities(id) { calls.push(['capabilities', id]); return { shellKind: target.shellKind } },
        async write(id, data) { calls.push(['write', id]); writes.push({ id, data, rawReady }); return true }
      }
    },
    get git() {
      touch('git-api')
      return { async notifyTerminalActivity(id) { calls.push(['activity', id]); activities.push({ id, rawReady }) } }
    }
  }
  const window = {
    electronAPI: api,
    addEventListener(name, listener) { touch(`add:${name}`); assert(!listeners.has(name)); listeners.set(name, listener) },
    removeEventListener(name, listener) { touch(`remove:${name}`); assert.equal(listeners.get(name), listener); listeners.delete(name) }
  }
  const ctx = {
    terminalId: 'raw-child-task', rootPath: target.cwd,
    get log() { touch('context:log'); return (name, data) => logs.push({ name, data }) },
    get sleep() { touch('context:sleep'); return async ms => { calls.push(['sleep', ms]) } },
    cancelled: () => cancelled
  }
  const require = name => {
    if (name === '../utils/terminal-command') return commandExports
    assert.match(name, /^\.\/test-/, `Unexpected runner dependency: ${name}`)
    return new Proxy({}, { get: (_object, method) => async received => {
      assert.equal(method, 'testTerminalAutofollow', `Unexpected internal suite: ${String(method)}`)
      assert.equal(received, ctx, 'The selected suite receives the real runner context')
      calls.push(['suite', method])
      return [{ name: 'INTERNAL-CONTROL', ok: true }]
    } })
  }
  const exports = {}
  new Function('require', 'exports', 'window', 'performance', mutation ? unguarded : compiled)(require, exports, window, {
    now() { touch('performance'); return 1 }
  })
  return {
    run: () => exports.runAllTests(ctx), api, window, ctx, accesses, writes, activities, calls, logs, listeners,
    markRawReady: () => { rawReady = true }
  }
}

function assertNoInitialization(unit) {
  assert.deepEqual(unit.accesses, [], 'Return precedes context destructuring, runtime listeners, clocks and terminal/Git APIs')
  assert.deepEqual(unit.writes, [])
  assert.deepEqual(unit.activities, [])
  assert.deepEqual(unit.calls, [])
  assert.deepEqual(unit.logs, [])
  assert.equal(unit.listeners.size, 0)
}

function assertInitialization(unit, target, rawReady = false) {
  assert.deepEqual(unit.writes, [{ id: unit.ctx.terminalId, data: target.command, rawReady }])
  assert.deepEqual(unit.activities, [{ id: unit.ctx.terminalId, rawReady }])
  assert.deepEqual(unit.calls.slice(0, 5), [
    ['capabilities', unit.ctx.terminalId], ['write', unit.ctx.terminalId], ['sleep', 600],
    ['activity', unit.ctx.terminalId], ['sleep', 600]
  ])
  assert(!unit.logs.some(entry => entry.name === 'autotest-error'), 'The runner may not hide a mocked boundary failure')
  assert.equal(unit.listeners.size, 0, 'Internal runner removes its runtime listeners')
}

test('AED-U01 exact external modes return before throwing initialization APIs on all shell paths', async () => {
  for (const mode of MODES) for (const target of PLATFORMS) {
    const unit = loadRunner({ mode, target, strict: true })
    await unit.run()
    assertNoInitialization(unit)
  }
})

test('AED-U02 positive internal suite preserves initialization and execution on POSIX, PowerShell and CMD', async () => {
  for (const target of PLATFORMS) {
    const unit = loadRunner({ mode: 'terminal-autofollow', target })
    await unit.run()
    assertInitialization(unit, target)
    assert.deepEqual(unit.calls.filter(call => call[0] === 'suite'), [['suite', 'testTerminalAutofollow']])
    const summary = unit.logs.find(entry => entry.name === '=== Test Summary ===')
    assert.equal(summary.data.totalTests, 1)
    assert.equal(summary.data.totalPassed, 1)
    assert.equal(summary.data.totalFailed, 0)
  }
})

test('AED-U03 only exact modes bypass initialization; existing trim/case and suite-list semantics remain', async () => {
  for (const mode of [' THEMES-UI-EXTERNAL ', ' PROMPT-INPUT-SETTINGS-EXTERNAL ']) {
    const unit = loadRunner({ mode, strict: true })
    await unit.run()
    assertNoInitialization(unit)
  }
  for (const mode of ['subpage-cdp-clicks-external', ' SUBPAGE-CDP-CLICKS-EXTERNAL ',
    'other-external', 'themes-ui-external-extra', 'prefix-themes-ui-external',
    'themes-ui-external;option', 'themes-ui-external,terminal-autofollow', 'all', '']) for (const target of PLATFORMS) {
    const unit = loadRunner({ mode, target, cancelled: true })
    await unit.run()
    assertInitialization(unit, target)
  }
})

test('AED-U04 deferred real runner entry after raw-child readiness stays silent in five trials per mode/shell', async () => {
  for (const mode of MODES) for (const target of PLATFORMS) for (let trial = 0; trial < 5; trial++) {
    const unit = loadRunner({ mode, target, strict: true })
    const barrier = deferred()
    const running = barrier.promise.then(() => unit.run())
    try {
      assertNoInitialization(unit)
      unit.markRawReady()
      barrier.release()
      await running
      assertNoInitialization(unit)
    } finally {
      barrier.release()
      await running
    }
  }
})

test('AED-U05 guard-disabled negative control sends the real Phase-0 cd after readiness in five trials per shell', async () => {
  for (const mode of MODES) for (const target of PLATFORMS) for (let trial = 0; trial < 5; trial++) {
    const unit = loadRunner({ mode, target, mutation: true })
    const barrier = deferred()
    const running = barrier.promise.then(() => unit.run())
    try {
      assertNoInitialization(unit)
      unit.markRawReady()
      barrier.release()
      await running
      assertInitialization(unit, target, true)
      assert.deepEqual(unit.calls.filter(call => call[0] === 'suite'), [], 'External mode never selected a renderer suite, even before the fix')
      const childBytes = Buffer.from(unit.writes.map(write => write.data).join(''))
      assert.throws(() => assert.deepEqual(childBytes, Buffer.alloc(0)), 'The unchanged empty-child oracle rejects the original pollution')
    } finally {
      barrier.release()
      await running
    }
  }
})
