/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure utility functions for the Pin/Recent quick-file feature.
 * Extracted from ProjectEditor.tsx for testability.
 */

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function getBaseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || ''
}

export function getParentPath(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

export function normalizeQuickFilePaths(paths: readonly string[] | null | undefined, maxCount: number): string[] {
  if (!Array.isArray(paths) || maxCount <= 0) return []
  const results: string[] = []
  const dedupe = new Set<string>()
  for (const item of paths) {
    const normalized = normalizePath(String(item || '').trim())
    if (!normalized || dedupe.has(normalized)) continue
    dedupe.add(normalized)
    results.push(normalized)
    if (results.length >= maxCount) break
  }
  return results
}

export function prependRecentFile(paths: readonly string[], path: string, maxCount: number): string[] {
  const normalizedPath = normalizePath(path.trim())
  if (!normalizedPath) return normalizeQuickFilePaths(paths, maxCount)
  const normalized = normalizeQuickFilePaths(paths, maxCount)
  return [normalizedPath, ...normalized.filter(item => item !== normalizedPath)].slice(0, maxCount)
}

export function replaceQuickFilePath(paths: readonly string[], sourcePath: string, nextPath: string, maxCount: number): string[] {
  const normalizedSource = normalizePath(sourcePath.trim())
  const normalizedNext = normalizePath(nextPath.trim())
  if (!normalizedSource || !normalizedNext) return normalizeQuickFilePaths(paths, maxCount)
  const mapped = paths.map((item) => {
    if (item === normalizedSource) return normalizedNext
    if (item.startsWith(`${normalizedSource}/`)) {
      return `${normalizedNext}${item.slice(normalizedSource.length)}`
    }
    return item
  })
  return normalizeQuickFilePaths(mapped, maxCount)
}

export function areQuickFileListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

export function removeQuickFilePath(paths: readonly string[], targetPath: string, maxCount: number): string[] {
  const normalizedTarget = normalizePath(targetPath.trim())
  if (!normalizedTarget) return normalizeQuickFilePaths(paths, maxCount)
  return normalizeQuickFilePaths(
    paths.filter(item => item !== normalizedTarget && !item.startsWith(`${normalizedTarget}/`)),
    maxCount
  )
}

export function moveQuickFile(paths: readonly string[], dragPath: string, targetPath: string, maxCount: number): string[] {
  const normalized = normalizeQuickFilePaths(paths, maxCount)
  const fromIndex = normalized.indexOf(dragPath)
  const toIndex = normalized.indexOf(targetPath)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return normalized
  const next = [...normalized]
  const [moved] = next.splice(fromIndex, 1)
  const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
  next.splice(insertIndex, 0, moved)
  return next
}

export function buildQuickFileLabels(paths: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {}
  paths.forEach((path) => {
    labels[path] = getBaseName(path)
  })
  return labels
}

export function decodeQuickFileDragPayload(raw: string): { path: string; source: 'pinned' | 'recent' } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; source?: unknown }
    const path = typeof parsed.path === 'string' ? normalizePath(parsed.path.trim()) : ''
    const source = parsed.source === 'pinned' || parsed.source === 'recent' ? parsed.source : null
    if (!path || !source) return null
    return { path, source }
  } catch {
    return null
  }
}
