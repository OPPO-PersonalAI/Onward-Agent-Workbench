/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import {
  formatPromptImageFilename,
  formatPromptImageToken,
  inferPromptAttachmentKind,
  normalizePromptAttachmentExt,
  toPromptImageFileUrl,
  type PromptImageAttachment
} from '../../utils/prompt-images'

export interface PromptAttachmentMentionMenuState {
  startOffset: number
  endOffset: number
  query: string
  selectedIndex: number
  candidates: PromptImageAttachment[]
}

export interface PromptAttachmentStripProps {
  images: readonly PromptImageAttachment[]
  onOpenPreview: (index: number) => void
  onInsertToken: (index: number) => void
  onRemove: (index: number) => void
}

/**
 * Top 3-column responsive grid displaying pasted attachments (`@1`, `@2`, `@3`...)
 * at the top of the Prompt Editor.
 */
export const PromptAttachmentStrip = React.memo(function PromptAttachmentStrip({
  images,
  onOpenPreview,
  onInsertToken,
  onRemove
}: PromptAttachmentStripProps) {
  const { t } = useI18n()
  if (images.length === 0) return null

  return (
    <div
      className="prompt-editor-images-strip"
      role="region"
      aria-label={t('promptEditor.images.aria')}
    >
      {images.map((img) => {
        const ext = normalizePromptAttachmentExt(img.ext || img.path)
        const mediaKind = img.mediaKind ?? inferPromptAttachmentKind(ext)
        const fileName = formatPromptImageFilename(img.index, ext)
        const extLabel = ext.replace(/^\./, '').toUpperCase()
        const secondaryLabel = img.width > 0 && img.height > 0
          ? `${img.width}×${img.height}`
          : (img.originalName || extLabel)
        return (
          <div
            key={`${img.batchId}-${img.index}`}
            className="prompt-editor-image-card"
            data-image-index={img.index}
            data-media-kind={mediaKind}
          >
            <button
              type="button"
              className="prompt-editor-image-thumb-btn"
              onClick={() => onOpenPreview(img.index)}
              title={t('promptEditor.images.previewTitle', { index: img.index })}
              aria-label={t('promptEditor.images.previewTitle', { index: img.index })}
            >
              {mediaKind === 'image' ? (
                <img
                  className="prompt-editor-image-thumb"
                  src={toPromptImageFileUrl(img.path, img.updatedAt)}
                  alt={`@${img.index} ${fileName}`}
                  draggable={false}
                />
              ) : mediaKind === 'video' ? (
                <div className="prompt-editor-video-thumb-wrap">
                  <video
                    className="prompt-editor-image-thumb"
                    src={toPromptImageFileUrl(img.path, img.updatedAt)}
                    muted
                    preload="metadata"
                  />
                  <span className="prompt-editor-video-play-icon" aria-hidden="true">▶</span>
                </div>
              ) : (
                <div className={`prompt-editor-file-thumb prompt-editor-file-thumb-${mediaKind}`}>
                  <span className="prompt-editor-file-ext-badge">{extLabel}</span>
                  {img.originalName && (
                    <span className="prompt-editor-file-orig-name">{img.originalName}</span>
                  )}
                </div>
              )}
              <span className="prompt-editor-image-meta">
                <span className="prompt-editor-image-filename">{fileName}</span>
                {secondaryLabel && (
                  <span className="prompt-editor-image-dimensions">{secondaryLabel}</span>
                )}
              </span>
            </button>
            <button
              type="button"
              className="prompt-editor-image-badge"
              onClick={(e) => {
                e.stopPropagation()
                onInsertToken(img.index)
              }}
              title={t('promptEditor.images.insertTokenTitle', { index: img.index })}
              aria-label={t('promptEditor.images.insertTokenTitle', { index: img.index })}
            >
              @{img.index}
            </button>
            <button
              type="button"
              className="prompt-editor-image-remove"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(img.index)
              }}
              title={t('promptEditor.images.removeTitle', { index: img.index })}
              aria-label={t('promptEditor.images.removeTitle', { index: img.index })}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
})

export interface PromptAttachmentMentionMenuProps {
  menu: PromptAttachmentMentionMenuState | null
  onHoverIndex: (idx: number) => void
  onSelectCandidate: (attachmentIndex: number) => void
}

/**
 * Floating `@` candidate autocomplete popup for referencing pasted attachments (`@1`, `@2`...).
 */
export const PromptAttachmentMentionMenu = React.memo(function PromptAttachmentMentionMenu({
  menu,
  onHoverIndex,
  onSelectCandidate
}: PromptAttachmentMentionMenuProps) {
  const { t } = useI18n()
  if (!menu || menu.candidates.length === 0) return null

  return (
    <div
      className="prompt-editor-mention-menu"
      role="listbox"
      aria-label={t('promptEditor.images.mentionTitle')}
    >
      <div className="prompt-editor-mention-header">
        {t('promptEditor.images.mentionTitle')}
      </div>
      <div className="prompt-editor-mention-list">
        {menu.candidates.map((cand, idx) => {
          const ext = normalizePromptAttachmentExt(cand.ext || cand.path)
          const mediaKind = cand.mediaKind ?? inferPromptAttachmentKind(ext)
          const fileName = formatPromptImageFilename(cand.index, ext)
          const extLabel = ext.replace(/^\./, '').toUpperCase()
          const isActive = idx === menu.selectedIndex
          const subLabel = cand.width > 0 && cand.height > 0
            ? `${cand.width}×${cand.height}`
            : (cand.originalName || extLabel)
          return (
            <button
              key={`mention-${cand.batchId}-${cand.index}`}
              type="button"
              role="option"
              aria-selected={isActive}
              className={isActive ? 'prompt-editor-mention-item is-active' : 'prompt-editor-mention-item'}
              data-mention-index={cand.index}
              onMouseEnter={() => onHoverIndex(idx)}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onSelectCandidate(cand.index)
              }}
            >
              <span className="prompt-editor-mention-token">@{cand.index}</span>
              {mediaKind === 'image' ? (
                <img
                  className="prompt-editor-mention-thumb"
                  src={toPromptImageFileUrl(cand.path, cand.updatedAt)}
                  alt={`@${cand.index}`}
                  draggable={false}
                />
              ) : (
                <span className="prompt-editor-mention-ext">{extLabel}</span>
              )}
              <span className="prompt-editor-mention-info">
                <span className="prompt-editor-mention-name">
                  {cand.originalName || fileName}
                </span>
                {subLabel && (
                  <span className="prompt-editor-mention-meta">{subLabel}</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
})

export interface PromptAttachmentLightboxProps {
  images: readonly PromptImageAttachment[]
  previewImageIndex: number | null
  hidden?: boolean
  onSelectIndex: (index: number) => void
  onInsertToken: (index: number) => void
  onClose: () => void
}

/**
 * Full-resolution Lightbox modal supporting images, video playback, PDF/HTML iframe
 * preview, and sandboxed Markdown/code text preview.
 */
export const PromptAttachmentLightbox = React.memo(function PromptAttachmentLightbox({
  images,
  previewImageIndex,
  hidden,
  onSelectIndex,
  onInsertToken,
  onClose
}: PromptAttachmentLightboxProps) {
  const { t } = useI18n()

  const activePreviewImage = useMemo(() => {
    if (previewImageIndex === null) return null
    return images.find((img) => img.index === previewImageIndex) ?? null
  }, [images, previewImageIndex])

  const activePreviewExt = useMemo(
    () => (activePreviewImage ? normalizePromptAttachmentExt(activePreviewImage.ext || activePreviewImage.path) : '.png'),
    [activePreviewImage]
  )
  const activePreviewKind = useMemo(
    () => (activePreviewImage ? (activePreviewImage.mediaKind ?? inferPromptAttachmentKind(activePreviewExt)) : 'image'),
    [activePreviewExt, activePreviewImage]
  )

  const [previewTextContent, setPreviewTextContent] = useState<string>('')
  useEffect(() => {
    if (!activePreviewImage) {
      setPreviewTextContent('')
      return
    }
    if (activePreviewKind !== 'markdown' && activePreviewKind !== 'code' && activePreviewKind !== 'other') {
      setPreviewTextContent('')
      return
    }
    let cancelled = false
    const reader = window.electronAPI?.clipboard?.readPromptAttachmentTextPreview
    if (!reader) {
      setPreviewTextContent('')
      return
    }
    void reader(activePreviewImage.path).then((res) => {
      if (cancelled) return
      if (res?.ok && typeof res.content === 'string') {
        setPreviewTextContent(res.truncated ? `${res.content}\n\n… (truncated)` : res.content)
      } else {
        setPreviewTextContent('')
      }
    }).catch(() => {
      if (!cancelled) setPreviewTextContent('')
    })
    return () => {
      cancelled = true
    }
  }, [activePreviewImage, activePreviewKind])

  if (hidden || !activePreviewImage) return null

  return (
    <div
      className="prompt-image-lightbox-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('promptEditor.images.previewTitle', { index: activePreviewImage.index })}
      onClick={onClose}
    >
      <div className="prompt-image-lightbox-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="prompt-image-lightbox-header">
          <div className="prompt-image-lightbox-title-group">
            <span className="prompt-image-lightbox-badge">@{activePreviewImage.index}</span>
            <span className="prompt-image-lightbox-filename">
              {formatPromptImageFilename(activePreviewImage.index, activePreviewExt)}
            </span>
            {activePreviewImage.originalName && (
              <span className="prompt-image-lightbox-dimensions">
                {activePreviewImage.originalName}
              </span>
            )}
            {activePreviewImage.width > 0 && activePreviewImage.height > 0 && (
              <span className="prompt-image-lightbox-dimensions">
                {activePreviewImage.width}×{activePreviewImage.height}
              </span>
            )}
          </div>
          <div className="prompt-image-lightbox-controls">
            {images.length > 1 && (
              <>
                <button
                  type="button"
                  className="prompt-image-lightbox-btn"
                  disabled={activePreviewImage.index <= 1}
                  onClick={() => onSelectIndex(Math.max(1, activePreviewImage.index - 1))}
                >
                  {t('promptEditor.images.lightboxPrev')}
                </button>
                <button
                  type="button"
                  className="prompt-image-lightbox-btn"
                  disabled={activePreviewImage.index >= images.length}
                  onClick={() => onSelectIndex(Math.min(images.length, activePreviewImage.index + 1))}
                >
                  {t('promptEditor.images.lightboxNext')}
                </button>
              </>
            )}
            <button
              type="button"
              className="prompt-image-lightbox-btn"
              onClick={() => {
                onInsertToken(activePreviewImage.index)
                onClose()
              }}
            >
              {formatPromptImageToken(activePreviewImage.index)}
            </button>
            <button
              type="button"
              className="prompt-image-lightbox-btn prompt-image-lightbox-close"
              onClick={onClose}
            >
              {t('promptEditor.images.lightboxClose')}
            </button>
          </div>
        </div>
        <div className="prompt-image-lightbox-body" data-preview-kind={activePreviewKind}>
          {activePreviewKind === 'image' ? (
            <img
              className="prompt-image-lightbox-img"
              src={toPromptImageFileUrl(activePreviewImage.path, activePreviewImage.updatedAt)}
              alt={`@${activePreviewImage.index} ${formatPromptImageFilename(activePreviewImage.index, activePreviewExt)}`}
            />
          ) : activePreviewKind === 'video' ? (
            <video
              className="prompt-image-lightbox-video"
              src={toPromptImageFileUrl(activePreviewImage.path, activePreviewImage.updatedAt)}
              controls
              autoPlay
            />
          ) : activePreviewKind === 'pdf' || activePreviewKind === 'html' ? (
            <iframe
              className="prompt-image-lightbox-iframe"
              src={toPromptImageFileUrl(activePreviewImage.path, activePreviewImage.updatedAt)}
              title={formatPromptImageFilename(activePreviewImage.index, activePreviewExt)}
              sandbox={activePreviewKind === 'pdf' ? undefined : 'allow-same-origin'}
            />
          ) : (
            <pre className="prompt-image-lightbox-code">
              <code>{previewTextContent || activePreviewImage.path}</code>
            </pre>
          )}
        </div>
      </div>
    </div>
  )
})
