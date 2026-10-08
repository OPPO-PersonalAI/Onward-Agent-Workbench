/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { redispatchPdfHostKey } from '../../utils/pdfHostKey'
import { buildPdfThemeVars, buildPdfViewerStrings } from '../../utils/preview-theme'
import { useI18n } from '../../i18n/useI18n'
import { PREVIEW_THEME_APPLIED_EVENT, readPreviewPalette } from '../../utils/preview-theme-dom'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { computePaneVisibility, type GitPdfStatus } from './computePaneVisibility'
import './GitPdfCompare.css'

export type { GitPdfStatus }

export interface GitPdfCompareLabels {
  statusAdded: string
  statusDeleted: string
  statusModified: string
  labelOriginal: string
  labelAdded: string
  labelModified: string
  noOriginal: string
  noModified: string
}

interface GitPdfCompareProps {
  status: GitPdfStatus
  /** Base64 bytes of the original side. Undefined means the file did not exist before. */
  originalPreviewData?: string
  /** Base64 bytes of the modified side. Undefined means the file was deleted. */
  modifiedPreviewData?: string
  originalSize?: number
  modifiedSize?: number
  /** File name displayed in the header (used in iframe title + size label). */
  filename: string
  /**
   * Fully qualified URL of the vendored PDF viewer. When null the iframe
   * cannot render yet; the outer compare chrome (status badge, pane headers,
   * empty states) still shows so callers don't flash the generic "binary
   * unsupported" fallback while the URL is being resolved.
   */
  viewerUrl: string | null
  labels: GitPdfCompareLabels
}

function formatFileSize(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64ToBlobUrl(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'application/pdf' })
  return URL.createObjectURL(blob)
}

function buildViewerSrc(viewerUrl: string, blobUrl: string, displayName: string): string {
  const sep = viewerUrl.includes('?') ? '&' : '?'
  return `${viewerUrl}${sep}file=${encodeURIComponent(blobUrl)}&name=${encodeURIComponent(displayName)}`
}

export function GitPdfCompare({
  status,
  originalPreviewData,
  modifiedPreviewData,
  originalSize,
  modifiedSize,
  filename,
  viewerUrl,
  labels
}: GitPdfCompareProps) {
  const { t } = useI18n()
  const i18nStrings = useMemo(() => buildPdfViewerStrings(t), [t])
  const originalBlobRef = useRef<string | null>(null)
  const modifiedBlobRef = useRef<string | null>(null)

  // Product telemetry: count once per PDF-diff view open (mount), never per re-render.
  useEffect(() => { trackFeatureUse('pdf-diff') }, [])

  const originalSrc = useMemo(() => {
    if (originalBlobRef.current) {
      URL.revokeObjectURL(originalBlobRef.current)
      originalBlobRef.current = null
    }
    if (!originalPreviewData || !viewerUrl) return null
    const blobUrl = base64ToBlobUrl(originalPreviewData)
    originalBlobRef.current = blobUrl
    return buildViewerSrc(viewerUrl, blobUrl, `${filename} (original)`)
  }, [filename, originalPreviewData, viewerUrl])

  const modifiedSrc = useMemo(() => {
    if (modifiedBlobRef.current) {
      URL.revokeObjectURL(modifiedBlobRef.current)
      modifiedBlobRef.current = null
    }
    if (!modifiedPreviewData || !viewerUrl) return null
    const blobUrl = base64ToBlobUrl(modifiedPreviewData)
    modifiedBlobRef.current = blobUrl
    return buildViewerSrc(viewerUrl, blobUrl, `${filename} (modified)`)
  }, [filename, modifiedPreviewData, viewerUrl])

  useEffect(() => {
    return () => {
      if (originalBlobRef.current) URL.revokeObjectURL(originalBlobRef.current)
      if (modifiedBlobRef.current) URL.revokeObjectURL(modifiedBlobRef.current)
      originalBlobRef.current = null
      modifiedBlobRef.current = null
    }
  }, [])

  const originalFrameRef = useRef<HTMLIFrameElement | null>(null)
  const modifiedFrameRef = useRef<HTMLIFrameElement | null>(null)
  const themeGenerationRef = useRef(0)
  const previousThemeSourcesRef = useRef<Array<{ source: Window; origin: string; file: boolean }>>([])

  // Forward theme CSS vars to both viewer iframes once they're ready, and
  // re-dispatch host-level shortcuts (Cmd/Ctrl+P, Escape) that the iframe
  // forwarded via postMessage so the host's existing keyboard handlers see
  // them as if the user pressed the key outside the iframe.
  useEffect(() => {
    const generation = ++themeGenerationRef.current
    let disposed = false
    const frames = [originalFrameRef.current, modifiedFrameRef.current].filter((frame): frame is HTMLIFrameElement => Boolean(frame))
    // Retain at most two previous sources for diagnostics, never for acceptance.
    // Opaque file origins alone cannot identify an owned viewer.
    const sources = frames.flatMap(frame => {
      const source = frame.contentWindow
      if (!source) return []
      try {
        const url = new URL(frame.src, document.baseURI)
        return [{ source, origin: url.origin, file: url.protocol === 'file:' }]
      } catch {
        // Diagnostic source discovery must never interrupt viewer delivery.
        return []
      }
    })
    const knownSources = [...sources, ...previousThemeSourcesRef.current]
    previousThemeSourcesRef.current = sources
    const rejected = new Set<string>()
    const rejectOnce = (rejection: 'stale-generation' | 'stale-source', phase: 'theme' | 'ready' | 'receive') => {
      const key = `${phase}:${rejection}`
      if (rejected.has(key)) return
      rejected.add(key)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, {
        surface: 'pdf-compare', reason: 'bridge-rejected', rejection, phase, generation,
        revision: document.documentElement.dataset.themeRevision?.slice(0, 128) ?? ''
      })
    }
    const traceRejectedMessage = (event: MessageEvent, rejection: 'stale-generation' | 'stale-source') => {
      const data = event.data
      if (!data || typeof data !== 'object') return
      const themeMessage = data.type === 'onward:pdf:ready' ||
        (data.type === 'onward:pdf:i18nApplied' && typeof data.revision === 'string') || (
        (data.type === 'onward:pdf:themeApplied' || data.type === 'onward:pdf:enhancementApplied') &&
        (data.kind === 'light' || data.kind === 'dark') && typeof data.revision === 'string' && typeof data.enhancement === 'boolean'
      )
      if (!themeMessage || !knownSources.some(known => known.source === event.source && (
        event.origin === known.origin || (known.file && event.origin === 'file://')
      ))) return
      rejectOnce(rejection, 'receive')
    }
    const current = () => !disposed && generation === themeGenerationRef.current
    const publish = (targets: HTMLIFrameElement[], reason: string) => {
      if (!current()) { rejectOnce('stale-generation', 'theme'); return }
      // Read at delivery time, including a late ready response after a theme edit.
      const palette = readPreviewPalette()
      const vars = buildPdfThemeVars(palette)
      const revision = document.documentElement.dataset.themeRevision?.slice(0, 128) ?? ''
      let sent = 0
      let detached = 0
      let noTarget = 0
      for (const frame of targets) {
        if (!frame.isConnected) { detached++; continue }
        if (!frame.contentWindow) { noTarget++; continue }
        frame.contentWindow.postMessage({ type: 'onward:pdf:theme', vars, kind: palette.kind, revision }, '*')
        if (reason === 'viewer-ready') frame.contentWindow.postMessage({ type: 'onward:pdf:i18n', strings: i18nStrings }, '*')
        sent++
      }
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, {
        surface: 'pdf-compare', phase: 'sent', reason, generation, revision, kind: palette.kind, frames: sent,
        detached, noTarget, i18n: reason === 'viewer-ready', rejection: targets.length === 0 ? 'no-target' : detached || noTarget ? 'unavailable-targets' : undefined
      })
    }
    const requestReady = () => {
      if (!current()) { rejectOnce('stale-generation', 'ready'); return }
      for (const frame of frames) frame.contentWindow?.postMessage({ type: 'onward:pdf:requestReady' }, '*')
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, {
        surface: 'pdf-compare', reason: 'ready-request', generation, frames: frames.length,
        noTarget: frames.filter(frame => !frame.contentWindow).length,
        rejection: frames.length === 0 ? 'no-target' : undefined
      })
    }
    const apply = () => publish(frames, 'theme-event')
    const handler = (event: MessageEvent) => {
      if (!current()) { traceRejectedMessage(event, 'stale-generation'); return }
      if (!event.data || typeof event.data !== 'object') return
      const frame = frames.find(candidate => event.source === candidate.contentWindow)
      if (!frame) { traceRejectedMessage(event, 'stale-source'); return }
      if (event.data.type === 'onward:pdf:ready') {
        publish([frame], 'viewer-ready')
      } else if (event.data.type === 'onward:pdf:themeApplied' || event.data.type === 'onward:pdf:enhancementApplied') {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, {
          surface: 'pdf-compare', phase: 'received', generation,
          reason: event.data.type === 'onward:pdf:themeApplied' ? 'viewer-applied' : 'enhancement-toggled',
          revision: typeof event.data.revision === 'string' ? event.data.revision.slice(0, 128) : '',
          enhancement: event.data.enhancement === true,
          kind: event.data.kind === 'light' ? 'light' : 'dark'
        })
      } else if (event.data.type === 'onward:pdf:i18nApplied') {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, {
          surface: 'pdf-compare', phase: 'received', reason: 'i18n-applied', generation,
          revision: typeof event.data.revision === 'string' ? event.data.revision.slice(0, 128) : ''
        })
      } else if (event.data.type === 'onward:pdf:hostKey') {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, { surface: 'pdf-compare', reason: 'host-key-forwarded', generation })
        redispatchPdfHostKey(event.data as Record<string, unknown>)
      }
    }
    window.addEventListener('message', handler)
    window.addEventListener(PREVIEW_THEME_APPLIED_EVENT, apply)
    for (const frame of frames) frame.addEventListener('load', requestReady)
    requestReady()
    return () => {
      disposed = true
      window.removeEventListener('message', handler)
      window.removeEventListener(PREVIEW_THEME_APPLIED_EVENT, apply)
      for (const frame of frames) frame.removeEventListener('load', requestReady)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_PREVIEW_APPLY, { surface: 'pdf-compare', reason: 'disposed', generation })
    }
  }, [originalSrc, modifiedSrc, status, i18nStrings])

  const statusLabel =
    status === 'added' ? labels.statusAdded
      : status === 'deleted' ? labels.statusDeleted
        : labels.statusModified
  const statusClass = `git-pdf-compare-status git-pdf-compare-status-${status}`

  const { showOriginalPane, showModifiedPane, isSinglePane } = computePaneVisibility(status)

  return (
    <div className="git-pdf-compare">
      <div className="git-pdf-compare-header">
        <span className={statusClass}>{statusLabel}</span>
        <span className="git-pdf-compare-filename" title={filename}>{filename}</span>
      </div>
      <div className={`git-pdf-compare-panes${isSinglePane ? ' is-single' : ''}`}>
        {showOriginalPane && (
          <div className="git-pdf-compare-pane" data-side="original">
            <div className="git-pdf-compare-pane-header">
              <span className="git-pdf-compare-pane-label">{labels.labelOriginal}</span>
              <span className="git-pdf-compare-pane-size">{formatFileSize(originalSize)}</span>
            </div>
            {originalSrc ? (
              <iframe
                ref={originalFrameRef}
                className="git-pdf-compare-frame"
                src={originalSrc}
                title={`${filename} (original)`}
                sandbox="allow-same-origin allow-scripts"
              />
            ) : (
              <div className="git-pdf-compare-empty">{labels.noOriginal}</div>
            )}
          </div>
        )}
        {showModifiedPane && (
          <div className="git-pdf-compare-pane" data-side="modified">
            <div className="git-pdf-compare-pane-header">
              <span className="git-pdf-compare-pane-label">
                {status === 'added' ? labels.labelAdded : labels.labelModified}
              </span>
              <span className="git-pdf-compare-pane-size">{formatFileSize(modifiedSize)}</span>
            </div>
            {modifiedSrc ? (
              <iframe
                ref={modifiedFrameRef}
                className="git-pdf-compare-frame"
                src={modifiedSrc}
                title={`${filename} (modified)`}
                sandbox="allow-same-origin allow-scripts"
              />
            ) : (
              <div className="git-pdf-compare-empty">{labels.noModified}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
