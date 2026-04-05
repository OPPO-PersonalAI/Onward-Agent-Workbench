/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const LOAD_TIMEOUT_MS = 30000
const QUICK_TIMEOUT_MS = 8000

/**
 * Recursive submodule Git Diff regression suite.
 *
 * Verifies that nested submodule trees still use staged loading correctly:
 * 1. root-only diff returns the full repo outline, including nested submodules
 * 2. Git Diff shell becomes visible quickly
 * 3. nested submodules remain visible in the outline while deeper diffs are loading
 * 4. full load completes with nested repo changes attached
 */
export async function testGitDiffRecursiveSubmodules(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const shellThresholdMs = platform === 'win32' ? 700 : 300
  const getGitDiffApi = () => window.__onwardGitDiffDebug

  log('git-diff-recursive-submodules:start', {
    suite: 'GitDiffRecursiveSubmodules',
    rootPath,
    platform
  })

  // RSM-01: root-only diff discovers nested submodules and marks them as loading
  if (!cancelled()) {
    const rootOnly = await window.electronAPI.git.getDiff(rootPath, { scope: 'root-only' })
    const repos = rootOnly.repos ?? []
    const loadingRepos = repos.filter((repo) => repo.loading)
    const maxSubmoduleDepth = repos.reduce((max, repo) => Math.max(max, repo.isSubmodule ? repo.depth : -1), -1)

    _assert('RSM-01-root-only-discovers-nested-submodules', (
      rootOnly.success &&
      rootOnly.submodulesLoading === true &&
      repos.length >= 4 &&
      loadingRepos.length >= 3 &&
      maxSubmoduleDepth >= 1
    ), {
      success: rootOnly.success,
      submodulesLoading: rootOnly.submodulesLoading ?? false,
      repoCount: repos.length,
      loadingRepoCount: loadingRepos.length,
      maxSubmoduleDepth,
      repoLabels: repos.map((repo) => `${repo.label}@${repo.depth}`).slice(0, 8),
      platform
    })
  }

  // RSM-02: opening Git Diff still shows the shell quickly
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const shellVisible = await waitFor('RSM-02-diff-open', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen() && api.getTiming().shellShownAt !== null)
    }, QUICK_TIMEOUT_MS)

    const timing = getGitDiffApi()?.getTiming() ?? null
    _assert('RSM-02-shell-visible-fast', shellVisible && (timing?.openToShellMs ?? Number.MAX_SAFE_INTEGER) < shellThresholdMs, {
      shellVisible,
      openToShellMs: timing?.openToShellMs ?? null,
      thresholdMs: shellThresholdMs,
      platform
    })
  }

  // RSM-03: nested outline is visible before full load settles
  if (!cancelled()) {
    const outlineVisible = await waitFor('RSM-03-outline-visible', () => {
      const api = getGitDiffApi()
      if (!api?.isOpen()) return false
      if (!api.isSubmodulesLoading()) return false
      const repos = api.getRepoList()
      return repos.some((repo) => repo.loading && repo.depth > 0)
    }, LOAD_TIMEOUT_MS)

    const api = getGitDiffApi()
    const timing = api?.getTiming() ?? null
    const repos = api?.getRepoList() ?? []
    _assert('RSM-03-nested-outline-visible-before-full-load', outlineVisible, {
      outlineVisible,
      submodulesLoading: api?.isSubmodulesLoading() ?? false,
      repoCount: repos.length,
      nestedLoadingCount: repos.filter((repo) => repo.loading && repo.depth > 0).length,
      maxSubmoduleDepth: repos.reduce((max, repo) => Math.max(max, repo.isSubmodule ? repo.depth : -1), -1),
      openToDiffLoadedMs: timing?.openToDiffLoadedMs ?? null,
      platform
    })
  }

  // RSM-04: full load completes and nested repos have loaded changes
  if (!cancelled()) {
    const fullLoaded = await waitFor('RSM-04-full-load', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen() && !api.isSubmodulesLoading())
    }, LOAD_TIMEOUT_MS)

    const api = getGitDiffApi()
    const repos = api?.getRepoList() ?? []
    const timing = api?.getTiming() ?? null
    const nestedReposWithChanges = repos.filter((repo) => repo.isSubmodule && repo.depth > 0 && repo.changeCount > 0)
    _assert('RSM-04-full-load-completes-for-nested-submodules', (
      fullLoaded &&
      nestedReposWithChanges.length > 0 &&
      repos.every((repo) => !repo.loading)
    ), {
      fullLoaded,
      repoCount: repos.length,
      nestedReposWithChanges: nestedReposWithChanges.map((repo) => ({
        label: repo.label,
        depth: repo.depth,
        changeCount: repo.changeCount
      })),
      fileCount: api?.getFileList().length ?? 0,
      openToDiffLoadedMs: timing?.openToDiffLoadedMs ?? null,
      platform
    })
  }

  // RSM-05: Git Diff still closes cleanly
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    const closed = await waitFor('RSM-05-close', () => {
      const api = getGitDiffApi()
      return !api || !api.isOpen()
    }, 4000)
    _assert('RSM-05-diff-close', closed, { closed, platform })
    await sleep(300)
  }

  log('git-diff-recursive-submodules:done', {
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length
  })

  return results
}
