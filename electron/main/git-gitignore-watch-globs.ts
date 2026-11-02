/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Convert a repo's `.gitignore` into `@parcel/watcher` `ignore` globs so the
 * GitStateMirror watcher does NOT fire (and trigger an expensive `git status`
 * recompute) for churning git-ignored paths.
 *
 * # Safety: directory patterns only
 *
 * We convert ONLY directory patterns (lines ending in `/`). git cannot
 * re-include a file underneath an ignored directory (the directory is pruned
 * before its contents are considered), so a directory ignore is immune to the
 * `!negation` over-ignore hazard — adding `build/**` can never suppress a path
 * that git would actually track. File / extension patterns (`*.raw`, `*.log`)
 * are intentionally NOT converted, because a later `!keep.raw` negation could
 * make blanket extension suppression drop a real change. Correct-by-construction
 * beats a fuller-but-riskier matcher.
 *
 * Pure (string in, globs out) so it is unit-testable in plain `node --test`.
 */

export interface GitignoreWatchGlobOptions {
  /** Hard cap on emitted globs to bound a pathological `.gitignore`. */
  maxGlobs?: number
}

/**
 * @param gitignoreContent raw contents of a repo-root `.gitignore` (or '')
 * @returns parcel-watcher `ignore` globs (relative to the watched root)
 */
export function gitignoreToWatchIgnoreGlobs(
  gitignoreContent: string,
  options: GitignoreWatchGlobOptions = {}
): string[] {
  const maxGlobs = options.maxGlobs ?? 200
  const globs: string[] = []
  const seen = new Set<string>()
  const push = (g: string): void => {
    if (!seen.has(g)) {
      seen.add(g)
      globs.push(g)
    }
  }

  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    if (globs.length >= maxGlobs) break
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) continue // negation: never converts to an ignore
    if (line.includes('[') || line.includes(']')) continue // char classes: skip
    if (!line.endsWith('/')) continue // directory patterns only (negation-immune)
    line = line.slice(0, -1) // strip trailing slash
    const anchored = line.startsWith('/')
    if (anchored) line = line.slice(1)
    line = line.replace(/^\.\//, '') // normalize leading "./"
    line = line.replace(/^\/+|\/+$/g, '') // strip stray leading/trailing slashes
    if (!line || line === '.' || line === '..') continue

    if (anchored || line.includes('/')) {
      // Root-anchored (leading slash) or a mid-path pattern (git anchors those
      // to the .gitignore location, i.e. the repo root here).
      push(`${line}/**`)
    } else {
      // Bare directory name: git matches it at the root AND any nested depth.
      push(`${line}/**`)
      push(`**/${line}/**`)
    }
  }
  return globs
}
