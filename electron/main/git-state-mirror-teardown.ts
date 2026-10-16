/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/** Native drain is owned by WatcherServiceRegistry, not by this computation worker. */
export function shouldRespawnGitStateMirrorWorker(opts: {
  disposed: boolean
  hasLiveWorker: boolean
  respawnAttempt: number
  maxAttempts: number
}): boolean {
  return !opts.disposed && !opts.hasLiveWorker && opts.respawnAttempt < opts.maxAttempts
}
