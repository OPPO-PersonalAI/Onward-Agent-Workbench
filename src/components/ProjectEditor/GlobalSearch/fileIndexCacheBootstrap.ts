/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { applyFsEvent, invalidate, setFileIndexWatcherAdapter } from './fileIndexCache'

let initialized = false

export function initializeFileIndexCacheBridge(): void {
  if (initialized) return
  if (typeof window === 'undefined') return
  const api = window.electronAPI?.project
  if (!api || typeof api.treeWatchStart !== 'function') return

  const debugLog = (...args: unknown[]) => {
    if (!window.electronAPI?.debug?.enabled) return
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    // Route via console AND the main-process debug log so autotest log files capture it.
    console.log('[FileIndexCacheBridge]', message)
    window.electronAPI?.debug?.log?.(`[FileIndexCacheBridge] ${message}`)
  }

  setFileIndexWatcherAdapter({
    start: (cwd: string) => {
      debugLog('start', cwd)
      void api.treeWatchStart(cwd)
    },
    stop: (cwd: string) => {
      debugLog('stop', cwd)
      void api.treeWatchStop(cwd)
    }
  })

  api.onTreeWatchEvent((event) => {
    if (!event || typeof event.cwd !== 'string') return
    const added = Array.isArray(event.added) ? event.added : []
    const removed = Array.isArray(event.removed) ? event.removed : []
    const resync = Boolean((event as { resync?: boolean }).resync)
    debugLog('event', JSON.stringify({ cwd: event.cwd, added: added.length, removed: removed.length, resync }))
    if (resync) {
      // The main-process watcher could not determine what changed (typically
      // a null-filename fs.watch event). Drop the entry so the next search
      // rebuilds from disk, rather than leaving removed paths stale.
      invalidate(event.cwd)
      return
    }
    applyFsEvent(event.cwd, { added, removed })
  })

  debugLog('initialized')
  initialized = true
}
