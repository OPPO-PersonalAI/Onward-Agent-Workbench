/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ProjectEditor restores logical unit tests (pure functions)
 */
import type { AutotestContext, TestResult } from './types'
import {
  buildMissingFileNotice,
  buildPendingCursor,
  clampCursorPosition,
  resolveStoredProjectEditorState,
  shouldKeepPendingRestoreState
} from '../components/ProjectEditor/projectEditorRestoreUtils'
import type { ProjectEditorState } from '../types/tab.d.ts'

function makeState(partial: Partial<ProjectEditorState>): ProjectEditorState {
  return {
    rootPath: partial.rootPath ?? null,
    activeFilePath: partial.activeFilePath ?? null,
    expandedDirs: partial.expandedDirs ?? [],
    editorViewState: partial.editorViewState,
    cursorLine: partial.cursorLine,
    cursorColumn: partial.cursorColumn,
    savedAt: partial.savedAt ?? Date.now()
  }
}

export async function testProjectEditorRestoreUnit(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const rootPath = '/workspace/demo'
  const rootScoped = makeState({
    rootPath,
    activeFilePath: 'a.md',
    cursorLine: 10,
    savedAt: 20
  })
  const terminalStored = makeState({
    rootPath,
    activeFilePath: 'b.md',
    cursorLine: 30,
    savedAt: 10
  })

  const resolvedPreferRootScoped = resolveStoredProjectEditorState(rootPath, terminalStored, rootScoped)
  _assert('PEU-01-resolve-prefer-root-scoped', resolvedPreferRootScoped?.activeFilePath === 'a.md', {
    activeFilePath: resolvedPreferRootScoped?.activeFilePath ?? null
  })

  const resolvedFallbackTerminal = resolveStoredProjectEditorState(rootPath, terminalStored, null)
  _assert('PEU-02-resolve-fallback-terminal', resolvedFallbackTerminal?.activeFilePath === 'b.md', {
    activeFilePath: resolvedFallbackTerminal?.activeFilePath ?? null
  })

  const mismatchTerminal = makeState({
    rootPath: '/workspace/other',
    activeFilePath: 'c.md'
  })
  const resolvedMismatch = resolveStoredProjectEditorState(rootPath, mismatchTerminal, null)
  _assert('PEU-03-resolve-root-mismatch', resolvedMismatch === null, {
    resolved: resolvedMismatch
  })

  const keepPending = shouldKeepPendingRestoreState({
    source: 'restore',
    path: 'a.md',
    pendingPath: 'a.md',
    hasPendingViewState: true,
    hasPendingCursor: false
  })
  _assert('PEU-04-keep-pending-restore', keepPending, { keepPending })

  const notKeepPendingBySource = shouldKeepPendingRestoreState({
    source: 'user',
    path: 'a.md',
    pendingPath: 'a.md',
    hasPendingViewState: true,
    hasPendingCursor: true
  })
  _assert('PEU-05-not-keep-pending-user-source', !notKeepPendingBySource, { notKeepPendingBySource })

  const pendingCursorDefaultColumn = buildPendingCursor(15, undefined)
  _assert('PEU-06-build-cursor-default-column', pendingCursorDefaultColumn?.column === 1, {
    cursor: pendingCursorDefaultColumn
  })

  const pendingCursorMissingLine = buildPendingCursor(undefined, 2)
  _assert('PEU-07-build-cursor-missing-line', pendingCursorMissingLine === null, {
    cursor: pendingCursorMissingLine
  })

  const clampedCursor = clampCursorPosition({
    lineNumber: 999,
    column: 999,
    lineCount: 20,
    getLineMaxColumn: (line) => line === 20 ? 5 : 80
  })
  _assert('PEU-08-clamp-cursor', clampedCursor.lineNumber === 20 && clampedCursor.column === 5, {
    clampedCursor
  })

  const missingNoticeRestore = buildMissingFileNotice('docs/a.md', 'restore', 'en')
  _assert(
    'PEU-09-missing-notice-restore',
    missingNoticeRestore.status === 'The previously opened file was deleted' && missingNoticeRestore.notice.includes('The previously opened file was deleted'),
    missingNoticeRestore
  )

  const missingNoticeUser = buildMissingFileNotice('docs/a.md', 'user', 'en')
  _assert(
    'PEU-10-missing-notice-user',
    missingNoticeUser.status === 'File was deleted or does not exist' && missingNoticeUser.notice.includes('File was deleted or does not exist'),
    missingNoticeUser
  )

  return results
}
