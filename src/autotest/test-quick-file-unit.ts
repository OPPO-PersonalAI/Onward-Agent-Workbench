/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for Pin/Recent quick-file pure functions.
 *
 * Covers: buildQuickFileLabels, normalizeQuickFilePaths, prependRecentFile,
 * moveQuickFile, removeQuickFilePath, replaceQuickFilePath,
 * areQuickFileListsEqual, decodeQuickFileDragPayload, getBaseName, getParentPath.
 */
import type { AutotestContext, TestResult } from './types'
import {
  buildQuickFileLabels,
  normalizeQuickFilePaths,
  prependRecentFile,
  moveQuickFile,
  removeQuickFilePath,
  replaceQuickFilePath,
  areQuickFileListsEqual,
  decodeQuickFileDragPayload,
  getBaseName,
  getParentPath
} from '../components/ProjectEditor/quickFileUtils'

function arrEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export async function testQuickFileUnit(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  // ── getBaseName ──
  _assert('QF-01-getBaseName-simple', getBaseName('src/components/App.tsx') === 'App.tsx')
  _assert('QF-02-getBaseName-root', getBaseName('file.ts') === 'file.ts')
  _assert('QF-03-getBaseName-empty', getBaseName('') === '')

  // ── getParentPath ──
  _assert('QF-04-getParentPath-nested', getParentPath('src/components/App.tsx') === 'src/components')
  _assert('QF-05-getParentPath-root', getParentPath('file.ts') === '')

  // ── buildQuickFileLabels: must return filename only ──
  const labels = buildQuickFileLabels(['src/a.ts', 'lib/utils/b.tsx', 'index.ts'])
  _assert('QF-06-labels-filename-only-a', labels['src/a.ts'] === 'a.ts')
  _assert('QF-07-labels-filename-only-b', labels['lib/utils/b.tsx'] === 'b.tsx')
  _assert('QF-08-labels-filename-only-root', labels['index.ts'] === 'index.ts')

  // ── normalizeQuickFilePaths ──
  // Basic normalization
  _assert('QF-09-normalize-basic',
    arrEq(normalizeQuickFilePaths(['a.ts', 'b.ts'], 5), ['a.ts', 'b.ts']))

  // Deduplication
  _assert('QF-10-normalize-dedup',
    arrEq(normalizeQuickFilePaths(['a.ts', 'b.ts', 'a.ts'], 5), ['a.ts', 'b.ts']))

  // Truncation by maxCount
  _assert('QF-11-normalize-truncate',
    arrEq(normalizeQuickFilePaths(['a.ts', 'b.ts', 'c.ts'], 2), ['a.ts', 'b.ts']))

  // Infinity maxCount: no truncation
  const manyFiles = Array.from({ length: 20 }, (_, i) => `file${i}.ts`)
  const normalizedInf = normalizeQuickFilePaths(manyFiles, Infinity)
  _assert('QF-12-normalize-infinity-no-truncate', normalizedInf.length === 20)

  // Backslash normalization (Windows paths)
  _assert('QF-13-normalize-backslash',
    arrEq(normalizeQuickFilePaths(['src\\a.ts', 'src\\b.ts'], 5), ['src/a.ts', 'src/b.ts']))

  // Null/undefined input
  _assert('QF-14-normalize-null', arrEq(normalizeQuickFilePaths(null, 5), []))
  _assert('QF-15-normalize-undefined', arrEq(normalizeQuickFilePaths(undefined, 5), []))

  // Empty strings filtered
  _assert('QF-16-normalize-empty-filtered',
    arrEq(normalizeQuickFilePaths(['a.ts', '', '  ', 'b.ts'], 5), ['a.ts', 'b.ts']))

  // ── prependRecentFile ──
  // Prepend new file
  _assert('QF-17-prepend-new',
    arrEq(prependRecentFile(['b.ts', 'c.ts'], 'a.ts', 10), ['a.ts', 'b.ts', 'c.ts']))

  // Prepend existing moves to front
  _assert('QF-18-prepend-existing-to-front',
    arrEq(prependRecentFile(['a.ts', 'b.ts', 'c.ts'], 'c.ts', 10), ['c.ts', 'a.ts', 'b.ts']))

  // Max count 10: truncation
  const tenFiles = Array.from({ length: 10 }, (_, i) => `old${i}.ts`)
  const prependedOverflow = prependRecentFile(tenFiles, 'new.ts', 10)
  _assert('QF-19-prepend-max10-truncate', prependedOverflow.length === 10)
  _assert('QF-20-prepend-max10-first', prependedOverflow[0] === 'new.ts')
  _assert('QF-21-prepend-max10-last-dropped', !prependedOverflow.includes('old9.ts'))

  // Max count 5 (old behavior)
  const fiveResult = prependRecentFile(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 'new.ts', 5)
  _assert('QF-22-prepend-max5', fiveResult.length === 5 && fiveResult[0] === 'new.ts')

  // ── moveQuickFile ──
  // Move forward
  const moved1 = moveQuickFile(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'a.ts', 'c.ts', Infinity)
  _assert('QF-23-move-forward', arrEq(moved1, ['b.ts', 'a.ts', 'c.ts', 'd.ts']))

  // Move backward
  const moved2 = moveQuickFile(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 'c.ts', 'a.ts', Infinity)
  _assert('QF-24-move-backward', arrEq(moved2, ['c.ts', 'a.ts', 'b.ts', 'd.ts']))

  // Move same position (no-op)
  const moved3 = moveQuickFile(['a.ts', 'b.ts', 'c.ts'], 'b.ts', 'b.ts', Infinity)
  _assert('QF-25-move-noop', arrEq(moved3, ['a.ts', 'b.ts', 'c.ts']))

  // Move non-existent (no-op)
  const moved4 = moveQuickFile(['a.ts', 'b.ts'], 'x.ts', 'a.ts', Infinity)
  _assert('QF-26-move-nonexistent', arrEq(moved4, ['a.ts', 'b.ts']))

  // ── removeQuickFilePath ──
  _assert('QF-27-remove-existing',
    arrEq(removeQuickFilePath(['a.ts', 'b.ts', 'c.ts'], 'b.ts', Infinity), ['a.ts', 'c.ts']))

  // Remove with children (directory removal)
  _assert('QF-28-remove-dir-children',
    arrEq(removeQuickFilePath(['src/a.ts', 'src/b.ts', 'lib/c.ts'], 'src', Infinity), ['lib/c.ts']))

  // Remove non-existent
  _assert('QF-29-remove-nonexistent',
    arrEq(removeQuickFilePath(['a.ts', 'b.ts'], 'x.ts', Infinity), ['a.ts', 'b.ts']))

  // ── replaceQuickFilePath ──
  _assert('QF-30-replace-exact',
    arrEq(replaceQuickFilePath(['src/a.ts', 'src/b.ts'], 'src/a.ts', 'lib/a.ts', Infinity), ['lib/a.ts', 'src/b.ts']))

  // Replace directory prefix
  _assert('QF-31-replace-dir-prefix',
    arrEq(replaceQuickFilePath(['src/a.ts', 'src/b.ts', 'lib/c.ts'], 'src', 'dist', Infinity), ['dist/a.ts', 'dist/b.ts', 'lib/c.ts']))

  // ── areQuickFileListsEqual ──
  _assert('QF-32-equal-same', areQuickFileListsEqual(['a', 'b'], ['a', 'b']))
  _assert('QF-33-equal-diff-order', !areQuickFileListsEqual(['a', 'b'], ['b', 'a']))
  _assert('QF-34-equal-diff-length', !areQuickFileListsEqual(['a'], ['a', 'b']))

  // ── decodeQuickFileDragPayload ──
  const decoded1 = decodeQuickFileDragPayload(JSON.stringify({ path: 'a.ts', source: 'pinned' }))
  _assert('QF-35-decode-valid-pinned', decoded1?.path === 'a.ts' && decoded1?.source === 'pinned')

  const decoded2 = decodeQuickFileDragPayload(JSON.stringify({ path: 'b.ts', source: 'recent' }))
  _assert('QF-36-decode-valid-recent', decoded2?.path === 'b.ts' && decoded2?.source === 'recent')

  const decoded3 = decodeQuickFileDragPayload(JSON.stringify({ path: 'a.ts', source: 'invalid' }))
  _assert('QF-37-decode-invalid-source', decoded3 === null)

  _assert('QF-38-decode-empty', decodeQuickFileDragPayload('') === null)
  _assert('QF-39-decode-malformed', decodeQuickFileDragPayload('{bad json') === null)

  // Backslash normalization in decode
  const decoded4 = decodeQuickFileDragPayload(JSON.stringify({ path: 'src\\a.ts', source: 'pinned' }))
  _assert('QF-40-decode-backslash', decoded4?.path === 'src/a.ts')

  // ── Visual font-size verification (reads computedStyle from live DOM) ──

  // Expected font size for all four target areas (change this value as needed)
  const EXPECTED_FONT_SIZE = '15px'

  const getFontSize = (selector: string): string | null => {
    const el = document.querySelector(selector) as HTMLElement | null
    if (!el) return null
    return window.getComputedStyle(el).fontSize
  }

  // Wait briefly for ProjectEditor to render
  await ctx.sleep(500)

  // 1. Working Directory container (two possible render paths)
  const cwdSize = getFontSize('.project-editor-root') ?? getFontSize('.subpage-panel-shell-location')
  _assert('QF-V01-cwd-font-size', cwdSize === EXPECTED_FONT_SIZE, {
    expected: EXPECTED_FONT_SIZE, actual: cwdSize ?? 'element not found'
  })

  // 2. Working Directory label
  const cwdLabelSize = getFontSize('.project-editor-root-label') ?? getFontSize('.subpage-panel-shell-location-label')
  _assert('QF-V02-cwd-label-font-size', cwdLabelSize === EXPECTED_FONT_SIZE, {
    expected: EXPECTED_FONT_SIZE, actual: cwdLabelSize ?? 'element not found'
  })

  // 3. Working Directory path
  const cwdPathSize = getFontSize('.project-editor-root-path') ?? getFontSize('.subpage-panel-shell-location-path')
  _assert('QF-V03-cwd-path-font-size', cwdPathSize === EXPECTED_FONT_SIZE, {
    expected: EXPECTED_FONT_SIZE, actual: cwdPathSize ?? 'element not found'
  })

  // 4. Pin/Recent section title (first one found)
  const titleSize = getFontSize('.project-editor-quick-row-title')
  _assert('QF-V04-quick-title-font-size', titleSize === EXPECTED_FONT_SIZE, {
    expected: EXPECTED_FONT_SIZE, actual: titleSize ?? 'element not found'
  })

  // 5. Quick file item (first one found, may be null if no files pinned)
  const itemSize = getFontSize('.project-editor-quick-item')
  if (itemSize !== null) {
    _assert('QF-V05-quick-item-font-size', itemSize === EXPECTED_FONT_SIZE, {
      expected: EXPECTED_FONT_SIZE, actual: itemSize
    })
  } else {
    _assert('QF-V05-quick-item-font-size', true, { note: 'no quick-item rendered, skipped' })
  }

  // 6. Current file name (editor title)
  const editorTitleSize = getFontSize('.project-editor-editor-title')
  _assert('QF-V06-editor-title-font-size', editorTitleSize === EXPECTED_FONT_SIZE, {
    expected: EXPECTED_FONT_SIZE, actual: editorTitleSize ?? 'element not found'
  })

  return results
}
