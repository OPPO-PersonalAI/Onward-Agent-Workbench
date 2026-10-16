/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WatchCallback, WatchSubscription } from './watcher-rpc'

/** Tracks calls before they settle, including subscribe -> shutdown races. */
export class WatcherServiceRegistry {
  private closing = false
  private operations = new Set<Promise<unknown>>()
  private subscriptions = new Map<number, WatchSubscription>()
  private unsubscribes = new Map<number, Promise<void>>()
  private shutdownPromise: Promise<void> | null = null

  private readonly backend: {
    subscribe(path: string, callback: WatchCallback, options: { ignore: string[] }): Promise<WatchSubscription>
  }
  constructor(backend: WatcherServiceRegistry['backend']) { this.backend = backend }

  subscribe(id: number, path: string, callback: WatchCallback, ignore: string[]): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Watcher service is stopping'))
    return this.track(async () => {
      const subscription = await this.backend.subscribe(path, (error, events) => {
        if (!this.closing) callback(error, events)
      }, { ignore })
      if (this.closing) await subscription.unsubscribe()
      else this.subscriptions.set(id, subscription)
    })
  }

  unsubscribe(id: number): Promise<void> {
    const pending = this.unsubscribes.get(id)
    if (pending) return pending
    const subscription = this.subscriptions.get(id)
    if (!subscription) return Promise.resolve()
    const operation = this.track(async () => {
      await subscription.unsubscribe()
      this.subscriptions.delete(id)
    })
    this.unsubscribes.set(id, operation)
    void operation.then(() => this.unsubscribes.delete(id), () => this.unsubscribes.delete(id))
    return operation
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownPromise = (async () => {
      // Rejected native cleanup is not proof of quiescence. Propagate failure;
      // the owning process decides when to terminate this isolated service.
      await Promise.all([...this.operations])
      await Promise.all([...this.subscriptions.keys()].map(id => this.unsubscribe(id)))
      while (this.operations.size) await Promise.all([...this.operations])
    })()
    return this.shutdownPromise
  }

  inspect(): { subscriptions: number; pending: number; closing: boolean } {
    return { subscriptions: this.subscriptions.size, pending: this.operations.size, closing: this.closing }
  }

  private track(run: () => Promise<void>): Promise<void> {
    const operation = Promise.resolve().then(run)
    this.operations.add(operation)
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation))
    return operation
  }
}
