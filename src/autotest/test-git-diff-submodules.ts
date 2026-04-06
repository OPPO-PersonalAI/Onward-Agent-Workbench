/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const LOAD_TIMEOUT_MS = 30000
const QUICK_TIMEOUT_MS = 8000

/**
 * Multi-submodule Git Diff regression suite.
 *
 * Verifies the staged-loading contract for repositories with multiple submodules:
 * 1. root-only diff returns a repo outline immediately, with submodules marked as loading
 * 2. opening Git Diff shows the shell quickly
 * 3. the repo outline is visible before the full submodule aggregation finishes
 * 4. the final load completes and clears loading markers
 */
export async function testGitDiffSubmodules(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const shellThresholdMs = platform === 'win32' ? 700 : 300
  const getGitDiffApi = () => window.__onwardGitDiffDebug

  log('git-diff-submodules:start', { suite: 'GitDiffSubmodules', rootPath, platform })

  // DSM-01: root-only diff exposes the repo outline without blocking on submodule diffs
  if (!cancelled()) {
    const rootOnly = await window.electronAPI.git.getDiff(rootPath, { scope: 'root-only' })
    const repos = rootOnly.repos ?? []
    const loadingRepos = repos.filter((repo) => repo.loading)
    const normalizedRoots = repos.every((repo) => !repo.root.includes('\\'))

    _assert('DSM-01-root-only-discovers-submodules', (
      rootOnly.success &&
      rootOnly.submodulesLoading === true &&
      repos.length > 1 &&
      loadingRepos.length > 0
    ), {
      success: rootOnly.success,
      submodulesLoading: rootOnly.submodulesLoading ?? false,
      repoCount: repos.length,
      loadingRepoCount: loadingRepos.length,
      fileCount: rootOnly.files.length,
      platform
    })

    _assert('DSM-01-root-only-paths-normalized', normalizedRoots, {
      repoRoots: repos.slice(0, 6).map((repo) => repo.root),
      platform
    })
  }

  // DSM-02: opening Git Diff still shows the shell quickly
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const shellVisible = await waitFor('DSM-02-diff-open', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen() && api.getTiming().shellShownAt !== null)
    }, QUICK_TIMEOUT_MS)

    const timing = getGitDiffApi()?.getTiming() ?? null
    _assert('DSM-02-shell-visible-fast', shellVisible && (timing?.openToShellMs ?? Number.MAX_SAFE_INTEGER) < shellThresholdMs, {
      shellVisible,
      openToShellMs: timing?.openToShellMs ?? null,
      thresholdMs: shellThresholdMs,
      platform
    })
  }

  // DSM-03: the repo outline is visible while submodule aggregation is still loading
  if (!cancelled()) {
    const outlineVisible = await waitFor('DSM-03-outline-visible', () => {
      const api = getGitDiffApi()
      if (!api?.isOpen()) return false
      if (!api.isSubmodulesLoading()) return false
      const repos = api.getRepoList()
      return repos.some((repo) => repo.loading)
    }, LOAD_TIMEOUT_MS)

    const api = getGitDiffApi()
    const timing = api?.getTiming() ?? null
    const repos = api?.getRepoList() ?? []
    _assert('DSM-03-outline-visible-before-full-load', outlineVisible, {
      outlineVisible,
      submodulesLoading: api?.isSubmodulesLoading() ?? false,
      repoCount: repos.length,
      loadingRepoCount: repos.filter((repo) => repo.loading).length,
      fileCount: api?.getFileList().length ?? 0,
      openToDiffLoadedMs: timing?.openToDiffLoadedMs ?? null,
      platform
    })
  }

  // DSM-04: the full load settles and clears loading markers
  if (!cancelled()) {
    const fullLoaded = await waitFor('DSM-04-full-load', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen() && !api.isSubmodulesLoading())
    }, LOAD_TIMEOUT_MS)

    const api = getGitDiffApi()
    const repos = api?.getRepoList() ?? []
    const timing = api?.getTiming() ?? null
    _assert('DSM-04-full-load-completes', (
      fullLoaded &&
      repos.length > 1 &&
      repos.some((repo) => repo.isSubmodule) &&
      repos.every((repo) => !repo.loading)
    ), {
      fullLoaded,
      repoCount: repos.length,
      fileCount: api?.getFileList().length ?? 0,
      openToDiffLoadedMs: timing?.openToDiffLoadedMs ?? null,
      platform
    })
  }

  // DSM-05: Git Diff still closes cleanly
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    const closed = await waitFor('DSM-05-close', () => {
      const api = getGitDiffApi()
      return !api || !api.isOpen()
    }, 4000)
    _assert('DSM-05-diff-close', closed, { closed, platform })
    await sleep(300)
  }

  log('git-diff-submodules:done', {
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length
  })

  return results
}
