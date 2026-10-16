/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/** Transport-independent subscription ownership. No native addon is loaded here. */
export interface WatchEvent { path: string; type: 'create' | 'update' | 'delete' }
export interface WatchSubscription { unsubscribe(): Promise<void> }
export type WatchCallback = (error: Error | null, events: WatchEvent[]) => void
export class WatcherConnectionError extends Error {}
export function isCurrentWatchSubscription(disposed: boolean, generation: number, current: number): boolean {
  return !disposed && generation === current
}
export type WatchCommand = {
  event: 'watcher-command'; id: number; subscription: number
} & ({ op: 'subscribe'; path: string; ignore: string[] } | { op: 'unsubscribe' })
export type WatchReply =
  | { event: 'watcher-reply'; id: number; error?: string }
  | { event: 'watcher-events'; subscription: number; events: WatchEvent[]; error?: string }

export function isWatchCommand(value: unknown): value is WatchCommand {
  return Boolean(value && typeof value === 'object' && (value as WatchCommand).event === 'watcher-command')
}
export function isWatchReply(value: unknown): value is WatchReply {
  const event = (value as WatchReply | null)?.event
  return event === 'watcher-reply' || event === 'watcher-events'
}

export class WatcherRpcClient {
  private nextId = 0
  private callbacks = new Map<number, WatchCallback>()
  private established = new Set<number>()
  private generation = 0
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  private closed = false

  private readonly send: (command: WatchCommand) => void
  constructor(send: (command: WatchCommand) => void) { this.send = send }

  async subscribe(path: string, callback: WatchCallback, options: { ignore?: string[] } = {}): Promise<WatchSubscription> {
    if (this.closed) throw new Error('Watcher client is closed')
    const subscription = ++this.nextId
    const generation = this.generation
    this.callbacks.set(subscription, callback)
    try {
      await this.request({ event: 'watcher-command', id: ++this.nextId, subscription, op: 'subscribe', path, ignore: options.ignore ?? [] })
      if (this.closed || generation !== this.generation) throw new WatcherConnectionError('Watcher connection changed')
      this.established.add(subscription)
    } catch (error) {
      this.callbacks.delete(subscription)
      this.established.delete(subscription)
      throw error
    }
    let stopped: Promise<void> | null = null
    return { unsubscribe: () => {
      if (stopped) return stopped
      this.callbacks.delete(subscription)
      this.established.delete(subscription)
      stopped = this.closed || generation !== this.generation ? Promise.resolve() : this.request({ event: 'watcher-command', id: ++this.nextId, subscription, op: 'unsubscribe' })
      return stopped
    } }
  }

  receive(message: WatchReply): void {
    if (message.event === 'watcher-events') {
      this.callbacks.get(message.subscription)?.(message.error ? new Error(message.error) : null, message.events)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve()
  }

  disconnect(error: Error, permanent = false): void {
    this.closed ||= permanent
    this.generation++
    const callbacks = [...this.callbacks].filter(([id]) => this.established.has(id)).map(([, callback]) => callback)
    this.callbacks.clear()
    this.established.clear()
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!permanent) for (const callback of callbacks) callback(error, [])
  }

  inspect(): { subscriptions: number; pending: number } {
    return { subscriptions: this.callbacks.size, pending: this.pending.size }
  }

  private request(command: WatchCommand): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.set(command.id, { resolve, reject })
      try { this.send(command) }
      catch (error) {
        this.pending.delete(command.id)
        reject(error)
      }
    })
  }
}
