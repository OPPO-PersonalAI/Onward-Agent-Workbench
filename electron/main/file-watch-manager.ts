/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { watch, readFile, stat } from 'fs'
import type { FSWatcher } from 'fs'
import type { BrowserWindow } from 'electron'
import { normalize } from 'path'

interface WatchEntry {
  watcher: FSWatcher | null
  debounceTimer: NodeJS.Timeout | null
  rebuildTimer: NodeJS.Timeout | null
  suppressUntil: number
  lastContent: string | null
  disposed: boolean
}

const DEBOUNCE_MS = 400
const SUPPRESS_WINDOW_MS = 1000
const REBUILD_DELAY_MS = 500
const REBUILD_MAX_RETRIES = 5

function debugLog(..._args: unknown[]) {
  // Keep the watcher quiet unless it needs local debugging.
}

export class FileWatchManager {
  private entries = new Map<string, WatchEntry>()

  constructor(private readonly mainWindow: BrowserWindow) {}

  watch(fullPath: string): void {
    const normalizedPath = normalize(fullPath)
    if (this.entries.has(normalizedPath)) {
      debugLog('watch:already-active', normalizedPath)
      return
    }

    const entry: WatchEntry = {
      watcher: null,
      debounceTimer: null,
      rebuildTimer: null,
      suppressUntil: 0,
      lastContent: null,
      disposed: false
    }
    this.entries.set(normalizedPath, entry)

    readFile(normalizedPath, 'utf-8', (error, content) => {
      if (entry.disposed) return
      if (!error) {
        entry.lastContent = content
      }
      this.createWatcher(normalizedPath, entry, 0)
    })
  }

  unwatch(fullPath: string): void {
    const normalizedPath = normalize(fullPath)
    const entry = this.entries.get(normalizedPath)
    if (!entry) return
    entry.disposed = true
    this.cleanupEntry(entry)
    this.entries.delete(normalizedPath)
  }

  suppressNext(fullPath: string): void {
    const normalizedPath = normalize(fullPath)
    const entry = this.entries.get(normalizedPath)
    if (!entry) return
    entry.suppressUntil = Date.now() + SUPPRESS_WINDOW_MS
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
  }

  dispose(): void {
    for (const [path, entry] of this.entries) {
      entry.disposed = true
      this.cleanupEntry(entry)
      this.entries.delete(path)
    }
  }

  private createWatcher(normalizedPath: string, entry: WatchEntry, retryCount: number): void {
    if (entry.disposed) return

    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // Ignore close failures during watcher replacement.
      }
      entry.watcher = null
    }

    try {
      entry.watcher = watch(normalizedPath, { persistent: true }, (eventType) => {
        if (eventType === 'rename') {
          this.scheduleRebuild(normalizedPath, entry, 0)
          return
        }
        this.handleEvent(normalizedPath, entry)
      })

      entry.watcher.on('error', () => {
        this.scheduleRebuild(normalizedPath, entry, 0)
      })
    } catch {
      if (retryCount < REBUILD_MAX_RETRIES) {
        this.scheduleRebuild(normalizedPath, entry, retryCount)
      }
    }
  }

  private scheduleRebuild(normalizedPath: string, entry: WatchEntry, retryCount: number): void {
    if (entry.disposed) return

    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // Ignore close failures during rebuild.
      }
      entry.watcher = null
    }

    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
    }

    entry.rebuildTimer = setTimeout(() => {
      entry.rebuildTimer = null
      if (entry.disposed) return

      stat(normalizedPath, (error) => {
        if (entry.disposed) return

        if (error) {
          this.emitChange(normalizedPath, 'deleted')
          if (retryCount < REBUILD_MAX_RETRIES) {
            this.scheduleRebuild(normalizedPath, entry, retryCount + 1)
          }
          return
        }

        this.createWatcher(normalizedPath, entry, retryCount + 1)
        void this.emitIfChanged(normalizedPath, entry)
      })
    }, REBUILD_DELAY_MS)
  }

  private handleEvent(normalizedPath: string, entry: WatchEntry): void {
    if (entry.disposed) return
    if (Date.now() < entry.suppressUntil) return

    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
    }

    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      if (!entry.disposed) {
        void this.emitIfChanged(normalizedPath, entry)
      }
    }, DEBOUNCE_MS)
  }

  private async emitIfChanged(normalizedPath: string, entry: WatchEntry): Promise<void> {
    try {
      const content = await new Promise<string>((resolve, reject) => {
        readFile(normalizedPath, 'utf-8', (error, data) => {
          if (error) {
            reject(error)
            return
          }
          resolve(data)
        })
      })

      if (content === entry.lastContent) {
        return
      }

      entry.lastContent = content
      this.emitChange(normalizedPath, 'changed', content)
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'ENOENT'
      ) {
        this.emitChange(normalizedPath, 'deleted')
      }
    }
  }

  private emitChange(fullPath: string, changeType: 'changed' | 'deleted', content?: string): void {
    if (this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('project:file-changed', fullPath, changeType, content)
  }

  private cleanupEntry(entry: WatchEntry): void {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.rebuildTimer) {
      clearTimeout(entry.rebuildTimer)
      entry.rebuildTimer = null
    }
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // Ignore close failures during cleanup.
      }
      entry.watcher = null
    }
  }
}
