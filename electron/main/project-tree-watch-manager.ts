/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'fs'
import { readdir, stat, realpath } from 'fs/promises'
import { watcherService } from './watcher-service-client'
import type { WatchSubscription, WatchEvent } from './watcher-rpc'
import { isCurrentWatchSubscription, WatcherConnectionError } from './watcher-rpc'
import type { BrowserWindow } from 'electron'
import { join, normalize } from 'path'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getIgnoredRelReason, isIgnoredRel } from './project-tree-watch-ignore'
import type { ProjectTreeWatchIgnoreReason } from './project-tree-watch-ignore'
import { parcelEventAction } from './project-tree-watch-classify'

interface TreeEntry {
  subscribeGeneration: number
  subscription: WatchSubscription | null
  pendingAdded: Set<string>
  pendingRemoved: Set<string>
  pendingResync: boolean
  flushTimer: NodeJS.Timeout | null
  ignoredFlushTimer: NodeJS.Timeout | null
  ignoredEventCounts: Map<ProjectTreeWatchIgnoreReason, number>
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
const IGNORED_SUMMARY_MS = 1000
// Upper cap so a runaway rename loop cannot unbounded-queue events.
const MAX_PENDING = 5000

// Ignore filter lives in `project-tree-watch-ignore.ts` so it can be
// unit-tested without Electron's main-process imports.

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

// Normalise a relative path supplied by an in-app mutation (project.createFile
// etc.) into the renderer's canonical form, dropping ignored paths so that, e.g.,
// `.git/index.lock` or `node_modules/.cache/**` writes never reach the file
// index (FIC-24/25). Returns null for empty / ignored paths.
function normalizeMutationRel(rel: string): string | null {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized) return null
  if (isIgnoredRel(normalized)) return null
  return normalized
}

export class ProjectTreeWatchManager {
  private entries = new Map<string, TreeEntry>()
  private readonly mainWindow: BrowserWindow

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
  }

  start(cwd: string): void {
    const fullPath = normalize(cwd)
    if (this.entries.has(fullPath)) return
    if (!existsSync(fullPath)) return

    const entry: TreeEntry = {
      subscribeGeneration: 0,
      subscription: null,
      pendingAdded: new Set(),
      pendingRemoved: new Set(),
      pendingResync: false,
      flushTimer: null,
      ignoredFlushTimer: null,
      ignoredEventCounts: new Map(),
      inflightWalks: 0,
      walkedDirs: new Set(),
      disposed: false,
      cwdForRenderer: toRendererCwd(cwd)
    }
    this.entries.set(fullPath, entry)

    // @parcel/watcher subscribes to native recursive FS events — FSEvents on
    // macOS, inotify on Linux, ReadDirectoryChangesW on Windows. This replaces
    // Node's `fs.watch({recursive:true})`, which delivers ZERO events on macOS
    // 15+ (a libuv FSEvents-bridge regression, nodejs/node#55592) and was the
    // root cause of the file index never seeing external creates / renames.
    // @parcel/watcher is already a production dependency and the same backend
    // the git-state-mirror worker uses. subscribe() is async; start() stays
    // fire-and-forget so callers keep their synchronous contract.
    void this.subscribe(fullPath, entry)
  }

  private async subscribe(fullPath: string, entry: TreeEntry): Promise<void> {
    const generation = ++entry.subscribeGeneration
    const started = performance.now()
    try {
      // FSEvents reports physical paths. Keep the renderer's logical cwd, but
      // subscribe/classify against the same physical root (including /var aliases).
      const nativeRoot = await realpath(fullPath)
      if (!isCurrentWatchSubscription(entry.disposed, generation, entry.subscribeGeneration)) {
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_SUBSCRIBE, { outcome: 'disposed-before-subscribe' })
        return
      }
      const subscription = await watcherService.subscribe(nativeRoot, (err, events) => {
        if (!isCurrentWatchSubscription(entry.disposed, generation, entry.subscribeGeneration)) return
        if (err) {
          // The watcher faulted (overflow / backend error). We cannot trust the
          // incremental state any more, so ask the renderer to discard its
          // snapshot and rebuild on next use — mirrors the old fs.watch
          // "filename === null" path.
          entry.pendingResync = true
          this.scheduleFlush(entry)
          if (err instanceof WatcherConnectionError) {
            performanceTrace.record(PERF_TRACE_EVENT.MAIN_WATCHER_SERVICE_LIFECYCLE, { phase: 'tree-resubscribe', generation })
            const previous = entry.subscription
            entry.subscription = null
            void previous?.unsubscribe().catch(() => {})
            void this.subscribe(fullPath, entry)
          }
          return
        }
        for (const event of events) {
          this.handleEvent(nativeRoot, entry, event)
        }
      })
      if (!isCurrentWatchSubscription(entry.disposed, generation, entry.subscribeGeneration)) {
        // stop() raced ahead of subscribe() resolving — tear the subscription
        // down immediately so we don't leak a live watcher.
        try {
          await subscription.unsubscribe()
        } catch {
          // ignore
        }
        performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_SUBSCRIBE, {
          cwd: entry.cwdForRenderer,
          outcome: 'disposed-race'
        })
        return
      }
      entry.subscription = subscription
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_SUBSCRIBE, {
        cwd: entry.cwdForRenderer,
        outcome: 'ok',
        canonicalized: nativeRoot !== fullPath,
        durationMs: performance.now() - started
      })
    } catch (error) {
      if (!isCurrentWatchSubscription(entry.disposed, generation, entry.subscribeGeneration)) return
      // Subscribe failed (path vanished, permission, backend unavailable). Fall
      // back to in-app invalidation from UI-driven mutations, as before.
      entry.subscription = null
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_SUBSCRIBE, {
        cwd: entry.cwdForRenderer,
        outcome: 'failed',
        error: String((error as Error)?.message ?? error).slice(0, 256)
      })
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_SUBSCRIBE, {
        cwd: entry.cwdForRenderer,
        outcome: 'failed',
        error: String((error as Error)?.message ?? error).slice(0, 256)
      })
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
    if (entry.ignoredFlushTimer) {
      clearTimeout(entry.ignoredFlushTimer)
      entry.ignoredFlushTimer = null
    }
    if (entry.subscription) {
      const subscription = entry.subscription
      entry.subscription = null
      void subscription.unsubscribe().catch(() => {
        // ignore — best-effort teardown
      })
    }
    this.entries.delete(fullPath)
  }

  dispose(): void {
    for (const cwd of [...this.entries.keys()]) {
      this.stop(cwd)
    }
  }

  private handleEvent(fullPath: string, entry: TreeEntry, event: WatchEvent): void {
    if (entry.disposed) return
    const rel = toRelativeRendererPath(fullPath, event.path)
    if (!rel) return
    // Drop high-frequency uninteresting paths (e.g. `.git/index.lock`,
    // `node_modules/.cache/**`) at the source. Without this, the app's own
    // git-status polling flickers `.git/objects/**` continuously and pegs
    // the renderer chasing FS events for paths Cmd+P / File Browser never
    // surfaces anyway.
    const ignoredReason = getIgnoredRelReason(rel)
    if (ignoredReason) {
      this.recordIgnoredEvent(entry, ignoredReason)
      return
    }
    if (parcelEventAction(event.type) === 'remove') {
      // @parcel/watcher tells us the path is gone — no stat needed. This is more
      // accurate than the old fs.watch stat→ENOENT inference, which raced a
      // delete-then-recreate and could misclassify a live path as removed.
      this.queueRemoval(entry, rel)
      return
    }
    // create | update: the path exists; classify file vs directory via stat.
    void this.classifyAndQueuePath(fullPath, entry, event.path, rel)
  }

  private queueRemoval(entry: TreeEntry, rel: string): void {
    // The rel path may name either a file or a directory that just went away.
    // We send it as a "removed" entry; the renderer's cache cascades prefix
    // matches so removing `src/util` also drops `src/util/*` paths that were
    // previously indexed. Also forget that we've walked this subtree so a later
    // recreation re-enumerates its contents.
    if (entry.pendingRemoved.size < MAX_PENDING) entry.pendingRemoved.add(rel)
    entry.pendingAdded.delete(rel)
    entry.walkedDirs.delete(rel)
    for (const dir of entry.walkedDirs) {
      if (dir.startsWith(`${rel}/`)) entry.walkedDirs.delete(dir)
    }
    this.scheduleFlush(entry)
  }

  private recordIgnoredEvent(entry: TreeEntry, reason: ProjectTreeWatchIgnoreReason): void {
    if (!performanceTrace.isEnabled()) return
    entry.ignoredEventCounts.set(reason, (entry.ignoredEventCounts.get(reason) ?? 0) + 1)
    if (entry.ignoredFlushTimer) return
    entry.ignoredFlushTimer = setTimeout(() => {
      entry.ignoredFlushTimer = null
      this.flushIgnoredEvents(entry)
    }, IGNORED_SUMMARY_MS)
    entry.ignoredFlushTimer.unref?.()
  }

  private flushIgnoredEvents(entry: TreeEntry): void {
    if (entry.disposed || entry.ignoredEventCounts.size === 0) return
    const git = entry.ignoredEventCounts.get('git') ?? 0
    const nodeModules = entry.ignoredEventCounts.get('nodeModules') ?? 0
    const cache = entry.ignoredEventCounts.get('cache') ?? 0
    const dsStore = entry.ignoredEventCounts.get('dsStore') ?? 0
    entry.ignoredEventCounts.clear()
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_IGNORED_SUMMARY, {
      cwd: entry.cwdForRenderer,
      total: git + nodeModules + cache + dsStore,
      git,
      nodeModules,
      cache,
      dsStore
    })
  }

  private async classifyAndQueuePath(fullPath: string, entry: TreeEntry, abs: string, rel: string): Promise<void> {
    if (entry.disposed) return
    // Classify the path via stat. We deliberately do NOT trust the watcher to
    // distinguish files from directories — queuing a directory path as a file
    // addition would pollute Cmd+P with folder names.
    let kind: 'file' | 'dir' | 'missing' | 'unknown'
    try {
      const st = await stat(abs)
      kind = st.isDirectory() ? 'dir' : 'file'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      kind = code === 'ENOENT' ? 'missing' : 'unknown'
    }

    if (entry.disposed) return

    if (kind === 'missing') {
      // A create/update event whose path already vanished — treat as a removal.
      this.queueRemoval(entry, rel)
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
          if (isIgnoredRel(childRel)) continue
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
    // Burst-start marker: one event per debounce window, not per raw
    // FSEvent. Raw events are often 10-100x noisier than the debounced
    // batch; this sampling keeps the trace readable while still letting
    // SQL bucket by time.
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_EVENT, {
      cwd: entry.cwdForRenderer,
      pendingAdded: entry.pendingAdded.size,
      pendingRemoved: entry.pendingRemoved.size,
      pendingResync: entry.pendingResync
    })
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

    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_BATCH, {
      cwd: entry.cwdForRenderer,
      added: added.length,
      removed: removed.length,
      resync
    })
    this.mainWindow.webContents.send(IPC.PROJECT_TREE_WATCH_EVENT, {
      cwd: entry.cwdForRenderer,
      added,
      removed,
      resync
    })
  }

  /**
   * Direct in-app mutation notification. The project.createFile / renamePath /
   * deletePath IPC handlers call this AFTER a successful fs op so the renderer
   * file index updates DETERMINISTICALLY, without depending on the OS watcher.
   *
   * The @parcel/watcher subscription above covers EXTERNAL changes (other
   * editors, `git checkout`) when the platform delivers native FS events. This
   * path covers the app's OWN edits — which must propagate even when no native
   * FS events arrive at all (unsigned dev builds / restricted hosts can deliver
   * zero FSEvents to fs.watch AND @parcel/watcher alike; see
   * docs/html/file-index-watcher-backend-decision.html). It mirrors what the
   * renderer ProjectEditor UI already does via fileIndexAddFile, extended to the
   * IPC mutation surface, and runs the same ignore filter so `.git` /
   * `node_modules` noise never enters the index.
   */
  notifyMutation(cwd: string, added: string[], removed: string[]): void {
    if (this.mainWindow.isDestroyed()) return
    const cleanAdded = added.map(normalizeMutationRel).filter((p): p is string => p !== null)
    const cleanRemoved = removed.map(normalizeMutationRel).filter((p): p is string => p !== null)
    if (cleanAdded.length === 0 && cleanRemoved.length === 0) return
    const cwdForRenderer = toRendererCwd(normalize(cwd))
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROJECT_TREE_WATCH_INAPP_MUTATION, {
      cwd: cwdForRenderer,
      added: cleanAdded.length,
      removed: cleanRemoved.length
    })
    this.mainWindow.webContents.send(IPC.PROJECT_TREE_WATCH_EVENT, {
      cwd: cwdForRenderer,
      added: cleanAdded,
      removed: cleanRemoved,
      resync: false
    })
  }
}
