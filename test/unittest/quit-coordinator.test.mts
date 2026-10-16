/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuitCoordinator, QUIT_DEADLINE_MS, QUIT_EXIT_RESERVE_MS, type QuitStage } from '../../electron/main/quit-coordinator.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(stages: QuitStage[]) {
  const calls: string[] = []
  const events: Array<{ phase: string; data: Record<string, unknown> }> = []
  let deadline!: () => void
  let delay = 0
  const coordinator = new QuitCoordinator({
    now: () => 100, stages: () => stages,
    begin: reason => calls.push(`begin:${reason}`),
    finish: (reason, clean) => calls.push(`finish:${reason}:${clean}`),
    force: (reason, clean) => calls.push(`force:${reason}:${clean}`),
    trace: (phase, data) => events.push({ phase, data }),
    schedule: (callback, ms) => { deadline = callback; delay = ms; return 1 },
    cancel: () => calls.push('timer-cancelled')
  })
  return { coordinator, calls, events, fire: () => deadline(), get delay() { return delay } }
}

test('QC-01 every exit reason shares the approved deadline and ordered required stages', async () => {
  for (const reason of ['quit', 'debug-quit', 'restart-to-update', 'relaunch-for-recovery', 'signal', 'will-quit']) {
    const order: string[] = []
    const h = harness(['renderer', 'cwd', 'storage', 'pty', 'services'].map(name => ({
      name, required: name !== 'services', run: () => { order.push(name) }
    })))
    assert.equal(await h.coordinator.request(reason), 'ready')
    assert.deepEqual(order, ['renderer', 'cwd', 'storage', 'pty', 'services'])
    assert.equal(h.delay + QUIT_EXIT_RESERVE_MS, QUIT_DEADLINE_MS)
    assert.equal(QUIT_DEADLINE_MS, 10_000)
    assert.deepEqual(h.calls, [`begin:${reason}`, `finish:${reason}:true`])
    h.coordinator.exited()
    assert.equal(h.calls.at(-1), 'timer-cancelled')
  }
})

test('QC-02 100 concurrent exits run teardown once and share one promise', async () => {
  const pending = deferred<void>()
  const h = harness([{ name: 'save', required: true, run: () => pending.promise }])
  const first = h.coordinator.request('quit')
  for (let i = 0; i < 100; i++) assert.equal(h.coordinator.request('signal'), first)
  pending.resolve()
  await first
  assert.deepEqual(h.calls, ['begin:quit', 'finish:quit:true'])
})

test('QC-03 cancellation leaves the app usable; a later request can exit', async () => {
  const h = harness([])
  assert.equal(await h.coordinator.request('quit', async () => false), 'cancelled')
  assert.equal(h.coordinator.stopping, false)
  assert.deepEqual(h.calls, [])
  assert.equal(await h.coordinator.request('quit', async () => true), 'ready')
})

test('QC-04 a signal supersedes an unanswered confirmation without double teardown', async () => {
  const dialog = deferred<boolean>()
  const h = harness([])
  const interactive = h.coordinator.request('quit', () => dialog.promise)
  const duplicate = h.coordinator.request('quit', () => { throw new Error('duplicate dialog') })
  assert.equal(interactive, duplicate)
  await h.coordinator.request('signal')
  dialog.resolve(true)
  await interactive
  assert.deepEqual(h.calls, ['begin:signal', 'finish:signal:true'])
})

test('QC-05 stalled persistence forces an abnormal exit and ignores late completion', async () => {
  const pending = deferred<void>()
  let laterStage = false
  const h = harness([
    { name: 'save', required: true, run: () => pending.promise },
    { name: 'services', run: () => { laterStage = true } }
  ])
  const exit = h.coordinator.request('quit')
  h.fire()
  assert.equal(await exit, 'forced')
  pending.resolve()
  await Promise.resolve()
  assert.equal(laterStage, false)
  assert.deepEqual(h.calls, ['begin:quit', 'force:quit:false'])
})

test('QC-06 a stuck watcher cannot invalidate successfully saved state', async () => {
  const entered = deferred<void>()
  const h = harness([
    { name: 'save', required: true, run: () => {} },
    { name: 'services', run: () => { entered.resolve(); return new Promise(() => {}) } }
  ])
  const exit = h.coordinator.request('quit')
  await entered.promise
  h.fire()
  assert.equal(await exit, 'forced')
  assert.deepEqual(h.calls, ['begin:quit', 'force:quit:true'])
})

test('QC-07 failed persistence never marks a clean exit but subsequent cleanup still runs', async () => {
  let cleaned = false
  const h = harness([
    { name: 'save', required: true, run: () => { throw new Error('disk full') } },
    { name: 'services', run: () => { cleaned = true } }
  ])
  await h.coordinator.request('quit')
  assert.equal(cleaned, true)
  assert.deepEqual(h.calls, ['begin:quit', 'finish:quit:false'])
  assert.equal(h.events.find(e => e.phase === 'stage-end')?.data.failed, true)
})

test('QC-08 deadline remains armed if Electron does not finish exiting', async () => {
  const h = harness([])
  await h.coordinator.request('quit')
  h.fire()
  assert.deepEqual(h.calls, ['begin:quit', 'finish:quit:true', 'force:quit:true'])
})

test('QC-09 initialization failure cannot skip required cleanup or manufacture a clean ledger', async () => {
  let forced!: () => void
  let cleaned = false
  let cleanResult = true
  const coordinator = new QuitCoordinator({
    now: () => 0, stages: () => [{ name: 'terminals', required: true, run: () => { cleaned = true } }],
    begin: () => { throw new Error('producer stop failed') },
    finish: (_reason, clean) => { cleanResult = clean }, force: () => {}, trace: () => {},
    schedule: callback => { forced = callback; return 1 }, cancel: () => {}
  })
  assert.equal(await coordinator.request('quit'), 'ready')
  assert.equal(cleaned, true)
  assert.equal(cleanResult, false)
  assert.equal(typeof forced, 'function')
})
