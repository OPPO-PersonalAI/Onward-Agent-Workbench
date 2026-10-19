/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { PromptInputAction } from '../../utils/prompt-input'
import { formatPromptShortcutLabel, getPromptInputActionLabel, getPromptTerminalKeyLabel } from '../../utils/prompt-input-labels'
import { useI18n } from '../../i18n/useI18n'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { shouldDismissMenuOnScroll } from '../../utils/popup-position'
import './PromptActionButton.css'
import { getPromptActionEmoji } from '../../utils/prompt-emoji'
import { PromptActionEmoji } from './PromptActionEmoji'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  action: PromptInputAction
  leader: string | null
}

/** Shared presentation for the live sender and the editable preview. */
export function PromptActionButton({ action, leader, className = '', style, onFocus, onBlur, ...props }: Props) {
  const { t } = useI18n()
  const tooltipId = useId()
  const [focusAnchor, setFocusAnchor] = useState<HTMLButtonElement | null>(null)
  const tooltipRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'color-button-mounted' })
  }, [])
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    if (!focusAnchor || !tooltip) return
    let repositions = 0
    let ignoredScrolls = 0
    let positionDurationMs = 0
    let cause = 'focus-or-unmount'
    // Focus can enqueue ancestor scrolls after onFocus. Keep the label anchored
    // through those events rather than retiring the new label immediately.
    const position = () => {
      const started = performance.now()
      const rect = focusAnchor.getBoundingClientRect()
      tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`
      tooltip.style.top = `${rect.top >= 100 ? rect.top - 6 : rect.bottom + 6}px`
      tooltip.style.transform = rect.top >= 100 ? 'translateY(-100%)' : ''
      repositions += 1
      positionDurationMs += performance.now() - started
    }
    position()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'color-button-focus-label', durationMs: positionDurationMs })
    const hide = () => { cause = 'window-blur'; setFocusAnchor(null) }
    const scroll = (event: Event) => {
      if (shouldDismissMenuOnScroll({ target: event.target, anchor: focusAnchor, menu: null })) position()
      else ignoredScrolls += 1
    }
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', position)
    window.addEventListener('blur', hide)
    return () => {
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', position)
      window.removeEventListener('blur', hide)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_ACTION, { phase: 'color-button-label-hidden', cause, repositions, ignoredScrolls, positionDurationMs })
    }
  }, [focusAnchor])
  const label = getPromptInputActionLabel(action, t)
  const shortcut = leader && action.shortcut ? t('promptInput.runtime.shortcut', {
    leader: formatPromptShortcutLabel(leader, window.electronAPI.platform),
    key: formatPromptShortcutLabel(action.shortcut, window.electronAPI.platform)
  }) : ''
  const description = t('promptInput.runtime.description', {
    prompt: t(action.includePrompt ? 'promptInput.runtime.withPrompt' : 'promptInput.runtime.keyOnly'),
    key: getPromptTerminalKeyLabel(action.terminalKey, t),
    target: t(action.target === 'all' ? 'promptInput.runtime.allTargets' : 'promptInput.runtime.defaultTargets')
  })
  const details = [label, description, shortcut].filter(Boolean).join('\n')
  return <><button {...props} type="button" data-action-id={action.id} data-preset={action.preset ?? 'custom'}
    className={`prompt-action-swatch ${className}`} aria-label={props['aria-label'] ?? label}
    title={props.title ?? details} aria-describedby={focusAnchor ? tooltipId : props['aria-describedby']}
    onFocus={event => {
      onFocus?.(event)
      if (!event.currentTarget.matches(':focus-visible')) return
      setFocusAnchor(event.currentTarget)
    }} onBlur={event => { onBlur?.(event); setFocusAnchor(null) }}
    style={{ ...style, ...(action.color ? { '--prompt-action-color': action.color } : {}) } as CSSProperties}>
    <PromptActionEmoji emoji={getPromptActionEmoji(action)} />
    </button>
    {focusAnchor && createPortal(<span ref={tooltipRef} id={tooltipId} role="tooltip" className="prompt-action-focus-label">{details}</span>, document.body)}
  </>
}
