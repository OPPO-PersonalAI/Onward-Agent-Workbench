#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const requireFromTest = createRequire(import.meta.url)
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const schedulerPath = resolve(repoRoot, 'src', 'terminal', 'terminal-output-scheduler.ts')

function createClock() {
  let now = 0
  let nextId = 1
  const callbacks = new Map()
  // This is a simulated browser frame cadence, not an application latency budget.
  const frameIntervalMs = 16

  function schedule(callback, delay) {
    const id = nextId++
    callbacks.set(id, { id, dueAt: now + delay, callback })
    return id
  }

  function checkedDeadline(ms) {
    assert.ok(Number.isFinite(ms) && ms >= 0, 'the virtual clock must advance monotonically')
    return now + ms
  }

  return {
    now: () => now,
    setTimeout: (callback, delay = 0) => schedule(callback, Math.max(0, delay)),
    clearTimeout: (id) => callbacks.delete(id),
    requestAnimationFrame: (callback) => {
      const nextFrame = (Math.floor(now / frameIntervalMs) + 1) * frameIntervalMs
      return schedule(() => callback(now), nextFrame - now)
    },
    cancelAnimationFrame: (id) => callbacks.delete(id),
    pendingCount: () => callbacks.size,
    // Advance without dispatch to model an event loop blocked past multiple timer deadlines.
    elapse: (ms) => { now = checkedDeadline(ms) },
    advanceBy: (ms) => {
      const deadline = checkedDeadline(ms)
      let dispatched = 0
      while (true) {
        const next = [...callbacks.values()]
          .filter(entry => entry.dueAt <= deadline)
          .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0]
        if (!next) break
        assert.ok(dispatched++ < 10000, 'virtual callbacks must not reschedule indefinitely')
        callbacks.delete(next.id)
        // Overdue callbacks execute at the resumed time, never at their missed deadline.
        now = Math.max(now, next.dueAt)
        next.callback()
      }
      now = deadline
    }
  }
}

function loadScheduler(fakeInputLane, clock) {
  const source = readFileSync(schedulerPath, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: schedulerPath
  }).outputText

  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === './input-priority-lane') {
        return { inputPriorityLane: fakeInputLane }
      }
      // The scheduler took on a perf-trace dependency in master commit
      // c4625ef. The test sandbox mocks the imports so the scheduler can
      // load without the real renderer-side trace stack.
      if (specifier === '../utils/perf-trace') {
        return {
          perfTrace: () => {},
          perfTraceTask: () => {}
        }
      }
      if (specifier === '../utils/perf-trace-names') {
        return {
          PERF_TRACE_EVENT: new Proxy({}, { get: (_target, prop) => String(prop) })
        }
      }
      return requireFromTest(specifier)
    },
    performance: { now: clock.now },
    requestAnimationFrame: clock.requestAnimationFrame,
    cancelAnimationFrame: clock.cancelAnimationFrame,
    window: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout
    }
  }

  vm.runInNewContext(compiled, sandbox, { filename: schedulerPath })
  return module.exports.TerminalOutputScheduler
}

function createTarget(id, writes, options = {}) {
  const pending = []
  return {
    id,
    pending,
    target: {
      id,
      hasPendingData: () => pending.length > 0,
      isOutputActive: () => options.outputActive !== false,
      isInteractive: () => Boolean(options.interactive?.()),
      consumeChunk: () => pending.shift() ?? null,
      writeData: (data) => writes.push({ id, data })
    }
  }
}

function testVisibleOutputUsesBatchCadence() {
  const fakeInputLane = {
    shouldYieldToPromptInput: () => false,
    hasRecentFocusedTaskInput: () => false
  }
  const clock = createClock()
  const TerminalOutputScheduler = loadScheduler(fakeInputLane, clock)
  const scheduler = new TerminalOutputScheduler({ batchIntervalMs: 20, visibleFrameBudgetMs: 100 })
  const writes = []
  const visible = createTarget('visible', writes)
  scheduler.registerTarget(visible.target)

  visible.pending.push('a')
  scheduler.markDirty('visible')
  clock.advanceBy(19)
  assert.equal(writes.length, 0, 'visible output must wait for the batch cadence')

  clock.advanceBy(1)
  assert.equal(writes.length, 0, 'the batch timer must enqueue a frame rather than write synchronously')
  clock.advanceBy(12)
  assert.deepEqual(writes, [{ id: 'visible', data: 'a' }])
  assert.equal(clock.pendingCount(), 0, 'the successful frame must cancel its fallback timer')

  visible.pending.push('b', 'c')
  scheduler.markDirty('visible')
  scheduler.markDirty('visible')
  assert.equal(clock.pendingCount(), 1, 'dirty notifications must coalesce into one batch')
  clock.advanceBy(19)
  assert.equal(writes.length, 1, 'the next batch must also respect the cadence')
  clock.advanceBy(13)
  assert.deepEqual(writes, [
    { id: 'visible', data: 'a' },
    { id: 'visible', data: 'b' },
    { id: 'visible', data: 'c' }
  ])
  assert.equal(clock.pendingCount(), 0)
}

function testPromptInputPreemptsFocusedTaskOutput() {
  let promptPressure = true
  const fakeInputLane = {
    shouldYieldToPromptInput: () => promptPressure,
    hasRecentFocusedTaskInput: () => false
  }
  const clock = createClock()
  const TerminalOutputScheduler = loadScheduler(fakeInputLane, clock)
  const scheduler = new TerminalOutputScheduler({
    batchIntervalMs: 20,
    promptInputMaxYieldMs: 80,
    focusedFrameBudgetMs: 100
  })
  const writes = []
  const focused = createTarget('focused', writes, { interactive: () => true })
  scheduler.registerTarget(focused.target)

  focused.pending.push('focused-output')
  scheduler.markDirty('focused', true)
  clock.advanceBy(16)
  assert.equal(writes.length, 0, 'Prompt input pressure must preempt the first focused Task frame')
  clock.advanceBy(32)
  assert.equal(writes.length, 0, 'Prompt input pressure must preempt focused Task output')

  promptPressure = false
  clock.advanceBy(31)
  assert.equal(writes.length, 0, 'deferred output must wait for its already scheduled frame')
  clock.advanceBy(1)
  assert.deepEqual(writes, [{ id: 'focused', data: 'focused-output' }])
  assert.equal(clock.pendingCount(), 0, 'the resumed frame must cancel its fallback timer')
}

function testFocusedTaskQueuePreemptsVisibleOutput() {
  const fakeInputLane = {
    shouldYieldToPromptInput: () => false,
    hasRecentFocusedTaskInput: () => false
  }
  const clock = createClock()
  const TerminalOutputScheduler = loadScheduler(fakeInputLane, clock)
  const scheduler = new TerminalOutputScheduler({ batchIntervalMs: 20, focusedFrameBudgetMs: 100, visibleFrameBudgetMs: 100 })
  const writes = []
  const visible = createTarget('visible', writes)
  const focused = createTarget('focused', writes, { interactive: () => true })
  scheduler.registerTarget(visible.target)
  scheduler.registerTarget(focused.target)

  visible.pending.push('visible-output')
  focused.pending.push('focused-output')
  scheduler.markDirty('visible')
  scheduler.markDirty('focused', true)

  clock.advanceBy(20)
  assert.equal(writes.length, 0, 'both lanes must wait for the scheduled frame')
  clock.advanceBy(12)
  assert.equal(writes[0]?.id, 'focused', 'focused Task output must flush before visible Task output')
  assert.equal(writes[1]?.id, 'visible')
  assert.deepEqual(writes, [
    { id: 'focused', data: 'focused-output' },
    { id: 'visible', data: 'visible-output' }
  ])
  assert.equal(clock.pendingCount(), 0)
}

function testDelayedBatchTimerExplainsOldSleepRace() {
  const clock = createClock()
  // Replay the old harness's zero-delay timer-backed rAF, entirely on the virtual clock.
  const oldTimingShim = {
    ...clock,
    requestAnimationFrame: (callback) => clock.setTimeout(() => callback(clock.now()), 0),
    cancelAnimationFrame: clock.clearTimeout
  }
  const TerminalOutputScheduler = loadScheduler({
    shouldYieldToPromptInput: () => false,
    hasRecentFocusedTaskInput: () => false
  }, oldTimingShim)
  const scheduler = new TerminalOutputScheduler({ batchIntervalMs: 20, focusedFrameBudgetMs: 100, visibleFrameBudgetMs: 100 })
  const writes = []
  const visible = createTarget('visible', writes)
  const focused = createTarget('focused', writes, { interactive: () => true })
  scheduler.registerTarget(visible.target)
  scheduler.registerTarget(focused.target)
  visible.pending.push('visible-output')
  focused.pending.push('focused-output')
  scheduler.markDirty('visible')
  scheduler.markDirty('focused', true)

  const observations = []
  clock.setTimeout(() => observations.push(writes.map(write => write.id)), 40)
  clock.elapse(50)
  clock.advanceBy(0)

  assert.deepEqual(observations, [[]], 'the old 40 ms observation can precede the rAF created by an overdue batch timer')
  assert.deepEqual(writes, [
    { id: 'focused', data: 'focused-output' },
    { id: 'visible', data: 'visible-output' }
  ], 'the actual scheduler still flushes in the correct priority order when the queued frame runs')
  assert.equal(clock.pendingCount(), 0, 'the delayed frame must also cancel its fallback timer')
}

// Explicit clocks make these deterministic ordering tests, not wall-clock latency measurements.
testVisibleOutputUsesBatchCadence()
testPromptInputPreemptsFocusedTaskOutput()
testFocusedTaskQueuePreemptsVisibleOutput()
testDelayedBatchTimerExplainsOldSleepRace()

console.log('terminal-output-scheduler-unit: PASS')
