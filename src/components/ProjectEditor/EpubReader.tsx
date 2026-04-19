/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import ePub from 'epubjs'
import type { Book, NavItem, Rendition } from 'epubjs'
import { useI18n } from '../../i18n/useI18n'
import type { OutlineItem } from './Outline/types'
import { OutlineSymbolKind } from './Outline/types'

interface EpubReaderProps {
  /** Base64-encoded EPUB bytes delivered by the main process. */
  previewData: string
  filePath: string
  /** Optional per-file memory restored by the host. */
  initialFontPct?: number
  initialLocation?: string | null
  /** Precise scroll offset captured last time the file was open. Applied after
   * rendition.display() settles so restore lands pixel-exactly, not just on
   * the correct chapter. */
  initialScrollTop?: number
  /** Invoked when the user changes a persistable setting. */
  onMemoryChange?: (patch: {
    epubFontPct?: number
    epubLocation?: string | null
    epubScrollTop?: number
  }) => void
  /** Fires once after book.loaded.navigation with the TOC as OutlineItem[]. */
  onOutlineLoaded?: (items: OutlineItem[]) => void
  /** Fires when the rendition settles on a new chapter. Href is fragment-free. */
  onLocationChange?: (href: string | null) => void
}

export interface EpubReaderHandle {
  /** Navigate to a chapter by its spine href (fragment-free form is fine). */
  goToHref(href: string): void
}

type EpubSearchHit = {
  cfi: string
  excerpt: string
  href?: string
  label?: string
}

const MIN_FONT_PCT = 70
const MAX_FONT_PCT = 200
const FONT_STEP = 10

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function collectHostTheme(): { background: string; foreground: string; accent: string; muted: string; panel: string } {
  const style = window.getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => {
    const v = style.getPropertyValue(name).trim()
    return v || fallback
  }
  return {
    background: read('--background', '#0a0a0a'),
    foreground: read('--text', '#f0f0f0'),
    accent: read('--accent', '#7d8796'),
    muted: read('--muted', '#a9a9a9'),
    panel: read('--panel', '#121212')
  }
}

function clampFontPct(v: number | undefined | null): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 100
  return Math.max(MIN_FONT_PCT, Math.min(MAX_FONT_PCT, n))
}

// Strip trailing fragment (#...) so activeHref comparisons match the href
// shape we store in OutlineItem.target.
function stripFragment(href: string | undefined | null): string | null {
  if (!href) return null
  const hashIdx = href.indexOf('#')
  return hashIdx === -1 ? href : href.slice(0, hashIdx)
}

function flattenNavItems(items: NavItem[], depth = 0): OutlineItem[] {
  return items.map((item) => {
    const children = (item.subitems && item.subitems.length > 0)
      ? flattenNavItems(item.subitems, depth + 1)
      : []
    // Preserve the ORIGINAL href (including any `#anchor` fragment) so
    // navigation lands on the exact section. Active-item matching (done on
    // the host) strips the fragment at compare time instead.
    const href = item.href ?? ''
    return {
      name: item.label?.trim() || item.href || ' ',
      kind: OutlineSymbolKind.Heading1,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      children,
      depth,
      target: { kind: 'epub-href' as const, href }
    }
  })
}

export const EpubReader = forwardRef<EpubReaderHandle, EpubReaderProps>(function EpubReader(
  { previewData, filePath, initialFontPct, initialLocation, initialScrollTop, onMemoryChange, onOutlineLoaded, onLocationChange },
  ref
) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bookRef = useRef<Book | null>(null)
  const renditionRef = useRef<Rendition | null>(null)
  // Keep initialLocation / initialScrollTop fresh across file switches. These
  // refs are snapshotted at the start of the main mount effect (which re-runs
  // whenever previewData changes — i.e. per file open). Updating them on
  // prop change keeps them ready for the next effect run without triggering
  // a re-mount of the book.
  const initialLocationRef = useRef<string | null>(initialLocation ?? null)
  const initialScrollTopRef = useRef<number | undefined>(initialScrollTop)
  useEffect(() => {
    initialLocationRef.current = initialLocation ?? null
    initialScrollTopRef.current = initialScrollTop
  }, [filePath, initialLocation, initialScrollTop])
  const onMemoryChangeRef = useRef(onMemoryChange)
  useEffect(() => { onMemoryChangeRef.current = onMemoryChange }, [onMemoryChange])
  const onOutlineLoadedRef = useRef(onOutlineLoaded)
  useEffect(() => { onOutlineLoadedRef.current = onOutlineLoaded }, [onOutlineLoaded])
  const onLocationChangeRef = useRef(onLocationChange)
  useEffect(() => { onLocationChangeRef.current = onLocationChange }, [onLocationChange])
  // Suppress the very first `relocated` that epub.js fires as part of its
  // initial display; otherwise the first active-item computation would be
  // done before the rendition has settled.
  const bookReadyRef = useRef(false)
  // Debounce scroll-persist so we don't hammer the host on every scroll tick.
  // Uses the same idea as PdfReader's queueReadingStatePost.
  const scrollPersistTimerRef = useRef<number | null>(null)
  // While we're applying a restored scrollTop, ignore incoming scroll events
  // so the programmatic scroll doesn't get immediately re-persisted at a
  // slightly different value due to epub.js's internal layout shifts.
  const programmaticScrollUntilRef = useRef<number>(0)

  const [fontPct, setFontPct] = useState(clampFontPct(initialFontPct))
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<EpubSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchHitsOpen, setSearchHitsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const themeName = useMemo(() => 'onward-theme', [])

  useImperativeHandle(ref, () => ({
    goToHref(href: string) {
      const rendition = renditionRef.current
      if (!rendition) return
      try { void rendition.display(href) } catch { /* ignore */ }
    }
  }), [])

  const applyTheme = useCallback(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    const colors = collectHostTheme()
    rendition.themes.register(themeName, {
      'html, body': {
        background: colors.background,
        color: colors.foreground,
        'font-family': '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", -apple-system, sans-serif'
      },
      a: { color: colors.accent },
      'a:hover': { color: colors.accent, 'text-decoration': 'underline' },
      img: { 'max-width': '100%', height: 'auto' },
      code: {
        background: colors.panel,
        color: colors.foreground,
        'border-radius': '4px',
        padding: '0 4px'
      },
      blockquote: {
        'border-left': `3px solid ${colors.accent}`,
        color: colors.muted,
        'padding-left': '10px',
        margin: '8px 0'
      }
    })
    rendition.themes.select(themeName)
    // NOTE: font size is applied by the dedicated fontPct useEffect below —
    // keeping fontPct OUT of this callback's deps is load-bearing: otherwise
    // changing the size would invalidate applyTheme, which is a dep of the
    // main mount useEffect, which would tear down + recreate the book and
    // snap the user back to chapter 1.
  }, [themeName])

  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    setError(null)
    bookReadyRef.current = false

    let disposed = false
    let book: Book | null = null
    let rendition: Rendition | null = null
    let handleScroll: (() => void) | null = null

    try {
      const buffer = base64ToArrayBuffer(previewData)
      book = ePub(buffer) as Book
      bookRef.current = book

      rendition = book.renderTo(container, {
        width: '100%',
        height: '100%',
        flow: 'scrolled-doc',
        allowScriptedContent: false
      })
      renditionRef.current = rendition

      // Apply the theme once the book is ready so we don't race with epub.js's
      // internal startup sequence (which touches `book.package` in start()).
      const readyThen = (book.ready ?? book.opened) as Promise<unknown> | undefined
      void (readyThen ?? Promise.resolve()).then(() => {
        if (disposed) return
        applyTheme()
        bookReadyRef.current = true
      })

      // Track display progress for autotest visibility. These refs get
      // surfaced via the debug hook below.
      const progress = (window as unknown as {
        __onwardEpubReaderProgress?: {
          displayStarted: number
          displayResolved: number | null
          displayRejected: string | null
          containerWidth: number
          containerHeight: number
          lastBookOpened: boolean
        }
      })
      progress.__onwardEpubReaderProgress = {
        displayStarted: Date.now(),
        displayResolved: null,
        displayRejected: null,
        containerWidth: container?.offsetWidth ?? 0,
        containerHeight: container?.offsetHeight ?? 0,
        lastBookOpened: false
      }
      void book.opened.then(() => {
        if (progress.__onwardEpubReaderProgress) {
          progress.__onwardEpubReaderProgress.lastBookOpened = true
        }
      }).catch(() => {
        /* ignore */
      })
      const initialTarget = initialLocationRef.current ?? undefined
      // Hook persistence: record where the user is reading whenever the
      // rendition relocates. We debounce by swapping onMemoryChangeRef.
      rendition.on('relocated', (loc: { start?: { cfi?: string; href?: string } }) => {
        const cfi = loc?.start?.cfi ?? loc?.start?.href ?? null
        const rawHref = loc?.start?.href ?? null
        const href = stripFragment(rawHref)
        if (progress.__onwardEpubReaderProgress) {
          ;(progress.__onwardEpubReaderProgress as Record<string, unknown>).lastLocationHref = href
          ;(progress.__onwardEpubReaderProgress as Record<string, unknown>).lastLocationCfi = cfi
        }
        onMemoryChangeRef.current?.({ epubLocation: cfi })
        // Suppress the first `relocated` until the book has fully settled so
        // the outline doesn't flash-highlight chapter 1 on restore.
        if (bookReadyRef.current) {
          onLocationChangeRef.current?.(href)
        }
      })
      // Pixel-exact scroll restore: after display() resolves AND the content
      // has laid out enough for the host container to be scrollable, write
      // the saved scrollTop. epub.js's scrolled-doc manager lays out the
      // book incrementally as iframes render, so we poll briefly until
      // scrollHeight can accommodate the target, then assign.
      const applySavedScroll = () => {
        const savedTop = initialScrollTopRef.current
        if (typeof savedTop !== 'number' || savedTop <= 0) return
        let attempts = 0
        const maxAttempts = 60
        const tick = () => {
          if (disposed) return
          const el = containerRef.current
          if (!el) return
          const maxTop = Math.max(0, el.scrollHeight - el.clientHeight)
          if (maxTop < savedTop - 2 && attempts < maxAttempts) {
            attempts += 1
            window.requestAnimationFrame(tick)
            return
          }
          const clamped = Math.min(savedTop, maxTop)
          programmaticScrollUntilRef.current = performance.now() + 600
          el.scrollTop = clamped
        }
        window.requestAnimationFrame(tick)
      }
      let resolved = false
      rendition.display(initialTarget).then(() => {
        resolved = true
        if (progress.__onwardEpubReaderProgress) {
          progress.__onwardEpubReaderProgress.displayResolved = Date.now()
        }
        applySavedScroll()
      }).catch((err: unknown) => {
        if (disposed) return
        if (progress.__onwardEpubReaderProgress) {
          progress.__onwardEpubReaderProgress.displayRejected = String((err as { message?: string })?.message ?? err)
        }
        setError(String((err as { message?: string })?.message ?? err))
      })

      // Persist precise scroll offset whenever the user scrolls. Debounced
      // to 250 ms the same way PdfReader debounces `onward:pdf:state`.
      handleScroll = () => {
        if (disposed) return
        if (performance.now() < programmaticScrollUntilRef.current) return
        if (scrollPersistTimerRef.current) {
          window.clearTimeout(scrollPersistTimerRef.current)
        }
        scrollPersistTimerRef.current = window.setTimeout(() => {
          scrollPersistTimerRef.current = null
          const el = containerRef.current
          if (!el) return
          onMemoryChangeRef.current?.({ epubScrollTop: el.scrollTop })
        }, 250)
      }
      container.addEventListener('scroll', handleScroll, { passive: true })
      // epub.js's DefaultViewManager occasionally stalls its first display()
      // against our sandboxed file:// iframe — the Promise never resolves but
      // no error is raised either. Retry a few times until we see a real
      // <iframe>. We gate retries behind book.opened so we don't hit the
      // 'book.package' undefined trap inside rendition.start().
      const bookReady = (book?.opened ?? Promise.resolve(null)) as Promise<unknown>
      const retryIntervals = [1000, 2500, 4500]
      void bookReady.then(() => {
        for (const delay of retryIntervals) {
          window.setTimeout(() => {
            if (disposed || resolved) return
            const iframeNow = container && container.querySelector('iframe')
            if (iframeNow) return
            const r = renditionRef.current
            if (!r) return
            try { void r.display(initialTarget) } catch { /* ignore */ }
          }, delay)
        }
      }).catch(() => { /* ignore — nothing to retry */ })

      void book.loaded.navigation.then((nav: { toc: NavItem[] }) => {
        if (disposed) return
        const toc = nav?.toc ?? []
        onOutlineLoadedRef.current?.(flattenNavItems(toc))
      })
    } catch (err) {
      setError(String((err as { message?: string })?.message ?? err))
    }

    return () => {
      disposed = true
      if (scrollPersistTimerRef.current) {
        window.clearTimeout(scrollPersistTimerRef.current)
        scrollPersistTimerRef.current = null
      }
      if (handleScroll) {
        try {
          container.removeEventListener('scroll', handleScroll)
        } catch {
          /* ignore */
        }
      }
      try {
        renditionRef.current?.destroy()
      } catch {
        /* ignore */
      }
      renditionRef.current = null
      try {
        bookRef.current?.destroy()
      } catch {
        /* ignore */
      }
      bookRef.current = null
    }
  }, [previewData, applyTheme])

  // Re-apply theme when host theme changes (class / data-theme mutations).
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => applyTheme())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [applyTheme])

  // Persist the font-size preference per-file. Same rationale as above.
  const fontPctInitializedRef = useRef(false)
  useEffect(() => {
    if (!fontPctInitializedRef.current) {
      fontPctInitializedRef.current = true
      return
    }
    onMemoryChangeRef.current?.({ epubFontPct: fontPct })
  }, [fontPct])

  // Apply font size on change while keeping the user anchored on the page
  // they're currently reading. epub.js re-layouts the entire rendition when
  // `themes.fontSize` changes, which resets the view to the first page of
  // the book unless we re-seek to the previous CFI afterwards. Snapshot the
  // anchor BEFORE applying the new size so we don't resolve to the already-
  // reset "page 1" location.
  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition) return
    // rendition.manager is attached only after start() runs, which is queued
    // behind book.opened. Calling currentLocation() before that throws.
    // Wait for `started` so the initial fontPct apply (and any later apply
    // triggered while the book is still opening) is well-timed.
    const apply = () => {
      const progressRef = (window as unknown as {
        __onwardEpubReaderProgress?: { lastLocationHref?: string | null; lastLocationCfi?: string | null }
      }).__onwardEpubReaderProgress ?? null
      const anchor = progressRef?.lastLocationCfi || progressRef?.lastLocationHref || null

      try { rendition.themes.fontSize(`${fontPct}%`) } catch { /* ignore */ }

      if (!anchor) return

      // epub.js's stylesheet-only fontSize change shouldn't navigate, but
      // the DefaultViewManager may still nudge the scroll position during
      // reflow. Re-seek on the next animation frame to pin the user back
      // where they were.
      window.requestAnimationFrame(() => {
        try { void rendition.display(anchor) } catch { /* ignore */ }
      })
    }

    const started = rendition.started as Promise<void> | undefined
    if (started && typeof started.then === 'function') {
      void started.then(apply).catch(() => apply())
    } else {
      apply()
    }
  }, [fontPct])

  const goPrev = useCallback(() => {
    void renditionRef.current?.prev()
  }, [])
  const goNext = useCallback(() => {
    void renditionRef.current?.next()
  }, [])

  const runSearch = useCallback(
    async (rawQuery: string): Promise<{ hits: EpubSearchHit[]; trace: Record<string, unknown> }> => {
      const book = bookRef.current
      const query = rawQuery.trim()
      const trace: Record<string, unknown> = { query }
      if (!book) {
        trace.skip = 'no-book'
        return { hits: [], trace }
      }
      if (!query) return { hits: [], trace }
      try {
        await book.ready
      } catch (err) {
        trace.readyError = String((err as { message?: string })?.message ?? err)
      }

      const spine = book.spine as unknown as {
        spineItems?: unknown[]
        each?: (cb: (item: unknown) => void) => void
      }
      const items: unknown[] = []
      if (Array.isArray(spine.spineItems) && spine.spineItems.length > 0) {
        items.push(...spine.spineItems)
      } else if (typeof spine.each === 'function') {
        spine.each(item => items.push(item))
      }
      trace.spineItemCount = items.length
      trace.spineKeys = Object.keys(spine)
      trace.itemKeys = items[0] ? Object.keys(items[0] as object).slice(0, 20) : null

      const lowerQuery = query.toLowerCase()
      const collectFromDocument = (
        doc: Document | null | undefined,
        href: string | undefined,
        sink: EpubSearchHit[]
      ) => {
        if (!doc) return
        const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        const limit = 150
        while (node) {
          const text = node.textContent ?? ''
          const lower = text.toLowerCase()
          let from = 0
          while (from < lower.length) {
            const idx = lower.indexOf(lowerQuery, from)
            if (idx === -1) break
            const excerpt = text.length <= limit
              ? text.trim()
              : `...${text.slice(Math.max(0, idx - limit / 2), idx + limit / 2).trim()}...`
            sink.push({
              cfi: `${href ?? ''}:${sink.length}`,
              excerpt,
              href
            })
            from = idx + lowerQuery.length
            if (sink.length > 200) return
          }
          node = walker.nextNode()
        }
      }

      const hits: EpubSearchHit[] = []
      const itemTrace: Array<Record<string, unknown>> = []
      for (const rawItem of items) {
        const item = rawItem as {
          load?: (loader: (path: string) => Promise<object>) => Promise<unknown>
          unload?: () => void
          document?: Document
          href?: string
        }
        const perItem: Record<string, unknown> = {
          href: item?.href ?? null,
          hadDocumentBefore: Boolean(item?.document),
          loadIsFn: typeof item?.load
        }
        if (typeof item?.load !== 'function') {
          perItem.skip = 'no-load'
          itemTrace.push(perItem)
          continue
        }
        let loadedFresh = false
        try {
          if (!item.document) {
            await item.load(book.load.bind(book))
            loadedFresh = true
          }
        } catch (err) {
          perItem.loadError = String((err as { message?: string })?.message ?? err)
          itemTrace.push(perItem)
          continue
        }
        perItem.hasDocumentAfter = Boolean(item.document)
        perItem.docText = item.document ? (item.document.body?.textContent ?? '').slice(0, 80) : null
        const before = hits.length
        try {
          collectFromDocument(item.document, item.href, hits)
        } catch (err) {
          perItem.collectError = String((err as { message?: string })?.message ?? err)
        } finally {
          if (loadedFresh) {
            try {
              item.unload?.()
            } catch {
              /* ignore */
            }
          }
        }
        perItem.hitsAdded = hits.length - before
        itemTrace.push(perItem)
        if (hits.length > 200) break
      }
      trace.items = itemTrace
      trace.totalHits = hits.length
      return { hits, trace }
    },
    []
  )

  const handleSearch = useCallback(async () => {
    setSearching(true)
    try {
      const { hits, trace } = await runSearch(searchQuery)
      ;(window as unknown as { __onwardEpubSearchTrace?: Record<string, unknown> }).__onwardEpubSearchTrace = trace
      setSearchHits(hits)
      setSearchHitsOpen(hits.length > 0)
    } finally {
      setSearching(false)
    }
  }, [runSearch, searchQuery])

  // Expose debug hook for autotests — so a test can invoke search directly
  // and read the trace without relying on UI click events.
  useEffect(() => {
    const hook = {
      runSearch: async (query: string) => {
        const result = await runSearch(query)
        ;(window as unknown as { __onwardEpubSearchTrace?: Record<string, unknown> }).__onwardEpubSearchTrace = result.trace
        setSearchHits(result.hits)
        setSearchHitsOpen(result.hits.length > 0)
        return result
      }
    }
    ;(window as unknown as { __onwardEpubReaderDebug?: typeof hook }).__onwardEpubReaderDebug = hook
    return () => {
      const w = window as unknown as { __onwardEpubReaderDebug?: typeof hook }
      if (w.__onwardEpubReaderDebug === hook) delete w.__onwardEpubReaderDebug
    }
  }, [runSearch])

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void handleSearch()
      }
    },
    [handleSearch]
  )

  const clampedFontPct = Math.min(MAX_FONT_PCT, Math.max(MIN_FONT_PCT, fontPct))

  return (
    <div className="project-editor-epub-reader" data-file-path={filePath}>
      <div className="project-editor-epub-toolbar">
        <button type="button" className="project-editor-epub-btn" onClick={goPrev} title={t('projectEditor.epubReader.prevChapter')}>
          ◀
        </button>
        <button type="button" className="project-editor-epub-btn" onClick={goNext} title={t('projectEditor.epubReader.nextChapter')}>
          ▶
        </button>
        <div className="project-editor-epub-fontsize">
          <button
            type="button"
            className="project-editor-epub-btn"
            onClick={() => setFontPct(v => Math.max(MIN_FONT_PCT, v - FONT_STEP))}
            title={t('projectEditor.epubReader.fontSmaller')}
          >
            A-
          </button>
          <span className="project-editor-epub-fontsize-value">{clampedFontPct}%</span>
          <button
            type="button"
            className="project-editor-epub-btn"
            onClick={() => setFontPct(v => Math.min(MAX_FONT_PCT, v + FONT_STEP))}
            title={t('projectEditor.epubReader.fontLarger')}
          >
            A+
          </button>
        </div>
        <div className="project-editor-epub-search">
          <input
            type="search"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => searchHits.length > 0 && setSearchHitsOpen(true)}
            placeholder={t('projectEditor.epubReader.searchPlaceholder')}
          />
          <button type="button" className="project-editor-epub-btn" onClick={() => void handleSearch()} disabled={searching}>
            {searching ? t('projectEditor.epubReader.searching') : t('projectEditor.epubReader.search')}
          </button>
          {searchHitsOpen && searchHits.length > 0 && (
            <div className="project-editor-epub-search-popover">
              <div className="project-editor-epub-search-popover-heading">
                {t('projectEditor.epubReader.searchResults', { count: String(searchHits.length) })}
                <button
                  type="button"
                  className="project-editor-epub-search-popover-close"
                  onClick={() => setSearchHitsOpen(false)}
                  title={t('projectEditor.epubReader.closeSearchResults')}
                >
                  ×
                </button>
              </div>
              <ul className="project-editor-epub-search-hits">
                {searchHits.slice(0, 100).map(hit => (
                  <li key={hit.cfi}>
                    <button
                      type="button"
                      className="project-editor-epub-search-hit"
                      onClick={() => {
                        // Navigate to the hit's chapter. We build our own
                        // pseudo-CFI from (href, index) during search; epub.js
                        // won't accept it as a CFI, but `href` is a valid
                        // spine target that takes the user close to the
                        // match. Wrap in try/catch so an invalid target
                        // never kicks the rendition into an empty state.
                        try {
                          if (hit.href) void renditionRef.current?.display(hit.href)
                        } catch {
                          /* ignore */
                        }
                        setSearchHitsOpen(false)
                      }}
                    >
                      {hit.excerpt}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="project-editor-epub-body">
        <div className="project-editor-epub-content" ref={containerRef} />
      </div>
      {error && <div className="project-editor-epub-error">{error}</div>}
    </div>
  )
})
