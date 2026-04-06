/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

type SavedFileViewMemory = {
  cursorLine?: number
  cursorColumn?: number
  previewScrollAnchor?: {
    slug: string | null
    ratio: number
    headingOffsetY?: number
    scrollTop?: number
  }
  outlineScrollTop?: number
  isPreviewOpen?: boolean
  isEditorVisible?: boolean
  outlineTarget?: 'editor' | 'preview'
}

type SavedProjectState = {
  rootPath: string | null
  activeFilePath: string | null
  expandedDirs: string[]
  pinnedFiles?: string[]
  recentFiles?: string[]
  editorViewState?: unknown
  cursorLine?: number
  cursorColumn?: number
  savedAt: number
  isPreviewOpen?: boolean
  isEditorVisible?: boolean
  isOutlineVisible?: boolean
  outlineTarget?: 'editor' | 'preview'
  previewScrollAnchor?: {
    slug: string | null
    ratio: number
    headingOffsetY?: number
    scrollTop?: number
  }
  fileTreeScrollTop?: number
  outlineScrollTop?: number
  fileStates?: Record<string, SavedFileViewMemory>
}

function buildMarkdownContent(label: string, sections: number, linesPerSection: number): string {
  const lines: string[] = [`# ${label} overview`, `${label} introduction line 1`, `${label} introduction line 2`]
  for (let section = 1; section <= sections; section += 1) {
    lines.push(`## ${label} section ${section}`)
    for (let line = 1; line <= linesPerSection; line += 1) {
      lines.push(`${label} section ${section} detail line ${line} with enough text to produce a stable preview layout.`)
    }
  }
  return lines.join('\n')
}

function buildTextContent(label: string, lines: number): string {
  return Array.from({ length: lines }, (_, index) => `${label} line ${index + 1}`).join('\n')
}

export async function testProjectEditorFileMemory(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath, reopenProjectEditor, isOpenRef } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = () => window.__onwardProjectEditorDebug
  if (
    !api()?.openFileByPathAsUser ||
    !api()?.setMarkdownPreviewOpen ||
    !api()?.scrollFileBrowserToFraction ||
    !api()?.getFileBrowserScrollTop ||
    !api()?.scrollOutlineToFraction ||
    !api()?.getOutlineScrollTop ||
    !api()?.setOutlineVisible ||
    !api()?.setSidebarMode
  ) {
    record('PFM-00-debug-api-available', false, { error: 'project editor file-memory debug hooks unavailable' })
    return results
  }

  const dispatchEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
  }

  const runId = Date.now()
  const anchorFile = `onward-autotest-file-memory-anchor-${runId}.md`
  const fillerFiles = Array.from({ length: 5 }, (_, index) => `onward-autotest-file-memory-filler-${runId}-${index + 1}.txt`)
  const browserFiles = Array.from({ length: 32 }, (_, index) => `onward-autotest-file-memory-browser-${runId}-${index + 1}.txt`)
  const anchorContent = buildMarkdownContent('anchor', 30, 12)
  const fillerContent = buildTextContent('filler', 80)
  const browserContent = buildTextContent('browser', 12)
  const normalizedRoot = normalizePath(rootPath)
  const recentTolerance = 60
  const restoreTolerance = 80

  const getLatestProjectState = async (): Promise<SavedProjectState | null> => {
    const appState = await window.electronAPI.appState.load()
    const candidates = Object.values(appState.projectEditorStates ?? {}) as SavedProjectState[]
    return candidates
      .filter((entry) => normalizePath(entry.rootPath ?? '') === normalizedRoot)
      .sort((a, b) => b.savedAt - a.savedAt)[0] ?? null
  }

  const waitForSavedState = async (
    label: string,
    predicate: (state: SavedProjectState) => boolean,
    timeoutMs = 12000
  ): Promise<SavedProjectState | null> => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < timeoutMs) {
      const latest = await getLatestProjectState()
      if (latest && predicate(latest)) return latest
      await sleep(180)
    }
    log('file-memory-state-timeout', { label, timeoutMs })
    return null
  }

  const waitForActiveFile = async (label: string, filePath: string) => {
    return await waitFor(
      `file-memory-active:${label}`,
      () => api()?.getActiveFilePath?.() === filePath,
      8000
    )
  }

  const waitForPreviewSettled = async (label: string) => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < 10000) {
      const currentApi = api()
      const ready = !currentApi?.isMarkdownRenderPending?.()
        && (currentApi?.getMarkdownRenderedHtml?.().length ?? 0) > 0
        && currentApi?.getPreviewRestorePhase?.() === 'idle'
      if (ready) return true
      await sleep(60)
    }
    log('file-memory-preview-timeout', {
      label,
      activeFilePath: api()?.getActiveFilePath?.() ?? null,
      previewPhase: api()?.getPreviewRestorePhase?.() ?? null
    })
    return false
  }

  const waitForOutlineReady = async (label: string) => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < 10000) {
      const currentApi = api()
      const ready = currentApi?.isOutlineVisible?.() === true
        && (currentApi?.getOutlineSymbolCount?.() ?? 0) > 10
        && (currentApi?.getOutlineScrollHeight?.() ?? 0) > 0
      if (ready) return true
      await sleep(60)
    }
    log('file-memory-outline-timeout', {
      label,
      activeFilePath: api()?.getActiveFilePath?.() ?? null,
      outlineVisible: api()?.isOutlineVisible?.() ?? null,
      outlineSymbolCount: api()?.getOutlineSymbolCount?.() ?? null
    })
    return false
  }

  try {
    const anchorCreated = await window.electronAPI.project.createFile(rootPath, anchorFile, anchorContent)
    if (!anchorCreated.success) {
      record('PFM-00-setup-anchor', false, { error: anchorCreated.error })
      return results
    }

    for (const fillerFile of fillerFiles) {
      const fillerCreated = await window.electronAPI.project.createFile(rootPath, fillerFile, fillerContent)
      if (!fillerCreated.success) {
        record('PFM-00-setup-filler', false, { fillerFile, error: fillerCreated.error })
        return results
      }
    }

    for (const browserFile of browserFiles) {
      const browserCreated = await window.electronAPI.project.createFile(rootPath, browserFile, browserContent)
      if (!browserCreated.success) {
        record('PFM-00-setup-browser', false, { browserFile, error: browserCreated.error })
        return results
      }
    }

    await api()?.openFileByPathAsUser?.(anchorFile, { trackRecent: true })
    const openedAnchor = await waitForActiveFile('initial-anchor', anchorFile)
    record('PFM-01-open-anchor-file', openedAnchor, {
      expected: anchorFile,
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!openedAnchor || cancelled()) return results

    const initialPreviewReady = await waitForPreviewSettled('initial-anchor')
    record('PFM-02-initial-preview-ready', initialPreviewReady, {
      previewPhase: api()?.getPreviewRestorePhase?.() ?? null
    })
    if (!initialPreviewReady || cancelled()) return results

    await api()?.openFileByPathAsUser?.(anchorFile, { trackRecent: true })
    const recentState = await waitForSavedState(
      'same-file-recent',
      (state) => state.recentFiles?.[0] === anchorFile
    )
    record('PFM-03-same-file-user-open-tracks-recent', Boolean(recentState), {
      recentFiles: recentState?.recentFiles ?? []
    })
    if (!recentState || cancelled()) return results

    api()?.scrollPreviewToFraction?.(0.52)
    await sleep(400)
    const hiddenPreviewSavedPosition = api()?.getPreviewScrollTop?.() ?? 0
    record('PFM-04-preview-anchor-captured-before-hide', hiddenPreviewSavedPosition > 100, {
      hiddenPreviewSavedPosition: Math.round(hiddenPreviewSavedPosition)
    })
    if (cancelled()) return results

    api()?.setMarkdownPreviewOpen?.(false)
    const previewClosed = await waitFor(
      'file-memory-preview-closed',
      () => api()?.isMarkdownPreviewVisible?.() === false,
      4000
    )
    record('PFM-05-preview-hidden-before-switch', previewClosed, {
      previewVisible: api()?.isMarkdownPreviewVisible?.() ?? null
    })
    if (!previewClosed || cancelled()) return results

    await api()?.openFileByPathAsUser?.(fillerFiles[0], { trackRecent: true })
    const switchedAway = await waitForActiveFile('hidden-preview-switch-away', fillerFiles[0])
    record('PFM-06-switch-away-after-preview-hide', switchedAway, {
      expected: fillerFiles[0],
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!switchedAway || cancelled()) return results

    await api()?.openFileByPathAsUser?.(anchorFile, { trackRecent: true })
    const restoredHiddenAnchor = await waitForActiveFile('hidden-preview-return', anchorFile)
    record('PFM-07-return-to-anchor-with-preview-still-closed', restoredHiddenAnchor && api()?.isMarkdownPreviewVisible?.() === false, {
      previewVisible: api()?.isMarkdownPreviewVisible?.() ?? null
    })
    if (!restoredHiddenAnchor || cancelled()) return results

    api()?.setMarkdownPreviewOpen?.(true)
    const reopenedPreviewReady = await waitForPreviewSettled('reopen-hidden-preview')
    record('PFM-08-preview-reopened-after-switch', reopenedPreviewReady, {
      previewPhase: api()?.getPreviewRestorePhase?.() ?? null
    })
    if (!reopenedPreviewReady || cancelled()) return results

    await sleep(300)
    const hiddenPreviewRestoredPosition = api()?.getPreviewScrollTop?.() ?? 0
    record('PFM-09-hidden-preview-restores-last-position', Math.abs(hiddenPreviewRestoredPosition - hiddenPreviewSavedPosition) <= recentTolerance, {
      hiddenPreviewSavedPosition: Math.round(hiddenPreviewSavedPosition),
      hiddenPreviewRestoredPosition: Math.round(hiddenPreviewRestoredPosition),
      diff: Math.round(Math.abs(hiddenPreviewRestoredPosition - hiddenPreviewSavedPosition)),
      tolerance: recentTolerance
    })
    if (cancelled()) return results

    api()?.scrollPreviewToFraction?.(0.74)
    await sleep(400)
    const evictedSavedPosition = api()?.getPreviewScrollTop?.() ?? 0
    record('PFM-10-eviction-anchor-position-captured', evictedSavedPosition > 100, {
      evictedSavedPosition: Math.round(evictedSavedPosition)
    })
    if (cancelled()) return results

    for (const fillerFile of fillerFiles) {
      await api()?.openFileByPathAsUser?.(fillerFile, { trackRecent: true })
      const fillerOpened = await waitForActiveFile(`evict-open:${fillerFile}`, fillerFile)
      record(`PFM-11-open-filler-${fillerFile}`, fillerOpened, {
        fillerFile,
        actual: api()?.getActiveFilePath?.() ?? null
      })
      if (!fillerOpened || cancelled()) return results
    }

    const evictedState = await waitForSavedState(
      'evicted-anchor-still-persisted',
      (state) => {
        const anchorMemory = state.fileStates?.[anchorFile]
        return !state.recentFiles?.includes(anchorFile)
          && Boolean(anchorMemory?.previewScrollAnchor)
      }
    )
    record('PFM-12-anchor-evicted-from-recent', Boolean(evictedState && !evictedState.recentFiles?.includes(anchorFile)), {
      recentFiles: evictedState?.recentFiles ?? []
    })
    record('PFM-13-anchor-memory-persists-after-recent-eviction', Boolean(evictedState?.fileStates?.[anchorFile]?.previewScrollAnchor), {
      anchorMemory: evictedState?.fileStates?.[anchorFile] ?? null
    })
    if (!evictedState || cancelled()) return results

    dispatchEscape()
    const closedAfterEviction = await waitFor('file-memory-close-after-eviction', () => !isOpenRef.current, 8000)
    record('PFM-14-close-before-reopen', closedAfterEviction, { closedAfterEviction })
    if (!closedAfterEviction || cancelled()) return results

    const reopenedAfterEviction = await reopenProjectEditor('project-editor-file-memory-evicted')
    record('PFM-15-reopen-after-eviction', reopenedAfterEviction, { reopenedAfterEviction })
    if (!reopenedAfterEviction || cancelled()) return results

    const activeAfterEviction = await waitForActiveFile('reopen-active-filler', fillerFiles[fillerFiles.length - 1])
    record('PFM-16-last-active-file-restored', activeAfterEviction, {
      expected: fillerFiles[fillerFiles.length - 1],
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!activeAfterEviction || cancelled()) return results

    await api()?.openFileByPathAsUser?.(anchorFile, { trackRecent: true })
    const reopenedEvictedAnchor = await waitForActiveFile('reopen-evicted-anchor', anchorFile)
    record('PFM-17-reopen-evicted-anchor', reopenedEvictedAnchor, {
      expected: anchorFile,
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!reopenedEvictedAnchor || cancelled()) return results

    const evictedPreviewReady = await waitForPreviewSettled('reopen-evicted-anchor-preview')
    record('PFM-18-evicted-anchor-preview-ready', evictedPreviewReady, {
      previewPhase: api()?.getPreviewRestorePhase?.() ?? null
    })
    if (!evictedPreviewReady || cancelled()) return results

    await sleep(300)
    const evictedRestoredPosition = api()?.getPreviewScrollTop?.() ?? 0
    record('PFM-19-evicted-anchor-restores-position-after-app-reopen', Math.abs(evictedRestoredPosition - evictedSavedPosition) <= restoreTolerance, {
      evictedSavedPosition: Math.round(evictedSavedPosition),
      evictedRestoredPosition: Math.round(evictedRestoredPosition),
      diff: Math.round(Math.abs(evictedRestoredPosition - evictedSavedPosition)),
      tolerance: restoreTolerance
    })
    if (cancelled()) return results

    api()?.setMarkdownEditorVisible?.(false)
    api()?.setOutlineTarget?.('preview')
    api()?.scrollPreviewToFraction?.(0.33)
    await sleep(400)
    const activeSavedPosition = api()?.getPreviewScrollTop?.() ?? 0
    record('PFM-20-active-anchor-view-mode-prepared', activeSavedPosition > 100, {
      activeSavedPosition: Math.round(activeSavedPosition),
      editorVisible: api()?.isMarkdownEditorVisible?.() ?? null,
      outlineTarget: api()?.getOutlineTarget?.() ?? null
    })
    if (cancelled()) return results

    dispatchEscape()
    const closedForActiveRestore = await waitFor('file-memory-close-for-active-restore', () => !isOpenRef.current, 8000)
    record('PFM-21-close-before-active-restore', closedForActiveRestore, { closedForActiveRestore })
    if (!closedForActiveRestore || cancelled()) return results

    const reopenedForActiveRestore = await reopenProjectEditor('project-editor-file-memory-active')
    record('PFM-22-reopen-for-active-restore', reopenedForActiveRestore, { reopenedForActiveRestore })
    if (!reopenedForActiveRestore || cancelled()) return results

    const activeAnchorRestored = await waitForActiveFile('active-anchor-after-reopen', anchorFile)
    record('PFM-23-active-anchor-restored-after-reopen', activeAnchorRestored, {
      expected: anchorFile,
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!activeAnchorRestored || cancelled()) return results

    const activePreviewReady = await waitForPreviewSettled('active-anchor-preview-after-reopen')
    record('PFM-24-active-anchor-preview-ready-after-reopen', activePreviewReady, {
      previewPhase: api()?.getPreviewRestorePhase?.() ?? null
    })
    if (!activePreviewReady || cancelled()) return results

    await sleep(300)
    const activeRestoredPosition = api()?.getPreviewScrollTop?.() ?? 0
    record('PFM-25-active-anchor-preview-position-restored', Math.abs(activeRestoredPosition - activeSavedPosition) <= restoreTolerance, {
      activeSavedPosition: Math.round(activeSavedPosition),
      activeRestoredPosition: Math.round(activeRestoredPosition),
      diff: Math.round(Math.abs(activeRestoredPosition - activeSavedPosition)),
      tolerance: restoreTolerance
    })
    record('PFM-26-active-anchor-editor-visibility-restored', api()?.isMarkdownEditorVisible?.() === false, {
      editorVisible: api()?.isMarkdownEditorVisible?.() ?? null
    })
    record('PFM-27-active-anchor-outline-target-restored', api()?.getOutlineTarget?.() === 'preview', {
      outlineTarget: api()?.getOutlineTarget?.() ?? null
    })
    if (cancelled()) return results

    const roundTripStateBefore = await getLatestProjectState()
    const roundTripSaved = await window.electronAPI.appState.save(await window.electronAPI.appState.load())
    const roundTripStateAfter = roundTripSaved ? await getLatestProjectState() : null
    const beforeAnchorMemory = roundTripStateBefore?.fileStates?.[anchorFile] ?? null
    const afterAnchorMemory = roundTripStateAfter?.fileStates?.[anchorFile] ?? null
    record('PFM-28-app-state-round-trip-save-succeeds', roundTripSaved, { roundTripSaved })
    record(
      'PFM-29-app-state-round-trip-retains-file-memory-fields',
      Boolean(
        roundTripStateAfter?.recentFiles?.includes(anchorFile)
          && afterAnchorMemory?.previewScrollAnchor
          && afterAnchorMemory.previewScrollAnchor.headingOffsetY === beforeAnchorMemory?.previewScrollAnchor?.headingOffsetY
          && afterAnchorMemory.isEditorVisible === false
          && afterAnchorMemory.outlineTarget === 'preview'
      ),
      {
        recentFiles: roundTripStateAfter?.recentFiles ?? [],
        beforeAnchorMemory,
        afterAnchorMemory
      }
    )

    api()?.setSidebarMode?.('files')
    await sleep(250)
    const fileBrowserScrolled = Boolean(api()?.scrollFileBrowserToFraction?.(0.92))
    await sleep(350)
    const savedFileBrowserScrollTop = api()?.getFileBrowserScrollTop?.() ?? 0
    record('PFM-30-file-browser-scroll-captured', fileBrowserScrolled && savedFileBrowserScrollTop > 100, {
      fileBrowserScrolled,
      savedFileBrowserScrollTop: Math.round(savedFileBrowserScrollTop),
      fileBrowserScrollHeight: api()?.getFileBrowserScrollHeight?.() ?? null
    })
    if (cancelled()) return results

    const savedFileBrowserState = await waitForSavedState(
      'file-browser-scroll-persisted',
      (state) => Math.abs((state.fileTreeScrollTop ?? -1) - savedFileBrowserScrollTop) <= restoreTolerance
    )
    record('PFM-31-file-browser-scroll-persisted', Boolean(savedFileBrowserState), {
      fileTreeScrollTop: savedFileBrowserState?.fileTreeScrollTop ?? null,
      savedFileBrowserScrollTop: Math.round(savedFileBrowserScrollTop)
    })
    if (!savedFileBrowserState || cancelled()) return results

    const pagehideFileBrowserScrolled = Boolean(api()?.scrollFileBrowserToFraction?.(0.61))
    const pagehideFileBrowserScrollTop = api()?.getFileBrowserScrollTop?.() ?? 0
    window.dispatchEvent(new Event('pagehide'))
    const pagehideFileBrowserState = await waitForSavedState(
      'file-browser-pagehide-flush',
      (state) => Math.abs((state.fileTreeScrollTop ?? -1) - pagehideFileBrowserScrollTop) <= restoreTolerance
    )
    record('PFM-31b-file-browser-pagehide-flush-persists-latest-scroll', pagehideFileBrowserScrolled && Boolean(pagehideFileBrowserState), {
      pagehideFileBrowserScrollTop: Math.round(pagehideFileBrowserScrollTop),
      persistedFileTreeScrollTop: pagehideFileBrowserState?.fileTreeScrollTop ?? null
    })
    if (!pagehideFileBrowserState || cancelled()) return results
    const expectedFileBrowserScrollTop = pagehideFileBrowserState.fileTreeScrollTop ?? pagehideFileBrowserScrollTop

    dispatchEscape()
    const closedForFileBrowserRestore = await waitFor('file-browser-close-before-restore', () => !isOpenRef.current, 8000)
    record('PFM-32-close-before-file-browser-restore', closedForFileBrowserRestore, { closedForFileBrowserRestore })
    if (!closedForFileBrowserRestore || cancelled()) return results

    const reopenedForFileBrowserRestore = await reopenProjectEditor('project-editor-file-browser-scroll')
    record('PFM-33-reopen-for-file-browser-restore', reopenedForFileBrowserRestore, { reopenedForFileBrowserRestore })
    if (!reopenedForFileBrowserRestore || cancelled()) return results

    const activeAfterFileBrowserRestore = await waitForActiveFile('file-browser-active-anchor-after-reopen', anchorFile)
    record('PFM-34-active-anchor-restored-before-file-browser-check', activeAfterFileBrowserRestore, {
      expected: anchorFile,
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!activeAfterFileBrowserRestore || cancelled()) return results

    await waitFor(
      'file-browser-scroll-restored',
      () => Math.abs((api()?.getFileBrowserScrollTop?.() ?? 0) - expectedFileBrowserScrollTop) <= restoreTolerance,
      4000
    )
    const restoredFileBrowserScrollTop = api()?.getFileBrowserScrollTop?.() ?? 0
    record(
      'PFM-35-file-browser-scroll-restored-after-reopen',
      Math.abs(restoredFileBrowserScrollTop - expectedFileBrowserScrollTop) <= restoreTolerance,
      {
        savedFileBrowserScrollTop: Math.round(expectedFileBrowserScrollTop),
        restoredFileBrowserScrollTop: Math.round(restoredFileBrowserScrollTop),
        diff: Math.round(Math.abs(restoredFileBrowserScrollTop - expectedFileBrowserScrollTop)),
        tolerance: restoreTolerance
      }
    )
    if (cancelled()) return results

    api()?.setOutlineVisible?.(true)
    const outlineReady = await waitForOutlineReady('outline-scroll-capture')
    record('PFM-36-outline-ready-before-scroll-restore', outlineReady, {
      outlineVisible: api()?.isOutlineVisible?.() ?? null,
      outlineSymbolCount: api()?.getOutlineSymbolCount?.() ?? null
    })
    if (!outlineReady || cancelled()) return results

    const outlineScrolled = Boolean(api()?.scrollOutlineToFraction?.(0.72))
    await sleep(300)
    const savedOutlineScrollTop = api()?.getOutlineScrollTop?.() ?? 0
    record('PFM-37-outline-scroll-captured', outlineScrolled && savedOutlineScrollTop > 40, {
      outlineScrolled,
      savedOutlineScrollTop: Math.round(savedOutlineScrollTop),
      outlineScrollHeight: api()?.getOutlineScrollHeight?.() ?? null
    })
    if (cancelled()) return results

    const savedOutlineState = await waitForSavedState(
      'outline-scroll-persisted',
      (state) => {
        const outlineScrollTop = state.fileStates?.[anchorFile]?.outlineScrollTop
        return typeof outlineScrollTop === 'number'
          && Math.abs(outlineScrollTop - savedOutlineScrollTop) <= restoreTolerance
      }
    )
    record('PFM-38-outline-scroll-persisted', Boolean(savedOutlineState), {
      outlineScrollTop: savedOutlineState?.fileStates?.[anchorFile]?.outlineScrollTop ?? null,
      savedOutlineScrollTop: Math.round(savedOutlineScrollTop)
    })
    if (!savedOutlineState || cancelled()) return results

    const pagehideOutlineScrolled = Boolean(api()?.scrollOutlineToFraction?.(0.46))
    const pagehideOutlineScrollTop = api()?.getOutlineScrollTop?.() ?? 0
    window.dispatchEvent(new Event('pagehide'))
    const pagehideOutlineState = await waitForSavedState(
      'outline-pagehide-flush',
      (state) => {
        const outlineScrollTop = state.fileStates?.[anchorFile]?.outlineScrollTop
        return typeof outlineScrollTop === 'number'
          && Math.abs(outlineScrollTop - pagehideOutlineScrollTop) <= restoreTolerance
      }
    )
    record('PFM-38b-outline-pagehide-flush-persists-latest-scroll', pagehideOutlineScrolled && Boolean(pagehideOutlineState), {
      pagehideOutlineScrollTop: Math.round(pagehideOutlineScrollTop),
      persistedOutlineScrollTop: pagehideOutlineState?.fileStates?.[anchorFile]?.outlineScrollTop ?? null
    })
    if (!pagehideOutlineState || cancelled()) return results
    const expectedOutlineScrollTop = pagehideOutlineState.fileStates?.[anchorFile]?.outlineScrollTop ?? pagehideOutlineScrollTop

    await api()?.openFileByPathAsUser?.(fillerFiles[0], { trackRecent: true })
    const switchedAwayForOutlineRestore = await waitForActiveFile('outline-switch-away', fillerFiles[0])
    record('PFM-39-switch-away-before-outline-restore', switchedAwayForOutlineRestore, {
      expected: fillerFiles[0],
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!switchedAwayForOutlineRestore || cancelled()) return results

    await api()?.openFileByPathAsUser?.(anchorFile, { trackRecent: true })
    const switchedBackForOutlineRestore = await waitForActiveFile('outline-switch-back', anchorFile)
    record('PFM-40-switch-back-before-outline-restore', switchedBackForOutlineRestore, {
      expected: anchorFile,
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!switchedBackForOutlineRestore || cancelled()) return results

    const outlineReadyAfterSwitch = await waitForOutlineReady('outline-scroll-after-switch')
    record('PFM-41-outline-ready-after-switch', outlineReadyAfterSwitch, {
      outlineVisible: api()?.isOutlineVisible?.() ?? null,
      outlineSymbolCount: api()?.getOutlineSymbolCount?.() ?? null
    })
    if (!outlineReadyAfterSwitch || cancelled()) return results

    await sleep(250)
    const restoredOutlineAfterSwitch = api()?.getOutlineScrollTop?.() ?? 0
    record(
      'PFM-42-outline-scroll-restored-on-switch',
      Math.abs(restoredOutlineAfterSwitch - expectedOutlineScrollTop) <= restoreTolerance,
      {
        savedOutlineScrollTop: Math.round(expectedOutlineScrollTop),
        restoredOutlineAfterSwitch: Math.round(restoredOutlineAfterSwitch),
        diff: Math.round(Math.abs(restoredOutlineAfterSwitch - expectedOutlineScrollTop)),
        tolerance: restoreTolerance
      }
    )
    if (cancelled()) return results

    dispatchEscape()
    const closedForOutlineRestore = await waitFor('outline-close-before-reopen', () => !isOpenRef.current, 8000)
    record('PFM-43-close-before-outline-reopen', closedForOutlineRestore, { closedForOutlineRestore })
    if (!closedForOutlineRestore || cancelled()) return results

    const reopenedForOutlineRestore = await reopenProjectEditor('project-editor-outline-scroll')
    record('PFM-44-reopen-for-outline-restore', reopenedForOutlineRestore, { reopenedForOutlineRestore })
    if (!reopenedForOutlineRestore || cancelled()) return results

    const activeAfterOutlineRestore = await waitForActiveFile('outline-active-anchor-after-reopen', anchorFile)
    record('PFM-45-active-anchor-restored-before-outline-check', activeAfterOutlineRestore, {
      expected: anchorFile,
      actual: api()?.getActiveFilePath?.() ?? null
    })
    if (!activeAfterOutlineRestore || cancelled()) return results

    const outlineReadyAfterReopen = await waitForOutlineReady('outline-scroll-after-reopen')
    record('PFM-46-outline-ready-after-reopen', outlineReadyAfterReopen, {
      outlineVisible: api()?.isOutlineVisible?.() ?? null,
      outlineSymbolCount: api()?.getOutlineSymbolCount?.() ?? null
    })
    if (!outlineReadyAfterReopen || cancelled()) return results

    await sleep(250)
    const restoredOutlineAfterReopen = api()?.getOutlineScrollTop?.() ?? 0
    record(
      'PFM-47-outline-scroll-restored-after-reopen',
      Math.abs(restoredOutlineAfterReopen - expectedOutlineScrollTop) <= restoreTolerance,
      {
        savedOutlineScrollTop: Math.round(expectedOutlineScrollTop),
        restoredOutlineAfterReopen: Math.round(restoredOutlineAfterReopen),
        diff: Math.round(Math.abs(restoredOutlineAfterReopen - expectedOutlineScrollTop)),
        tolerance: restoreTolerance
      }
    )
    if (cancelled()) return results

    const finalRoundTripStateBefore = await getLatestProjectState()
    const finalRoundTripSaved = await window.electronAPI.appState.save(await window.electronAPI.appState.load())
    const finalRoundTripStateAfter = finalRoundTripSaved ? await getLatestProjectState() : null
    const finalBeforeAnchorMemory = finalRoundTripStateBefore?.fileStates?.[anchorFile] ?? null
    const finalAfterAnchorMemory = finalRoundTripStateAfter?.fileStates?.[anchorFile] ?? null
    record('PFM-48-app-state-round-trip-after-scroll-save-succeeds', finalRoundTripSaved, {
      finalRoundTripSaved
    })
    record(
      'PFM-49-app-state-round-trip-retains-tree-and-outline-scroll',
      Boolean(
        Math.abs((finalRoundTripStateAfter?.fileTreeScrollTop ?? -1) - (finalRoundTripStateBefore?.fileTreeScrollTop ?? -9999)) <= restoreTolerance
          && Math.abs((finalAfterAnchorMemory?.outlineScrollTop ?? -1) - (finalBeforeAnchorMemory?.outlineScrollTop ?? -9999)) <= restoreTolerance
          && finalAfterAnchorMemory?.outlineTarget === 'preview'
      ),
      {
        beforeFileTreeScrollTop: finalRoundTripStateBefore?.fileTreeScrollTop ?? null,
        afterFileTreeScrollTop: finalRoundTripStateAfter?.fileTreeScrollTop ?? null,
        beforeAnchorMemory: finalBeforeAnchorMemory,
        afterAnchorMemory: finalAfterAnchorMemory
      }
    )
  } finally {
    const deletedAnchor = await window.electronAPI.project.deletePath(rootPath, anchorFile)
    const deletedFillers = await Promise.all(
      fillerFiles.map(async (fillerFile) => {
        return await window.electronAPI.project.deletePath(rootPath, fillerFile)
      })
    )
    const deletedBrowserFiles = await Promise.all(
      browserFiles.map(async (browserFile) => {
        return await window.electronAPI.project.deletePath(rootPath, browserFile)
      })
    )
    log('project-editor-file-memory:cleanup', {
      anchorFile,
      fillerFiles,
      browserFiles,
      deletedAnchor: deletedAnchor.success,
      deletedFillers: deletedFillers.map((entry) => entry.success),
      deletedBrowserFiles: deletedBrowserFiles.map((entry) => entry.success)
    })
  }

  return results
}
