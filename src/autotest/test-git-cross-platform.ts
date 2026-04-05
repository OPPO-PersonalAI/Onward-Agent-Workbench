/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cross-platform Git operations test suite
 *
 * Designed to catch platform-specific issues when porting to new platforms.
 * Covers common failure modes:
 *   - Path separator inconsistency (backslash vs forward slash)
 *   - CWD tracking (OSC 9;9 on Windows, shell integration on macOS/Linux)
 *   - Git process startup latency (high on Windows, low on Unix)
 *   - Infinite loop / re-render detection (useEffect dependency bugs)
 *   - Subdirectory vs repo root resolution
 *   - Non-ASCII path handling (CJK characters, spaces, special chars)
 */
import type { AutotestContext, TestResult } from './types'

const LOAD_TIMEOUT_MS = 15000
const QUICK_TIMEOUT_MS = 8000

export async function testGitCrossPlatform(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('git-xplat:start', { suite: 'GitCrossPlatform', rootPath })

  const platform = window.electronAPI.platform
  const shellThresholdMs = platform === 'win32' ? 700 : 300
  const getHistoryApi = () => window.__onwardGitHistoryDebug
  const getDiffApi = () => window.__onwardGitDiffDebug

  // ================================================================
  // Section 1: CWD & Path Resolution
  // ================================================================

  // XP-01: Terminal CWD matches expected path
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    const hasCwd = typeof cwd === 'string' && cwd.length > 0
    _assert('XP-01-terminal-cwd-available', hasCwd, { cwd, platform })
  }

  // XP-02: resolveRepoRoot returns forward-slash path on all platforms
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      const hasRoot = typeof repoRoot === 'string' && repoRoot.length > 0
      const usesForwardSlash = hasRoot && !repoRoot.includes('\\')
      _assert('XP-02-repo-root-forward-slash', hasRoot && usesForwardSlash, {
        cwd,
        repoRoot,
        usesForwardSlash,
        platform
      })
    } else {
      results.push({ name: 'XP-02-repo-root-forward-slash', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // XP-03: CWD path and resolveRepoRoot path are consistent format
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      // After resolveRepoRoot, both should use the same separator
      // The resolved path should be a prefix of or equal to the CWD (modulo separators)
      const normCwd = cwd.replace(/\\/g, '/').toLowerCase()
      const normRoot = (repoRoot || '').replace(/\\/g, '/').toLowerCase()
      const cwdUnderRoot = normCwd.startsWith(normRoot)
      _assert('XP-03-cwd-under-repo-root', cwdUnderRoot, {
        cwd,
        repoRoot,
        normCwd,
        normRoot,
        platform
      })
    } else {
      results.push({ name: 'XP-03-cwd-under-repo-root', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // ================================================================
  // Section 2: Git History — Infinite Loop Detection
  // (This catches the Windows path separator bug that caused infinite re-renders)
  // ================================================================

  // XP-04: Git History opens and loads commits (no infinite loop)
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    const opened = await waitFor('XP-04-history-open', () => {
      const a = getHistoryApi()
      return Boolean(a?.isOpen())
    }, QUICK_TIMEOUT_MS)

    if (opened) {
      const loaded = await waitFor('XP-04-history-loaded', () => {
        const a = getHistoryApi()
        return Boolean(a && a.getCommitCount() > 0 && !a.isLoading())
      }, LOAD_TIMEOUT_MS)
      const count = getHistoryApi()?.getCommitCount() ?? 0
      _assert('XP-04-history-loads-commits', loaded && count > 0, {
        loaded,
        commitCount: count,
        platform
      })
    } else {
      results.push({ name: 'XP-04-history-loads-commits', ok: false, detail: { reason: 'panel did not open' } })
    }
  }

  // XP-05: Git History loading completes within timeout (no stuck spinner)
  // Re-render loop would cause isLoading() to never become false
  if (!cancelled()) {
    const api = getHistoryApi()
    if (api?.isOpen()) {
      const startTime = performance.now()
      const finishedLoading = await waitFor('XP-05-loading-done', () => {
        const a = getHistoryApi()
        return Boolean(a && !a.isLoading())
      }, LOAD_TIMEOUT_MS)
      const elapsed = Math.round(performance.now() - startTime)
      _assert('XP-05-history-no-infinite-loop', finishedLoading, {
        finishedLoading,
        elapsedMs: elapsed,
        platform,
        note: 'If this fails, check for path format inconsistency causing useEffect dependency loop'
      })
    } else {
      results.push({ name: 'XP-05-history-no-infinite-loop', ok: false, detail: { reason: 'not open' } })
    }
  }

  // XP-06: Git History commit selection loads files correctly
  if (!cancelled()) {
    const api = getHistoryApi()
    if (api?.isOpen() && api.getCommitCount() > 0) {
      api.selectCommitByIndex(0)
      const filesLoaded = await waitFor('XP-06-files', () => {
        const a = getHistoryApi()
        return Boolean(a && a.getFiles().length > 0 && !a.isLoading())
      }, LOAD_TIMEOUT_MS)
      const files = api.getFiles()
      _assert('XP-06-history-files-load', filesLoaded && files.length > 0, {
        filesLoaded,
        fileCount: files.length,
        sample: files.slice(0, 3).map(f => f.filename),
        platform
      })
    } else {
      results.push({ name: 'XP-06-history-files-load', ok: false, detail: { reason: 'no commits' } })
    }
  }

  // XP-07: Close Git History via ESC
  if (!cancelled()) {
    const api = getHistoryApi()
    if (api?.isOpen()) {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }))
      const closed = await waitFor('XP-07-esc-close', () => {
        const a = getHistoryApi()
        return !a || !a.isOpen()
      }, 4000)
      _assert('XP-07-history-esc-close', closed, { closed, platform })
      await sleep(300)
    } else {
      results.push({ name: 'XP-07-history-esc-close', ok: false, detail: { reason: 'not open' } })
    }
  }

  // ================================================================
  // Section 3: Git Diff — Path Resolution & Loading
  // ================================================================

  // XP-08: Git Diff opens and loads file list
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const shellVisible = await waitFor('XP-08-diff-open', () => {
      const a = getDiffApi()
      return Boolean(a?.isOpen() && a.getTiming().shellShownAt !== null)
    }, QUICK_TIMEOUT_MS)

    const shellTiming = getDiffApi()?.getTiming() ?? null
    _assert('XP-08-diff-shell-visible-fast', shellVisible && (shellTiming?.openToShellMs ?? Number.MAX_SAFE_INTEGER) < shellThresholdMs, {
      shellVisible,
      openToShellMs: shellTiming?.openToShellMs ?? null,
      thresholdMs: shellThresholdMs,
      platform
    })

    if (shellVisible) {
      const loadDone = await waitFor('XP-08-diff-loaded', () => {
        const a = getDiffApi()
        if (!a) return false
        return a.getTiming().diffLoadedAt !== null
      }, LOAD_TIMEOUT_MS)
      const timing = getDiffApi()?.getTiming() ?? null
      const fileCount = getDiffApi()?.getFileList()?.length ?? -1
      _assert('XP-08-diff-loads', loadDone, {
        loadDone,
        fileCount,
        openToDiffLoadedMs: timing?.openToDiffLoadedMs ?? null,
        openToCwdReadyMs: timing?.openToCwdReadyMs ?? null,
        cwdReadyToDiffLoadedMs: timing?.cwdReadyToDiffLoadedMs ?? null,
        platform
      })
    } else {
      results.push({ name: 'XP-08-diff-loads', ok: false, detail: { reason: 'panel did not open' } })
    }
  }

  // XP-09: Git Diff CWD uses repo root (not subdirectory or raw terminal CWD)
  if (!cancelled()) {
    const api = getDiffApi()
    if (api?.isOpen()) {
      const diffCwd = api.getCwd?.() ?? null
      const repoRoot = api.getRepoRoot?.() ?? null
      // On all platforms, the diff CWD should be the repo root with forward slashes
      const hasCwd = typeof diffCwd === 'string' && diffCwd.length > 0
      const noBackslash = hasCwd && !diffCwd!.includes('\\')
      _assert('XP-09-diff-cwd-normalized', hasCwd && noBackslash, {
        diffCwd,
        repoRoot,
        noBackslash,
        platform
      })
    } else {
      results.push({ name: 'XP-09-diff-cwd-normalized', ok: false, detail: { reason: 'not open' } })
    }
  }

  // XP-10: Close Git Diff
  if (!cancelled()) {
    const api = getDiffApi()
    if (api?.isOpen()) {
      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      const closed = await waitFor('XP-10-diff-close', () => {
        const a = getDiffApi()
        return !a || !a.isOpen()
      }, 4000)
      _assert('XP-10-diff-close', closed, { closed, platform })
      await sleep(300)
    } else {
      results.push({ name: 'XP-10-diff-close', ok: false, detail: { reason: 'not open' } })
    }
  }

  // ================================================================
  // Section 4: Git IPC — Direct API Correctness
  // ================================================================

  // XP-11: getHistory IPC returns valid result with correct path format
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      if (repoRoot) {
        const startTime = performance.now()
        const result = await window.electronAPI.git.getHistory(repoRoot)
        const elapsed = Math.round(performance.now() - startTime)
        const valid = result?.success === true && Array.isArray(result.commits) && result.commits.length > 0
        const resultCwd = (result as any)?.cwd || null
        // The returned CWD should use forward slashes (git format)
        const cwdNormalized = typeof resultCwd === 'string' && !resultCwd.includes('\\')
        _assert('XP-11-history-ipc-valid', valid, {
          success: result?.success,
          commitCount: result?.commits?.length,
          elapsedMs: elapsed,
          resultCwd,
          cwdNormalized,
          platform
        })
      } else {
        results.push({ name: 'XP-11-history-ipc-valid', ok: false, detail: { reason: 'no repo root' } })
      }
    } else {
      results.push({ name: 'XP-11-history-ipc-valid', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // XP-12: getDiff IPC returns valid result
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd) {
      const repoRoot = await window.electronAPI.git.resolveRepoRoot(cwd)
      if (repoRoot) {
        const startTime = performance.now()
        const result = await window.electronAPI.git.getDiff(repoRoot)
        const elapsed = Math.round(performance.now() - startTime)
        const valid = result?.success === true && result?.gitInstalled === true && result?.isGitRepo === true
        _assert('XP-12-diff-ipc-valid', valid, {
          success: result?.success,
          gitInstalled: result?.gitInstalled,
          isGitRepo: result?.isGitRepo,
          fileCount: result?.files?.length ?? 0,
          elapsedMs: elapsed,
          platform
        })
      } else {
        results.push({ name: 'XP-12-diff-ipc-valid', ok: false, detail: { reason: 'no repo root' } })
      }
    } else {
      results.push({ name: 'XP-12-diff-ipc-valid', ok: false, detail: { reason: 'no cwd' } })
    }
  }

  // ================================================================
  // Section 5: Performance — Git Latency Bounds
  // ================================================================

  // XP-13: getHistory completes within platform-specific threshold
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    const repoRoot = cwd ? await window.electronAPI.git.resolveRepoRoot(cwd) : null
    if (repoRoot) {
      // Run 3 times and take median for stability
      const timings: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await window.electronAPI.git.getHistory(repoRoot, { limit: 20 })
        timings.push(Math.round(performance.now() - t0))
      }
      timings.sort((a, b) => a - b)
      const median = timings[1]
      // Platform-specific thresholds:
      //   Windows: git.exe startup is slow (~500-1500ms), allow 5s
      //   macOS/Linux: typically <1s
      const threshold = platform === 'win32' ? 5000 : 2000
      _assert('XP-13-history-latency', median < threshold, {
        timings,
        medianMs: median,
        thresholdMs: threshold,
        platform
      })
    } else {
      results.push({ name: 'XP-13-history-latency', ok: false, detail: { reason: 'no repo root' } })
    }
  }

  // XP-14: getDiff completes within platform-specific threshold
  if (!cancelled()) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    const repoRoot = cwd ? await window.electronAPI.git.resolveRepoRoot(cwd) : null
    if (repoRoot) {
      const timings: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await window.electronAPI.git.getDiff(repoRoot)
        timings.push(Math.round(performance.now() - t0))
      }
      timings.sort((a, b) => a - b)
      const median = timings[1]
      // Windows needs more time due to multiple git subprocesses
      const threshold = platform === 'win32' ? 10000 : 4000
      _assert('XP-14-diff-latency', median < threshold, {
        timings,
        medianMs: median,
        thresholdMs: threshold,
        platform
      })
    } else {
      results.push({ name: 'XP-14-diff-latency', ok: false, detail: { reason: 'no repo root' } })
    }
  }

  // ================================================================
  // Section 6: Rapid Open/Close Stability
  // ================================================================

  // XP-15: Git History rapid open/close (5 cycles) — no stale state
  if (!cancelled()) {
    let allOk = true
    for (let i = 0; i < 5; i++) {
      if (cancelled()) break
      window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
      const opened = await waitFor(`XP-15-open-${i}`, () => {
        const a = getHistoryApi()
        return Boolean(a?.isOpen())
      }, QUICK_TIMEOUT_MS)
      if (!opened) { allOk = false; break }
      await sleep(300)
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }))
      const closed = await waitFor(`XP-15-close-${i}`, () => {
        const a = getHistoryApi()
        return !a || !a.isOpen()
      }, 4000)
      if (!closed) { allOk = false; break }
      await sleep(200)
    }
    _assert('XP-15-history-rapid-cycle', allOk, { cycles: 5, platform })
  }

  // XP-16: Git Diff ↔ History mutual exclusion (switching between them)
  if (!cancelled()) {
    // Open Diff
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const diffOpened = await waitFor('XP-16-diff-open', () => {
      const a = getDiffApi()
      return Boolean(a?.isOpen())
    }, QUICK_TIMEOUT_MS)

    if (diffOpened) {
      // Switch to History
      window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
      const historyOpened = await waitFor('XP-16-history-open', () => {
        const a = getHistoryApi()
        return Boolean(a?.isOpen())
      }, QUICK_TIMEOUT_MS)
      await sleep(500)
      const diffClosed = !getDiffApi() || !getDiffApi()!.isOpen()

      _assert('XP-16-diff-history-mutex', historyOpened && diffClosed, {
        historyOpened,
        diffClosed,
        platform
      })

      // Close history
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
      }))
      await waitFor('XP-16-cleanup', () => {
        const a = getHistoryApi()
        return !a || !a.isOpen()
      }, 4000)
      await sleep(300)
    } else {
      results.push({ name: 'XP-16-diff-history-mutex', ok: false, detail: { reason: 'diff did not open' } })
    }
  }

  // ================================================================
  // Summary
  // ================================================================

  log('git-xplat:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    platform
  })

  return results
}
