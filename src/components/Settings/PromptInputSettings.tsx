/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '../../i18n/core'
import { RESERVED_SHORTCUTS } from '../../../electron/main/reserved-shortcuts'
import {
  normalizePromptInputSettings, normalizePromptShortcut, validatePromptInputSettings, reorderPromptActions,
  PROMPT_TERMINAL_KEYS, promptTargetSlot, normalizePromptTargetModifier, type PromptInputAction, type PromptInputValidationError
} from '../../utils/prompt-input'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { getPromptInputActionLabel, formatPromptShortcutLabel } from '../../utils/prompt-input-labels'
import { ShortcutInput } from './ShortcutInput'
import { PromptActionButton } from '../PromptNotebook/PromptActionButton'
import { PromptShortcutPreview } from './PromptShortcutPreview'
import { PromptActionAppearance } from './PromptActionAppearance'
import './PromptInputSettings.css'

const VALIDATION_KEYS: Record<PromptInputValidationError, TranslationKey> = {
  'invalid-leader': 'promptInput.settings.invalidLeader',
  'invalid-shortcut': 'promptInput.settings.invalidShortcut',
  'duplicate-shortcut': 'promptInput.settings.duplicateShortcut',
  'invalid-action': 'promptInput.settings.invalidAction',
  'shortcut-conflict': 'promptInput.settings.shortcutConflict',
  'invalid-selector': 'promptInput.settings.invalidSelector',
  'selector-conflict': 'promptInput.settings.selectorConflict'
}

const ICONS = {
  add: 'M7 2h2v5h5v2H9v5H7V9H2V7h5V2Z',
  visible: 'M8 3C4 3 1.5 6 0 8c1.5 2 4 5 8 5s6.5-3 8-5c-1.5-2-4-5-8-5Zm0 1.5c2.8 0 4.8 1.8 6.1 3.5-1.3 1.7-3.3 3.5-6.1 3.5S3.2 9.7 1.9 8C3.2 6.3 5.2 4.5 8 4.5ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  copy: 'M5 1h9v10h-2V3H5V1ZM2 5h8v10H2V5Zm2 2v6h4V7H4Z',
  remove: 'M6 1h4v2h4v2H2V3h4V1ZM3 6h10l-1 9H4L3 6Zm3 1v6h1V7H6Zm3 0v6h1V7H9Z'
}
function Icon({ name }: { name: keyof typeof ICONS }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d={ICONS[name]} /></svg>
}

export function PromptInputSettings({ revealRequest = 0 }: { revealRequest?: number }) {
  const { settings, updatePromptInput } = useSettings()
  const { t } = useI18n()
  const id = useId()
  const saved = useMemo(() => normalizePromptInputSettings(settings?.promptInput), [settings?.promptInput])
  const [draft, setDraft] = useState(saved)
  const [baseline, setBaseline] = useState(saved)
  const [timeout, setTimeoutValue] = useState(String(saved.timeoutMs))
  const [saving, setSaving] = useState(false)
  const [recording, setRecording] = useState(false)
  const [status, setStatus] = useState<TranslationKey | null>(null)
  const [saveError, setSaveError] = useState<TranslationKey | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState(saved.actions[0]?.id ?? '')
  const [previewHit, setPreviewHit] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null)
  const dragRef = useRef<{ id: string; started: number } | null>(null)
  const headingRef = useRef<HTMLButtonElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [orderRevision, setOrderRevision] = useState(0)
  const mounted = useRef(true)
  const savingRef = useRef(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline) || timeout !== String(baseline.timeoutMs)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const platform = window.electronAPI?.platform ?? 'darwin'
  const existingShortcuts = useMemo(() => [
    ...Object.values(settings?.shortcuts ?? {}), ...Object.values(RESERVED_SHORTCUTS).flat()
  ], [settings?.shortcuts])
  const globalShortcut = settings?.shortcuts.activateAndFocusPrompt ?? null
  const timeoutMs = Number(timeout)
  const timeoutValid = timeout.trim() !== '' && Number.isInteger(timeoutMs) && timeoutMs >= 500 && timeoutMs <= 10000
  const validation = validatePromptInputSettings(draft, existingShortcuts, platform, [globalShortcut])
  const validationKey = !timeoutValid ? 'promptInput.settings.invalidTimeout' : validation ? VALIDATION_KEYS[validation] : null
  const action = draft.actions.find(item => item.id === selectedId) ?? draft.actions[0]
  const previewSettings = useMemo(() => ({ ...draft, timeoutMs: timeoutValid ? timeoutMs : 1500 }), [draft, timeoutMs, timeoutValid])

  useLayoutEffect(() => {
    if (!revealRequest) return
    setExpanded(true)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'expand-search' })
    headingRef.current?.scrollIntoView({ block: 'nearest' })
  }, [revealRequest])

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!expanded || !rail) return
    const started = performance.now()
    const targetId = previewHit ?? action?.id
    const button = Array.from(rail.querySelectorAll<HTMLButtonElement>('[data-action-id]')).find(item => item.dataset.actionId === targetId)
    if (!button) {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'preview-hidden-action' })
      return
    }
    const bounds = rail.getBoundingClientRect()
    const rect = button.getBoundingClientRect()
    if (rect.left < bounds.left + 3) rail.scrollLeft += rect.left - bounds.left - 3
    else if (rect.right > bounds.right - 3) rail.scrollLeft += rect.right - bounds.right + 3
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'preview-reveal', durationMs: performance.now() - started })
    let resizeTraceAt = -Infinity
    const observer = new ResizeObserver(() => {
      const bounds = rail.getBoundingClientRect()
      const rect = button.getBoundingClientRect()
      const delta = rect.left < bounds.left + 3 ? rect.left - bounds.left - 3
        : rect.right > bounds.right - 3 ? rect.right - bounds.right + 3 : 0
      if (Math.abs(delta) < 1) return
      rail.scrollLeft += delta
      const now = performance.now()
      if (now - resizeTraceAt >= 1000) {
        resizeTraceAt = now
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'preview-resize-reveal' })
      }
    })
    observer.observe(rail)
    return () => observer.disconnect()
  }, [expanded, action?.id, action?.visible, previewHit, orderRevision])

  useEffect(() => {
    mounted.current = true
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-open' })
    return () => {
      mounted.current = false
      if (dragRef.current) perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_REORDER, { reason: 'dispose' })
      dragRef.current = null
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-close', dirty: dirtyRef.current, saving: savingRef.current })
    }
  }, [])

  useEffect(() => {
    if (savingRef.current || dirtyRef.current) return
    setDraft(saved)
    setBaseline(saved)
    setTimeoutValue(String(saved.timeoutMs))
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-sync', actions: saved.actions.length })
  }, [saved])

  const traceEdit = (field: string) => {
    setStatus(null)
    setSaveError(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'draft-edit', field })
  }

  const updateAction = (actionId: string, patch: Partial<PromptInputAction>) => {
    setDraft(current => ({ ...current, actions: current.actions.map(action => action.id === actionId ? { ...action, ...patch } : action) }))
    setStatus(null)
    setSaveError(null)
  }

  const actionName = (action: PromptInputAction) => getPromptInputActionLabel(action, t)
  const keyName = (key: string) => key.startsWith('Control+')
    ? t('promptInput.key.control', { key: key.slice(8) })
    : t(`promptInput.key.${key}` as TranslationKey)

  const validateLeader = (key: string): TranslationKey | null => {
    const error = validatePromptInputSettings({ ...draft, leader: key, actions: [] }, existingShortcuts, platform, [globalShortcut])
    if (error) return VALIDATION_KEYS[error]
    return draft.actions.some(action => normalizePromptShortcut(action.shortcut, platform) === key)
      ? 'promptInput.settings.invalidShortcut' : null
  }

  const validateActionKey = (actionId: string, key: string): TranslationKey | null => {
    const canonical = normalizePromptShortcut(key, platform)
    if (!canonical || canonical === 'Escape' || /^[1-8]$/.test(canonical) || canonical === normalizePromptShortcut(draft.leader, platform)) return 'promptInput.settings.invalidShortcut'
    if (canonical === normalizePromptShortcut(globalShortcut, platform)) return 'promptInput.settings.globalShortcutConflict'
    if (promptTargetSlot(canonical, draft.targetModifier) !== null) return 'promptInput.settings.selectorConflict'
    return draft.actions.some(action => action.id !== actionId && normalizePromptShortcut(action.shortcut, platform) === canonical)
      ? 'promptInput.settings.duplicateShortcut' : null
  }

  const addAction = (source?: PromptInputAction) => {
    const action: PromptInputAction = source
      ? { ...source, id: crypto.randomUUID(), name: t('promptInput.settings.copyName', { name: actionName(source) }).slice(0, 120), shortcut: null }
      : { id: crypto.randomUUID(), name: t('promptInput.settings.newName'), visible: true, includePrompt: true, terminalKey: 'None', target: 'default', shortcut: null }
    setDraft(current => {
      const actions = [...current.actions]
      const sourceIndex = source ? actions.findIndex(item => item.id === source.id) : -1
      actions.splice(sourceIndex < 0 ? actions.length : sourceIndex + 1, 0, action)
      return { ...current, actions }
    })
    traceEdit(source ? 'duplicate' : 'create')
    setSelectedId(action.id)
  }

  const moveAction = (sourceId: string, targetId: string, after: boolean, source: 'drag' | 'keyboard') => {
    setDraft(current => {
      const actions = reorderPromptActions(current.actions, sourceId, targetId, after)
      return actions === current.actions ? current : { ...current, actions }
    })
    setSelectedId(sourceId)
    setOrderRevision(value => value + 1)
    traceEdit('reorder')
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_REORDER, {
      reason: 'commit', source, after, durationMs: dragRef.current ? performance.now() - dragRef.current.started : 0
    })
    dragRef.current = null
    setDrop(null)
  }
  const selectAction = (id: string) => {
    setSelectedId(id)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'select-action' })
  }
  const moveByKey = (event: KeyboardEvent, id: string) => {
    if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const index = draft.actions.findIndex(item => item.id === id)
    const after = event.key === 'ArrowRight'
    const target = draft.actions[index + (after ? 1 : -1)]
    if (target) moveAction(id, target.id, after, 'keyboard')
    else perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_REORDER, { reason: 'boundary' })
  }
  const endDrag = () => {
    if (dragRef.current) perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_REORDER, { reason: 'cancel' })
    dragRef.current = null
    setDrop(null)
  }

  const save = async () => {
    if (savingRef.current || recording) return
    if (validationKey) {
      setSaveError(validationKey)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-invalid', error: validation ?? 'invalid-timeout' })
      return
    }
    savingRef.current = true
    setSaving(true)
    setStatus(null)
    setSaveError(null)
    const submitted = normalizePromptInputSettings({ ...draft, timeoutMs })
    let ok = false
    try {
      ok = await updatePromptInput(submitted)
    } catch {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-save-rejected' })
    } finally {
      savingRef.current = false
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-save-result', ok, mounted: mounted.current })
      if (mounted.current) {
        setSaving(false)
        if (ok) {
          setDraft(submitted)
          setBaseline(submitted)
          setTimeoutValue(String(submitted.timeoutMs))
          setStatus('promptInput.settings.saved')
        } else {
          setSaveError('promptInput.settings.saveFailed')
        }
      }
    }
  }

  const cancel = () => {
    setDraft(saved)
    setBaseline(saved)
    setTimeoutValue(String(saved.timeoutMs))
    setSaveError(null)
    setStatus('promptInput.settings.cancelled')
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: 'editor-cancel' })
  }

  return <section className="prompt-input-settings settings-group" data-settings-target="prompt-input" data-testid="prompt-input-settings" tabIndex={-1} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="settings-group-title">
      <button type="button" className="prompt-input-disclosure" ref={headingRef} data-testid="prompt-input-expand"
        aria-expanded={expanded} aria-controls={`${id}-editor`} onClick={() => {
          endDrag()
          setExpanded(value => !value)
          perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_SETTINGS, { reason: expanded ? 'collapse' : 'expand' })
        }}><span aria-hidden="true">{expanded ? '⌄' : '›'}</span>{t('promptInput.settings.title')}</button>
    </h3>
    {expanded && <div id={`${id}-editor`}>
    <fieldset disabled={saving || !settings} className="prompt-input-fields">
      <div className="prompt-input-global-row">
        <span title={t('promptInput.settings.leaderHint')}>{t('promptInput.settings.leaderCompact')}</span>
        <ShortcutInput mode="leader" value={draft.leader} disabled={saving} label={t('promptInput.settings.leader')}
          placeholder={t('promptInput.recording.notSet')} dataTestId="prompt-input-leader"
          validate={validateLeader} onRecordingChange={setRecording}
          onChange={leader => { setDraft(current => ({ ...current, leader })); traceEdit('leader') }} />
        <label className="prompt-input-timeout" title={t('promptInput.settings.timeoutHint')}>
        <span>{t('promptInput.settings.timeoutCompact')}</span>
        <input type="number" min={500} max={10000} step={100} inputMode="numeric" value={timeout}
          data-testid="prompt-input-timeout" aria-label={t('promptInput.settings.timeout')} aria-invalid={!timeoutValid}
          onChange={event => { setTimeoutValue(event.target.value); setStatus(null); setSaveError(null) }} onBlur={() => traceEdit('timeout')} />
        </label>
      </div>
      <label className="prompt-input-selector-row">
        <span>{t('promptInput.settings.selector')}</span>
        <select value={draft.targetModifier ?? ''} data-testid="prompt-input-target-modifier" onChange={event => {
          setDraft(current => ({ ...current, targetModifier: normalizePromptTargetModifier(event.target.value) }))
          traceEdit('target-modifier')
        }}>
          <option value="Alt">{t(platform === 'darwin' ? 'promptInput.selector.option' : 'promptInput.selector.alt')}</option>
          <option value="Control">{t('promptInput.selector.control')}</option>
          <option value="Shift">{t('promptInput.selector.shift')}</option>
          <option value="">{t('promptInput.selector.direct')}</option>
        </select>
      </label>
      <p className="prompt-input-hint" data-testid="prompt-input-target-hint">{draft.targetModifier
        ? t('promptInput.settings.selectorHint', { key: formatPromptShortcutLabel(`${draft.targetModifier}+3`, platform) })
        : t('promptInput.settings.selectorDirectHint')}</p>
      <div className="prompt-input-preview-heading">
        <span title={t('promptInput.settings.reorderHint')}>{t('promptInput.settings.preview')}</span>
        <select data-testid="prompt-input-action-select" aria-label={t('promptInput.settings.chooseAction')} value={action?.id ?? ''}
          onChange={event => selectAction(event.target.value)} onKeyDown={event => { if (action) moveByKey(event, action.id) }}>
          {draft.actions.map(item => <option key={item.id} value={item.id}>{actionName(item)}{item.visible ? '' : ` · ${t('promptInput.settings.hidden')}`}</option>)}
        </select>
        <button type="button" className="prompt-input-icon" data-testid="prompt-input-add" title={t('promptInput.settings.add')}
          aria-label={t('promptInput.settings.add')} onClick={() => addAction()}><Icon name="add" /></button>
      </div>
      <div className="prompt-action-rail" ref={railRef} data-testid="prompt-input-preview" aria-label={t('promptInput.settings.preview')}>
        {draft.actions.filter(item => item.visible).map(item => <PromptActionButton key={item.id} action={item} leader={draft.leader}
          disabled={saving} aria-pressed={item.id === action?.id} data-preview-hit={previewHit === item.id}
          draggable={!saving} data-drop={drop?.id === item.id ? drop.after ? 'after' : 'before' : undefined}
          onClick={() => selectAction(item.id)} onKeyDown={event => moveByKey(event, item.id)}
          onDragStart={event => {
            dragRef.current = { id: item.id, started: performance.now() }
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', item.id)
            perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_REORDER, { reason: 'start' })
          }} onDragOver={event => {
            if (!dragRef.current) return
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            const after = event.clientX > rect.left + rect.width / 2
            setDrop(current => current?.id === item.id && current.after === after ? current : { id: item.id, after })
          }} onDragLeave={() => setDrop(null)} onDragEnd={endDrag} onDrop={event => {
            event.preventDefault()
            const source = dragRef.current?.id
            if (!source) { perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_INPUT_REORDER, { reason: 'external-drop-rejected' }); return }
            const rect = event.currentTarget.getBoundingClientRect()
            moveAction(source, item.id, event.clientX > rect.left + rect.width / 2, 'drag')
          }} />)}
      </div>
      {!draft.actions.length && <p className="prompt-input-hint">{t('promptInput.settings.empty')}</p>}
      {action && <div key={action.id} className="prompt-input-action" data-action-id={action.id} data-prompt-action-id={action.id} data-testid="prompt-input-action">
          <div className="prompt-input-edit-row">
            <PromptActionAppearance action={action} onChange={patch => updateAction(action.id, patch)} />
            <input className="prompt-input-name" type="text" value={action.name} maxLength={120} placeholder={actionName({ ...action, name: '' })}
              aria-label={t('promptInput.settings.name')} title={actionName(action)}
              data-testid={`prompt-input-action-${action.id}-name`} onChange={event => updateAction(action.id, { name: event.target.value })}
              onBlur={() => traceEdit('name')} />
          <label className="prompt-input-icon prompt-input-visibility" title={t('promptInput.settings.visible')}>
            <input type="checkbox" checked={action.visible} data-testid={`prompt-input-action-${action.id}-visible`}
              aria-label={t('promptInput.settings.visible')}
              onChange={event => { updateAction(action.id, { visible: event.target.checked }); traceEdit('visible') }} />
            <Icon name="visible" />
          </label>
            <button type="button" className="prompt-input-icon" onClick={() => addAction(action)} data-testid={`prompt-input-action-${action.id}-duplicate`}
              title={t('promptInput.settings.duplicate')} aria-label={t('promptInput.settings.duplicate')}><Icon name="copy" /></button>
            <button type="button" className="prompt-input-icon prompt-input-delete" data-testid={`prompt-input-action-${action.id}-delete`}
              title={t('promptInput.settings.delete')} aria-label={t('promptInput.settings.delete')}
              onClick={() => { setDraft(current => ({ ...current, actions: current.actions.filter(item => item.id !== action.id) })); traceEdit('delete') }}><Icon name="remove" /></button>
          </div>
          <div className="prompt-input-edit-row">
          <label className="prompt-input-checkbox" title={t('promptInput.settings.includePrompt')}>
            <input type="checkbox" checked={action.includePrompt} data-testid={`prompt-input-action-${action.id}-include-prompt`}
              aria-label={t('promptInput.settings.includePrompt')}
              onChange={event => { updateAction(action.id, { includePrompt: event.target.checked }); traceEdit('include-prompt') }} />
            <span>{t('promptInput.settings.promptCompact')}</span>
          </label>
              <select value={action.terminalKey} data-testid={`prompt-input-action-${action.id}-terminal-key`} aria-label={t('promptInput.settings.terminalKey')}
                title={keyName(action.terminalKey)}
                onChange={event => { updateAction(action.id, { terminalKey: event.target.value }); traceEdit('terminal-key') }}>
                {PROMPT_TERMINAL_KEYS.map(key => <option key={key} value={key}>{keyName(key)}</option>)}
              </select>
              <select value={action.target} data-testid={`prompt-input-action-${action.id}-target`} aria-label={t('promptInput.settings.target')}
                title={t(action.target === 'all' ? 'promptInput.target.all' : 'promptInput.target.default')}
                onChange={event => { updateAction(action.id, { target: event.target.value === 'all' ? 'all' : 'default' }); traceEdit('target') }}>
                <option value="default">{t('promptInput.settings.targetDefault')}</option>
                <option value="all">{t('promptInput.settings.targetAll')}</option>
              </select>
          </div>
          <div className="prompt-input-edit-row">
            <span title={t('promptInput.settings.shortcutHint')}>{t('promptInput.settings.shortcutCompact')}</span>
            <ShortcutInput mode="action" value={action.shortcut} disabled={saving}
              label={t('promptInput.settings.shortcut')} dataTestId={`prompt-input-action-${action.id}-shortcut`}
              validate={key => validateActionKey(action.id, key)} onRecordingChange={setRecording}
              onChange={shortcut => { updateAction(action.id, { shortcut }); traceEdit('action-shortcut') }} />
          </div>
        </div>}
      <PromptShortcutPreview settings={previewSettings} disabled={saving || recording || Boolean(validationKey)} onMatch={setPreviewHit} />
    </fieldset>
    {validationKey && !saveError && <p className="prompt-input-error" role="alert" data-testid="prompt-input-error">{t(validationKey)}</p>}
    <div className="prompt-input-save-bar">
      <p role={saveError ? 'alert' : 'status'} aria-live="polite" className={saveError ? 'prompt-input-error' : 'prompt-input-hint'} data-testid="prompt-input-status"
        data-state={saving ? 'saving' : saveError ? 'error' : status === 'promptInput.settings.saved' ? 'saved' : dirty ? 'dirty' : 'idle'}>
        {saving ? t('promptInput.settings.saving') : saveError ? t(saveError) : status ? t(status) : dirty ? t('promptInput.settings.unsaved') : ''}
      </p>
      <div className="prompt-input-save-buttons">
        <button type="button" onClick={cancel} disabled={saving || (!dirty && !saveError)} data-testid="prompt-input-cancel">{t('promptInput.settings.cancel')}</button>
        <button type="button" className="prompt-input-save" onClick={() => { void save() }} disabled={saving || recording || !dirty || !settings} data-testid="prompt-input-save">
          {t(saving ? 'promptInput.settings.saving' : 'promptInput.settings.save')}
        </button>
      </div>
    </div>
    </div>}
  </section>
}
