/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Join-or-start registry for per-repo `git fetch` runs.
 *
 * Why this exists (BUG-0005 follow-up, 2026-10-26 field bundle): a click on the
 * Task badge's sync button that landed while the background fetch for the same
 * repo was running was DROPPED — `fetchNow` returned `null`, the renderer
 * cleared its spinner in the same tick, and the user saw "nothing happened"
 * (5 clicks, 0 main-side `git-fetch.user-requested`). The user-confirmed fix is
 * VS Code's semantics (`@throttle` on `fetchDefault`): a second request while
 * one is running WAITS for that run instead of being discarded, and never
 * spawns a duplicate transfer of the same pack.
 *
 * Pure (no Electron, no child_process) so the join semantics are locked by
 * `test/unittest/git-fetch-inflight.test.mts`.
 */

export interface InFlightRun<T> {
  promise: Promise<T>
  /** True when this caller attached to a run started by someone else. */
  joined: boolean
}

export class InFlightRegistry<T> {
  private readonly inflight = new Map<string, Promise<T>>()

  /**
   * Return the in-flight run for `key` if there is one; otherwise call `start`
   * and register its promise until it settles (fulfilled OR rejected).
   *
   * The map stores the exact promise handed to callers, so every joiner
   * observes the same settlement. A `start` that throws synchronously never
   * registers anything — the next call starts fresh.
   */
  runOrJoin(key: string, start: () => Promise<T>): InFlightRun<T> {
    const existing = this.inflight.get(key)
    if (existing) return { promise: existing, joined: true }

    const promise = start()
    this.inflight.set(key, promise)
    const release = (): void => {
      // Only clear our own entry; a later run may already own the key.
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    }
    promise.then(release, release)
    return { promise, joined: false }
  }

  has(key: string): boolean {
    return this.inflight.has(key)
  }

  get size(): number {
    return this.inflight.size
  }
}
