/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WatcherServiceRegistry } from '../../electron/main/watcher-service-registry.ts'
import { WatcherRpcClient, isCurrentWatchSubscription, type WatchCommand, type WatchCallback } from '../../electron/main/watcher-rpc.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('WS-U07 stale callbacks cannot replace a newer subscription or resurrect a disposed view', () => {
  assert.equal(isCurrentWatchSubscription(false, 1, 1), true)
  assert.equal(isCurrentWatchSubscription(false, 1, 2), false)
  assert.equal(isCurrentWatchSubscription(true, 1, 1), false)
})

test('WS-U01 shutdown drains a subscribe that completes after shutdown began', async () => {
  const subscribed = deferred<{ unsubscribe: () => Promise<void> }>()
  const unsubscribed = deferred<void>()
  let calls = 0
  const registry = new WatcherServiceRegistry({ subscribe: () => subscribed.promise })
  const subscribe = registry.subscribe(1, 'fixture-label', () => {}, [])
  const stop = registry.shutdown()
  let stopped = false
  void stop.then(() => { stopped = true })
  subscribed.resolve({ unsubscribe: () => { calls++; return unsubscribed.promise } })
  await Promise.resolve()
  assert.equal(stopped, false)
  await assert.rejects(registry.subscribe(2, 'fixture-label', () => {}, []), /stopping/)
  unsubscribed.resolve()
  await Promise.all([subscribe, stop])
  assert.equal(calls, 1)
  assert.deepEqual(registry.inspect(), { subscriptions: 0, pending: 0, closing: true })
})

test('WS-U02 concurrent unsubscribe/shutdown joins the actual native completion exactly once', async () => {
  const pending = deferred<void>()
  let calls = 0
  const registry = new WatcherServiceRegistry({ subscribe: async () => ({ unsubscribe: () => { calls++; return pending.promise } }) })
  await registry.subscribe(1, 'fixture-label', () => {}, [])
  const a = registry.unsubscribe(1)
  assert.equal(registry.unsubscribe(1), a)
  const stop = registry.shutdown()
  assert.equal(registry.shutdown(), stop)
  pending.resolve()
  await Promise.all([a, stop])
  assert.equal(calls, 1)
})

test('WS-U03 failed unsubscribe never becomes a false drained acknowledgment', async () => {
  const registry = new WatcherServiceRegistry({ subscribe: async () => ({ unsubscribe: async () => { throw new Error('native failure') } }) })
  await registry.subscribe(1, 'fixture-label', () => {}, [])
  await assert.rejects(registry.unsubscribe(1), /native failure/)
  assert.equal(registry.inspect().subscriptions, 1)
  await assert.rejects(registry.shutdown(), /native failure/)
})

test('WS-U04 shutdown refuses events and new subscriptions during drain', async () => {
  let callback!: WatchCallback
  let events = 0
  const registry = new WatcherServiceRegistry({ subscribe: async (_path, cb) => {
    callback = cb
    return { unsubscribe: async () => {} }
  } })
  await registry.subscribe(1, 'fixture-label', () => events++, [])
  callback(null, [])
  const stop = registry.shutdown()
  callback(null, [])
  await stop
  assert.equal(events, 1)
})

test('WS-U05 RPC disconnect rejects pending work and shutdown cannot spawn new work', async () => {
  const commands: WatchCommand[] = []
  const client = new WatcherRpcClient(command => commands.push(command))
  const subscription = client.subscribe('fixture-label', () => {})
  const rejection = assert.rejects(subscription, /lost/)
  client.disconnect(new Error('lost'), true)
  await rejection
  await assert.rejects(client.subscribe('fixture-label', () => {}), /closed/)
  assert.equal(commands.length, 1)
  assert.deepEqual(client.inspect(), { subscriptions: 0, pending: 0 })
})

test('WS-U06 RPC duplicate unsubscribe and stale events cannot resurrect a subscription', async () => {
  const commands: WatchCommand[] = []
  const client = new WatcherRpcClient(command => commands.push(command))
  let callbacks = 0
  const pending = client.subscribe('fixture-label', () => callbacks++)
  client.receive({ event: 'watcher-reply', id: commands[0].id })
  const subscription = await pending
  const stop = subscription.unsubscribe()
  assert.equal(subscription.unsubscribe(), stop)
  client.receive({ event: 'watcher-events', subscription: commands[0].subscription, events: [] })
  client.receive({ event: 'watcher-reply', id: commands[1].id })
  await stop
  assert.equal(callbacks, 0)
  assert.equal(commands.length, 2)
})

test('WS-U08 an initial subscribe failure rejects once, without inventing an active watcher fault', async () => {
  const client = new WatcherRpcClient(() => {})
  let callbacks = 0
  const subscription = client.subscribe('fixture-label', () => callbacks++)
  const rejected = assert.rejects(subscription, /lost/)
  client.disconnect(new Error('lost'))
  await rejected
  assert.equal(callbacks, 0)
})

test('WS-U09 a reply racing connection death cannot publish a stale subscription', async () => {
  const commands: WatchCommand[] = []
  const client = new WatcherRpcClient(command => commands.push(command))
  const subscription = client.subscribe('fixture-label', () => {})
  client.receive({ event: 'watcher-reply', id: commands[0].id })
  client.disconnect(new Error('lost'))
  await assert.rejects(subscription, /connection changed/)
})

test('WS-U10 disposing an old connection never spawns work on its replacement', async () => {
  const commands: WatchCommand[] = []
  const client = new WatcherRpcClient(command => commands.push(command))
  const pending = client.subscribe('fixture-label', () => {})
  client.receive({ event: 'watcher-reply', id: commands[0].id })
  const subscription = await pending
  client.disconnect(new Error('lost'))
  await subscription.unsubscribe()
  assert.equal(commands.length, 1)
})
