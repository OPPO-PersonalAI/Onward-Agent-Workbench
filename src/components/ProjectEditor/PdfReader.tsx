/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useI18n } from '../../i18n/useI18n'
import type { OutlineItem } from './Outline/types'
import { OutlineSymbolKind } from './Outline/types'

/** Raw outline tree shape posted by the embedded PDF viewer. */
interface RawPdfOutlineNode {
  title: string
  page: number | null
  /** Full pdf.js destination (string for named, array for explicit). The host
   * forwards this back via `onward:pdf:goToDest` for precise navigation. */
  dest?: unknown
  children: RawPdfOutlineNode[]
}

interface PdfReaderProps {
  /** Full viewer URL including `?file=<file-url>&name=<display-name>`. */
  viewerUrl: string
  filePath: string
  /** Per-file position memory. Sent to the viewer after pagesinit. */
  initialState?: { page?: number; scrollTop?: number; scale?: string }
  /** Fires whenever the user scrolls / paginates / zooms so the host can persist. */
  onStateChange?: (state: { page: number; scrollTop: number; scale: string | null }) => void
  /** Fires once after document load with the flattened outline tree. Empty if none. */
  onOutlineLoaded?: (items: OutlineItem[]) => void
  /** Fires on every page change (including from scroll / arrow keys). */
  onPageChange?: (page: number) => void
}

export interface PdfReaderHandle {
  /** Jump the viewer to an absolute 1-based page number. No-op if not ready. */
  goToPage(page: number): void
  /** Navigate to a full pdf.js destination (preserves /XYZ, /FitH, etc.).
   * Prefer this over goToPage when the outline entry has a dest attached. */
  goToDest(dest: unknown): void
}

// CSS custom properties on the host document we forward to the viewer so it can
// pick up Onward's accent / surface colors. The viewer maps these into its own
// `--onward-pdf-*` tokens.
const FORWARDED_CSS_VARS = [
  'background',
  'panel',
  'panel-elevated',
  'line',
  'text',
  'muted',
  'accent',
  'shadow-1'
] as const

function collectThemeVars(): Record<string, string> {
  const root = document.documentElement
  const style = window.getComputedStyle(root)
  const out: Record<string, string> = {}
  for (const name of FORWARDED_CSS_VARS) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (!value) continue
    out[`--onward-pdf-${name === 'background' ? 'bg' : name === 'shadow-1' ? 'shadow' : name}`] = value
  }
  if (out['--onward-pdf-panel']) {
    out['--onward-pdf-page-tint'] = out['--onward-pdf-panel']
  }
  return out
}

// Convert the raw viewer-side tree into the shared OutlineItem shape. PDF
// entries use `target: { kind: 'pdf-page', page }`; items without a resolvable
// page still appear in the tree for visual context but are non-clickable at
// the panel level (host will filter or ignore them on click).
function flattenRawOutline(raw: RawPdfOutlineNode[], depth = 0): OutlineItem[] {
  return raw.map((node) => {
    const children = flattenRawOutline(node.children, depth + 1)
    const item: OutlineItem = {
      name: node.title || ' ',
      kind: OutlineSymbolKind.Heading1,
      startLine: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 0,
      children,
      depth
    }
    if (typeof node.page === 'number' && node.page > 0) {
      item.target = { kind: 'pdf-page', page: node.page, dest: node.dest ?? undefined }
    } else if (node.dest != null) {
      // Unresolvable page but we still have a destination — use page 1 as a
      // placeholder so the entry is clickable; the actual navigation goes
      // through goToDest which honours the real destination regardless of
      // the coarse page hint.
      item.target = { kind: 'pdf-page', page: 1, dest: node.dest }
    }
    return item
  })
}

export const PdfReader = forwardRef<PdfReaderHandle, PdfReaderProps>(function PdfReader(
  { viewerUrl, filePath, initialState, onStateChange, onOutlineLoaded, onPageChange },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)
  const { t } = useI18n()

  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  const onOutlineLoadedRef = useRef(onOutlineLoaded)
  useEffect(() => { onOutlineLoadedRef.current = onOutlineLoaded }, [onOutlineLoaded])
  const onPageChangeRef = useRef(onPageChange)
  useEffect(() => { onPageChangeRef.current = onPageChange }, [onPageChange])

  const initialStateRef = useRef(initialState ?? null)
  useEffect(() => { initialStateRef.current = initialState ?? null }, [filePath, initialState])

  const lastPageRef = useRef<number>(0)
  // Reset the page-change dedupe when the viewer URL changes (each URL maps
  // to a distinct PDF). Otherwise, opening PDF-B at the same saved page as
  // PDF-A would be treated as a no-op and the outline highlight would stay
  // stuck on page 1.
  useEffect(() => { lastPageRef.current = 0 }, [viewerUrl])

  useImperativeHandle(ref, () => ({
    goToPage(page: number) {
      if (!readyRef.current) return
      if (!Number.isFinite(page) || page < 1) return
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:goToPage', page },
        '*'
      )
    },
    goToDest(dest: unknown) {
      if (!readyRef.current) return
      if (dest == null) return
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'onward:pdf:goToDest', dest },
        '*'
      )
    }
  }), [])

  const i18nStrings = useMemo(
    () => ({
      prevPage: t('projectEditor.pdfReader.prevPage'),
      nextPage: t('projectEditor.pdfReader.nextPage'),
      zoomOut: t('projectEditor.pdfReader.zoomOut'),
      zoomIn: t('projectEditor.pdfReader.zoomIn'),
      zoom: t('projectEditor.pdfReader.zoom'),
      fitWidth: t('projectEditor.pdfReader.fitWidth'),
      fitPage: t('projectEditor.pdfReader.fitPage'),
      searchPlaceholder: t('projectEditor.pdfReader.searchPlaceholder'),
      prevMatch: t('projectEditor.pdfReader.prevMatch'),
      nextMatch: t('projectEditor.pdfReader.nextMatch'),
      colorToggleOn: t('projectEditor.pdfReader.colorToggleOn'),
      colorToggleOff: t('projectEditor.pdfReader.colorToggleOff'),
      colorToggleTitleOn: t('projectEditor.pdfReader.colorToggleTitleOn'),
      colorToggleTitleOff: t('projectEditor.pdfReader.colorToggleTitleOff'),
      close: t('projectEditor.pdfReader.close'),
      cancel: t('projectEditor.pdfReader.cancel'),
      confirm: t('projectEditor.pdfReader.confirm'),
      passwordTitle: t('projectEditor.pdfReader.passwordTitle'),
      passwordPrompt: t('projectEditor.pdfReader.passwordPrompt'),
      passwordIncorrect: t('projectEditor.pdfReader.passwordIncorrect'),
      emptyState: t('projectEditor.pdfReader.emptyState'),
      errorInvalid: t('projectEditor.pdfReader.errorInvalid'),
      errorMissing: t('projectEditor.pdfReader.errorMissing'),
      errorPassword: t('projectEditor.pdfReader.errorPassword'),
      errorUnexpected: t('projectEditor.pdfReader.errorUnexpected'),
      errorGeneric: t('projectEditor.pdfReader.errorGeneric')
    }),
    [t]
  )

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'onward:pdf:ready') {
        readyRef.current = true
        postThemeAndI18n()
        const restore = initialStateRef.current
        if (restore && (restore.page || restore.scrollTop || restore.scale)) {
          iframeRef.current?.contentWindow?.postMessage({
            type: 'onward:pdf:restoreState',
            page: restore.page ?? 1,
            scrollTop: restore.scrollTop ?? 0,
            scale: restore.scale ?? null
          }, '*')
        }
      } else if (data.type === 'onward:pdf:outline') {
        const raw = Array.isArray(data.items) ? (data.items as RawPdfOutlineNode[]) : []
        onOutlineLoadedRef.current?.(flattenRawOutline(raw))
      } else if (data.type === 'onward:pdf:state') {
        const page = Number(data.page) || 1
        const scrollTop = Number(data.scrollTop) || 0
        const scale = typeof data.scale === 'string' ? data.scale : null
        onStateChangeRef.current?.({ page, scrollTop, scale })
        if (page !== lastPageRef.current) {
          lastPageRef.current = page
          onPageChangeRef.current?.(page)
        }
      }
    }
    const postThemeAndI18n = () => {
      const target = iframeRef.current?.contentWindow
      if (!target) return
      target.postMessage({ type: 'onward:pdf:theme', vars: collectThemeVars() }, '*')
      target.postMessage({ type: 'onward:pdf:i18n', strings: i18nStrings }, '*')
    }
    window.addEventListener('message', handleMessage)
    if (readyRef.current) postThemeAndI18n()
    return () => window.removeEventListener('message', handleMessage)
  }, [i18nStrings])

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(() => {
      if (!readyRef.current) return
      const target = iframeRef.current?.contentWindow
      if (!target) return
      target.postMessage({ type: 'onward:pdf:theme', vars: collectThemeVars() }, '*')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

  return (
    <div className="project-editor-pdf-reader" data-file-path={filePath}>
      <iframe
        ref={iframeRef}
        key={viewerUrl}
        src={viewerUrl}
        title={filePath}
        className="project-editor-pdf-reader-iframe"
        sandbox="allow-same-origin allow-scripts"
      />
    </div>
  )
})
