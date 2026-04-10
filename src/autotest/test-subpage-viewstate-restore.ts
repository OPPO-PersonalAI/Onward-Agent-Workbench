/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test: editor cursor/scroll position must survive Editor↔Diff↔History round trips.
 *
 * The user pins a file, scrolls to a deep line, switches to Diff/History,
 * switches back — the cursor and scroll position should be restored.
 */

import type { AutotestContext, TestResult } from './types'

// ── helpers (copied from test-subpage-navigation) ──────────────

function isVisibleElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.closest('[aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function getSubpageButton(target: 'diff' | 'editor' | 'history'): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-subpage-button="${target}"]`))
  return buttons.find((button) => isVisibleElement(button)) ?? null
}

function clickSubpageButton(target: 'diff' | 'editor' | 'history'): boolean {
  const button = getSubpageButton(target)
  if (!button || button.disabled) return false
  button.click()
  return true
}

function getProjectEditorApi() {
  return window.__onwardProjectEditorDebug
}

function getGitDiffApi() {
  return window.__onwardGitDiffDebug
}

function getGitHistoryApi() {
  return window.__onwardGitHistoryDebug
}

function buildLongTextContent(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `Line ${i + 1}: content for automated view-state restore test`).join('\n')
}

// ── main test ──────────────────────────────────────────────────

export async function testSubpageViewstateRestore(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = () => getProjectEditorApi()
  const CURSOR_TARGET_LINE = 60
  const SCROLL_TOLERANCE = 15 // lines

  const runId = Date.now()
  const testFile = `onward-autotest-viewstate-${runId}.txt`
  const fileContent = buildLongTextContent(200)

  log('SVR:setup', { testFile, rootPath })

  // ── Phase 0: create fixture file ────────────────────────────

  const created = await window.electronAPI.project.createFile(rootPath, testFile, fileContent)
  record('SVR-00-fixture-created', created.success, { error: created.error ?? null })
  if (!created.success) return results

  try {
    // ── Phase 1: open file, set cursor, verify initial state ──

    await api()?.openFileByPathAsUser?.(testFile, { trackRecent: true })
    const fileOpened = await waitFor('svr-file-open', () => api()?.getActiveFilePath?.() === testFile, 8000)
    record('SVR-01-file-opened', fileOpened, { actual: api()?.getActiveFilePath?.() ?? null })
    if (!fileOpened || cancelled()) return results

    await sleep(500) // wait for Monaco to be fully loaded

    const cursorSet = api()?.setCursorPosition?.(CURSOR_TARGET_LINE, 1) ?? false
    record('SVR-02-cursor-set', cursorSet, { targetLine: CURSOR_TARGET_LINE })
    if (!cursorSet || cancelled()) return results

    await sleep(300)

    const scrolled = api()?.scrollToLine?.(CURSOR_TARGET_LINE) ?? false
    record('SVR-03-scrolled-to-line', scrolled, { targetLine: CURSOR_TARGET_LINE })
    if (!scrolled || cancelled()) return results

    await sleep(500) // allow debounced state save

    const preCursor = api()?.getCursorPosition?.()
    const preFirstVisible = api()?.getFirstVisibleLine?.() ?? 1
    const preScrollTop = api()?.getScrollTop?.() ?? 0

    record('SVR-04-initial-position-captured', Boolean(preCursor && preCursor.lineNumber === CURSOR_TARGET_LINE), {
      cursorLine: preCursor?.lineNumber ?? null,
      firstVisibleLine: preFirstVisible,
      scrollTop: Math.round(preScrollTop)
    })
    if (!preCursor || cancelled()) return results

    log('SVR:pre-switch-state', {
      cursorLine: preCursor.lineNumber,
      firstVisibleLine: preFirstVisible,
      scrollTop: Math.round(preScrollTop)
    })

    // ── Phase 2: Editor → Diff → Editor round-trip ────────────

    const clickedDiff = clickSubpageButton('diff')
    const diffOpened = clickedDiff && await waitFor('svr-diff-open', () => Boolean(getGitDiffApi()?.isOpen()), 8000)
    record('SVR-05-switched-to-diff', Boolean(diffOpened), { clickedDiff })
    if (!diffOpened || cancelled()) return results

    await sleep(800) // ensure Editor fully closed and state settled

    const clickedEditorFromDiff = clickSubpageButton('editor')
    const editorRestoredFromDiff = clickedEditorFromDiff && await waitFor(
      'svr-editor-restore-from-diff',
      () => api()?.getActiveFilePath?.() === testFile,
      10000
    )
    record('SVR-06-editor-restored-from-diff', Boolean(editorRestoredFromDiff), {
      clickedEditorFromDiff,
      activeFilePath: api()?.getActiveFilePath?.() ?? null
    })
    if (!editorRestoredFromDiff || cancelled()) return results

    // Wait for Monaco to apply view state
    await sleep(1200)

    const postDiffCursor = api()?.getCursorPosition?.()
    const postDiffFirstVisible = api()?.getFirstVisibleLine?.() ?? 1

    record('SVR-07-cursor-restored-after-diff', Boolean(
      postDiffCursor && postDiffCursor.lineNumber === CURSOR_TARGET_LINE
    ), {
      expected: CURSOR_TARGET_LINE,
      actual: postDiffCursor?.lineNumber ?? null,
      column: postDiffCursor?.column ?? null
    })

    record('SVR-08-scroll-restored-after-diff', Math.abs(postDiffFirstVisible - preFirstVisible) <= SCROLL_TOLERANCE, {
      expectedFirstVisible: preFirstVisible,
      actualFirstVisible: postDiffFirstVisible,
      diff: Math.abs(postDiffFirstVisible - preFirstVisible),
      tolerance: SCROLL_TOLERANCE
    })

    log('SVR:post-diff-state', {
      cursorLine: postDiffCursor?.lineNumber ?? null,
      firstVisibleLine: postDiffFirstVisible,
      expectedCursorLine: CURSOR_TARGET_LINE,
      expectedFirstVisible: preFirstVisible
    })

    if (cancelled()) return results

    // ── Phase 3: Editor → History → Editor round-trip ─────────

    // First re-establish a known cursor position
    const cursorReSet = api()?.setCursorPosition?.(CURSOR_TARGET_LINE, 1) ?? false
    const scrollReSet = api()?.scrollToLine?.(CURSOR_TARGET_LINE) ?? false
    await sleep(500)

    const preHistoryCursor = api()?.getCursorPosition?.()
    const preHistoryFirstVisible = api()?.getFirstVisibleLine?.() ?? 1

    record('SVR-09-pre-history-position', Boolean(cursorReSet && scrollReSet && preHistoryCursor?.lineNumber === CURSOR_TARGET_LINE), {
      cursorLine: preHistoryCursor?.lineNumber ?? null,
      firstVisibleLine: preHistoryFirstVisible
    })
    if (cancelled()) return results

    const clickedHistory = clickSubpageButton('history')
    const historyOpened = clickedHistory && await waitFor('svr-history-open', () => Boolean(getGitHistoryApi()?.isOpen()), 8000)
    record('SVR-10-switched-to-history', Boolean(historyOpened), { clickedHistory })
    if (!historyOpened || cancelled()) return results

    await sleep(800)

    const clickedEditorFromHistory = clickSubpageButton('editor')
    const editorRestoredFromHistory = clickedEditorFromHistory && await waitFor(
      'svr-editor-restore-from-history',
      () => api()?.getActiveFilePath?.() === testFile,
      10000
    )
    record('SVR-11-editor-restored-from-history', Boolean(editorRestoredFromHistory), {
      clickedEditorFromHistory,
      activeFilePath: api()?.getActiveFilePath?.() ?? null
    })
    if (!editorRestoredFromHistory || cancelled()) return results

    await sleep(1200)

    const postHistoryCursor = api()?.getCursorPosition?.()
    const postHistoryFirstVisible = api()?.getFirstVisibleLine?.() ?? 1

    record('SVR-12-cursor-restored-after-history', Boolean(
      postHistoryCursor && postHistoryCursor.lineNumber === CURSOR_TARGET_LINE
    ), {
      expected: CURSOR_TARGET_LINE,
      actual: postHistoryCursor?.lineNumber ?? null,
      column: postHistoryCursor?.column ?? null
    })

    record('SVR-13-scroll-restored-after-history', Math.abs(postHistoryFirstVisible - preHistoryFirstVisible) <= SCROLL_TOLERANCE, {
      expectedFirstVisible: preHistoryFirstVisible,
      actualFirstVisible: postHistoryFirstVisible,
      diff: Math.abs(postHistoryFirstVisible - preHistoryFirstVisible),
      tolerance: SCROLL_TOLERANCE
    })

    log('SVR:post-history-state', {
      cursorLine: postHistoryCursor?.lineNumber ?? null,
      firstVisibleLine: postHistoryFirstVisible,
      expectedCursorLine: CURSOR_TARGET_LINE,
      expectedFirstVisible: preHistoryFirstVisible
    })

    // ── Phase 4: Rapid round-trip (Diff → History → Editor) ───

    if (!cancelled()) {
      const cursorReSet2 = api()?.setCursorPosition?.(CURSOR_TARGET_LINE, 1) ?? false
      api()?.scrollToLine?.(CURSOR_TARGET_LINE)
      await sleep(500)

      const rapidDiff = clickSubpageButton('diff')
      const rapidDiffOpen = rapidDiff && await waitFor('svr-rapid-diff', () => Boolean(getGitDiffApi()?.isOpen()), 8000)
      if (!rapidDiffOpen) {
        record('SVR-14-rapid-roundtrip-cursor', false, { reason: 'rapid diff open failed' })
        record('SVR-15-rapid-roundtrip-scroll', false, { reason: 'rapid diff open failed' })
      } else {
        await sleep(400)
        const rapidHistory = clickSubpageButton('history')
        const rapidHistoryOpen = rapidHistory && await waitFor('svr-rapid-history', () => Boolean(getGitHistoryApi()?.isOpen()), 8000)
        if (!rapidHistoryOpen) {
          record('SVR-14-rapid-roundtrip-cursor', false, { reason: 'rapid history open failed' })
          record('SVR-15-rapid-roundtrip-scroll', false, { reason: 'rapid history open failed' })
        } else {
          await sleep(400)
          const rapidEditor = clickSubpageButton('editor')
          const rapidEditorOpen = rapidEditor && await waitFor('svr-rapid-editor', () => api()?.getActiveFilePath?.() === testFile, 10000)

          await sleep(1200)
          const rapidCursor = api()?.getCursorPosition?.()
          const rapidFirstVisible = api()?.getFirstVisibleLine?.() ?? 1

          record('SVR-14-rapid-roundtrip-cursor', Boolean(
            cursorReSet2 && rapidEditorOpen && rapidCursor && rapidCursor.lineNumber === CURSOR_TARGET_LINE
          ), {
            expected: CURSOR_TARGET_LINE,
            actual: rapidCursor?.lineNumber ?? null
          })

          record('SVR-15-rapid-roundtrip-scroll', Boolean(
            rapidEditorOpen && Math.abs(rapidFirstVisible - CURSOR_TARGET_LINE) <= SCROLL_TOLERANCE * 2
          ), {
            firstVisibleLine: rapidFirstVisible,
            targetLine: CURSOR_TARGET_LINE,
            tolerance: SCROLL_TOLERANCE * 2
          })
        }
      }
    }

  } finally {
    // cleanup
    const deleted = await window.electronAPI.project.deletePath(rootPath, testFile)
    log('SVR:cleanup', { testFile, deleted: deleted.success })
  }

  return results
}
