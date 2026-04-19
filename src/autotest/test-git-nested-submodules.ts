/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const LOAD_TIMEOUT_MS = 30000
const QUICK_TIMEOUT_MS = 8000

function normalizePath(value: string | null | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function joinPath(root: string, ...parts: string[]): string {
  const base = normalizePath(root)
  return [base, ...parts].join('/').replace(/\/+/g, '/')
}

function maxSubmoduleDepth(repos: Array<{ isSubmodule: boolean; depth: number }>): number {
  return repos.reduce((max, repo) => Math.max(max, repo.isSubmodule ? repo.depth : -1), -1)
}

function commitSummaries(commits: Array<{ summary: string }>): string[] {
  return commits.map((commit) => commit.summary)
}

export async function testGitNestedSubmodules(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const rootRepo = normalizePath(rootPath)
  const level1Root = joinPath(rootRepo, 'modules', 'level-1')
  const level2Root = joinPath(level1Root, 'deps', 'level-2')
  const level3Root = joinPath(level2Root, 'deps', 'level-3')
  const level4Root = joinPath(level3Root, 'deps', 'level-4')
  const level5Root = joinPath(level4Root, 'deps', 'level-5')
  const levels = [level1Root, level2Root, level3Root, level4Root, level5Root]
  const platform = window.electronAPI.platform

  log('git-nested-submodules:start', {
    suite: 'GitNestedSubmodules',
    rootRepo,
    platform
  })

  if (!cancelled()) {
    const history = await window.electronAPI.git.getHistory(rootRepo, { limit: 20, skip: 0 })
    const summaries = commitSummaries(history.commits)
    const repos = history.repos ?? []
    const repoRoots = new Set(repos.map((repo) => normalizePath(repo.root)))
    const rootOnlyHistory = history.success &&
      summaries.length > 0 &&
      summaries.every((summary) => summary.startsWith('root:')) &&
      !summaries.some((summary) => summary.startsWith('level-'))
    const fiveLevelsDiscovered = levels.every((levelRoot) => repoRoots.has(normalizePath(levelRoot)))
    const parentChainOk = repos
      .filter((repo) => repo.isSubmodule)
      .every((repo) => {
        if (normalizePath(repo.root) === level1Root) return normalizePath(repo.parentRoot) === rootRepo
        const previousLevel = levels[levels.indexOf(normalizePath(repo.root)) - 1]
        return previousLevel ? normalizePath(repo.parentRoot) === previousLevel : true
      })

    _assert('GNS-01-history-root-is-current-repo-only', rootOnlyHistory, {
      success: history.success,
      summaries,
      rootRepo,
      platform
    })
    _assert('GNS-02-history-discovers-five-level-repo-tree', (
      history.success &&
      repos.length >= 6 &&
      fiveLevelsDiscovered &&
      maxSubmoduleDepth(repos) >= 4 &&
      parentChainOk
    ), {
      repoCount: repos.length,
      maxSubmoduleDepth: maxSubmoduleDepth(repos),
      repoLabels: repos.map((repo) => `${repo.label}@${repo.depth}`).slice(0, 10),
      parentChainOk,
      platform
    })
  }

  if (!cancelled()) {
    const history = await window.electronAPI.git.getHistory(level5Root, { limit: 20, skip: 0 })
    const summaries = commitSummaries(history.commits)
    _assert('GNS-03-history-submodule-scope-changes-commits', (
      history.success &&
      normalizePath(history.cwd) === level5Root &&
      summaries.length > 0 &&
      summaries.every((summary) => summary.startsWith('level-5:')) &&
      !summaries.some((summary) => summary.startsWith('root:'))
    ), {
      cwd: normalizePath(history.cwd),
      expected: level5Root,
      summaries,
      superprojectRoot: normalizePath(history.superprojectRoot),
      platform
    })
  }

  if (!cancelled()) {
    const rootOnly = await window.electronAPI.git.getDiff(rootRepo, { scope: 'root-only' })
    const repos = rootOnly.repos ?? []
    const rootLeakedNestedFiles = rootOnly.files.filter((file) =>
      normalizePath(file.repoRoot) === rootRepo &&
      file.filename.startsWith('modules/level-1/')
    )
    _assert('GNS-04-diff-root-only-keeps-nested-files-out-of-root', (
      rootOnly.success &&
      rootOnly.submodulesLoading === true &&
      repos.filter((repo) => repo.loading).length >= 5 &&
      maxSubmoduleDepth(repos) >= 4 &&
      rootLeakedNestedFiles.length === 0
    ), {
      success: rootOnly.success,
      submodulesLoading: rootOnly.submodulesLoading ?? false,
      repoCount: repos.length,
      loadingCount: repos.filter((repo) => repo.loading).length,
      leakedFiles: rootLeakedNestedFiles,
      fileSample: rootOnly.files.map((file) => `${file.repoLabel}:${file.filename}`).slice(0, 10),
      platform
    })
  }

  if (!cancelled()) {
    const fullDiff = await window.electronAPI.git.getDiff(rootRepo, { scope: 'full' })
    const files = fullDiff.files.map((file) => ({
      ...file,
      repoRoot: normalizePath(file.repoRoot),
      repoLabel: file.repoLabel ?? ''
    }))
    const rootOwnedFiles = files.filter((file) => file.filename === 'root-owned.txt')
    const rootOwnedMisattributed = rootOwnedFiles.filter((file) => file.repoRoot !== rootRepo)
    const level5Files = files.filter((file) => file.filename === 'level-5.txt')
    const level5Misattributed = level5Files.filter((file) => file.repoRoot !== level5Root)
    const untrackedLevel2 = files.filter((file) => file.filename === 'level-2-untracked.txt')

    _assert('GNS-05-diff-full-attributes-files-to-owning-repo', (
      fullDiff.success &&
      rootOwnedFiles.length >= 1 &&
      rootOwnedMisattributed.length === 0 &&
      level5Files.length >= 1 &&
      level5Misattributed.length === 0 &&
      untrackedLevel2.length === 1 &&
      untrackedLevel2[0].repoRoot === level2Root
    ), {
      success: fullDiff.success,
      fileCount: fullDiff.files.length,
      rootOwnedFiles,
      rootOwnedMisattributed,
      level5Files,
      level5Misattributed,
      untrackedLevel2,
      platform
    })
  }

  const getHistoryApi = () => window.__onwardGitHistoryDebug
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    const loaded = await waitFor('GNS-06-history-loaded', () => {
      const api = getHistoryApi()
      return Boolean(api?.isOpen() && !api.isLoading() && api.getCommitCount() > 0)
    }, LOAD_TIMEOUT_MS)
    const api = getHistoryApi()
    const opened = Boolean(api?.isOpen())
    const tree = api?.getVisibleRepoItems?.() ?? []
    const currentItem = tree.find((item) => normalizePath(item.root) === rootRepo)
    _assert('GNS-06-history-ui-defaults-to-current-git-label', (
      opened &&
      loaded &&
      normalizePath(api?.getActiveCwd?.() ?? '') === rootRepo &&
      Boolean(currentItem) &&
      currentItem?.isCurrent === true &&
      !/all repositories/i.test(currentItem?.label ?? '')
    ), {
      opened,
      loaded,
      activeCwd: normalizePath(api?.getActiveCwd?.() ?? ''),
      currentItem,
      tree: tree.slice(0, 8),
      platform
    })
  }

  if (!cancelled()) {
    const api = getHistoryApi()
    api?.switchRepo?.(level5Root)
    const switched = await waitFor('GNS-07-history-switch-level5', () => {
      const nextApi = getHistoryApi()
      const summaries = nextApi?.getCommits?.().map((commit) => commit.summary) ?? []
      return Boolean(
        nextApi?.isOpen() &&
        !nextApi.isLoading() &&
        normalizePath(nextApi.getActiveCwd?.() ?? '') === level5Root &&
        summaries.length > 0 &&
        summaries.every((summary) => summary.startsWith('level-5:'))
      )
    }, LOAD_TIMEOUT_MS)
    const summaries = getHistoryApi()?.getCommits?.().map((commit) => commit.summary) ?? []
    _assert('GNS-07-history-ui-switches-to-selected-submodule', switched, {
      switched,
      activeCwd: normalizePath(getHistoryApi()?.getActiveCwd?.() ?? ''),
      expected: level5Root,
      summaries,
      platform
    })
  }

  if (!cancelled()) {
    const api = getHistoryApi()
    api?.switchRepo?.(null)
    await sleep(50)
    const parentHintVisibleDuringSwitch = Boolean(document.querySelector('.git-history-superproject-hint'))
    const warningVisibleDuringSwitch = Boolean(document.querySelector('.git-history-warning'))
    const switched = await waitFor('GNS-08-history-switch-current-git', () => {
      const nextApi = getHistoryApi()
      const summaries = nextApi?.getCommits?.().map((commit) => commit.summary) ?? []
      return Boolean(
        nextApi?.isOpen() &&
        !nextApi.isLoading() &&
        normalizePath(nextApi.getActiveCwd?.() ?? '') === rootRepo &&
        summaries.length > 0 &&
        summaries.every((summary) => summary.startsWith('root:'))
      )
    }, LOAD_TIMEOUT_MS)
    _assert('GNS-08-history-current-git-switch-has-no-parent-hint-flash', (
      switched &&
      !parentHintVisibleDuringSwitch &&
      !warningVisibleDuringSwitch
    ), {
      switched,
      parentHintVisibleDuringSwitch,
      warningVisibleDuringSwitch,
      activeCwd: normalizePath(getHistoryApi()?.getActiveCwd?.() ?? ''),
      platform
    })
  }

  if (!cancelled()) {
    const before = getHistoryApi()?.getVisibleRepoItems?.() ?? []
    getHistoryApi()?.setRepoExpanded?.(level2Root, false)
    await sleep(200)
    const collapsed = getHistoryApi()?.getVisibleRepoItems?.() ?? []
    getHistoryApi()?.setRepoExpanded?.(level2Root, true)
    await sleep(200)
    const expanded = getHistoryApi()?.getVisibleRepoItems?.() ?? []
    _assert('GNS-08-history-repo-tree-expand-collapse', (
      before.length >= 6 &&
      collapsed.length < before.length &&
      expanded.length >= before.length
    ), {
      beforeCount: before.length,
      collapsedCount: collapsed.length,
      expandedCount: expanded.length,
      platform
    })
  }

  const getDiffApi = () => window.__onwardGitDiffDebug
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const opened = await waitFor('GNS-09-diff-open', () => Boolean(getDiffApi()?.isOpen()), QUICK_TIMEOUT_MS)
    const loaded = await waitFor('GNS-09-diff-loaded', () => {
      const api = getDiffApi()
      return Boolean(api?.isOpen() && !api.isSubmodulesLoading() && api.getFileList().length > 0)
    }, LOAD_TIMEOUT_MS)
    const api = getDiffApi()
    const tree = api?.getVisibleRepoItems?.() ?? []
    _assert('GNS-09-diff-ui-shows-five-level-repo-tree', (
      opened &&
      loaded &&
      tree.length >= 6 &&
      tree.some((item) => normalizePath(item.root) === level5Root && item.treeDepth >= 5)
    ), {
      opened,
      loaded,
      tree: tree.slice(0, 10),
      platform
    })
  }

  if (!cancelled()) {
    const clicked = (() => {
      const item = Array.from(document.querySelectorAll('.git-diff-repo-filter-item'))
        .find((element) => (element as HTMLElement).title === level5Root) as HTMLElement | undefined
      if (!item) return false
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return true
    })()
    const filtered = await waitFor('GNS-10-diff-filter-level5', () => {
      const items = Array.from(document.querySelectorAll('.git-diff-file-item'))
      if (items.length === 0) return false
      return items.every((item) => {
        const badge = item.querySelector('.git-diff-repo-badge') as HTMLElement | null
        return normalizePath(badge?.title) === level5Root
      })
    }, QUICK_TIMEOUT_MS)
    const visibleFiles = Array.from(document.querySelectorAll('.git-diff-file-item')).map((item) => {
      const badge = item.querySelector('.git-diff-repo-badge') as HTMLElement | null
      const fileName = item.querySelector('.git-diff-file-name') as HTMLElement | null
      return {
        filename: fileName?.textContent?.trim() ?? '',
        repoRoot: normalizePath(badge?.title)
      }
    })
    const allLevel5 = visibleFiles.length > 0 && visibleFiles.every((file) => file.repoRoot === level5Root)
    _assert('GNS-10-diff-ui-repo-filter-isolates-selected-submodule', clicked && filtered && allLevel5, {
      clicked,
      filtered,
      visibleFiles,
      expectedRepoRoot: level5Root,
      platform
    })
    getDiffApi()?.setRepoFilter?.(null)
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    const closed = await waitFor('GNS-10-diff-close', () => !getDiffApi()?.isOpen(), 4000)
    _assert('GNS-11-diff-close', closed, { closed, platform })
  }

  log('git-nested-submodules:done', {
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    total: results.length
  })

  return results
}
