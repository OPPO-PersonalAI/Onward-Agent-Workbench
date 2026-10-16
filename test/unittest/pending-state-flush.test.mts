/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPendingStateFlushRegistry, snapshotPromptDraft, awaitInitialStateForFlush } from '../../src/utils/pending-state-flush.ts'

test('PSF-01 local drafts are published synchronously before their owner snapshots state', () => {
  const registry = createPendingStateFlushRegistry()
  const pending = new Map()
  registry.register(() => pending.set('tab-a', snapshotPromptDraft('Latest', 'Final keystroke', 200, 1)))
  registry.register(() => pending.set('tab-b', snapshotPromptDraft('Other', 'Other draft', 300, 1)))
  assert.equal(registry.flush(), 2)
  assert.equal(pending.get('tab-a').content, 'Final keystroke')
  assert.equal(pending.get('tab-b').content, 'Other draft')
})

test('PSF-02 unmount removes a producer and repeated mount cycles do not accumulate callbacks', () => {
  const registry = createPendingStateFlushRegistry()
  let calls = 0
  for (let i = 0; i < 100; i++) {
    const unregister = registry.register(() => calls++)
    unregister()
  }
  assert.equal(registry.flush(), 0)
  assert.equal(calls, 0)
})

test('PSF-03 one failed producer does not skip other drafts and cannot produce a success ACK', () => {
  const registry = createPendingStateFlushRegistry()
  let reached = false
  registry.register(() => { throw new Error('failed local snapshot') })
  registry.register(() => { reached = true })
  assert.throws(() => registry.flush(), AggregateError)
  assert.equal(reached, true)
})

test('PSF-04 empty drafts clear saved content; nonempty drafts retain exact whitespace and metadata', () => {
  assert.equal(snapshotPromptDraft(' ', '\n', 200, 1), null)
  assert.deepEqual(snapshotPromptDraft(' Title ', ' Last input\n', 200, 12), {
    title: ' Title ', content: ' Last input\n', height: 200, savedAt: 12
  })
})

test('PSF-05 early quit cannot snapshot default state before the initial disk load completes', async () => {
  let loaded!: (ok: boolean) => void
  const load = new Promise<boolean>(resolve => { loaded = resolve })
  let collected = false
  const flush = awaitInitialStateForFlush(load).then(() => { collected = true })
  await Promise.resolve()
  assert.equal(collected, false)
  loaded(true)
  await flush
  assert.equal(collected, true)
})

test('PSF-06 a failed or absent initial load cannot acknowledge a successful final save', async () => {
  await assert.rejects(awaitInitialStateForFlush(null), /did not complete/)
  await assert.rejects(awaitInitialStateForFlush(Promise.resolve(false)), /did not complete/)
})
