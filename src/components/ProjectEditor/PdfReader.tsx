/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react'
import { useI18n } from '../../i18n/useI18n'

interface PdfReaderProps {
  /** Full viewer URL including `?file=<file-url>&name=<display-name>`. */
  viewerUrl: string
  filePath: string
  /** Host-driven outline pane visibility (unifies UX with Markdown preview). */
  outlineOpen?: boolean
  /** Fires once the embedded viewer reports whether this PDF has an outline. */
  onOutlineAvailabilityChange?: (hasOutline: boolean) => void
  /** Per-file position memory. Sent to the viewer after pagesinit. */
  initialState?: { page?: number; scrollTop?: number; scale?: string }
  /** Fires whenever the user scrolls / paginates / zooms so the host can persist. */
  onStateChange?: (state: { page: number; scrollTop: number; scale: string | null }) => void
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
    // Map Onward token → viewer token.
    out[`--onward-pdf-${name === 'background' ? 'bg' : name === 'shadow-1' ? 'shadow' : name}`] = value
  }
  // Page tint defaults to the panel color.
  if (out['--onward-pdf-panel']) {
    out['--onward-pdf-page-tint'] = out['--onward-pdf-panel']
  }
  return out
}

export function PdfReader({
  viewerUrl,
  filePath,
  outlineOpen,
  onOutlineAvailabilityChange,
  initialState,
  onStateChange
}: PdfReaderProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const readyRef = useRef(false)
  const { t } = useI18n()
  const onOutlineAvailabilityChangeRef = useRef(onOutlineAvailabilityChange)
  useEffect(() => { onOutlineAvailabilityChangeRef.current = onOutlineAvailabilityChange }, [onOutlineAvailabilityChange])
  const onStateChangeRef = useRef(onStateChange)
  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  const initialStateRef = useRef(initialState ?? null)
  // Capture the latest initialState whenever the file path changes — we only
  // want to push state on ready once per distinct file, not every re-render.
  useEffect(() => { initialStateRef.current = initialState ?? null }, [filePath, initialState])

  const i18nStrings = useMemo(
    () => ({
      toc: t('projectEditor.pdfReader.toc'),
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
        // Re-apply the host's outline visibility as soon as the viewer is
        // ready, in case it was toggled while the iframe was still loading.
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'onward:pdf:setOutlineOpen', open: Boolean(outlineOpen) },
          '*'
        )
        // Push any per-file restore state now so the viewer can apply it
        // on its "pagesinit" event. Only send if we actually have values
        // to restore — the viewer otherwise falls back to its defaults.
        const restore = initialStateRef.current
        if (restore && (restore.page || restore.scrollTop || restore.scale)) {
          iframeRef.current?.contentWindow?.postMessage({
            type: 'onward:pdf:restoreState',
            page: restore.page ?? 1,
            scrollTop: restore.scrollTop ?? 0,
            scale: restore.scale ?? null
          }, '*')
        }
      } else if (data.type === 'onward:pdf:outlineStatus') {
        onOutlineAvailabilityChangeRef.current?.(Boolean(data.hasOutline))
      } else if (data.type === 'onward:pdf:state') {
        onStateChangeRef.current?.({
          page: Number(data.page) || 1,
          scrollTop: Number(data.scrollTop) || 0,
          scale: typeof data.scale === 'string' ? data.scale : null
        })
      }
    }
    const postThemeAndI18n = () => {
      const target = iframeRef.current?.contentWindow
      if (!target) return
      target.postMessage({ type: 'onward:pdf:theme', vars: collectThemeVars() }, '*')
      target.postMessage({ type: 'onward:pdf:i18n', strings: i18nStrings }, '*')
    }
    window.addEventListener('message', handleMessage)
    // If the iframe is already loaded (remount case), attempt to push state eagerly.
    if (readyRef.current) postThemeAndI18n()
    return () => window.removeEventListener('message', handleMessage)
  }, [i18nStrings])

  // Push outlineOpen changes to the viewer iframe whenever the host toggles
  // the Markdown-style Outline button.
  useEffect(() => {
    if (!readyRef.current) return
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'onward:pdf:setOutlineOpen', open: Boolean(outlineOpen) },
      '*'
    )
  }, [outlineOpen])

  useEffect(() => {
    // Observe theme changes on the host document and re-forward.
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
}
