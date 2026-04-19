/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { watch, existsSync, statSync } from 'fs'
import type { FSWatcher } from 'fs'
import { readdir } from 'fs/promises'
import type { BrowserWindow } from 'electron'
import { join, normalize } from 'path'

interface TreeEntry {
  watcher: FSWatcher | null
  pendingAdded: Set<string>
  pendingRemoved: Set<string>
  pendingResync: boolean
  flushTimer: NodeJS.Timeout | null
  inflightWalks: number
  // Directory paths whose contents we have already enumerated at least once.
  // macOS FSEvents delivers a parent-directory "changed" event for nearly
  // every child-file mutation; we must not re-walk the subtree each time,
  // otherwise each create/rename/delete triggers an O(N) scan that pushes the
  // real file event behind a long chain of flushes.
  walkedDirs: Set<string>
  disposed: boolean
  cwdForRenderer: string
}

const FLUSH_DEBOUNCE_MS = 180
// Upper cap so a runaway rename loop cannot unbounded-queue events.
const MAX_PENDING = 5000

function toRendererCwd(fullPath: string): string {
  return fullPath.replace(/\\/g, '/')
}

function toRelativeRendererPath(cwd: string, abs: string): string | null {
  const normalizedCwd = normalize(cwd)
  const normalizedAbs = normalize(abs)
  if (!normalizedAbs.startsWith(normalizedCwd)) return null
  const rel = normalizedAbs.slice(normalizedCwd.length).replace(/^[\\/]+/, '')
  return rel ? rel.replace(/\\/g, '/') : null
}

export class ProjectTreeWatchManager {
  private entries = new Map<string, TreeEntry>()

  constructor(private readonly mainWindow: BrowserWindow) {}

  start(cwd: string): void {
    const fullPath = normalize(cwd)
    if (this.entries.has(fullPath)) return
    if (!existsSync(fullPath)) return

    const entry: TreeEntry = {
      watcher: null,
      pendingAdded: new Set(),
      pendingRemoved: new Set(),
      pendingResync: false,
      flushTimer: null,
      inflightWalks: 0,
      walkedDirs: new Set(),
      disposed: false,
      cwdForRenderer: toRendererCwd(cwd)
    }
    this.entries.set(fullPath, entry)

    // fs.watch recursive: true is supported on darwin + win32 natively.
    // On linux, Node 20+ implements recursive via inotify; when unsupported we skip
    // watching and fall back to in-app invalidation from UI-driven mutations.
    // TODO(cross-platform): track whether Linux inotify coverage is sufficient for
    // very large trees; consider a bounded chokidar dep if we observe gaps.
    try {
      entry.watcher = watch(
        fullPath,
        { recursive: true, persistent: false },
        (_eventType, filename) => {
          if (entry.disposed) return
          this.handleRawEvent(fullPath, entry, filename)
        }
      )
      entry.watcher.on('error', () => {
        // Swallow; watcher may drop on its own, we'll rely on UI-driven invalidation.
      })
    } catch {
      entry.watcher = null
    }
  }

  stop(cwd: string): void {
    const fullPath = normalize(cwd)
    const entry = this.entries.get(fullPath)
    if (!entry) return
    entry.disposed = true
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // ignore
      }
      entry.watcher = null
    }
    this.entries.delete(fullPath)
  }

  dispose(): void {
    for (const cwd of [...this.entries.keys()]) {
      this.stop(cwd)
    }
  }

  private handleRawEvent(fullPath: string, entry: TreeEntry, rawFilename: string | Buffer | null): void {
    if (!rawFilename) {
      // fs.watch cannot tell us what changed — the only correct response is to
      // ask the renderer to discard its snapshot and rebuild on next use. The
      // previous additive rescan would miss removals and leave stale entries.
      entry.pendingResync = true
      this.scheduleFlush(entry)
      return
    }
    const filename = typeof rawFilename === 'string' ? rawFilename : rawFilename.toString('utf8')
    const abs = join(fullPath, filename)
    const rel = toRelativeRendererPath(fullPath, abs)
    if (!rel) return

    // Classify the path via stat. We deliberately do NOT trust fs.watch to
    // distinguish files from directories — queuing a directory path as a file
    // addition would pollute Cmd+P with folder names.
    let kind: 'file' | 'dir' | 'missing' | 'unknown'
    try {
      const st = statSync(abs)
      kind = st.isDirectory() ? 'dir' : 'file'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      kind = code === 'ENOENT' ? 'missing' : 'unknown'
    }

    if (kind === 'missing') {
      // The rel path may name either a file or a directory that just went
      // away. We send it as a "removed" entry; the renderer's cache cascades
      // prefix matches so removing `src/util` also drops `src/util/*` paths
      // that were previously indexed. Also forget that we've walked this
      // subtree so a later recreation re-enumerates its contents.
      if (entry.pendingRemoved.size < MAX_PENDING) entry.pendingRemoved.add(rel)
      entry.pendingAdded.delete(rel)
      entry.walkedDirs.delete(rel)
      for (const dir of entry.walkedDirs) {
        if (dir.startsWith(`${rel}/`)) entry.walkedDirs.delete(dir)
      }
      this.scheduleFlush(entry)
      return
    }

    if (kind === 'file') {
      if (entry.pendingAdded.size < MAX_PENDING) entry.pendingAdded.add(rel)
      entry.pendingRemoved.delete(rel)
      this.scheduleFlush(entry)
      return
    }

    if (kind === 'dir') {
      // A directory was added, renamed into place, or simply had its mtime
      // bumped because a child file was written. Only the FIRST occurrence is
      // worth enumerating — on macOS FSEvents delivers a parent-dir event
      // alongside nearly every file-level event, and re-walking the subtree
      // each time would drown out the real file event behind a burst of
      // redundant scans.
      if (entry.walkedDirs.has(rel)) return
      entry.walkedDirs.add(rel)
      void this.enqueueDirectoryContents(fullPath, entry, rel)
      return
    }
    // kind === 'unknown' (e.g. EACCES): skip; a later event or manual refresh
    // will reconcile state.
  }

  private async enqueueDirectoryContents(
    fullPath: string,
    entry: TreeEntry,
    relDir: string
  ): Promise<void> {
    entry.inflightWalks += 1
    try {
      const stack: string[] = [relDir]
      while (stack.length > 0) {
        if (entry.disposed) return
        const current = stack.pop() as string
        let children
        try {
          children = await readdir(join(fullPath, current), { withFileTypes: true })
        } catch {
          // Directory vanished mid-walk or is unreadable; move on.
          continue
        }
        for (const child of children) {
          const childRel = `${current}/${child.name}`.replace(/\\/g, '/')
          if (child.isDirectory()) {
            stack.push(childRel)
          } else if (child.isFile() || child.isSymbolicLink()) {
            if (entry.pendingAdded.size < MAX_PENDING) entry.pendingAdded.add(childRel)
          }
        }
      }
    } finally {
      entry.inflightWalks -= 1
      if (!entry.disposed) this.scheduleFlush(entry)
    }
  }

  private scheduleFlush(entry: TreeEntry): void {
    if (entry.flushTimer) return
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null
      this.flush(entry)
    }, FLUSH_DEBOUNCE_MS)
  }

  private flush(entry: TreeEntry): void {
    if (entry.disposed) return
    if (this.mainWindow.isDestroyed()) return
    if (
      entry.pendingAdded.size === 0 &&
      entry.pendingRemoved.size === 0 &&
      !entry.pendingResync
    ) return

    // Flush whatever we have right now. An in-flight directory walk may still
    // discover more files — those will land in the NEXT flush via scheduleFlush
    // in enqueueDirectoryContents' finally block. Blocking on walker completion
    // here would artificially delay the file-level events that FSEvents already
    // delivered and break fast incremental-search round-trips.

    const added = [...entry.pendingAdded]
    const removed = [...entry.pendingRemoved]
    const resync = entry.pendingResync
    entry.pendingAdded.clear()
    entry.pendingRemoved.clear()
    entry.pendingResync = false

    this.mainWindow.webContents.send('project:tree-watch:event', {
      cwd: entry.cwdForRenderer,
      added,
      removed,
      resync
    })
  }
}
