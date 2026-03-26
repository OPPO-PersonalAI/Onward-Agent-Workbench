/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 0.5: ProjectEditor last file + cursor recovery test
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

export async function testProjectEditorRestore(ctx: AutotestContext): Promise<TestResult[]> {
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

  const tempPath = `onward-autotest-project-editor-restore-${Date.now()}.md`
  const tempPath2 = `onward-autotest-project-editor-restore-switch-${Date.now()}.md`
  const tempPath3 = `onward-autotest-project-editor-restore-insert-${Date.now()}.md`
  const content = Array.from({ length: 120 }, (_, idx) => `line-${idx + 1}`).join('\n')
  const content2 = Array.from({ length: 60 }, (_, idx) => `switch-line-${idx + 1}`).join('\n')
  const content3 = Array.from({ length: 90 }, (_, idx) => `insert-base-line-${idx + 1}`).join('\n')
  const expectedLineCount1 = 120
  const expectedLineCount2 = 60
  const expectedLineCount3 = 90

  log('phase0.5:start', { suite: 'ProjectEditorRestore', tempPath, tempPath2, tempPath3 })

  const createResult = await window.electronAPI.project.createFile(rootPath, tempPath, content)
  if (!createResult.success) {
    _assert('PE-00-setup', false, { reason: 'create-temp-file-failed', error: createResult.error, tempPath })
    return results
  }
  const createResult2 = await window.electronAPI.project.createFile(rootPath, tempPath2, content2)
  if (!createResult2.success) {
    await window.electronAPI.project.deletePath(rootPath, tempPath)
    _assert('PE-00b-setup-switch-file', false, { reason: 'create-temp-file2-failed', error: createResult2.error, tempPath2 })
    return results
  }

  const normalizedRoot = normalizePath(rootPath)
  const waitForSavedState = async (targetFilePath: string): Promise<{ latestState: SavedProjectState | null; savedCount: number }> => {
    const timeoutMs = 8000
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      const appState = await window.electronAPI.appState.load()
      const candidates = Object.values(appState.projectEditorStates ?? {})
        .filter((entry) => normalizePath(entry.rootPath ?? '') === normalizedRoot)
        .sort((a, b) => b.savedAt - a.savedAt)
      const latestState = candidates[0] ?? null
      if (latestState?.activeFilePath === targetFilePath && latestState.editorViewState) {
        return { latestState, savedCount: candidates.length }
      }
      await sleep(160)
    }
    return { latestState: null, savedCount: 0 }
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

  try {
    await openFileInEditor(tempPath)
    const openReady = await waitFor(
      'project-editor-open-temp-file',
      () => {
        const api = getApi()
        return Boolean(api?.getActiveFilePath && api.getActiveFilePath() === tempPath)
      },
      8000
    )
    _assert('PE-01-open-temp-file', openReady, { tempPath })
    if (!openReady || cancelled()) return results

    const api = getApi()
    const targetLine = 37
    const modelReady = await waitForEditorModelReady(tempPath, expectedLineCount1, 'initial')
    if (!modelReady) {
      _assert('PE-02-set-cursor', false, {
        targetLine,
        reason: 'model-not-ready',
        expectedLineCount1,
        lineCount: getApi()?.getEditorLineCount?.() ?? 0,
        activeFilePath: getApi()?.getActiveFilePath?.() ?? null
      })
      return results
    }

    const setCursorOk = Boolean(api?.setCursorPosition(targetLine, 1))
    const cursorSettled = setCursorOk && await waitFor(
      'project-editor-cursor-initial',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - targetLine) <= 1,
      4000
    )
    _assert('PE-02-set-cursor', cursorSettled, {
      targetLine,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!cursorSettled || cancelled()) return results

    const { latestState, savedCount } = await waitForSavedState(tempPath)
    const latest = latestState
    _assert('PE-03-state-persisted', Boolean(latest), {
      rootPath: normalizedRoot,
      savedCount
    })
    _assert('PE-04-state-active-file', latest?.activeFilePath === tempPath, {
      expected: tempPath,
      actual: latest?.activeFilePath ?? null
    })
    _assert('PE-05-state-has-view-state', Boolean(latest?.editorViewState), {
      hasViewState: Boolean(latest?.editorViewState)
    })
    if (cancelled()) return results

    dispatchEscape()
    const closed = await waitFor('project-editor-close', () => !isOpenRef.current, 8000)
    _assert('PE-06-close-project-editor', closed, { closed })
    if (!closed || cancelled()) return results

    const reopened = await reopenProjectEditor('project-editor-restore')
    _assert('PE-07-reopen-project-editor', reopened, { reopened })
    if (!reopened || cancelled()) return results

    const restoredFile = await waitFor(
      'project-editor-restore-file',
      () => {
        const currentApi = getApi()
        return Boolean(currentApi?.getActiveFilePath && currentApi.getActiveFilePath() === tempPath)
      },
      8000
    )
    _assert('PE-08-restore-file', restoredFile, { expected: tempPath })
    if (!restoredFile || cancelled()) return results

    await sleep(600)
    const restoredCursor = getApi()?.getCursorPosition()
    const restoredLine = restoredCursor?.lineNumber ?? -1
    const cursorOk = Math.abs(restoredLine - targetLine) <= 1
    _assert('PE-09-restore-cursor', cursorOk, {
      expectedLine: targetLine,
      actualLine: restoredLine,
      restoredCursor
    })

    await openFileInEditor(tempPath2)
    const switchedFile = await waitFor(
      'project-editor-switch-file',
      () => {
        const currentApi = getApi()
        return Boolean(currentApi?.getActiveFilePath && currentApi.getActiveFilePath() === tempPath2)
      },
      8000
    )
    _assert('PE-10-switch-file', switchedFile, { expected: tempPath2 })
    if (!switchedFile || cancelled()) return results

    await sleep(1200)
    const keptSwitchedFile = getApi()?.getActiveFilePath() === tempPath2
    _assert('PE-11-switch-file-not-overridden', keptSwitchedFile, {
      expected: tempPath2,
      actual: getApi()?.getActiveFilePath() ?? null
    })
    if (!keptSwitchedFile || cancelled()) return results

    const targetLine2 = 28
    const modelReadySecond = await waitForEditorModelReady(tempPath2, expectedLineCount2, 'second')
    if (!modelReadySecond) {
      _assert('PE-12-set-cursor-second-file', false, {
        targetLine2,
        reason: 'model-not-ready',
        expectedLineCount2,
        lineCount: getApi()?.getEditorLineCount?.() ?? 0,
        activeFilePath: getApi()?.getActiveFilePath?.() ?? null
      })
      return results
    }

    const setCursorOk2 = Boolean(getApi()?.setCursorPosition(targetLine2, 1))
    const cursorSettled2 = setCursorOk2 && await waitFor(
      'project-editor-cursor-second',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - targetLine2) <= 1,
      4000
    )
    _assert('PE-12-set-cursor-second-file', cursorSettled2, {
      targetLine2,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!cursorSettled2 || cancelled()) return results

    const secondSaved = await waitForSavedState(tempPath2)
    _assert('PE-13-state-second-file-persisted', Boolean(secondSaved.latestState), {
      activeFilePath: secondSaved.latestState?.activeFilePath ?? null,
      cursorLine: secondSaved.latestState?.cursorLine ?? null
    })
    if (!secondSaved.latestState || cancelled()) return results

    dispatchEscape()
    const closedForChange = await waitFor('project-editor-close-for-change', () => !isOpenRef.current, 8000)
    _assert('PE-14-close-before-content-change', closedForChange, { closedForChange })
    if (!closedForChange || cancelled()) return results

    const changedContent = Array.from({ length: 8 }, (_, idx) => `updated-line-${idx + 1}`).join('\n')
    const saveChangedResult = await window.electronAPI.project.saveFile(rootPath, tempPath2, changedContent)
    _assert('PE-15-update-file-content', saveChangedResult.success, { error: saveChangedResult.error })
    if (!saveChangedResult.success || cancelled()) return results

    const reopenedAfterChange = await reopenProjectEditor('project-editor-restore-after-change')
    _assert('PE-16-reopen-after-change', reopenedAfterChange, { reopenedAfterChange })
    if (!reopenedAfterChange || cancelled()) return results

    const restoredChangedFile = await waitFor(
      'project-editor-restore-changed-file',
      () => {
        const currentApi = getApi()
        return Boolean(currentApi?.getActiveFilePath && currentApi.getActiveFilePath() === tempPath2)
      },
      8000
    )
    _assert('PE-17-restore-changed-file', restoredChangedFile, {
      expected: tempPath2
    })
    if (!restoredChangedFile || cancelled()) return results

    await sleep(700)
    const cursorAfterChange = getApi()?.getCursorPosition()
    const lineAfterChange = cursorAfterChange?.lineNumber ?? -1
    const cursorClamped = lineAfterChange >= 1 && lineAfterChange <= 8
    _assert('PE-18-restore-cursor-after-content-change', cursorClamped, {
      expectedRange: '1~8',
      actualLine: lineAfterChange,
      cursorAfterChange
    })
    if (!cursorClamped || cancelled()) return results

    dispatchEscape()
    const closedForMissing = await waitFor('project-editor-close-for-missing', () => !isOpenRef.current, 8000)
    _assert('PE-19-close-before-delete', closedForMissing, { closedForMissing })
    if (!closedForMissing || cancelled()) return results

    const deleteSecondResult = await window.electronAPI.project.deletePath(rootPath, tempPath2)
    _assert('PE-20-delete-last-opened-file', deleteSecondResult.success, { error: deleteSecondResult.error })
    if (!deleteSecondResult.success || cancelled()) return results

    const reopenedAfterDelete = await reopenProjectEditor('project-editor-restore-after-delete')
    _assert('PE-21-reopen-after-delete', reopenedAfterDelete, { reopenedAfterDelete })
    if (!reopenedAfterDelete || cancelled()) return results

    const missingNoticeAppeared = await waitFor(
      'project-editor-missing-notice',
      () => {
        const notice = getApi()?.getMissingFileNotice()
        return Boolean(notice && notice.message.includes('The previously opened file was deleted'))
      },
      8000
    )
    const missingNotice = getApi()?.getMissingFileNotice() ?? null
    _assert('PE-22-missing-file-notice', missingNoticeAppeared, { missingNotice })
    if (!missingNoticeAppeared || cancelled()) return results

    const createInsertResult = await window.electronAPI.project.createFile(rootPath, tempPath3, content3)
    _assert('PE-23-create-insert-file', createInsertResult.success, {
      tempPath3,
      error: createInsertResult.error
    })
    if (!createInsertResult.success || cancelled()) return results

    await openFileInEditor(tempPath3)
    const openedInsertFile = await waitFor(
      'project-editor-open-insert-file',
      () => {
        const currentApi = getApi()
        return Boolean(currentApi?.getActiveFilePath && currentApi.getActiveFilePath() === tempPath3)
      },
      8000
    )
    _assert('PE-24-open-insert-file', openedInsertFile, {
      expected: tempPath3,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openedInsertFile || cancelled()) return results

    const targetLine3 = 33
    const modelReadyInsert = await waitForEditorModelReady(tempPath3, expectedLineCount3, 'insert')
    if (!modelReadyInsert) {
      _assert('PE-25-set-cursor-insert-file', false, {
        targetLine3,
        reason: 'model-not-ready',
        expectedLineCount3,
        lineCount: getApi()?.getEditorLineCount?.() ?? 0,
        activeFilePath: getApi()?.getActiveFilePath?.() ?? null
      })
      return results
    }

    const setCursorOk3 = Boolean(getApi()?.setCursorPosition(targetLine3, 1))
    const cursorSettled3 = setCursorOk3 && await waitFor(
      'project-editor-cursor-insert',
      () => Math.abs((getApi()?.getCursorPosition?.()?.lineNumber ?? -1) - targetLine3) <= 1,
      4000
    )
    _assert('PE-25-set-cursor-insert-file', cursorSettled3, {
      targetLine3,
      cursorLine: getApi()?.getCursorPosition?.()?.lineNumber ?? null
    })
    if (!cursorSettled3 || cancelled()) return results

    const insertSaved = await waitForSavedState(tempPath3)
    _assert('PE-26-state-insert-file-persisted', Boolean(insertSaved.latestState), {
      activeFilePath: insertSaved.latestState?.activeFilePath ?? null,
      cursorLine: insertSaved.latestState?.cursorLine ?? null
    })
    if (!insertSaved.latestState || cancelled()) return results

    dispatchEscape()
    const closedForInsertChange = await waitFor('project-editor-close-for-insert-change', () => !isOpenRef.current, 8000)
    _assert('PE-27-close-before-insert-content-change', closedForInsertChange, { closedForInsertChange })
    if (!closedForInsertChange || cancelled()) return results

    const insertedPrefix = Array.from({ length: 40 }, (_, idx) => `inserted-prefix-line-${idx + 1}`).join('\n')
    const insertedContent = `${insertedPrefix}\n${content3}`
    const saveInsertedResult = await window.electronAPI.project.saveFile(rootPath, tempPath3, insertedContent)
    _assert('PE-28-insert-lines-into-file', saveInsertedResult.success, { error: saveInsertedResult.error })
    if (!saveInsertedResult.success || cancelled()) return results

    const reopenedAfterInsert = await reopenProjectEditor('project-editor-restore-after-insert')
    _assert('PE-29-reopen-after-insert', reopenedAfterInsert, { reopenedAfterInsert })
    if (!reopenedAfterInsert || cancelled()) return results

    const restoredInsertFile = await waitFor(
      'project-editor-restore-insert-file',
      () => {
        const currentApi = getApi()
        return Boolean(currentApi?.getActiveFilePath && currentApi.getActiveFilePath() === tempPath3)
      },
      8000
    )
    _assert('PE-30-restore-insert-file', restoredInsertFile, {
      expected: tempPath3,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!restoredInsertFile || cancelled()) return results

    const cursorRestoredAfterInsert = await waitFor(
      'project-editor-restore-cursor-after-insert',
      () => {
        const lineNumber = getApi()?.getCursorPosition()?.lineNumber ?? -1
        return Math.abs(lineNumber - targetLine3) <= 1
      },
      8000,
      120
    )
    const cursorAfterInsert = getApi()?.getCursorPosition()
    const lineAfterInsert = cursorAfterInsert?.lineNumber ?? -1
    _assert('PE-31-restore-cursor-after-insert', cursorRestoredAfterInsert, {
      expectedLine: targetLine3,
      actualLine: lineAfterInsert,
      cursorAfterInsert
    })
  } finally {
    const cleanup = await window.electronAPI.project.deletePath(rootPath, tempPath)
    const cleanup2 = await window.electronAPI.project.deletePath(rootPath, tempPath2)
    const cleanup3 = await window.electronAPI.project.deletePath(rootPath, tempPath3)
    log('phase0.5:cleanup', {
      tempPath,
      tempPath2,
      tempPath3,
      ok: cleanup.success,
      ok2: cleanup2.success,
      ok3: cleanup3.success,
      error: cleanup.error,
      error2: cleanup2.error,
      error3: cleanup3.error
    })
  }

  return results
}
