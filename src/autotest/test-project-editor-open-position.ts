/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 0.6: ProjectEditor open file location special test
 */
import type { AutotestContext, TestResult } from './types'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

type SavedProjectState = {
  rootPath: string | null
  activeFilePath: string | null
  expandedDirs: string[]
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  savedAt: number
}

export async function testProjectEditorOpenPosition(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath, openFileInEditor, reopenProjectEditor, isOpenRef } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const dispatchEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
  }

  const tempPathA = `onward-autotest-open-position-a-${Date.now()}.md`
  const tempPathB = `onward-autotest-open-position-b-${Date.now()}.md`
  const contentA = Array.from({ length: 360 }, (_, idx) => `A-line-${idx + 1}`).join('\n')
  const contentB = Array.from({ length: 260 }, (_, idx) => `B-line-${idx + 1}`).join('\n')
  const expectedLineCountA = 360
  const expectedLineCountB = 260
  const targetLineA = 180
  const targetLineB = 120
  const tolerance = 12

  log('phase0.6:start', { suite: 'ProjectEditorOpenPosition', tempPathA, tempPathB })

  const createA = await window.electronAPI.project.createFile(rootPath, tempPathA, contentA)
  if (!createA.success) {
    _assert('POP-00-setup-file-a', false, { error: createA.error })
    return results
  }
  const createB = await window.electronAPI.project.createFile(rootPath, tempPathB, contentB)
  if (!createB.success) {
    await window.electronAPI.project.deletePath(rootPath, tempPathA)
    _assert('POP-00b-setup-file-b', false, { error: createB.error })
    return results
  }

  const normalizedRoot = normalizePath(rootPath)
  const waitForSavedState = async (
    targetFilePath: string,
    expectedCursorLine?: number
  ): Promise<SavedProjectState | null> => {
    const timeoutMs = 10000
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      const appState = await window.electronAPI.appState.load()
      const latestState = Object.values(appState.projectEditorStates ?? {})
        .filter((entry) => normalizePath(entry.rootPath ?? '') === normalizedRoot)
        .sort((a, b) => b.savedAt - a.savedAt)[0] ?? null
      if (latestState?.activeFilePath === targetFilePath && latestState.editorViewState) {
        if (typeof expectedCursorLine === 'number') {
          const currentLine = latestState.cursorLine ?? -1
          if (Math.abs(currentLine - expectedCursorLine) > 1) {
            await sleep(160)
            continue
          }
        }
        return latestState
      }
      await sleep(160)
    }
    return null
  }

  const waitForEditorModelReady = async (targetPath: string, expectedLineCount: number, tag: string) => {
    return await waitFor(
      `model-ready:${tag}`,
      () => (
        getApi()?.getActiveFilePath?.() === targetPath
          && (getApi()?.getEditorLineCount?.() ?? 0) === expectedLineCount
      ),
      8000
    )
  }

  const waitForVisibleLineAround = async (targetLine: number, tag: string) => {
    return await waitFor(
      `visible-line-around:${tag}`,
      () => {
        const line = getApi()?.getFirstVisibleLine?.() ?? -1
        return Math.abs(line - targetLine) <= tolerance
      },
      8000
    )
  }

  try {
    await openFileInEditor(tempPathA)
    const openA = await waitFor(
      'open-file-a',
      () => getApi()?.getActiveFilePath?.() === tempPathA,
      8000
    )
    _assert('POP-01-open-file-a', openA, { expected: tempPathA, actual: getApi()?.getActiveFilePath?.() ?? null })
    if (!openA || cancelled()) return results

    const modelReadyA = await waitForEditorModelReady(tempPathA, expectedLineCountA, 'open-file-a')
    if (!modelReadyA) {
      _assert('POP-02-set-cursor-a', false, {
        reason: 'model-not-ready',
        targetLineA,
        expectedLineCountA,
        lineCount: getApi()?.getEditorLineCount?.() ?? 0,
        activeFilePath: getApi()?.getActiveFilePath?.() ?? null
      })
      return results
    }

    const setCursorA = Boolean(getApi()?.setCursorPosition?.(targetLineA, 1))
    const cursorASettled = setCursorA && await waitFor(
      'cursor-a-after-set',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - targetLineA) <= 1,
      4000
    )
    _assert('POP-02-set-cursor-a', cursorASettled, {
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!cursorASettled || cancelled()) return results

    const scrollA = Boolean(getApi()?.scrollToLine?.(targetLineA))
    _assert('POP-03-scroll-file-a', scrollA, { targetLineA })
    if (!scrollA || cancelled()) return results

    const lineAVisible = await waitForVisibleLineAround(targetLineA, 'a-initial')
    _assert('POP-04-visible-line-a-initial', lineAVisible, {
      targetLineA,
      actual: getApi()?.getFirstVisibleLine?.() ?? null
    })
    if (!lineAVisible || cancelled()) return results

    await sleep(1400)
    const stateA = await waitForSavedState(tempPathA, targetLineA)
    _assert('POP-05-state-a-persisted', Boolean(stateA), {
      activeFilePath: stateA?.activeFilePath ?? null,
      hasViewState: Boolean(stateA?.editorViewState),
      cursorLine: stateA?.cursorLine ?? null
    })
    if (!stateA || cancelled()) return results

    await openFileInEditor(tempPathB)
    const openB = await waitFor(
      'open-file-b',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('POP-06-open-file-b', openB, { expected: tempPathB, actual: getApi()?.getActiveFilePath?.() ?? null })
    if (!openB || cancelled()) return results

    const modelReadyB = await waitForEditorModelReady(tempPathB, expectedLineCountB, 'open-file-b')
    if (!modelReadyB) {
      _assert('POP-07-scroll-file-b', false, {
        reason: 'model-not-ready',
        targetLineB,
        expectedLineCountB,
        lineCount: getApi()?.getEditorLineCount?.() ?? 0,
        activeFilePath: getApi()?.getActiveFilePath?.() ?? null
      })
      return results
    }

    const scrollB = Boolean(getApi()?.scrollToLine?.(targetLineB))
    _assert('POP-07-scroll-file-b', scrollB, { targetLineB })
    if (!scrollB || cancelled()) return results

    const lineBVisible = await waitForVisibleLineAround(targetLineB, 'b-initial')
    _assert('POP-08-visible-line-b-initial', lineBVisible, {
      targetLineB,
      actual: getApi()?.getFirstVisibleLine?.() ?? null
    })
    if (!lineBVisible || cancelled()) return results

    const setCursorB = Boolean(getApi()?.setCursorPosition?.(targetLineB, 1))
    const cursorBSettled = setCursorB && await waitFor(
      'cursor-b-after-set',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - targetLineB) <= 1,
      4000
    )
    _assert('POP-08b-set-cursor-b-for-restore', cursorBSettled, {
      targetLineB,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!cursorBSettled || cancelled()) return results

    await sleep(1400)
    const stateB = await waitForSavedState(tempPathB, targetLineB)
    _assert('POP-09-state-b-persisted', Boolean(stateB), {
      activeFilePath: stateB?.activeFilePath ?? null,
      hasViewState: Boolean(stateB?.editorViewState),
      cursorLine: stateB?.cursorLine ?? null
    })
    if (!stateB || cancelled()) return results

    await openFileInEditor(tempPathA)
    const switchedBackA = await waitFor(
      'switch-back-a',
      () => getApi()?.getActiveFilePath?.() === tempPathA,
      8000
    )
    _assert('POP-10-switch-back-a', switchedBackA, { actual: getApi()?.getActiveFilePath?.() ?? null })
    if (!switchedBackA || cancelled()) return results

    const restoredAOnSwitch = await waitFor(
      'visible-line-around:a-switch-back',
      () => {
        const firstVisibleLine = getApi()?.getFirstVisibleLine?.() ?? -1
        const cursorLine = getApi()?.getCursorPosition?.()?.lineNumber ?? -1
        return Math.abs(firstVisibleLine - targetLineA) <= tolerance || Math.abs(cursorLine - targetLineA) <= 1
      },
      8000
    )
    _assert('POP-11-restore-position-a-on-switch', restoredAOnSwitch, {
      targetLineA,
      actual: getApi()?.getFirstVisibleLine?.() ?? null,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!restoredAOnSwitch || cancelled()) return results

    await openFileInEditor(tempPathB)
    const switchedBackB = await waitFor(
      'switch-back-b',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('POP-12-switch-back-b', switchedBackB, { actual: getApi()?.getActiveFilePath?.() ?? null })
    if (!switchedBackB || cancelled()) return results

    const restoredBOnSwitch = await waitFor(
      'visible-line-around:b-switch-back',
      () => {
        const firstVisibleLine = getApi()?.getFirstVisibleLine?.() ?? -1
        const cursorLine = getApi()?.getCursorPosition?.()?.lineNumber ?? -1
        return Math.abs(firstVisibleLine - targetLineB) <= tolerance || Math.abs(cursorLine - targetLineB) <= 1
      },
      8000
    )
    _assert('POP-13-restore-position-b-on-switch', restoredBOnSwitch, {
      targetLineB,
      actual: getApi()?.getFirstVisibleLine?.() ?? null,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!restoredBOnSwitch || cancelled()) return results

    dispatchEscape()
    const closed = await waitFor('close-project-editor', () => !isOpenRef.current, 8000)
    _assert('POP-14-close-project-editor', closed, { closed })
    if (!closed || cancelled()) return results

    const reopened = await reopenProjectEditor('open-position-reopen')
    _assert('POP-15-reopen-project-editor', reopened, { reopened })
    if (!reopened || cancelled()) return results

    const restoredLastFile = await waitFor(
      'restore-last-file-b',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('POP-16-restore-last-file', restoredLastFile, {
      expected: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!restoredLastFile || cancelled()) return results

    const restoredLineAfterReopen = await waitFor(
      'visible-line-around:b-after-reopen',
      () => {
        const firstVisibleLine = getApi()?.getFirstVisibleLine?.() ?? -1
        const cursorLine = getApi()?.getCursorPosition?.()?.lineNumber ?? -1
        return Math.abs(firstVisibleLine - targetLineB) <= tolerance || Math.abs(cursorLine - targetLineB) <= 1
      },
      8000
    )
    _assert('POP-17-restore-position-after-reopen', restoredLineAfterReopen, {
      targetLineB,
      actual: getApi()?.getFirstVisibleLine?.() ?? null,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
  } finally {
    const cleanupA = await window.electronAPI.project.deletePath(rootPath, tempPathA)
    const cleanupB = await window.electronAPI.project.deletePath(rootPath, tempPathB)
    log('phase0.6:cleanup', {
      tempPathA,
      tempPathB,
      okA: cleanupA.success,
      okB: cleanupB.success,
      errA: cleanupA.error,
      errB: cleanupB.error
    })
  }

  return results
}
