/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '../../i18n/core'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import { normalizePromptShortcut, promptShortcutFromKey } from '../../utils/prompt-input'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'

interface ShortcutInputProps {
  value: string | null
  onChange: (value: string | null) => void
  onConflict?: (conflictKey: string | null) => void
  placeholder?: string
  mode?: 'shortcut' | 'leader' | 'action'
  label?: string
  disabled?: boolean
  excludeKey?: string
  promptLeader?: string | null
  validate?: (accelerator: string) => TranslationKey | null
  dataTestId?: string
  onRecordingChange?: (recording: boolean) => void
}

// Serialize suspend/resume IPC across recorder instances, including late acknowledgements.
let recordingSuspension: Promise<void> = Promise.resolve()
export function setRecordingSuspended(suspended: boolean, preserveNativeMenus = false): Promise<void> {
  const pending = recordingSuspension.then(async () => {
    const started = performance.now()
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: suspended ? 'record-suspend-send' : 'record-resume-send', preserveNativeMenus })
    try {
      const api = window.electronAPI?.promptInput
      if (!api) throw new Error('Prompt input bridge is unavailable')
      await api.suspend(suspended, preserveNativeMenus)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, {
        reason: suspended ? 'record-suspend-ack' : 'record-resume-ack', durationMs: performance.now() - started
      })
    } catch (error) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: suspended ? 'record-suspend-rejected' : 'record-resume-rejected' })
      throw error
    }
  })
  recordingSuspension = pending.catch(() => {})
  return pending
}

interface RecordingSession {
  ready: boolean
  checking: boolean
  detach?: () => void
}

// Convert KeyboardEvent to Electron Accelerator format
function keyEventToAccelerator(e: KeyboardEvent): string | null {
  const keys: string[] = []

  // Add modifier keys
  if (e.metaKey) keys.push('CommandOrControl')
  if (e.ctrlKey && !e.metaKey) keys.push('Ctrl')
  if (e.altKey) keys.push('Alt')
  if (e.shiftKey) keys.push('Shift')

  // Get primary key
  let mainKey = ''
  const code = e.code

  // Function keys
  if (code.startsWith('F') && /^F\d{1,2}$/.test(code)) {
    mainKey = code
  }
  // Numeric keys
  else if (code.startsWith('Digit')) {
    mainKey = code.replace('Digit', '')
  }
  // letter keys
  else if (code.startsWith('Key')) {
    mainKey = code.replace('Key', '')
  }
  // Special keys
  else {
    const specialKeys: Record<string, string> = {
      'Space': 'Space',
      'Enter': 'Enter',
      'Tab': 'Tab',
      'Backspace': 'Backspace',
      'Delete': 'Delete',
      'Escape': 'Escape',
      'ArrowUp': 'Up',
      'ArrowDown': 'Down',
      'ArrowLeft': 'Left',
      'ArrowRight': 'Right',
      'Home': 'Home',
      'End': 'End',
      'PageUp': 'PageUp',
      'PageDown': 'PageDown',
      'Insert': 'Insert',
      'Minus': '-',
      'Equal': '=',
      'BracketLeft': '[',
      'BracketRight': ']',
      'Backslash': '\\',
      'Semicolon': ';',
      'Quote': "'",
      'Comma': ',',
      'Period': '.',
      'Slash': '/',
      'Backquote': '`'
    }
    mainKey = specialKeys[code] || ''
  }

  // If there is no primary key, returns null
  if (!mainKey) return null

  // If there are only modifier keys but no primary keys, null is also returned.
  if (keys.length === 0) return null

  keys.push(mainKey)
  return keys.join('+')
}

// Convert Accelerator format to display format
function acceleratorToDisplay(accelerator: string | null): string {
  if (!accelerator) return ''

  const platform = window.electronAPI?.platform || 'darwin'
  const isMac = platform === 'darwin'

  const parts = accelerator.split('+')
  const displayParts = parts.map(part => {
    const mappings: Record<string, string> = {
      'CommandOrControl': isMac ? '\u2318' : 'Ctrl',
      'Command': '\u2318',
      'Control': 'Ctrl',
      'Ctrl': 'Ctrl',
      'Alt': isMac ? '\u2325' : 'Alt',
      'Option': '\u2325',
      'Shift': isMac ? '\u21E7' : 'Shift',
      'Meta': isMac ? '\u2318' : 'Win',
      'Space': '\u2423',
      'Enter': '\u21B5',
      'Tab': '\u21E5',
      'Backspace': '\u232B',
      'Delete': '\u2326',
      'Escape': 'Esc',
      'Up': '\u2191',
      'Down': '\u2193',
      'Left': '\u2190',
      'Right': '\u2192'
    }
    return mappings[part] || part
  })

  return displayParts.join(isMac ? '' : '+')
}

export function ShortcutInput({
  value,
  onChange,
  onConflict,
  placeholder,
  mode = 'shortcut',
  label,
  disabled = false,
  excludeKey,
  promptLeader,
  validate,
  dataTestId,
  onRecordingChange
}: ShortcutInputProps) {
  const { t } = useI18n()
  const [isRecording, setIsRecording] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const [error, setError] = useState<TranslationKey | null>(null)
  const inputRef = useRef<HTMLButtonElement>(null)
  const sessionRef = useRef<RecordingSession | null>(null)
  const mountedRef = useRef(true)
  const recordingChangeRef = useRef(onRecordingChange)
  recordingChangeRef.current = onRecordingChange

  const stopRecording = useCallback((reason: string, updateState = true) => {
    const session = sessionRef.current
    if (!session) return
    sessionRef.current = null
    session.detach?.()
    recordingChangeRef.current?.(false)
    if (updateState) {
      setIsRecording(false)
      setIsPreparing(false)
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-stop', cause: reason })
    void setRecordingSuspended(false).catch(() => {
      if (mountedRef.current && !sessionRef.current) setError('promptInput.recording.resumeFailed')
    })
  }, [])

  // Check for shortcut conflicts
  const checkConflict = useCallback(async (accelerator: string) => {
    if (mode === 'action') return null
    const platform = window.electronAPI?.platform ?? 'darwin'
    if (mode === 'shortcut' && promptLeader && normalizePromptShortcut(accelerator, platform) === normalizePromptShortcut(promptLeader, platform)) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-leader-conflict' })
      return 'promptInputLeader'
    }
    if (!window.electronAPI?.settings) throw new Error('Settings bridge is unavailable')
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-check-send', mode })
    // The legacy conflict registry spells Meta as Command.
    const conflictKey = await window.electronAPI.settings.checkShortcutConflict(accelerator.replace(/\bMeta\b/g, 'Command'), excludeKey)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-check-received', mode, conflict: Boolean(conflictKey) })
    if (mode === 'leader' && conflictKey === 'promptInputLeader') return null
    return conflictKey
  }, [mode, excludeKey, promptLeader])

  // Handle keyboard presses
  const handleKeyDown = useCallback(async (e: KeyboardEvent) => {
    const session = sessionRef.current
    if (!session?.ready) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (e.isComposing || e.keyCode === 229 || e.repeat) return

    // If it is Escape, cancel recording
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      stopRecording('escape')
      setConflict(null)
      setError(null)
      return
    }
    if (session.checking) return

    // Convert to Accelerator format
    const accelerator = mode === 'shortcut' ? keyEventToAccelerator(e) : promptShortcutFromKey(e, window.electronAPI?.platform)
    if (!accelerator) return
    const validationError = validate?.(accelerator)
    if (validationError) {
      setError(validationError)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-invalid', mode })
      return
    }
    session.checking = true
    try {
      const conflictKey = await checkConflict(accelerator)
      if (sessionRef.current !== session) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-check-stale' })
        return
      }
      if (conflictKey) {
        setConflict(conflictKey)
        setError(null)
        onConflict?.(conflictKey)
        return
      }
      setConflict(null)
      setError(null)
      stopRecording('accepted')
      trackFeatureUse('shortcut-edit')
      onChange(accelerator)
      onConflict?.(null)
    } catch {
      if (sessionRef.current === session) setError('promptInput.recording.checkFailed')
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-check-rejected', mode })
    } finally {
      session.checking = false
    }
  }, [onChange, onConflict, checkConflict, mode, validate, stopRecording])
  const keyHandlerRef = useRef(handleKeyDown)
  keyHandlerRef.current = handleKeyDown

  // Process click to start recording
  const handleClick = useCallback(async () => {
    if (disabled || sessionRef.current) return
    const session: RecordingSession = { ready: false, checking: false }
    sessionRef.current = session
    inputRef.current?.focus()
    setIsPreparing(true)
    setConflict(null)
    setError(null)
    recordingChangeRef.current?.(true)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-start', mode })
    try {
      await setRecordingSuspended(true)
      if (sessionRef.current !== session) {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-start-stale' })
        return
      }
      const element = inputRef.current
      if (!element) {
        stopRecording('detached')
        return
      }
      session.ready = true
      const listener = (event: KeyboardEvent) => { void keyHandlerRef.current(event) }
      element.addEventListener('keydown', listener, true)
      session.detach = () => element.removeEventListener('keydown', listener, true)
      setIsPreparing(false)
      setIsRecording(true)
    } catch {
      if (sessionRef.current !== session) return
      stopRecording('suspend-failed')
      setError('promptInput.recording.failed')
    }
  }, [disabled, mode, stopRecording])

  // Dealing with losing focus
  const handleBlur = useCallback(() => {
    stopRecording('blur')
    setConflict(null)
  }, [stopRecording])

  // Handle clear
  const handleClear = useCallback(() => {
    stopRecording('clear')
    onChange(null)
    setConflict(null)
    setError(null)
    onConflict?.(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'record-clear', mode })
  }, [onChange, onConflict, mode, stopRecording])

  useEffect(() => {
    mountedRef.current = true
    const blur = () => stopRecording('window-blur')
    const visibility = () => { if (document.hidden) stopRecording('hidden') }
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      mountedRef.current = false
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
      stopRecording('unmount', false)
    }
  }, [stopRecording])
  useEffect(() => { if (disabled) stopRecording('disabled') }, [disabled, stopRecording])

  const displayValue = isPreparing ? t('promptInput.recording.preparing') : isRecording
    ? t(mode === 'shortcut' ? 'settings.shortcut.prompt' : 'promptInput.recording.prompt')
    : value
      ? mode === 'shortcut' ? acceleratorToDisplay(value) : value
      : (placeholder || t('settings.shortcut.notSet'))

  const inputClassName = [
    'shortcut-input',
    isRecording && 'recording',
    isPreparing && 'preparing',
    (conflict || error) && 'conflict',
    !value && !isRecording && !isPreparing && 'not-set'
  ].filter(Boolean).join(' ')

  return (
    <div className="shortcut-input-wrapper">
      <button
        type="button"
        ref={inputRef}
        className={inputClassName}
        disabled={disabled}
        aria-label={label}
        aria-pressed={isRecording}
        aria-busy={isPreparing}
        aria-invalid={Boolean(conflict || error)}
        data-testid={dataTestId}
        data-recording={isRecording ? 'ready' : isPreparing ? 'preparing' : 'idle'}
        onClick={() => { void handleClick() }}
        onBlur={handleBlur}
      >
        {displayValue}
      </button>
      <button
        type="button"
        className="shortcut-clear-btn"
        onClick={handleClear}
        disabled={disabled || !value}
        title={t('settings.shortcut.clear')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {conflict && (
        <div className="shortcut-conflict-msg" role="alert">
          {t('settings.shortcut.conflict', { label: getShortcutLabel(conflict, t) })}
        </div>
      )}
      {error && <div className="shortcut-conflict-msg" role="alert">{t(error)}</div>}
    </div>
  )
}

// Get the display label for the shortcut
function getShortcutLabel(key: string, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<string, string> = {
    focusTerminal1: t('settings.shortcut.focusTask', { index: 1 }),
    focusTerminal2: t('settings.shortcut.focusTask', { index: 2 }),
    focusTerminal3: t('settings.shortcut.focusTask', { index: 3 }),
    focusTerminal4: t('settings.shortcut.focusTask', { index: 4 }),
    focusTerminal5: t('settings.shortcut.focusTask', { index: 5 }),
    focusTerminal6: t('settings.shortcut.focusTask', { index: 6 }),
    focusTerminal7: t('settings.shortcut.focusTask', { index: 7 }),
    focusTerminal8: t('settings.shortcut.focusTask', { index: 8 }),
    switchTab1: t('settings.shortcut.switchTab', { index: 1 }),
    switchTab2: t('settings.shortcut.switchTab', { index: 2 }),
    switchTab3: t('settings.shortcut.switchTab', { index: 3 }),
    switchTab4: t('settings.shortcut.switchTab', { index: 4 }),
    switchTab5: t('settings.shortcut.switchTab', { index: 5 }),
    switchTab6: t('settings.shortcut.switchTab', { index: 6 }),
    activateAndFocusPrompt: t('settings.shortcut.togglePrompt'),
    addToHistory: t('settings.shortcut.addToHistory'),
    focusPromptEditor: t('settings.shortcut.focusPromptEditor'),
    terminalGitDiff: t('settings.shortcut.viewGitDiff'),
    terminalGitHistory: t('settings.shortcut.viewGitHistory'),
    terminalChangeWorkDir: t('settings.shortcut.changeWorkDir'),
    terminalOpenWorkDir: t('settings.shortcut.openWorkDir'),
    terminalProjectEditor: t('settings.shortcut.openProjectEditor'),
    viewGitDiff: t('settings.shortcut.projectEditorViewGitDiff'),
    promptEditCancel: t('settings.shortcut.reservedPromptEditCancel'),
    promptEditSave: t('settings.shortcut.reservedPromptEditSave'),
    promptEditSaveAsNew: t('settings.shortcut.reservedPromptEditSaveAsNew'),
    promptInputLeader: t('promptInput.settings.leader'),
    promptInputAction: t('promptInput.settings.actionShortcutLabel'),
    promptInputTarget: t('promptInput.settings.selector')
  }
  return labels[key] || key
}
