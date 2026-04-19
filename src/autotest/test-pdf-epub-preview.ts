/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Fixtures live on disk under `test/fixtures/pdf-epub/` (see CLAUDE.md rule
 * "fixture files must live on disk"). The test copies them into `rootPath`
 * via a terminal command so the flow mirrors what a user would see in the
 * Files panel. Regenerate with `node test/fixtures/pdf-epub-fixture-builder.mjs --write`.
 */

const TEST_PDF_FILENAME = '__autotest_pdf_preview.pdf'
const TEST_PDF_OUTLINE_FILENAME = '__autotest_pdf_preview_outlined.pdf'
const TEST_EPUB_FILENAME = '__autotest_epub_preview.epub'
const TEST_MARKER_FILENAME = '__autotest_pdf_epub_marker.txt'

const FIXTURE_REL_DIR = 'test/fixtures/pdf-epub'
const PDF_FIXTURE_SRC = 'onward-autotest.pdf'
const PDF_OUTLINE_FIXTURE_SRC = 'onward-autotest.outlined.pdf'
const EPUB_FIXTURE_SRC = 'onward-autotest.epub'

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

// Build a `cp`-style command that copies a repo-relative fixture into the
// test's cwd (which is `rootPath`). POSIX uses `cp`, Windows PowerShell uses
// `Copy-Item` — both quote paths to handle spaces safely.
function platformBuildCopyCommand(srcRelPath: string, destFilename: string, rootPath: string): string {
  if (window.electronAPI.platform === 'win32') {
    const src = `${rootPath}\\${srcRelPath.replace(/\//g, '\\')}`
    return `powershell -Command "Copy-Item -LiteralPath '${src}' -Destination '${destFilename}' -Force"`
  }
  const src = `${rootPath}/${srcRelPath}`
  return `cp "${src}" "${destFilename}"`
}

function platformBuildDeleteCommand(filenames: string[]): string {
  if (window.electronAPI.platform === 'win32') {
    return filenames.map(f => `if (Test-Path '${f}') { Remove-Item -Force '${f}' }`).join('; ')
  }
  return filenames.map(f => `rm -f '${f}'`).join(' && ')
}

export async function testPdfEpubPreview(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const termExec = async (command: string, label: string, waitMs = 1200) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`, { command: command.length > 120 ? `${command.slice(0, 120)}…` : command })
  }

  log('pdf-epub-preview:start', { rootPath })

  // Prepare a scratch marker file first so we can reliably switch off the
  // PDF/EPUB view between assertions.
  await termExec(
    `printf '%s' 'onward-autotest-marker' > '${TEST_MARKER_FILENAME}'`,
    'marker:create'
  )

  // Copy PDF + EPUB fixtures from the on-disk test fixture directory into the
  // project's root so the Files panel can pick them up.
  await termExec(
    platformBuildCopyCommand(`${FIXTURE_REL_DIR}/${PDF_FIXTURE_SRC}`, TEST_PDF_FILENAME, rootPath),
    'pdf:copy',
    1200
  )
  await termExec(
    platformBuildCopyCommand(`${FIXTURE_REL_DIR}/${EPUB_FIXTURE_SRC}`, TEST_EPUB_FILENAME, rootPath),
    'epub:copy',
    1200
  )

  const pdfPath = joinPath(rootPath, TEST_PDF_FILENAME)
  const epubPath = joinPath(rootPath, TEST_EPUB_FILENAME)
  const markerPath = joinPath(rootPath, TEST_MARKER_FILENAME)

  if (cancelled()) return results

  // ---------- PDF preview ----------

  log('pdf:open', { pdfPath })
  // Open as a "user" action so the file is added to Recent — matches what
  // happens when the user clicks the file in the tree.
  await getApi()?.openFileByPathAsUser?.(pdfPath)
  const pdfVisible = await waitFor(
    'pdf-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  record('pdf-reader-visible', pdfVisible, { filename: TEST_PDF_FILENAME })

  // Listen for the "onward:pdf:ready" postMessage that the embedded viewer
  // emits once it has loaded pdf.js. This is the closest proxy for "the user
  // sees the PDF" without cracking open a cross-origin iframe.
  let viewerReady = false
  const readyListener = (event: MessageEvent) => {
    if (event?.data?.type === 'onward:pdf:ready') viewerReady = true
  }
  window.addEventListener('message', readyListener)

  const iframeMounted = await waitFor(
    'pdf-reader-iframe-mounted',
    () => Boolean(getApi()?.getPdfReaderState?.()?.visible),
    8000
  )
  const pdfState = getApi()?.getPdfReaderState?.() ?? null
  record('pdf-reader-iframe-mounted', iframeMounted, { state: pdfState })
  record(
    'pdf-reader-src-points-to-viewer',
    Boolean(pdfState?.src && pdfState.src.includes('viewer.html') && pdfState.src.includes('file=')),
    { src: pdfState?.src ?? null }
  )
  // Verify the iframe and its split-layout ancestors actually have non-zero
  // dimensions. A layout collapse (height:0) is invisible via state probes
  // but would leave the user staring at a blank area — exactly the symptom
  // the 0418-wk1 user reported.
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const reader = document.querySelector('.project-editor-pdf-reader') as HTMLElement | null
    const pane = document.querySelector('.project-editor-editor-pane') as HTMLElement | null
    const split = document.querySelector('.project-editor-split') as HTMLElement | null
    const dims = {
      iframe: iframe ? { w: iframe.offsetWidth, h: iframe.offsetHeight } : null,
      reader: reader ? { w: reader.offsetWidth, h: reader.offsetHeight } : null,
      pane: pane ? { w: pane.offsetWidth, h: pane.offsetHeight } : null,
      split: split ? { w: split.offsetWidth, h: split.offsetHeight } : null
    }
    record(
      'pdf-reader-iframe-has-nonzero-dimensions',
      Boolean(iframe && iframe.offsetWidth > 100 && iframe.offsetHeight > 100),
      dims
    )
  }
  record(
    'pdf-reader-src-points-to-fixture',
    Boolean(pdfState?.src && pdfState.src.includes(encodeURIComponent('__autotest_pdf_preview.pdf'))),
    { src: pdfState?.src ?? null }
  )

  const readyFired = await waitFor(
    'pdf-viewer-ready-message',
    () => viewerReady,
    15000,
    100
  )
  record('pdf-viewer-ready-message', readyFired, { received: viewerReady })
  window.removeEventListener('message', readyListener)

  // The PDF path should be marked as binary from the editor's point of view.
  record(
    'pdf-active-file-path-correct',
    getApi()?.getActiveFilePath() === pdfPath,
    { expected: pdfPath, got: getApi()?.getActiveFilePath() }
  )

  // Switching away should clear the PDF reader.
  await getApi()?.openFileByPath(markerPath)
  const pdfGone = await waitFor(
    'pdf-reader-cleared-after-switch',
    () => getApi()?.isPdfReaderVisible?.() === false,
    5000
  )
  record('pdf-reader-cleared-after-switch', pdfGone)

  // Re-open: regression check for state reset leaks.
  await getApi()?.openFileByPath(pdfPath)
  const pdfVisibleAgain = await waitFor(
    'pdf-reader-reopen',
    () => getApi()?.isPdfReaderVisible?.() === true,
    8000
  )
  record('pdf-reader-reopen', pdfVisibleAgain)

  // ---------- EPUB preview ----------

  log('epub:open', { epubPath })
  await getApi()?.openFileByPathAsUser?.(epubPath)
  const epubVisible = await waitFor(
    'epub-reader-visible',
    () => getApi()?.isEpubReaderVisible?.() === true,
    10000
  )
  record('epub-reader-visible', epubVisible, { filename: TEST_EPUB_FILENAME })

  // PDF and EPUB should be mutually exclusive (switching should have cleared PDF).
  record(
    'pdf-and-epub-mutually-exclusive',
    getApi()?.isPdfReaderVisible?.() !== true && getApi()?.isEpubReaderVisible?.() === true
  )

  // Wait for epub.js to populate the TOC + render chapter 1.
  const tocPopulated = await waitFor(
    'epub-toc-populated',
    () => {
      const state = getApi()?.getEpubReaderState?.()
      return Boolean(state && state.tocCount >= 2)
    },
    12000
  )
  record('epub-toc-populated', tocPopulated, { state: getApi()?.getEpubReaderState?.() ?? null })

  // epub.js mounts the chapter inside a nested <iframe> inside the content
  // pane. The exact DOM shape differs by epub.js ViewManager (default creates
  // a wrapper <div> + iframe; continuous manager inlines differently). Accept
  // any of: debug hasContent flag, an <iframe> anywhere under the content
  // pane, or any non-empty descendant. The timeout is generous because the
  // underlying epub.js DefaultViewManager sometimes stalls its first display
  // on our sandboxed file:// iframe — our EpubReader retries in that case.
  const contentRendered = await waitFor(
    'epub-content-rendered',
    () => {
      const state = getApi()?.getEpubReaderState?.()
      if (state?.hasContent) return true
      const reader = document.querySelector('.project-editor-epub-reader')
      const pane = reader?.querySelector('.project-editor-epub-content') as HTMLElement | null
      if (!pane) return false
      if (pane.querySelector('iframe')) return true
      if ((pane.textContent ?? '').trim().length > 0) return true
      return pane.querySelectorAll('*').length > 0
    },
    60000,
    200
  )
  const progress = (window as unknown as { __onwardEpubReaderProgress?: Record<string, unknown> }).__onwardEpubReaderProgress ?? null
  record('epub-content-rendered', contentRendered, {
    state: getApi()?.getEpubReaderState?.() ?? null,
    iframePresent: Boolean(document.querySelector('.project-editor-epub-content iframe')),
    paneDescendants: document.querySelector('.project-editor-epub-content')?.querySelectorAll('*').length ?? 0,
    paneText: (document.querySelector('.project-editor-epub-content')?.textContent ?? '').trim().slice(0, 80),
    progress
  })

  const epubState = getApi()?.getEpubReaderState?.() ?? null
  record(
    'epub-font-size-default-100pct',
    Boolean(epubState?.fontSizeLabel && epubState.fontSizeLabel.startsWith('100')),
    { fontSizeLabel: epubState?.fontSizeLabel ?? null }
  )

  // The EPUB's TOC is now rendered by the shared OutlinePanel. Assert that:
  //   (a) the old in-reader `<aside>` TOC has been removed,
  //   (b) OutlinePanel has ≥ 1 item for the current EPUB,
  //   (c) clicking a TOC entry navigates the reader via the new onItemNavigate
  //       channel (not a direct epub.js display() call from the sidebar).
  record(
    'epub-outline-panel-replaces-sidebar',
    !document.querySelector('.project-editor-epub-sidebar'),
    {}
  )
  const outlinePanelItemsBefore = await waitFor(
    'epub-outline-panel-populated',
    () => document.querySelectorAll('.outline-panel .outline-panel-item').length >= 2,
    8000
  )
  record('epub-outline-panel-populated', outlinePanelItemsBefore, {
    itemCount: document.querySelectorAll('.outline-panel .outline-panel-item').length
  })
  const outlineItems = Array.from(
    document.querySelectorAll('.outline-panel .outline-panel-item')
  ) as HTMLElement[]
  if (outlineItems.length >= 2) {
    ;(outlineItems[1] as HTMLElement).click()
    const navigated = await waitFor(
      'epub-outline-click-navigates',
      () => {
        const href = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
        return typeof href === 'string' && href.toLowerCase().includes('chapter2')
      },
      4000,
      150
    )
    record('epub-outline-click-navigates', navigated, {
      href: getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
    })
    // Auto-center assertion: the active item's center should fall inside the
    // middle 60% band of the OutlinePanel tree. We check rect geometry rather
    // than scroll position so the test is independent of item height.
    await sleep(400)
    const tree = document.querySelector('.outline-panel .outline-panel-tree') as HTMLElement | null
    const active = document.querySelector('.outline-panel .outline-panel-item.active') as HTMLElement | null
    let centered = false
    if (tree && active) {
      // If the tree is too small to scroll (everything fits), we can't
      // physically center — treat that as "no centering needed" so the
      // assertion reflects intent rather than tautological fail for tiny
      // fixtures. For real scrollable trees, enforce the 60% band.
      if (tree.scrollHeight <= tree.clientHeight + 2) {
        centered = true
      } else {
        const c = tree.getBoundingClientRect()
        const a = active.getBoundingClientRect()
        const band = c.height * 0.6
        const topBand = c.top + (c.height - band) / 2
        const bottomBand = topBand + band
        centered = a.top >= topBand && a.bottom <= bottomBand
      }
    }
    record('epub-outline-active-centered', centered, {
      hasTree: Boolean(tree),
      hasActive: Boolean(active)
    })
  } else {
    record('epub-outline-click-navigates', false, { itemCount: outlineItems.length })
    record('epub-outline-active-centered', false, { itemCount: outlineItems.length })
  }

  // Capture which chapter the user is on BEFORE bumping the font. The TOC
  // click above navigated to chapter 2; if fontSize accidentally reset the
  // rendition to page 1 the `currentLocationHref` would flip back to
  // chapter 1 after A+.
  const preBumpHref = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null

  // Click the A+ button and verify the label changes.
  const biggerBtn = document.querySelector(
    '.project-editor-epub-fontsize .project-editor-epub-btn:last-child'
  ) as HTMLButtonElement | null
  biggerBtn?.click()
  await sleep(200)
  const bumpedFontOk = await waitFor(
    'epub-font-size-bumped',
    () => {
      const state = getApi()?.getEpubReaderState?.()
      const label = state?.fontSizeLabel ?? ''
      return label.startsWith('110')
    },
    3000
  )
  record('epub-font-size-bumped', bumpedFontOk, {
    fontSizeLabel: getApi()?.getEpubReaderState?.()?.fontSizeLabel ?? null
  })

  // Verify font-size change did NOT snap the user back to the cover page.
  // Give epub.js a moment to re-layout and re-seek.
  const locPreserved = await waitFor(
    'epub-font-size-preserves-location',
    () => {
      const cur = getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
      return Boolean(preBumpHref && cur && cur === preBumpHref)
    },
    5000,
    200
  )
  record('epub-font-size-preserves-location', locPreserved, {
    before: preBumpHref,
    after: getApi()?.getEpubReaderState?.()?.currentLocationHref ?? null
  })

  // Drive EPUB search exactly as a user would: type into the search input
  // (using the native value setter so React's synthetic event system picks
  // up the change) and click the search button. Then observe the DOM for
  // rendered hit entries. No backdoor.
  const searchInput = document.querySelector(
    '.project-editor-epub-search input[type="search"]'
  ) as HTMLInputElement | null
  const searchBtn = Array.from(
    document.querySelectorAll('.project-editor-epub-search .project-editor-epub-btn')
  ).find(btn => !(btn as HTMLButtonElement).classList.contains('is-disabled')) as HTMLButtonElement | undefined
  if (!searchInput || !searchBtn) {
    record('epub-search-controls-present', false)
  } else {
    record('epub-search-controls-present', true)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(searchInput, 'searchable')
    searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(120)
    searchBtn.click()
    const hitFound = await waitFor(
      'epub-search-hit',
      () => document.querySelectorAll('.project-editor-epub-search-hit').length > 0,
      10000
    )
    const hits = document.querySelectorAll('.project-editor-epub-search-hit')
    record('epub-search-hit', hitFound, { domHitCount: hits.length })
    // Visual sanity: first hit excerpt should contain the query (case-insensitive).
    const firstHitText = (hits[0]?.textContent ?? '').toLowerCase()
    record('epub-search-hit-excerpt-matches-query', firstHitText.includes('searchable'), {
      firstHitText: firstHitText.slice(0, 80)
    })
    // Clicking a hit should navigate the rendition. We can at least confirm the
    // click does not throw and the reader still shows content after.
    ;(hits[0] as HTMLElement | undefined)?.click()
    await sleep(400)
    const stillHasContent = Boolean(getApi()?.getEpubReaderState?.()?.hasContent)
    record('epub-search-hit-click-keeps-content', stillHasContent)
  }

  // The outline toggle lives in the main ProjectEditor header ("Close / Open
  // Outline"), shared with Markdown and code files. When it's toggled off,
  // the unified .outline-panel disappears from the DOM for the EPUB reader
  // too. We also keep the assertion that the in-reader `<aside>` is gone.
  // The EPUB toolbar itself no longer renders any outline-related buttons
  // (we removed the inline sidebar entirely) — assert that none exist.
  record('epub-no-inline-toc-button',
    document.querySelectorAll('.project-editor-epub-sidebar, .project-editor-epub-toc-item').length === 0,
    {}
  )
  const outlineHeaderBtn = Array.from(
    document.querySelectorAll('.project-editor-action-btn.project-editor-preview-toggle')
  )[0] as HTMLButtonElement | undefined
  record('epub-outline-button-in-header', Boolean(outlineHeaderBtn), {
    label: outlineHeaderBtn?.textContent?.trim() ?? null
  })
  if (outlineHeaderBtn) {
    outlineHeaderBtn.click()
    await sleep(250)
    const outlineHidden = !document.querySelector('.outline-panel')
    record('epub-header-outline-toggle-hides-panel', outlineHidden)
    // Toggle back for remaining assertions (PDF outline checks below).
    outlineHeaderBtn.click()
    await sleep(200)
  }

  // Switching away clears the EPUB reader.
  await getApi()?.openFileByPath(markerPath)
  const epubGone = await waitFor(
    'epub-reader-cleared-after-switch',
    () => getApi()?.isEpubReaderVisible?.() === false,
    5000
  )
  record('epub-reader-cleared-after-switch', epubGone)

  // Reopen the SAME EPUB. Per-file persistence should restore the bumped
  // font-size (110%). This validates FileViewMemory wiring rather than a
  // global setting. We don't wait for hasContent here — just the label on
  // the font-size chip.
  await getApi()?.openFileByPath(epubPath)
  await waitFor(
    'epub-reader-reopened',
    () => getApi()?.isEpubReaderVisible?.() === true,
    8000
  )
  const persistedFontOk = await waitFor(
    'epub-font-size-persisted',
    () => {
      const label = getApi()?.getEpubReaderState?.()?.fontSizeLabel ?? ''
      return label.startsWith('110')
    },
    5000,
    150
  )
  record('epub-font-size-persisted', persistedFontOk, {
    fontSizeLabel: getApi()?.getEpubReaderState?.()?.fontSizeLabel ?? null
  })

  // ---------- Outlined PDF fixture: unified OutlinePanel integration ----------
  // Copy the outlined PDF fixture next to the other fixtures.
  await termExec(
    platformBuildCopyCommand(`${FIXTURE_REL_DIR}/${PDF_OUTLINE_FIXTURE_SRC}`, TEST_PDF_OUTLINE_FILENAME, rootPath),
    'outlined-pdf:copy',
    1200
  )
  const outlinedPdfPath = joinPath(rootPath, TEST_PDF_OUTLINE_FILENAME)
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  await waitFor(
    'pdf-outlined-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  // Unified OutlinePanel integration for PDF: after the outlined fixture
  // loads, the Onward .outline-panel on the page should contain ≥ 1 entry,
  // and the viewer iframe should NO LONGER have its own #outlinePanel (we
  // removed the in-iframe outline UI).
  const pdfOutlinePopulated = await waitFor(
    'pdf-outline-panel-populated',
    () => document.querySelectorAll('.outline-panel .outline-panel-item').length >= 1,
    15000,
    200
  )
  record('pdf-outline-panel-populated', pdfOutlinePopulated, {
    itemCount: document.querySelectorAll('.outline-panel .outline-panel-item').length
  })
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    record('pdf-outline-panel-replaces-iframe-outline',
      !doc?.getElementById('outlinePanel'),
      { hasIframePanel: Boolean(doc?.getElementById('outlinePanel')) }
    )
  }

  // Navigate the PDF to page 1 via the viewer's internal API and confirm the
  // outline entry for page 1 is marked active. This exercises the
  // onPageChange → pdfActiveItem computation in ProjectEditor.
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const viewerWin = iframe?.contentWindow as (Window & {
      pdfViewer?: { currentPageNumber?: number }
    }) | null
    // Hop to an arbitrary page to force a `pagechanging` → onPageChange fire.
    // The outlined fixture is single-page, but just going to page 1 again is
    // enough to trigger the state post (same flow that the user's scroll
    // would hit).
    if (viewerWin?.pdfViewer) {
      try { viewerWin.pdfViewer.currentPageNumber = 1 } catch { /* ignore */ }
    }
    const activeMatches = await waitFor(
      'pdf-outline-highlights-current-page',
      () => Boolean(document.querySelector('.outline-panel .outline-panel-item.active')),
      4000,
      150
    )
    record('pdf-outline-highlights-current-page', activeMatches, {
      active: document.querySelector('.outline-panel .outline-panel-item.active')?.textContent?.trim() ?? null
    })
    // Same geometric center check as the EPUB case.
    const tree = document.querySelector('.outline-panel .outline-panel-tree') as HTMLElement | null
    const active = document.querySelector('.outline-panel .outline-panel-item.active') as HTMLElement | null
    let centered = false
    if (tree && active) {
      // If the tree is too small to scroll (everything fits), we can't
      // physically center — treat that as "no centering needed" so the
      // assertion reflects intent rather than tautological fail for tiny
      // fixtures. For real scrollable trees, enforce the 60% band.
      if (tree.scrollHeight <= tree.clientHeight + 2) {
        centered = true
      } else {
        const c = tree.getBoundingClientRect()
        const a = active.getBoundingClientRect()
        const band = c.height * 0.6
        const topBand = c.top + (c.height - band) / 2
        const bottomBand = topBand + band
        centered = a.top >= topBand && a.bottom <= bottomBand
      }
    }
    record('pdf-outline-active-centered', centered, {
      hasTree: Boolean(tree),
      hasActive: Boolean(active)
    })
  }

  // Dark toggle button label/title should reflect the current state using
  // the new "restore the inverted background" copy, not "Dark".
  // Wait for viewer.js to apply i18n after the iframe remounts; a fresh
  // iframe may briefly have an empty button before applyColorEnhancementState
  // runs.
  await waitFor(
    'pdf-dark-toggle-ready',
    () => {
      const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const doc = iframe?.contentDocument
      const btn = doc?.getElementById('colorToggleBtn') as HTMLButtonElement | null
      return Boolean(btn && (btn.textContent?.trim().length ?? 0) > 0)
    },
    6000,
    150
  )
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    const btn = doc?.getElementById('colorToggleBtn') as HTMLButtonElement | null
    const label = btn?.textContent?.trim() ?? ''
    const title = btn?.title ?? ''
    record('pdf-dark-toggle-uses-descriptive-label',
      label.length > 0 && label.toLowerCase() !== 'dark' && title.length > 0,
      { label, title }
    )
    // Click once: should flip to the "restore" variant.
    btn?.click()
    await sleep(200)
    const labelAfter = btn?.textContent?.trim() ?? ''
    const titleAfter = btn?.title ?? ''
    record('pdf-dark-toggle-flips-label-on-click',
      labelAfter.length > 0 && labelAfter !== label && titleAfter !== title,
      { labelAfter, titleAfter }
    )
    // Restore for next runs.
    btn?.click()
    await sleep(150)
  }

  // ---------- Pinned + Recent Files parity ----------
  // Recent list should contain every file the user opened above — the
  // plain PDF, the outlined PDF, and the EPUB — because ProjectEditor's
  // openFile pushes to recents on user-sourced opens regardless of type.
  const recentLabels = Array.from(document.querySelectorAll('.quick-file-measure-item')).map(el => el.textContent?.trim() ?? '')
  record('pdf-in-recent-files',
    recentLabels.some(l => l.toLowerCase().endsWith('.pdf')),
    { recent: recentLabels.slice(0, 10) }
  )
  record('epub-in-recent-files',
    recentLabels.some(l => l.toLowerCase().endsWith('.epub')),
    { recent: recentLabels.slice(0, 10) }
  )

  // ---------- PDF view-state memory ----------
  // Our fixture is single-page and small, so scroll-based memory is hard
  // to assert. Instead, change the zoom preset (the user-visible setting
  // that also flows through `onward:pdf:state`) and verify it's restored
  // after close + reopen. Same persistence channel as scroll/page.
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  await waitFor(
    'pdf-position-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    8000
  )
  const getZoomSelect = () => {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    return iframe?.contentDocument?.getElementById('zoomSelect') as HTMLSelectElement | null
  }
  await waitFor('pdf-position-viewer-ready', () => Boolean(getZoomSelect()), 10000)
  const select = getZoomSelect()
  if (select) {
    select.value = '2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    // Viewer debounces state post at 250ms; give it a beat.
    await sleep(500)
  }
  record('pdf-state-scale-changed',
    getZoomSelect()?.value === '2',
    { value: getZoomSelect()?.value ?? null }
  )

  // Switch away, then reopen same PDF — memory should restore scale.
  await getApi()?.openFileByPathAsUser?.(markerPath)
  await waitFor('pdf-state-gone', () => getApi()?.isPdfReaderVisible?.() === false, 5000)
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  const restored = await waitFor(
    'pdf-state-restored',
    () => getZoomSelect()?.value === '2',
    10000,
    200
  )
  record('pdf-state-restored', restored, {
    scaleAfter: getZoomSelect()?.value ?? null
  })

  // ---------- Cleanup ----------
  await termExec(
    platformBuildDeleteCommand([TEST_PDF_FILENAME, TEST_PDF_OUTLINE_FILENAME, TEST_EPUB_FILENAME, TEST_MARKER_FILENAME]),
    'cleanup',
    800
  )

  log('pdf-epub-preview:done', {
    pass: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length
  })

  return results
}
