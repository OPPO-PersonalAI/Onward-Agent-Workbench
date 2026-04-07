/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ProjectEditor restores logical unit tests (pure functions)
 */
import type { AutotestContext, TestResult } from './types'
import {
  buildLegacyFileMemoryEntry,
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
    pinnedFiles: partial.pinnedFiles,
    recentFiles: partial.recentFiles,
    editorViewState: partial.editorViewState,
    cursorLine: partial.cursorLine,
    cursorColumn: partial.cursorColumn,
    isPreviewOpen: partial.isPreviewOpen,
    isEditorVisible: partial.isEditorVisible,
    isOutlineVisible: partial.isOutlineVisible,
    outlineTarget: partial.outlineTarget,
    fileTreeWidth: partial.fileTreeWidth,
    previewWidth: partial.previewWidth,
    outlineWidth: partial.outlineWidth,
    modalWidth: partial.modalWidth,
    modalHeight: partial.modalHeight,
    previewScrollAnchor: partial.previewScrollAnchor,
    fileTreeScrollTop: partial.fileTreeScrollTop,
    outlineScrollTop: partial.outlineScrollTop,
    fileStates: partial.fileStates,
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

  const legacyCursorOnly = buildLegacyFileMemoryEntry(makeState({
    activeFilePath: 'docs/cursor-only.md',
    cursorLine: 18,
    cursorColumn: 4
  }))
  _assert('PEU-11-legacy-cursor-only-migrated', legacyCursorOnly?.cursorLine === 18 && legacyCursorOnly?.cursorColumn === 4, {
    legacyCursorOnly
  })

  const legacyPreviewOnly = buildLegacyFileMemoryEntry(makeState({
    activeFilePath: 'docs/preview-only.md',
    previewScrollAnchor: { slug: 'section-2', ratio: 0.6, headingOffsetY: 42 },
    isPreviewOpen: false,
    isEditorVisible: true,
    outlineTarget: 'preview',
    outlineScrollTop: 120
  }))
  _assert(
    'PEU-12-legacy-preview-only-migrated',
    legacyPreviewOnly?.previewScrollAnchor?.headingOffsetY === 42
      && legacyPreviewOnly?.isPreviewOpen === false
      && legacyPreviewOnly?.outlineTarget === 'preview'
      && legacyPreviewOnly?.outlineScrollTop === 120,
    { legacyPreviewOnly }
  )

  return results
}
