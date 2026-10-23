/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PromptInputAction } from '../../utils/prompt-input'
import { getPromptActionEmoji } from '../../utils/prompt-emoji'
import { EMOJI_COLUMNS, EMOJI_ROW_HEIGHT, movePromptEmojiIndex, visiblePromptEmojiIndex, type PromptEmojiPage, type PromptEmojiQuery } from '../../utils/prompt-emoji-search'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '../../i18n/core'
import { useModalOpenRegistration } from '../../hooks/useModalEscape'
import { isModalCancelKey } from '../../utils/modal-dismiss'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { PromptActionButton } from '../PromptNotebook/PromptActionButton'
import { PromptActionEmoji } from '../PromptNotebook/PromptActionEmoji'
import { setRecordingSuspended } from './ShortcutInput'
import './PromptActionAppearance.css'

interface Props {
  action: PromptInputAction
  onChange: (patch: Partial<PromptInputAction>) => void
}

export function PromptActionAppearance({ action, onChange }: Props) {
  const { t } = useI18n()
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  useEffect(() => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'trigger-mounted' })
  }, [])
  return <>
    <PromptActionButton action={action} leader={null} className="prompt-input-appearance"
      aria-label={t('promptInput.emoji.appearance')} title={t('promptInput.emoji.appearance')}
      aria-haspopup="dialog" aria-expanded={Boolean(anchor)} data-testid={`prompt-input-action-${action.id}-appearance`}
      onClick={event => {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'open-request' })
        setAnchor(event.currentTarget)
      }} />
    {anchor && <EmojiPicker action={action} onChange={onChange} anchor={anchor} onClose={() => setAnchor(null)} />}
  </>
}

function EmojiPicker({ action, onChange, anchor, onClose }: Props & { anchor: HTMLButtonElement; onClose: () => void }) {
  const { t, locale } = useI18n()
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState(-1)
  const [offset, setOffset] = useState(0)
  const [active, setActive] = useState(0)
  const [retry, setRetry] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [inputReady, setInputReady] = useState(false)
  const [page, setPage] = useState<PromptEmojiPage | null>(null)
  const [requested, setRequested] = useState(0)
  const submitRef = useRef<(request: Omit<PromptEmojiQuery, 'id'>) => void>(() => {})
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const closeReason = useRef('owner-unmount')
  const rafRef = useRef<number | null>(null)
  const viewportStats = useRef({ scrollFrames: 0, focusReconciliations: 0 })
  const currentEmoji = getPromptActionEmoji(action)
  const loading = !ready || !page || page.id !== requested
  useModalOpenRegistration(true)

  const close = (reason: string) => {
    closeReason.current = reason
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'close-request', cause: reason })
    closeRef.current()
  }
  const choose = (emoji: string) => {
    onChange({ emoji })
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'select' })
    close('selected')
  }

  useLayoutEffect(() => {
    const dialog = dialogRef.current!
    dialog.showModal()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'open' })
    // Own keyboard routing before editor save/ESC handlers on document capture.
    // Keep native editing/Tab defaults while hiding keys from application handlers.
    const capture = (event: KeyboardEvent) => {
      if (!dialog.contains(event.target as Node)) return
      if (event.type === 'keydown') keyRef.current(event)
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', capture, true)
    window.addEventListener('keyup', capture, true)
    window.addEventListener('keypress', capture, true)
    return () => {
      window.removeEventListener('keydown', capture, true)
      window.removeEventListener('keyup', capture, true)
      window.removeEventListener('keypress', capture, true)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      dialog.close()
      if (anchor.isConnected) anchor.focus({ preventScroll: true })
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'close', cause: closeReason.current, focusRestored: anchor.isConnected })
    }
  }, [anchor])

  useEffect(() => {
    let disposed = false
    let generation = 0
    const suspend = () => {
      const request = ++generation
      setInputReady(false)
      void setRecordingSuspended(true, true).then(() => {
        if (disposed || request !== generation) {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'input-ack-stale' })
          return
        }
        setInputReady(true)
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'input-ready' })
      }).catch(() => {
        if (disposed || request !== generation) return
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'suspend-failed' })
        closeReason.current = 'suspend-failed'
        closeRef.current()
      })
    }
    const blur = () => {
      ++generation
      setInputReady(false)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'input-blur' })
    }
    suspend()
    window.addEventListener('focus', suspend)
    window.addEventListener('blur', blur)
    return () => {
      disposed = true
      window.removeEventListener('focus', suspend)
      window.removeEventListener('blur', blur)
      void setRecordingSuspended(false).catch(() => {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'resume-failed' })
      })
    }
  }, [])

  useLayoutEffect(() => {
    if (!inputReady) return
    searchRef.current?.focus({ preventScroll: true })
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'search-focus', focused: document.activeElement === searchRef.current })
  }, [inputReady])

  useEffect(() => {
    const started = performance.now()
    let worker: Worker | undefined
    let disposed = false
    let available = false
    let inFlight = false
    let latest = 0
    let queued: PromptEmojiQuery | null = null
    let lastSummary = started
    const stats = { sent: 0, received: 0, stale: 0, measuredQueries: 0, durationMs: 0, maxDurationMs: 0 }
    const report = (reason: string) => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_SEARCH, { reason, sent: stats.sent, received: stats.received, stale: stats.stale, ...viewportStats.current })
      if (stats.measuredQueries) perfTraceDiagnostic(PERF_TRACE_EVENT.WORKER_PROMPT_EMOJI_SEARCH, {
        reason, queries: stats.measuredQueries, durationMs: stats.durationMs, maxDurationMs: stats.maxDurationMs
      })
      stats.measuredQueries = 0
      stats.durationMs = 0
      stats.maxDurationMs = 0
      lastSummary = performance.now()
    }
    const fail = (reason: string) => {
      if (disposed) return
      available = false
      queued = null
      worker?.terminate()
      setFailed(true)
      setReady(false)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_CATALOG, { reason, durationMs: performance.now() - started })
    }
    const flush = () => {
      if (!available || inFlight || !queued || disposed) return
      const request = queued
      queued = null
      inFlight = true
      stats.sent += 1
      try { worker!.postMessage(request) } catch { fail('send-failed') }
    }
    submitRef.current = request => {
      queued = { ...request, id: ++latest }
      setRequested(latest)
      flush()
    }
    setFailed(false)
    setReady(false)
    setPage(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_CATALOG, { reason: 'start' })
    try {
      worker = new Worker(new URL('../../workers/promptEmojiWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = event => {
        if (disposed) return
        const message = event.data
        if (message.type === 'ready') {
          available = true
          setReady(true)
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_CATALOG, { reason: 'ready', count: message.count, durationMs: performance.now() - started })
          perfTraceDiagnostic(PERF_TRACE_EVENT.WORKER_PROMPT_EMOJI_CATALOG, { count: message.count, durationMs: message.durationMs })
          flush()
        } else if (message.type === 'page') {
          inFlight = false
          stats.received += 1
          stats.measuredQueries += 1
          stats.durationMs += message.durationMs
          stats.maxDurationMs = Math.max(stats.maxDurationMs, message.durationMs)
          if (message.id === latest) setPage(message)
          else stats.stale += 1
          // Summarize both message directions, never emit a trace per keystroke.
          if (performance.now() - lastSummary >= 1000) report('interval')
          flush()
        } else fail('search-failed')
      }
      worker.onerror = event => { event.preventDefault(); fail('worker-failed') }
      worker.onmessageerror = () => fail('decode-failed')
    } catch { fail('start-failed') }
    return () => {
      disposed = true
      queued = null
      submitRef.current = () => {}
      worker?.terminate()
      report('dispose')
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_CATALOG, { reason: 'dispose', ready: available, inFlight })
    }
  }, [retry])

  useEffect(() => {
    submitRef.current({ query, group, offset, locale })
  }, [query, group, offset, locale, retry])

  const resetPosition = () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setPage(null)
    setOffset(0)
    setActive(0)
    if (listRef.current) listRef.current.scrollTop = 0
  }
  const reveal = (next: number) => {
    setActive(next)
    const list = listRef.current!
    const top = Math.floor(next / EMOJI_COLUMNS) * EMOJI_ROW_HEIGHT
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + EMOJI_ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = top + EMOJI_ROW_HEIGHT - list.clientHeight
    setOffset(Math.max(0, Math.floor(list.scrollTop / EMOJI_ROW_HEIGHT) - 1) * EMOJI_COLUMNS)
  }
  keyRef.current = event => {
    if (event.isComposing || event.keyCode === 229) return
    if (isModalCancelKey(event)) { event.preventDefault(); close('escape'); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'save-shortcut-contained' })
      return
    }
    if (event.target === searchRef.current && event.key === 'ArrowDown' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      listRef.current?.focus()
      return
    }
    if (event.target !== listRef.current || !page) return
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      event.preventDefault()
      reveal(movePromptEmojiIndex(active, event.key, page.total))
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const entry = !loading && page.items[active - page.offset]
      if (entry) choose(entry.emoji)
    }
  }
  const activeOption = !loading ? page?.items[active - page.offset] : undefined
  return createPortal(<dialog ref={dialogRef} className="prompt-emoji-picker" data-testid="prompt-emoji-picker"
    data-input-ready={inputReady} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close('native-cancel') }}>
    <div className="prompt-emoji-header"><h3 id={`${id}-title`}>{t('promptInput.emoji.appearance')}</h3>
      <button type="button" aria-label={t('promptInput.emoji.close')} data-testid="prompt-emoji-close" onClick={() => close('button')}>×</button></div>
    <input ref={searchRef} type="search" value={query} maxLength={96} disabled={!inputReady} className="prompt-emoji-search" data-testid="prompt-emoji-search"
      aria-label={t('promptInput.emoji.search')} placeholder={t('promptInput.emoji.search')} onChange={event => { resetPosition(); setQuery(event.target.value) }} />
    <select value={group} data-testid="prompt-emoji-category" aria-label={t('promptInput.emoji.category')}
      onChange={event => {
        resetPosition(); setGroup(Number(event.target.value))
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'category', group: Number(event.target.value) })
      }}>
      <option value={-1}>{t('promptInput.emoji.all')}</option>
      {Array.from({ length: 10 }, (_, group) => <option key={group} value={group}>{t(`promptInput.emoji.group${group}` as TranslationKey)}</option>)}
    </select>
    {failed ? <div className="prompt-emoji-error" role="alert"><p>{t('promptInput.emoji.failed')}</p>
      <button type="button" data-testid="prompt-emoji-retry" onClick={() => {
        resetPosition()
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'retry' }); setRetry(value => value + 1)
      }}>{t('promptInput.emoji.retry')}</button></div> : <>
      <div ref={listRef} className="prompt-emoji-list" data-testid="prompt-emoji-list" data-total={page?.total ?? 0}
        role="listbox" tabIndex={0} aria-label={t('promptInput.emoji.list')} aria-busy={loading}
        onFocus={event => {
          if (event.target !== event.currentTarget || !page) return
          const list = event.currentTarget
          const next = visiblePromptEmojiIndex(active, list.scrollTop, list.clientHeight, page.total)
          reveal(next)
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'grid-focus', repositioned: next !== active })
        }}
        aria-activedescendant={activeOption ? `${id}-${activeOption.key}` : undefined} onScroll={() => {
          if (rafRef.current !== null) return
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null
            const list = listRef.current
            if (!list) return
            viewportStats.current.scrollFrames += 1
            setOffset(Math.max(0, Math.floor(list.scrollTop / EMOJI_ROW_HEIGHT) - 1) * EMOJI_COLUMNS)
            if (document.activeElement === list && page) {
              viewportStats.current.focusReconciliations += 1
              setActive(current => visiblePromptEmojiIndex(current, list.scrollTop, list.clientHeight, page.total))
            }
          })
        }}>
        <div className="prompt-emoji-grid" style={{ height: Math.ceil((page?.total ?? 0) / EMOJI_COLUMNS) * EMOJI_ROW_HEIGHT }}>
          {page?.items.map((entry, index) => <button type="button" key={entry.key} id={`${id}-${entry.key}`} role="option" tabIndex={-1}
            data-testid={`prompt-emoji-option-${entry.key}`} aria-label={locale === 'zh-CN' ? entry.zh : entry.en}
            title={locale === 'zh-CN' ? entry.zh : entry.en} aria-selected={entry.emoji === currentEmoji} aria-setsize={page.total} aria-posinset={page.offset + index + 1}
            data-active={page.offset + index === active} disabled={loading}
            style={{ top: Math.floor((page.offset + index) / EMOJI_COLUMNS) * EMOJI_ROW_HEIGHT, left: `${index % EMOJI_COLUMNS * 100 / EMOJI_COLUMNS}%` }}
            onClick={() => choose(entry.emoji)}><PromptActionEmoji emoji={entry.emoji} /></button>)}
        </div>
      </div>
      <p className="prompt-emoji-status" role="status">{loading ? t('promptInput.emoji.loading') : !page?.total ? t('promptInput.emoji.empty') : t('promptInput.emoji.count', { count: page.total })}</p>
    </>}
    <div className="prompt-emoji-color"><label htmlFor={`${id}-color`}>{t('promptInput.settings.color')}</label>
      <input id={`${id}-color`} type="color" value={action.color ?? '#808080'} data-testid={`prompt-input-action-${action.id}-color`}
        onChange={event => onChange({ color: event.target.value })} onBlur={() => {
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'color-edit' })
        }} />
      <button type="button" data-testid="prompt-emoji-reset" onClick={() => {
        onChange({ emoji: undefined, color: undefined })
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_PICKER, { reason: 'reset' })
      }}>{t('promptInput.emoji.reset')}</button>
    </div>
    <p className="prompt-emoji-hint">{t('promptInput.emoji.keyboard')}</p>
    <p className="prompt-emoji-credit">{t('promptInput.emoji.credit')}</p>
  </dialog>, document.body)
}
