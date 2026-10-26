/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-fetch-inflight.test.mts
 *
 * Locks the join-or-start semantics behind the Task badge's sync button
 * (BUG-0005 follow-up, 2026-10-26). In the field bundle a click that landed
 * while the background fetch was running was DROPPED: 5 clicks, 0 main-side
 * requests, one frame of spinner. The user-confirmed fix is VS Code's
 * `@throttle` behaviour — a second request joins the running one, never spawns
 * a duplicate transfer, and is never discarded.
 *
 * Paired with run-git-autofetch-ahead-behind AB-14 (the same rule end-to-end
 * through the real IPC + a real slow git transport).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { InFlightRegistry } from '../../electron/main/git-fetch-inflight.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('a second request while one runs joins it: same promise, start called once', async () => {
  const registry = new InFlightRegistry<string>()
  const d = deferred<string>()
  let starts = 0
  const start = () => {
    starts += 1
    return d.promise
  }
  const first = registry.runOrJoin('repo', start)
  const second = registry.runOrJoin('repo', start)
  assert.equal(first.joined, false)
  assert.equal(second.joined, true)
  assert.equal(first.promise, second.promise, 'joiners must observe the exact same settlement')
  assert.equal(starts, 1, 'no duplicate transfer')
  d.resolve('done')
  assert.equal(await second.promise, 'done')
})

test('after the run settles, the next request starts a fresh run', async () => {
  const registry = new InFlightRegistry<number>()
  let starts = 0
  const start = () => Promise.resolve(++starts)
  assert.equal(await registry.runOrJoin('repo', start).promise, 1)
  await tick()
  assert.equal(registry.has('repo'), false)
  const next = registry.runOrJoin('repo', start)
  assert.equal(next.joined, false)
  assert.equal(await next.promise, 2)
})

test('a rejected run is released too — a failure must not wedge the repo', async () => {
  const registry = new InFlightRegistry<number>()
  const d = deferred<number>()
  const run = registry.runOrJoin('repo', () => d.promise)
  d.reject(new Error('boom'))
  await assert.rejects(run.promise, /boom/)
  await tick()
  assert.equal(registry.has('repo'), false)
  const retry = registry.runOrJoin('repo', () => Promise.resolve(7))
  assert.equal(retry.joined, false)
  assert.equal(await retry.promise, 7)
})

test('a start that throws synchronously registers nothing', () => {
  const registry = new InFlightRegistry<number>()
  assert.throws(() => registry.runOrJoin('repo', () => {
    throw new Error('spawn failed')
  }), /spawn failed/)
  assert.equal(registry.has('repo'), false)
  assert.equal(registry.size, 0)
})

test('different repos never join each other', async () => {
  const registry = new InFlightRegistry<string>()
  const a = deferred<string>()
  const b = deferred<string>()
  const runA = registry.runOrJoin('repo-a', () => a.promise)
  const runB = registry.runOrJoin('repo-b', () => b.promise)
  assert.equal(runA.joined, false)
  assert.equal(runB.joined, false)
  assert.notEqual(runA.promise, runB.promise)
  assert.equal(registry.size, 2)
  a.resolve('a')
  b.resolve('b')
  assert.deepEqual(await Promise.all([runA.promise, runB.promise]), ['a', 'b'])
})

test('a joiner that arrives later still sees the outcome, and the entry is cleared before it resumes', async () => {
  const registry = new InFlightRegistry<string>()
  const d = deferred<string>()
  registry.runOrJoin('repo', () => d.promise)
  await tick()
  const late = registry.runOrJoin('repo', () => Promise.resolve('should-not-run'))
  assert.equal(late.joined, true)
  d.resolve('original')
  assert.equal(await late.promise, 'original')
  // The release handler was attached before any joiner's continuation, so by
  // the time a joiner resumes, a new click would start a fresh run.
  assert.equal(registry.has('repo'), false)
})
