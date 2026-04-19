/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sidebar auto-scroll automation.
 *
 * Verifies:
 *   - Outline panel smooth-centers the active heading when the Markdown
 *     preview is scrolled to different regions.
 *   - Outline panel smooth-centers the active heading when the Markdown
 *     editor cursor moves.
 *   - Outline panel smooth-centers the active symbol when a code file is
 *     scrolled.
 *   - File Browser auto-expands every ancestor and centers the row when a
 *     deeply-nested file is opened via a non-tree source.
 *   - "Locate current file" button re-centers the row on demand after the
 *     user has scrolled the tree away.
 *   - A manual scroll of the outline pauses auto-center for ~3 seconds.
 */
import type { AutotestContext, TestResult } from './types'

const LONG_MD = 'test/sidebar-autoscroll-long.md'
const DEEP_MD = 'test/fixtures/sidebar-deep/alpha/beta/gamma/delta/target-leaf.md'
// Python fixture — the outline parser's regex strategy resolves Python
// symbols synchronously, sidestepping Monaco's JS / TS language-service
// cold-start flakiness in autotest runs.
const CODE_FIXTURE = 'test/fixtures/sidebar-autoscroll-code.py'

// Dead zone is 60% of viewport so the edge is at ratio 0.30; allow a small
// cushion for 28 px row height so ratios up to ~0.32 mean "in dead zone".
const CENTER_TOLERANCE = 0.32
const BOUNDARY_MARGIN_RATIO = 0.05
const SCROLL_SETTLE_MS = 900

function inViewport(bounds: {
  found: boolean
  containerTop: number
  containerHeight: number
  itemTop?: number
  itemHeight?: number
  rowTop?: number
  rowHeight?: number
} | null): boolean {
  if (!bounds || !bounds.found) return false
  const top = (bounds.itemTop ?? bounds.rowTop ?? 0)
  const height = (bounds.itemHeight ?? bounds.rowHeight ?? 0)
  const cTop = bounds.containerTop
  const cBottom = bounds.containerTop + bounds.containerHeight
  return top + height > cTop && top < cBottom
}

function acceptableCenter(
  bounds: { centerOffsetRatio: number; found: boolean } | null,
  scrollTop: number,
  scrollMax: number
): { ok: boolean; reason: string } {
  if (!bounds || !bounds.found) return { ok: false, reason: 'no-active' }
  if (bounds.centerOffsetRatio <= CENTER_TOLERANCE) return { ok: true, reason: 'within-tolerance' }
  // Boundary exemption: items near the top/bottom of the outline scroll range
  // cannot be centered because there is not enough content past them.
  const boundary = Math.max(30, scrollMax * BOUNDARY_MARGIN_RATIO)
  if (scrollMax <= 4) return { ok: true, reason: 'no-scroll-needed' }
  if (scrollTop <= boundary) return { ok: true, reason: 'near-top' }
  if (scrollTop >= scrollMax - boundary) return { ok: true, reason: 'near-bottom' }
  return { ok: false, reason: 'out-of-dead-zone' }
}

export async function testSidebarAutoscroll(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, assert, cancelled, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = window.__onwardProjectEditorDebug
  if (!api) {
    record('SA-01-api-available', false, { error: 'debug api not found' })
    return results
  }

  const required = [
    'openFileByPath',
    'setMarkdownPreviewVisible',
    'setMarkdownEditorVisible',
    'isMarkdownPreviewVisible',
    'scrollPreviewToFraction',
    'getOutlineActiveItemName',
    'getOutlineActiveItemBounds',
    'getOutlineScrollTop',
    'scrollOutlineToFraction',
    'scrollToLine',
    'setCursorPosition',
    'getFileBrowserExpandedDirs',
    'getFileBrowserActiveRowBounds',
    'clickLocateFileButton',
    'scrollFileBrowserToFraction',
    'getOutlineSymbolCount'
  ] as const
  const missing = required.filter(m => typeof (api as Record<string, unknown>)[m] !== 'function')
  record('SA-01-api-available', missing.length === 0, { missing })
  if (missing.length > 0) return results
  if (cancelled()) return results

  // ---------------------------------------------------------------
  // SA-02: Outline smooth-centers as markdown preview is scrolled
  // ---------------------------------------------------------------
  log('SA-02:open-long-markdown', { file: LONG_MD })
  await api.openFileByPath(LONG_MD)
  // Preview visibility gates markdown rendering, so show it before waiting.
  api.setMarkdownPreviewVisible?.(true)
  api.setMarkdownEditorVisible?.(false)
  await sleep(200)
  const mdRenderReady = await waitFor('SA-02-render', () => {
    return !api.isMarkdownRenderPending() && api.getMarkdownRenderedHtml().length > 500
  }, 20000, 120)
  record('SA-02-render', mdRenderReady)
  if (!mdRenderReady || cancelled()) return results

  // Allow initial-scroll restore window (500 ms) + outline re-render cycles
  // to settle before exercising scroll-driven centering.
  await sleep(1500)

  const previewVisible = api.isMarkdownPreviewVisible()
  record('SA-02-preview-visible', previewVisible)
  if (!previewVisible || cancelled()) return results

  const symbolCount = api.getOutlineSymbolCount!()
  record('SA-02-heading-count', symbolCount >= 30, { symbolCount })

  let maxOutlineCenterRatio = 0
  let outlineOutOfCenter = 0
  let outlineNotVisible = 0
  const fractions = [0.10, 0.30, 0.55, 0.80, 0.95]
  for (const fraction of fractions) {
    if (cancelled()) break
    api.scrollPreviewToFraction!(fraction)
    await sleep(SCROLL_SETTLE_MS)
    const bounds = api.getOutlineActiveItemBounds!()
    const visible = inViewport(bounds)
    const scrollTop = api.getOutlineScrollTop!()
    const scrollMax = (api.getOutlineScrollMax ? api.getOutlineScrollMax() : 0)
    const verdict = acceptableCenter(bounds, scrollTop, scrollMax)
    const ratio = bounds?.centerOffsetRatio ?? 1
    if (ratio > maxOutlineCenterRatio) maxOutlineCenterRatio = ratio
    if (!verdict.ok) outlineOutOfCenter += 1
    if (!verdict.ok && !visible) outlineNotVisible += 1
    log('SA-02:sample', {
      fraction,
      active: api.getOutlineActiveItemName!(),
      outlineScrollTop: scrollTop,
      scrollMax,
      visible,
      ratio: Number(ratio.toFixed(3)),
      verdict: verdict.reason
    })
  }
  const diag02 = (window as unknown as { __onwardOutlineAutoCenterDiag?: unknown }).__onwardOutlineAutoCenterDiag
  log('SA-02:diag', diag02)
  record('SA-02-outline-follows-preview', outlineOutOfCenter === 0 && outlineNotVisible === 0, {
    samples: fractions.length,
    outOfCenter: outlineOutOfCenter,
    notVisible: outlineNotVisible,
    maxRatio: Number(maxOutlineCenterRatio.toFixed(3))
  })
  if (cancelled()) return results

  // ---------------------------------------------------------------
  // SA-03: Manual outline scroll pauses auto-center for ~3 s
  // ---------------------------------------------------------------
  api.scrollPreviewToFraction!(0.5)
  await sleep(SCROLL_SETTLE_MS)
  const centeredTop = api.getOutlineScrollTop!()
  api.scrollOutlineToFraction!(0)
  await sleep(120)
  const afterManual = api.getOutlineScrollTop!()
  record('SA-03-manual-scroll-applied', afterManual < centeredTop - 2, { centeredTop, afterManual })

  api.scrollPreviewToFraction!(0.15)
  await sleep(SCROLL_SETTLE_MS)
  const withinPause = api.getOutlineScrollTop!()
  record('SA-03-pause-honored', withinPause === afterManual, {
    afterManual,
    withinPause,
    drift: Math.abs(withinPause - afterManual)
  })
  log('SA-03:waiting-for-pause-expiry', {})
  await sleep(3500)
  // First trigger a heading change to a different slug so the effect fires
  // even if our previous pre-pause scroll already selected a similar slug.
  api.scrollPreviewToFraction!(0.15)
  await sleep(SCROLL_SETTLE_MS)
  api.scrollPreviewToFraction!(0.9)
  await sleep(SCROLL_SETTLE_MS + 200)
  const afterPause = api.getOutlineScrollTop!()
  const afterBounds = api.getOutlineActiveItemBounds!()
  const afterMax = api.getOutlineScrollMax ? api.getOutlineScrollMax() : 0
  const afterVerdict = acceptableCenter(afterBounds, afterPause, afterMax)
  record('SA-03-resumes-after-pause', afterVerdict.ok, {
    ratio: Number((afterBounds?.centerOffsetRatio ?? 1).toFixed(3)),
    outlineScrollTop: afterPause,
    verdict: afterVerdict.reason
  })
  if (cancelled()) return results

  // ---------------------------------------------------------------
  // SA-04: Outline follows code scroll
  // ---------------------------------------------------------------
  log('SA-04:open-code', { file: CODE_FIXTURE })
  // Ensure the outline panel is shown (it gates symbol parsing) and drop
  // any lingering markdown preview state from the previous section.
  api.setMarkdownPreviewVisible?.(false)
  api.setOutlineVisible?.(true)
  await sleep(300)
  await api.openFileByPath(CODE_FIXTURE)
  // Monaco's JS worker may need to cold-start when switching from a
  // Markdown file — give it up to a minute before deciding symbols failed.
  await sleep(2000)
  const symbolsReady = await waitFor('SA-04-symbols', () => (api.getOutlineSymbolCount!() >= 8), 60000, 500)
  const codeCount = api.getOutlineSymbolCount!()
  record('SA-04-code-symbols', symbolsReady && codeCount >= 8, {
    codeCount,
    outlineVisible: api.isOutlineVisible?.(),
    activeFilePath: api.getActiveFilePath()
  })

  let codeOutOfCenter = 0
  let codeNotVisible = 0
  let maxCodeRatio = 0
  // Python fixture: fn_N has `def` at line 5N+1 and body at line 5N+3.
  // Target body lines so the outline parser's regex-based active-symbol
  // lookup reliably resolves to the enclosing function.
  //   fn_05 body=28, fn_15=78, fn_30=153, fn_45=228
  const codeLines: Array<{ line: number; column: number }> = [
    { line: 28, column: 9 },
    { line: 78, column: 9 },
    { line: 153, column: 9 },
    { line: 228, column: 9 }
  ]
  for (const { line, column } of codeLines) {
    if (cancelled()) break
    api.scrollToLine!(line)
    api.setCursorPosition!(line, column)
    await sleep(SCROLL_SETTLE_MS)
    const bounds = api.getOutlineActiveItemBounds!()
    const visible = inViewport(bounds)
    const scrollTop = api.getOutlineScrollTop!()
    const scrollMax = (api.getOutlineScrollMax ? api.getOutlineScrollMax() : 0)
    const verdict = acceptableCenter(bounds, scrollTop, scrollMax)
    const ratio = bounds?.centerOffsetRatio ?? 1
    if (ratio > maxCodeRatio) maxCodeRatio = ratio
    if (!verdict.ok) codeOutOfCenter += 1
    if (!verdict.ok && !visible) codeNotVisible += 1
    log('SA-04:sample', {
      line,
      column,
      active: api.getOutlineActiveItemName!(),
      cursor: api.getCursorPosition?.(),
      editorScrollTop: api.getScrollTop?.(),
      firstVisibleLine: api.getFirstVisibleLine?.(),
      outlineScrollTop: scrollTop,
      scrollMax,
      visible,
      ratio: Number(ratio.toFixed(3)),
      verdict: verdict.reason
    })
  }
  record('SA-04-outline-follows-code', codeOutOfCenter === 0 && codeNotVisible === 0, {
    samples: codeLines.length,
    outOfCenter: codeOutOfCenter,
    notVisible: codeNotVisible,
    maxRatio: Number(maxCodeRatio.toFixed(3))
  })
  if (cancelled()) return results

  // ---------------------------------------------------------------
  // SA-05: Outline follows markdown editor cursor
  // ---------------------------------------------------------------
  log('SA-05:reopen-markdown-editor', {})
  await api.openFileByPath(LONG_MD)
  // Editor mode needs both to be handled: we show the editor, then ensure
  // preview has rendered symbols (it may already be cached from SA-02).
  api.setMarkdownPreviewVisible?.(true)
  api.setMarkdownEditorVisible?.(true)
  await sleep(300)
  const editorRenderReady = await waitFor('SA-05-render', () => {
    return !api.isMarkdownRenderPending() && api.getMarkdownRenderedHtml().length > 500
  }, 20000, 120)
  record('SA-05-render', editorRenderReady)
  if (!editorRenderReady || cancelled()) return results

  api.setMarkdownEditorVisible?.(true)
  api.setMarkdownPreviewVisible?.(false)
  await sleep(500)

  const editorHeadings = [40, 140, 260, 380, 470]
  let editorOutOfCenter = 0
  let editorNotVisible = 0
  let maxEditorRatio = 0
  for (const line of editorHeadings) {
    if (cancelled()) break
    api.scrollToLine!(line)
    api.setCursorPosition!(line, 1)
    await sleep(SCROLL_SETTLE_MS)
    const bounds = api.getOutlineActiveItemBounds!()
    const visible = inViewport(bounds)
    const scrollTop = api.getOutlineScrollTop!()
    const scrollMax = (api.getOutlineScrollMax ? api.getOutlineScrollMax() : 0)
    const verdict = acceptableCenter(bounds, scrollTop, scrollMax)
    const ratio = bounds?.centerOffsetRatio ?? 1
    if (ratio > maxEditorRatio) maxEditorRatio = ratio
    if (!verdict.ok) editorOutOfCenter += 1
    if (!verdict.ok && !visible) editorNotVisible += 1
    log('SA-05:sample', {
      line,
      active: api.getOutlineActiveItemName!(),
      outlineScrollTop: scrollTop,
      scrollMax,
      visible,
      ratio: Number(ratio.toFixed(3)),
      verdict: verdict.reason
    })
  }
  record('SA-05-outline-follows-editor', editorOutOfCenter === 0 && editorNotVisible === 0, {
    samples: editorHeadings.length,
    outOfCenter: editorOutOfCenter,
    notVisible: editorNotVisible,
    maxRatio: Number(maxEditorRatio.toFixed(3))
  })
  if (cancelled()) return results

  // ---------------------------------------------------------------
  // SA-06: File Browser auto-reveal for non-tree open
  // ---------------------------------------------------------------
  // First collapse tree by opening a shallow file so deep ancestors are not
  // already expanded from prior sections.
  await api.openFileByPath('CLAUDE.md')
  await sleep(400)

  // Now open the deeply nested fixture. openFileByPath goes through the
  // same code path as a Search / Pin / Recent click — not a tree click —
  // so auto-reveal should fire.
  log('SA-06:open-deep', { file: DEEP_MD })
  await api.openFileByPath(DEEP_MD)
  await sleep(1200)

  const expectedAncestors = [
    'test',
    'test/fixtures',
    'test/fixtures/sidebar-deep',
    'test/fixtures/sidebar-deep/alpha',
    'test/fixtures/sidebar-deep/alpha/beta',
    'test/fixtures/sidebar-deep/alpha/beta/gamma',
    'test/fixtures/sidebar-deep/alpha/beta/gamma/delta'
  ]
  const expanded = new Set(api.getFileBrowserExpandedDirs!())
  const missingAncestors = expectedAncestors.filter(p => !expanded.has(p))
  record('SA-06-ancestors-expanded', missingAncestors.length === 0, {
    missing: missingAncestors,
    expandedSample: Array.from(expanded).slice(0, 15)
  })

  const rowBounds = api.getFileBrowserActiveRowBounds!()
  const rowVisible = inViewport(rowBounds)
  const rowCentered = rowVisible && (rowBounds?.centerOffsetRatio ?? 1) <= CENTER_TOLERANCE
  const revealState06 = (window as unknown as { __onwardFileBrowserRevealLastState?: unknown }).__onwardFileBrowserRevealLastState
  log('SA-06:reveal-state', revealState06)
  const revealDiag06 = (window as unknown as { __onwardFileBrowserRevealDiag?: unknown }).__onwardFileBrowserRevealDiag
  log('SA-06:reveal-diag', revealDiag06)
  record('SA-06-row-centered', rowCentered, {
    found: rowBounds?.found,
    visible: rowVisible,
    ratio: Number((rowBounds?.centerOffsetRatio ?? 1).toFixed(3)),
    containerTop: rowBounds?.containerTop,
    containerHeight: rowBounds?.containerHeight,
    rowTop: rowBounds?.rowTop,
    rowHeight: rowBounds?.rowHeight,
    scrollTop: api.getFileBrowserScrollTop?.(),
    scrollHeight: api.getFileBrowserScrollHeight?.()
  })
  if (cancelled()) return results

  // ---------------------------------------------------------------
  // SA-07: Locate button re-centers after user scrolls tree away
  // ---------------------------------------------------------------
  api.scrollFileBrowserToFraction!(0)
  await sleep(200)
  const beforeLocate = api.getFileBrowserActiveRowBounds!()
  log('SA-07:before-locate', {
    scrollTop: api.getFileBrowserScrollTop?.(),
    visible: inViewport(beforeLocate),
    ratio: Number((beforeLocate?.centerOffsetRatio ?? 1).toFixed(3))
  })
  const clicked = api.clickLocateFileButton!()
  record('SA-07-button-clicked', clicked)
  if (!clicked) return results
  await sleep(1800)
  const diag07 = (window as unknown as { __onwardFileBrowserRevealDiag?: unknown }).__onwardFileBrowserRevealDiag
  log('SA-07:reveal-diag', diag07)
  const afterLocate = api.getFileBrowserActiveRowBounds!()
  log('SA-07:after-locate', {
    scrollTop: api.getFileBrowserScrollTop?.(),
    visible: inViewport(afterLocate),
    ratio: Number((afterLocate?.centerOffsetRatio ?? 1).toFixed(3))
  })
  const locateOk = inViewport(afterLocate) && (afterLocate?.centerOffsetRatio ?? 1) <= CENTER_TOLERANCE
  record('SA-07-locate-centers', locateOk, {
    visible: inViewport(afterLocate),
    ratio: Number((afterLocate?.centerOffsetRatio ?? 1).toFixed(3))
  })

  // ---------------------------------------------------------------
  // SA-09: Locate still works after the user expanded an unrelated folder
  //        (regression: reveal must search from the editor's current file,
  //        not rely on File-Browser-interaction memory).
  // ---------------------------------------------------------------
  log('SA-09:setup', {})
  // Ensure the editor's active file is still the deep fixture.
  const currentActive = api.getActiveFilePath()
  if (currentActive !== DEEP_MD) {
    await api.openFileByPath(DEEP_MD)
    await sleep(900)
  }
  // Collapse the deep fixture's top ancestor and expand an unrelated folder
  // ("src") so the tree now shows a different region without the active row.
  const fileTreeContainer = document.querySelector<HTMLElement>('.project-editor-tree')
  const clickItemByPath = (path: string): boolean => {
    const el = fileTreeContainer?.querySelector<HTMLElement>(
      `.project-editor-tree-item[data-path="${CSS.escape(path)}"]`
    )
    if (!el) return false
    el.click()
    return true
  }
  // Collapse the top ancestor twice? Nope — a single click toggles. We want
  // the deep row *not* to be visible before clicking Locate.
  // Make sure sidebar-deep is collapsed (click to toggle if currently open).
  let expandedSnapshot = new Set(api.getFileBrowserExpandedDirs!())
  if (expandedSnapshot.has('test/fixtures/sidebar-deep')) {
    clickItemByPath('test/fixtures/sidebar-deep')
    await sleep(250)
    expandedSnapshot = new Set(api.getFileBrowserExpandedDirs!())
  }
  // Ensure some unrelated folder is expanded so the tree layout has
  // changed in a way that doesn't reveal the deep target row. If src/ is
  // already expanded, fine; otherwise click to expand.
  if (!expandedSnapshot.has('src')) {
    clickItemByPath('src')
    await sleep(500)
    expandedSnapshot = new Set(api.getFileBrowserExpandedDirs!())
  }
  const ancestorCollapsed = !expandedSnapshot.has('test/fixtures/sidebar-deep')
  const unrelatedExpanded = expandedSnapshot.has('src')
  record('SA-09-setup-state', ancestorCollapsed && unrelatedExpanded, {
    ancestorCollapsed,
    unrelatedExpanded,
    expandedSample: Array.from(expandedSnapshot).slice(0, 8)
  })

  // Now press Locate — it must re-expand the full ancestor chain and
  // center the row even though we did nothing to tell it about the deep file
  // other than that it's the editor's active file.
  const located = api.clickLocateFileButton!()
  record('SA-09-button-clicked', located)
  if (!located) return results
  await sleep(1800)

  const revealDiag09 = (window as unknown as { __onwardFileBrowserRevealDiag?: unknown }).__onwardFileBrowserRevealDiag
  log('SA-09:reveal-diag', revealDiag09)
  const expandedAfter = new Set(api.getFileBrowserExpandedDirs!())
  const ancestors09 = [
    'test', 'test/fixtures', 'test/fixtures/sidebar-deep',
    'test/fixtures/sidebar-deep/alpha',
    'test/fixtures/sidebar-deep/alpha/beta',
    'test/fixtures/sidebar-deep/alpha/beta/gamma',
    'test/fixtures/sidebar-deep/alpha/beta/gamma/delta'
  ]
  const missingAfter = ancestors09.filter(p => !expandedAfter.has(p))
  record('SA-09-ancestors-reexpanded', missingAfter.length === 0, { missingAfter })

  const bounds09 = api.getFileBrowserActiveRowBounds!()
  const visible09 = inViewport(bounds09)
  const centered09 = visible09 && (bounds09?.centerOffsetRatio ?? 1) <= CENTER_TOLERANCE
  record('SA-09-row-centered-after-unrelated-expand', centered09, {
    visible: visible09,
    ratio: Number((bounds09?.centerOffsetRatio ?? 1).toFixed(3)),
    found: bounds09?.found,
    scrollTop: api.getFileBrowserScrollTop?.(),
    scrollHeight: api.getFileBrowserScrollHeight?.()
  })

  // ---------------------------------------------------------------
  // SA-11: Reveal queued while in Search mode replays when user returns to
  //        Files mode.
  // ---------------------------------------------------------------
  log('SA-11:setup', {})
  // Start from a clean state: open a shallow file so DEEP_MD isn't active.
  await api.openFileByPath('CLAUDE.md')
  await sleep(500)
  // Switch to Search mode — this unmounts the tree. Now open the deep file
  // via openFileByPath (simulating a Search-result click). The reveal must
  // not fail silently; it should defer until the tree is remounted.
  api.setSidebarMode?.('search')
  await sleep(250)
  record('SA-11-sidebar-in-search', api.getSidebarMode?.() === 'search', {
    mode: api.getSidebarMode?.()
  })
  await api.openFileByPath(DEEP_MD)
  await sleep(600)
  // At this point reveal should have bailed with skippedNoContainer and
  // stored pending. Flip back to Files.
  api.setSidebarMode?.('files')
  await sleep(1400)
  const expandedSA11 = new Set(api.getFileBrowserExpandedDirs!())
  const ancestors11 = [
    'test/fixtures/sidebar-deep',
    'test/fixtures/sidebar-deep/alpha/beta/gamma/delta'
  ]
  const missingSA11 = ancestors11.filter(p => !expandedSA11.has(p))
  const bounds11 = api.getFileBrowserActiveRowBounds!()
  const centered11 = inViewport(bounds11) && (bounds11?.centerOffsetRatio ?? 1) <= CENTER_TOLERANCE
  record('SA-11-replays-after-mode-switch', missingSA11.length === 0 && centered11, {
    missingAncestors: missingSA11,
    visible: inViewport(bounds11),
    ratio: Number((bounds11?.centerOffsetRatio ?? 1).toFixed(3)),
    scrollTop: api.getFileBrowserScrollTop?.()
  })

  // ---------------------------------------------------------------
  // SA-12: Rapid file switch aborts the in-flight stale reveal.
  //        Open DEEP_MD, then immediately open CLAUDE.md. The final state
  //        must reflect CLAUDE.md (selection + centered row).
  // ---------------------------------------------------------------
  log('SA-12:setup', {})
  // Kick off the deep-file open (its reveal starts in the background).
  const deepOpen = api.openFileByPath(DEEP_MD)
  // Immediately trigger a second open — synchronous from test's POV.
  await sleep(30)
  const shallowOpen = api.openFileByPath('CLAUDE.md')
  await Promise.all([deepOpen, shallowOpen])
  await sleep(1500)
  const active12 = api.getActiveFilePath()
  const revealDiag12 = (window as unknown as { __onwardFileBrowserRevealDiag?: { lastPath?: string; lastReason?: string } }).__onwardFileBrowserRevealDiag
  const bounds12 = api.getFileBrowserActiveRowBounds!()
  const centered12 = inViewport(bounds12) && (bounds12?.centerOffsetRatio ?? 1) <= CENTER_TOLERANCE
  record('SA-12-final-active-is-shallow', active12 === 'CLAUDE.md', { active: active12 })
  record('SA-12-no-stale-reveal', centered12, {
    lastRevealPath: revealDiag12?.lastPath,
    lastReason: revealDiag12?.lastReason,
    visible: inViewport(bounds12),
    ratio: Number((bounds12?.centerOffsetRatio ?? 1).toFixed(3))
  })

  // ---------------------------------------------------------------
  // SA-10: Summary (informational)
  // ---------------------------------------------------------------
  record('SA-10-summary', true, {
    maxOutlinePreviewRatio: Number(maxOutlineCenterRatio.toFixed(3)),
    maxOutlineCodeRatio: Number(maxCodeRatio.toFixed(3)),
    maxOutlineEditorRatio: Number(maxEditorRatio.toFixed(3))
  })

  return results
}
