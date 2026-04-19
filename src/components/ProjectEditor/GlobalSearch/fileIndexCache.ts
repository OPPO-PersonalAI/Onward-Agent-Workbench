/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeProjectCwd } from '../../../utils/pathNormalize.ts'

export type FileIndexStatus = 'idle' | 'building' | 'ready'

export interface FileIndexSnapshot {
  status: FileIndexStatus
  files: string[]
}

export interface FileIndexWatcherAdapter {
  start(cwd: string): void
  stop(cwd: string): void
}

interface FileIndexEntry {
  status: FileIndexStatus
  files: string[]
  fileSet: Set<string>
  buildPromise: Promise<string[]> | null
  buildToken: number
  listeners: Set<() => void>
  lastTouched: number
  watching: boolean
}

const MAX_ENTRIES = 8

const entries = new Map<string, FileIndexEntry>()
let watcherAdapter: FileIndexWatcherAdapter | null = null
let totalBuildCount = 0

function now(): number {
  return Date.now()
}

function touch(entry: FileIndexEntry): void {
  entry.lastTouched = now()
}

function notify(entry: FileIndexEntry): void {
  for (const listener of entry.listeners) {
    try {
      listener()
    } catch {
      // Listeners are best-effort; a crashing subscriber must not poison the others.
    }
  }
}

function createEmptyEntry(): FileIndexEntry {
  return {
    status: 'idle',
    files: [],
    fileSet: new Set(),
    buildPromise: null,
    buildToken: 0,
    listeners: new Set(),
    lastTouched: now(),
    watching: false
  }
}

function ensureEntry(cwd: string): FileIndexEntry {
  let entry = entries.get(cwd)
  if (!entry) {
    entry = createEmptyEntry()
    entries.set(cwd, entry)
    evictIfNeeded()
  }
  return entry
}

function evictIfNeeded(): void {
  if (entries.size <= MAX_ENTRIES) return
  const candidates: Array<[string, FileIndexEntry]> = []
  for (const [cwd, entry] of entries) {
    if (entry.listeners.size > 0) continue
    candidates.push([cwd, entry])
  }
  candidates.sort((a, b) => a[1].lastTouched - b[1].lastTouched)
  for (const [cwd] of candidates) {
    if (entries.size <= MAX_ENTRIES) break
    disposeCwd(cwd)
  }
}

function disposeCwd(cwd: string): void {
  const entry = entries.get(cwd)
  if (!entry) return
  entries.delete(cwd)
  if (entry.watching && watcherAdapter) {
    try {
      watcherAdapter.stop(cwd)
    } catch {
      // Best-effort cleanup; the main-process watcher will eventually time out.
    }
    entry.watching = false
  }
}

function startWatch(cwd: string, entry: FileIndexEntry): void {
  if (entry.watching || !watcherAdapter) return
  try {
    watcherAdapter.start(cwd)
    entry.watching = true
  } catch {
    entry.watching = false
  }
}

export function setFileIndexWatcherAdapter(adapter: FileIndexWatcherAdapter | null): void {
  watcherAdapter = adapter
}

export function subscribe(rawCwd: string, listener: () => void): () => void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = ensureEntry(cwd)
  entry.listeners.add(listener)
  touch(entry)
  return () => {
    const current = entries.get(cwd)
    if (!current) return
    current.listeners.delete(listener)
  }
}

export function getIndexSnapshot(rawCwd: string): FileIndexSnapshot {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry) return { status: 'idle', files: [] }
  return { status: entry.status, files: entry.files }
}

export async function ensureIndex(
  rawCwd: string,
  walker: (cwd: string) => Promise<string[]>
): Promise<string[]> {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = ensureEntry(cwd)
  touch(entry)

  if (entry.status === 'ready') return entry.files
  if (entry.buildPromise) return entry.buildPromise

  entry.status = 'building'
  const token = ++entry.buildToken
  totalBuildCount += 1

  const promise = (async (): Promise<string[]> => {
    try {
      const files = await walker(cwd)
      const current = entries.get(cwd)
      if (current === entry && entry.buildToken === token) {
        entry.files = files.slice()
        entry.fileSet = new Set(files)
        entry.status = 'ready'
        touch(entry)
        startWatch(cwd, entry)
        notify(entry)
        return entry.files
      }
      return files
    } catch (error) {
      const current = entries.get(cwd)
      if (current === entry && entry.buildToken === token) {
        entry.status = 'idle'
        entry.files = []
        entry.fileSet = new Set()
        notify(entry)
      }
      throw error
    } finally {
      const current = entries.get(cwd)
      if (current === entry && entry.buildToken === token) {
        entry.buildPromise = null
      }
    }
  })()

  entry.buildPromise = promise
  return promise
}

export function invalidate(rawCwd: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry) return
  entry.buildToken += 1
  entry.status = 'idle'
  entry.files = []
  entry.fileSet = new Set()
  entry.buildPromise = null
  touch(entry)
  notify(entry)
}

function normalizeRelPath(relPath: string): string {
  return normalizeProjectCwd(relPath).replace(/^\/+/, '')
}

export function addFile(rawCwd: string, relPath: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry || entry.status !== 'ready') return
  const normalized = normalizeRelPath(relPath)
  if (!normalized || entry.fileSet.has(normalized)) return
  entry.fileSet.add(normalized)
  entry.files = [...entry.files, normalized]
  touch(entry)
  notify(entry)
}

export function removeFile(rawCwd: string, relPath: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry || entry.status !== 'ready') return
  const normalized = normalizeRelPath(relPath)
  if (!normalized) return
  const prefix = `${normalized}/`
  const next = entry.files.filter((file) => file !== normalized && !file.startsWith(prefix))
  if (next.length === entry.files.length) return
  entry.files = next
  entry.fileSet = new Set(next)
  touch(entry)
  notify(entry)
}

export function renameFile(rawCwd: string, fromPath: string, toPath: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry || entry.status !== 'ready') return
  const from = normalizeRelPath(fromPath)
  const to = normalizeRelPath(toPath)
  if (!from || !to || from === to) return
  const prefix = `${from}/`
  let changed = false
  const next = entry.files.map((file) => {
    if (file === from) {
      changed = true
      return to
    }
    if (file.startsWith(prefix)) {
      changed = true
      return to + file.slice(from.length)
    }
    return file
  })
  if (!changed) return
  entry.files = next
  entry.fileSet = new Set(next)
  touch(entry)
  notify(entry)
}

export function applyFsEvent(
  rawCwd: string,
  diff: { added?: string[]; removed?: string[] }
): void {
  const cwd = normalizeProjectCwd(rawCwd)
  const entry = entries.get(cwd)
  if (!entry || entry.status !== 'ready') return
  let changed = false
  if (diff.removed && diff.removed.length > 0) {
    for (const relPath of diff.removed) {
      const normalized = normalizeRelPath(relPath)
      if (!normalized) continue
      const prefix = `${normalized}/`
      const before = entry.files.length
      entry.files = entry.files.filter((file) => file !== normalized && !file.startsWith(prefix))
      if (entry.files.length !== before) changed = true
    }
  }
  if (diff.added && diff.added.length > 0) {
    for (const relPath of diff.added) {
      const normalized = normalizeRelPath(relPath)
      if (!normalized || entry.fileSet.has(normalized)) continue
      entry.files.push(normalized)
      entry.fileSet.add(normalized)
      changed = true
    }
  }
  if (changed) {
    entry.fileSet = new Set(entry.files)
    touch(entry)
    notify(entry)
  }
}

export function dispose(rawCwd: string): void {
  const cwd = normalizeProjectCwd(rawCwd)
  disposeCwd(cwd)
}

export function disposeAll(): void {
  for (const cwd of [...entries.keys()]) {
    disposeCwd(cwd)
  }
}

export function getCacheStats(): {
  totalBuilds: number
  entryCount: number
  entries: Array<{ cwd: string; status: FileIndexStatus; fileCount: number }>
} {
  return {
    totalBuilds: totalBuildCount,
    entryCount: entries.size,
    entries: [...entries.entries()].map(([cwd, entry]) => ({
      cwd,
      status: entry.status,
      fileCount: entry.files.length
    }))
  }
}

export function __resetCacheStatsForTest(): void {
  totalBuildCount = 0
}

export function __getInternalStateForTest(): {
  size: number
  keys: string[]
  snapshot(cwd: string): FileIndexSnapshot
} {
  return {
    size: entries.size,
    keys: [...entries.keys()],
    snapshot(cwd: string) {
      return getIndexSnapshot(cwd)
    }
  }
}
