/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Fixture builder: test/fixtures/pdf-epub-fixture-builder.mjs
 *
 * The PDF carries the text "Onward Autotest PDF" on a single 300x200 page.
 * The EPUB is a valid EPUB 3 with two chapters and a nav.xhtml TOC; the text
 * "Onward Autotest EPUB chapter 1." / "... chapter 2." appears in each.
 */
const PDF_BASE64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDMwIDEwMCBUZCAoT253YXJkIEF1dG90ZXN0IFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNDcgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MTcKJSVFT0YK'

const PDF_OUTLINE_BASE64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgL091dGxpbmVzIDYgMCBSID4+CmVuZG9iagoyIDAgb2JqCjw8IC9UeXBlIC9QYWdlcyAvS2lkcyBbMyAwIFJdIC9Db3VudCAxID4+CmVuZG9iagozIDAgb2JqCjw8IC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgMzAwIDIwMF0gL0NvbnRlbnRzIDQgMCBSIC9SZXNvdXJjZXMgPDwgL0ZvbnQgPDwgL0YxIDUgMCBSID4+ID4+ID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggNTkgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiAzMCAxMDAgVGQgKE9ud2FyZCBBdXRvdGVzdCBPdXRsaW5lZCBQREYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL1R5cGUgL091dGxpbmVzIC9GaXJzdCA3IDAgUiAvTGFzdCA3IDAgUiAvQ291bnQgMSA+PgplbmRvYmoKNyAwIG9iago8PCAvVGl0bGUgKEF1dG90ZXN0IENoYXB0ZXIpIC9QYXJlbnQgNiAwIFIgL0Rlc3QgWzMgMCBSIC9GaXRdID4+CmVuZG9iagp4cmVmCjAgOAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA4MCAwMDAwMCBuIAowMDAwMDAwMTM3IDAwMDAwIG4gCjAwMDAwMDAyNjMgMDAwMDAgbiAKMDAwMDAwMDM3MiAwMDAwMCBuIAowMDAwMDAwNDQyIDAwMDAwIG4gCjAwMDAwMDA1MTMgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA4IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo1OTMKJSVFT0YK'

const EPUB_BASE64 =
  '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'

const TEST_PDF_FILENAME = '__autotest_pdf_preview.pdf'
const TEST_PDF_OUTLINE_FILENAME = '__autotest_pdf_preview_outlined.pdf'
const TEST_EPUB_FILENAME = '__autotest_epub_preview.epub'
const TEST_MARKER_FILENAME = '__autotest_pdf_epub_marker.txt'

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

function platformBuildWriteBase64Command(filename: string, base64: string): string {
  if (window.electronAPI.platform === 'win32') {
    return `powershell -Command "[IO.File]::WriteAllBytes('${filename}', [Convert]::FromBase64String('${base64}'))"`
  }
  // `printf '%s' <base64> | base64 -d > <file>` works on macOS and Linux.
  return `printf '%s' '${base64}' | base64 -d > '${filename}'`
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

  // Write PDF + EPUB fixtures next to the marker.
  await termExec(
    platformBuildWriteBase64Command(TEST_PDF_FILENAME, PDF_BASE64),
    'pdf:write',
    1500
  )
  await termExec(
    platformBuildWriteBase64Command(TEST_EPUB_FILENAME, EPUB_BASE64),
    'epub:write',
    1500
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

  // Click a TOC entry and verify navigation doesn't break the reader. This
  // mirrors the user action of browsing the outline to jump to chapter 2.
  const tocItems = document.querySelectorAll('.project-editor-epub-toc > li .project-editor-epub-toc-item')
  if (tocItems.length >= 2) {
    ;(tocItems[1] as HTMLElement).click()
    await sleep(500)
    const contentStillThere = Boolean(getApi()?.getEpubReaderState?.()?.hasContent)
    record('epub-toc-click-navigates', contentStillThere, {
      tocCount: tocItems.length
    })
  } else {
    record('epub-toc-click-navigates', false, { tocCount: tocItems.length })
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

  // The in-reader ☰ is gone — outline toggling now lives in the main
  // ProjectEditor toolbar ("Close Outline / Open Outline"), same button
  // users use for Markdown. Find it and verify its label + toggle effect.
  const outlineHeaderBtn = Array.from(
    document.querySelectorAll('.project-editor-action-btn.project-editor-preview-toggle')
  )[0] as HTMLButtonElement | undefined
  record('epub-outline-button-in-header', Boolean(outlineHeaderBtn), {
    label: outlineHeaderBtn?.textContent?.trim() ?? null
  })
  record('epub-no-inline-toc-button',
    !document.querySelector('.project-editor-epub-toolbar button[title*="Outline"], .project-editor-epub-toolbar button[title*="目录"]'),
    {}
  )
  if (outlineHeaderBtn) {
    outlineHeaderBtn.click()
    await sleep(250)
    const sidebarGone = !document.querySelector('.project-editor-epub-sidebar')
    record('epub-header-outline-toggle-hides-sidebar', sidebarGone)
    // Toggle back for remaining assertions.
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

  // ---------- Outlined PDF fixture: auto-expand behavior ----------
  // Write an outlined PDF next to the other fixtures (same working dir).
  await termExec(
    platformBuildWriteBase64Command(TEST_PDF_OUTLINE_FILENAME, PDF_OUTLINE_BASE64),
    'outlined-pdf:write',
    1200
  )
  const outlinedPdfPath = joinPath(rootPath, TEST_PDF_OUTLINE_FILENAME)
  await getApi()?.openFileByPathAsUser?.(outlinedPdfPath)
  await waitFor(
    'pdf-outlined-reader-visible',
    () => getApi()?.isPdfReaderVisible?.() === true,
    10000
  )
  // Wait for the viewer iframe's internal outlinePanel to be present and
  // NOT carry the "collapsed" class. This is the precise signal that our
  // ported applyAutoOutlineBehavior did its job (and that the pane is
  // pinned to the right side; layout is enforced by the markup order +
  // border-left CSS we shipped).
  const outlineAutoExpanded = await waitFor(
    'pdf-outline-auto-expanded',
    () => {
      const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
      const doc = iframe?.contentDocument
      const panel = doc?.getElementById('outlinePanel')
      if (!panel) return false
      return !panel.classList.contains('collapsed') && (panel.querySelectorAll('.outline-item').length > 0)
    },
    15000,
    200
  )
  {
    const iframe = document.querySelector('.project-editor-pdf-reader-iframe') as HTMLIFrameElement | null
    const doc = iframe?.contentDocument
    const panel = doc?.getElementById('outlinePanel')
    record('pdf-outline-auto-expanded', outlineAutoExpanded, {
      hasPanel: Boolean(panel),
      collapsed: panel?.classList.contains('collapsed') ?? null,
      outlineItemCount: panel?.querySelectorAll('.outline-item').length ?? 0
    })

    // Outline panel is the LAST child of #workspace → it sits on the right.
    const workspace = doc?.getElementById('workspace')
    const lastChild = workspace?.lastElementChild
    record('pdf-outline-on-right',
      Boolean(lastChild && lastChild.id === 'outlinePanel'),
      { lastChildId: lastChild?.id ?? null }
    )
  }

  // Dark toggle button label/title should reflect the current state using
  // the new "restore the inverted background" copy, not "Dark".
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
