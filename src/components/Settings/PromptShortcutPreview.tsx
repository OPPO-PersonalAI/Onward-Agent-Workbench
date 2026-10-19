/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { getPromptInputActionLabel } from '../../utils/prompt-input-labels'
import { promptShortcutCancellation, promptShortcutFromKey, reducePromptLeader, type PromptInputSettings, type PromptLeaderState, type PromptShortcutEvent } from '../../utils/prompt-input'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { setRecordingSuspended } from './ShortcutInput'

// Sample identities are deliberately independent of the live Task layout.
const PREVIEW_CONTEXT = {
  tabId: 'settings-preview', visibleTerminalIds: Array.from({ length: 8 }, (_, index) => String(index + 1)),
  activeTerminalId: '1', blocked: false
}

export function PromptShortcutPreview({ settings, disabled, onMatch }: {
  settings: PromptInputSettings; disabled: boolean; onMatch: (actionId: string | null) => void
}) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'ready' | 'failed'>('idle')
  const [result, setResult] = useState<PromptShortcutEvent | null>(null)
  const sessionRef = useRef<{ ready: boolean } | null>(null)
  const stateRef = useRef<PromptLeaderState | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const mounted = useRef(true)
  const matchRef = useRef(onMatch)
  matchRef.current = onMatch
  const trace = useCallback((reason: string, data?: Record<string, unknown>) => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_PREVIEW, { reason, ...data })
  }, [])
  const reset = useCallback(() => {
    stateRef.current = null
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    matchRef.current(null)
  }, [])
  const stop = useCallback((reason: string) => {
    reset()
    if (!sessionRef.current) return
    sessionRef.current = null
    if (mounted.current) { setPhase('idle'); setResult(null) }
    trace('exit', { cause: reason })
    void setRecordingSuspended(false).catch(() => {
      trace('resume-failed')
      if (mounted.current && !sessionRef.current) setPhase('failed')
    })
  }, [reset, trace])

  useEffect(() => {
    mounted.current = true
    trace('mount')
    const blur = () => stop('window-blur')
    const hidden = () => { if (document.hidden) stop('hidden') }
    // Window capture runs before editor/save/subpage document-capture handlers.
    // Scope ownership to this focused surface; preserve unconsumed Tab traversal.
    const captureKey = (event: KeyboardEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) return
      if (event.type === 'keydown') keyHandlerRef.current(event)
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) event.preventDefault()
      event.stopImmediatePropagation()
    }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('keydown', captureKey, true)
    window.addEventListener('keyup', captureKey, true)
    window.addEventListener('keypress', captureKey, true)
    return () => {
      mounted.current = false
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('keydown', captureKey, true)
      window.removeEventListener('keyup', captureKey, true)
      window.removeEventListener('keypress', captureKey, true)
      stop('unmount')
      trace('unmount')
    }
  }, [stop, trace])
  useEffect(() => {
    if (sessionRef.current) trace('draft-replaced')
    reset()
    setResult(null)
    if (disabled) stop('disabled')
  }, [settings, disabled, reset, stop, trace])

  const start = async () => {
    if (disabled || sessionRef.current) {
      trace('enter-rejected', { cause: disabled ? 'disabled' : 'already-active' })
      return
    }
    const session = { ready: false }
    sessionRef.current = session
    setPhase('preparing')
    setResult(null)
    trace('enter')
    try {
      await setRecordingSuspended(true)
      if (sessionRef.current !== session) { trace('enter-stale'); return }
      session.ready = true
      setPhase('ready')
      trace('ready')
    } catch {
      if (sessionRef.current === session) { stop('suspend-failed'); setPhase('failed') }
      trace('suspend-failed')
    }
  }

  keyHandlerRef.current = (event: KeyboardEvent) => {
    if (!sessionRef.current?.ready) return
    const started = performance.now()
    const key = promptShortcutFromKey(event, window.electronAPI.platform)
    const cancellation = promptShortcutCancellation(event)
      ?? (stateRef.current && !key && !/^(Control|Meta|Alt|Shift)$/.test(event.key) ? 'unmatched' : null)
    if (cancellation) {
      const wasArmed = stateRef.current !== null
      reset()
      if (wasArmed) {
        setResult({ kind: 'cancel', active: false, tabId: PREVIEW_CONTEXT.tabId, reason: cancellation })
        trace('input-cancel', { cause: cancellation })
      }
      return
    }
    const transition = reducePromptLeader(stateRef.current,
      key, started, settings, PREVIEW_CONTEXT,
      { repeat: event.repeat, platform: window.electronAPI.platform })
    if (transition.consume) { event.preventDefault(); event.stopPropagation() }
    if (!transition.event) return
    reset()
    stateRef.current = transition.state
    setResult(transition.event)
    // Only chord transitions are recorded, never ordinary typing or held-key repeats.
    trace('transition', { kind: transition.event.kind, cause: transition.event.reason,
      actionId: transition.event.actionId, targetId: transition.event.targetId, durationMs: performance.now() - started })
    if (transition.state) {
      timerRef.current = setTimeout(() => {
        reset()
        setResult({ kind: 'cancel', active: false, tabId: PREVIEW_CONTEXT.tabId, reason: 'timeout' })
        trace('timeout')
      }, Math.max(0, transition.state.deadline - performance.now()))
    } else if (transition.event.kind === 'dispatch' && transition.event.actionId) {
      matchRef.current(transition.event.actionId)
    }
  }
  const matched = result?.kind === 'dispatch' ? settings.actions.find(action => action.id === result.actionId) : null
  const text = phase === 'failed' ? t('promptInput.preview.failed')
    : phase === 'preparing' ? t('promptInput.recording.preparing')
      : !settings.leader ? t('promptInput.settings.leaderDisabled')
        : matched ? t('promptInput.preview.matched', {
          name: getPromptInputActionLabel(matched, t), target: result?.targetId
            ? t('promptInput.target.explicit', { index: result.targetId }) : t(matched.target === 'all' ? 'promptInput.target.all' : 'promptInput.target.default')
        }) : result?.active ? t('promptInput.preview.waiting', { target: result.targetId ?? '—' })
          : result?.kind === 'passthrough' ? t('promptInput.preview.passthrough')
            : result?.kind === 'cancel' ? t('promptInput.preview.cancelled') : t('promptInput.preview.idle')
  return <div className="prompt-input-preview-test" ref={rootRef} role="group" tabIndex={disabled ? -1 : 0}
    aria-label={t('promptInput.preview.label')} aria-disabled={disabled}
    data-testid="prompt-input-preview-test" data-prompt-shortcut-recorder="true" data-phase={phase}
    data-result={result?.kind ?? ''} data-action-id={matched?.id} data-target-id={result?.targetId}
    onFocus={() => { void start() }} onClick={() => { void start() }} onBlur={() => stop('blur')}
    onCompositionStart={() => { reset(); setResult(null); trace('composition-cancel') }}>
    <span role={phase === 'failed' ? 'alert' : 'status'} aria-live="polite">{text}</span>
  </div>
}
