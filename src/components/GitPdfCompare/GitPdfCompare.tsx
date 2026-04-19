/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef } from 'react'
import './GitPdfCompare.css'

export type GitPdfStatus = 'added' | 'deleted' | 'modified'

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
  const originalBlobRef = useRef<string | null>(null)
  const modifiedBlobRef = useRef<string | null>(null)

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

  // Forward theme CSS vars to both viewer iframes once they're ready.
  useEffect(() => {
    const vars = (() => {
      const style = window.getComputedStyle(document.documentElement)
      const read = (name: string) => style.getPropertyValue(name).trim()
      const out: Record<string, string> = {}
      const map: Record<string, string> = {
        '--background': '--onward-pdf-bg',
        '--panel': '--onward-pdf-panel',
        '--panel-elevated': '--onward-pdf-panel-elevated',
        '--line': '--onward-pdf-line',
        '--text': '--onward-pdf-text',
        '--muted': '--onward-pdf-muted',
        '--accent': '--onward-pdf-accent'
      }
      for (const [src, dst] of Object.entries(map)) {
        const v = read(src)
        if (v) out[dst] = v
      }
      if (out['--onward-pdf-panel']) out['--onward-pdf-page-tint'] = out['--onward-pdf-panel']
      return out
    })()
    const handler = (event: MessageEvent) => {
      if (!event.data || typeof event.data !== 'object') return
      if (event.data.type !== 'onward:pdf:ready') return
      if (event.source === originalFrameRef.current?.contentWindow) {
        originalFrameRef.current?.contentWindow?.postMessage({ type: 'onward:pdf:theme', vars }, '*')
      } else if (event.source === modifiedFrameRef.current?.contentWindow) {
        modifiedFrameRef.current?.contentWindow?.postMessage({ type: 'onward:pdf:theme', vars }, '*')
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [originalSrc, modifiedSrc])

  const statusLabel =
    status === 'added' ? labels.statusAdded
      : status === 'deleted' ? labels.statusDeleted
        : labels.statusModified
  const statusClass = `git-pdf-compare-status git-pdf-compare-status-${status}`

  return (
    <div className="git-pdf-compare">
      <div className="git-pdf-compare-header">
        <span className={statusClass}>{statusLabel}</span>
        <span className="git-pdf-compare-filename" title={filename}>{filename}</span>
      </div>
      <div className="git-pdf-compare-panes">
        <div className="git-pdf-compare-pane">
          <div className="git-pdf-compare-pane-header">
            <span className="git-pdf-compare-pane-label">
              {status === 'added' ? labels.labelOriginal : labels.labelOriginal}
            </span>
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
        <div className="git-pdf-compare-pane">
          <div className="git-pdf-compare-pane-header">
            <span className="git-pdf-compare-pane-label">
              {status === 'deleted' ? labels.labelModified : status === 'added' ? labels.labelAdded : labels.labelModified}
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
      </div>
    </div>
  )
}
