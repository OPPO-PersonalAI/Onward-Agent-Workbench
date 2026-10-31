/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SettingsState } from '../../types/settings'
import { useSettings } from '../../contexts/SettingsContext'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '../../i18n/core'
import { settingsValuesEqual, selectSettingsPage, type SettingsPageValues } from '../../utils/settings-page'
import { registerSettingsLeaveGuard, type SettingsLeaveReason } from '../../utils/settings-leave-guard'
import { isAnyModalOpen } from '../../utils/modal-dismiss'
import { useModalOpenRegistration } from '../../hooks/useModalEscape'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import { PAGE_LABELS, type SettingsPage } from './settings-navigation'

export interface SettingsDraftEditor {
  dirty: boolean
  busy?: boolean
  error?: string | null
  prepare: (settings: SettingsState) => SettingsState
  reset: () => void
  accepted: () => void
  focusError?: () => void
}

export interface SettingsDraftSession {
  settings: SettingsState | null
  dirty: boolean
  saving: boolean
  busy: boolean
  update: (change: (settings: SettingsState) => SettingsState) => void
  read: () => SettingsState | null
  register: (id: string, read: () => SettingsDraftEditor) => () => void
}

export const SettingsDraftContext = createContext<SettingsDraftSession | null>(null)
export const useSettingsDraft = () => useContext(SettingsDraftContext)

export function useSettingsDraftEditor(id: string, editor: SettingsDraftEditor): void {
  const session = useSettingsDraft()
  const ref = useRef(editor)
  ref.current = editor
  useLayoutEffect(() => session?.register(id, () => ref.current), [session?.register, id, editor.dirty, editor.busy, editor.error])
}

export function useSettingsDraftController(page: SettingsPage, container: React.RefObject<HTMLDivElement>) {
  const { settings: live, commitPage } = useSettings()
  const { t } = useI18n()
  const [baseline, setBaseline] = useState<SettingsPageValues>({})
  const [draft, setDraft] = useState<SettingsPageValues>({})
  const [owner, setOwner] = useState<SettingsPage>(page)
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<TranslationKey | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const editors = useRef(new Map<string, () => SettingsDraftEditor>())
  const pending = useRef<((allowed: boolean) => void) | null>(null)
  const savingPromise = useRef<Promise<boolean> | null>(null)
  const latest = useRef(live)
  latest.current = live
  const mounted = useRef(true)
  const valuesDirty = owner === page && !settingsValuesEqual(baseline, draft)
  const participants = [...editors.current.values()].map(read => read())
  const dirty = valuesDirty || participants.some(editor => editor.dirty)
  const busy = participants.some(editor => editor.busy)
  const invalid = participants.some(editor => editor.error)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const register = useCallback((id: string, read: () => SettingsDraftEditor) => {
    editors.current.set(id, read)
    setRevision(value => value + 1)
    return () => {
      if (editors.current.get(id) === read) editors.current.delete(id)
      if (mounted.current) setRevision(value => value + 1)
    }
  }, [])

  useLayoutEffect(() => {
    if (!live) return
    if (owner !== page || (!dirtyRef.current && !savingPromise.current)) {
      const values = page === 'about' ? {} : selectSettingsPage(live, page)
      setBaseline(values)
      setDraft(values)
      setOwner(page)
      if (owner !== page) { setStatus(null); setError(null) }
    }
  }, [live, page, owner])

  const settings = useMemo(() => live ? { ...live, ...(owner === page ? draft : {}) } : null, [live, draft, page, owner])
  const read = useCallback(() => settings ? [...editors.current.values()].reduce((state, editor) => editor().prepare(state), settings) : null, [settings])
  const update = useCallback((change: (state: SettingsState) => SettingsState) => {
    if (savingPromise.current || page === 'about' || !latest.current) return
    setDraft(previous => selectSettingsPage(change({ ...latest.current!, ...previous }), page))
    setStatus(null)
    setError(null)
  }, [page])

  const reset = useCallback(() => {
    if (!latest.current || page === 'about') return
    const values = selectSettingsPage(latest.current, page)
    setBaseline(values)
    setDraft(values)
    for (const read of editors.current.values()) read().reset()
    setStatus('settings.save.discarded')
    setError(null)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_DRAFT, { stage: 'discarded', page })
  }, [page])

  const save = useCallback((): Promise<boolean> => {
    if (savingPromise.current) return savingPromise.current
    if (!settings || page === 'about' || !dirtyRef.current) return Promise.resolve(true)
    const entries = [...editors.current.values()].map(read => read())
    const invalid = entries.find(editor => editor.error || editor.busy)
    if (invalid) {
      setError(invalid.error || t('settings.save.busy'))
      invalid.focusError?.()
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_COMMIT, { stage: 'validation-rejected', page, busy: Boolean(invalid.busy) })
      return Promise.resolve(false)
    }
    const submitted = entries.reduce((state, editor) => editor.prepare(state), settings)
    setSaving(true)
    setStatus(null)
    setError(null)
    const promise = (async () => {
      const result = await commitPage({ page, baseline, draft: selectSettingsPage(submitted, page) })
      if (!mounted.current) return false
      if (result.success) {
        const values = selectSettingsPage(result.settings, page)
        setBaseline(values)
        setDraft(values)
        for (const editor of entries) editor.accepted()
        setStatus('settings.save.saved')
        return true
      }
      setError(t(result.error === 'conflict' ? 'settings.save.conflict' : result.error === 'shortcut-unavailable'
        ? 'settings.save.shortcutUnavailable' : 'settings.save.failed'))
      return false
    })().finally(() => {
      savingPromise.current = null
      if (mounted.current) setSaving(false)
    })
    savingPromise.current = promise
    return promise
  }, [settings, page, baseline, commitPage, t])

  const leave = useCallback(async (reason: SettingsLeaveReason): Promise<boolean> => {
    if (savingPromise.current) return savingPromise.current
    if (!dirtyRef.current) return true
    if (pending.current) return false
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'confirmation-opened', page, reason })
    return new Promise<boolean>(resolve => { pending.current = resolve; setConfirming(true) })
  }, [page])
  const settle = useCallback((allowed: boolean, choice: string) => {
    const resolve = pending.current
    pending.current = null
    setConfirming(false)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'decision', page, choice, allowed })
    resolve?.(allowed)
  }, [page])

  useEffect(() => registerSettingsLeaveGuard(leave), [leave])
  useLayoutEffect(() => {
    window.electronAPI.settings.setDraftPending(dirty || saving)
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_DRAFT, { stage: 'state', page, dirty, saving })
  }, [dirty, saving, page])
  useEffect(() => window.electronAPI.settings.onConfirmExit(requestId => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'exit-received' })
    void leave('quit').then(allowed => {
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'exit-reply', allowed })
      window.electronAPI.settings.confirmExit(requestId, allowed)
    })
  }), [leave])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || isAnyModalOpen() || !container.current?.contains(document.activeElement)) return
      const modifier = window.electronAPI.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        event.stopPropagation()
        void save()
      } else if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        event.stopPropagation()
        container.current?.querySelector<HTMLButtonElement>('.settings-close-btn')?.click()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, container, busy])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      pending.current?.(false)
      pending.current = null
      window.electronAPI.settings.setDraftPending(false)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_DRAFT, { stage: 'disposed' })
    }
  }, [])

  const session = useMemo<SettingsDraftSession>(() => ({ settings, dirty, saving, busy, update, register, read }),
    [settings, dirty, saving, busy, update, register, read, revision])
  const footer = page === 'about' ? null : <div className="settings-save-footer" data-testid="settings-save-footer">
    <div className={`settings-save-status${error ? ' is-error' : dirty ? ' is-dirty' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite" data-testid="settings-save-status"
      data-state={saving ? 'saving' : error ? 'error' : dirty ? 'dirty' : 'clean'}>
      <span>{error || t(saving ? 'settings.save.saving' : dirty ? 'settings.save.dirty' : status ?? 'settings.save.clean')}</span>
      <small>{t('settings.save.scope', { page: t(PAGE_LABELS[page]) })}</small>
    </div>
    <div className="settings-save-actions">
      <button type="button" className="settings-action-button" data-testid="settings-discard" disabled={!dirty || saving || busy} onClick={reset}>{t('settings.save.discard')}</button>
      <button type="button" className="settings-action-button is-primary" data-testid="settings-save" disabled={!dirty || saving || busy || invalid} onClick={() => { void save() }}>{t(saving ? 'settings.save.saving' : 'common.save')}</button>
    </div>
  </div>
  const modal = confirming ? <SettingsLeaveDialog page={t(PAGE_LABELS[page])} busy={busy}
    onKeep={() => settle(false, 'keep')} onDiscard={() => { reset(); settle(true, 'discard') }}
    onSave={() => { setConfirming(false); void save().then(ok => settle(ok, 'save')) }} /> : null
  return { session, footer, modal, leave }
}

function SettingsLeaveDialog({ page, busy, onKeep, onDiscard, onSave }: {
  page: string; busy: boolean; onKeep: () => void; onDiscard: () => void; onSave: () => void
}) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  useModalOpenRegistration(true)
  useLayoutEffect(() => {
    const origin = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); if (origin?.isConnected) origin.focus({ preventScroll: true }) }
  }, [])
  return createPortal(<dialog ref={dialog} className="settings-leave-dialog" data-testid="settings-leave-dialog"
    aria-labelledby="settings-leave-title" aria-describedby="settings-leave-description" onCancel={event => { event.preventDefault(); onKeep() }}>
    <h2 id="settings-leave-title">{t('settings.save.leaveTitle', { page })}</h2>
    <p id="settings-leave-description">{t('settings.save.leaveBody')}</p>
    <div className="settings-save-actions">
      <button type="button" className="settings-action-button" data-testid="settings-leave-keep" autoFocus onClick={onKeep}>{t('settings.save.keepEditing')}</button>
      <button type="button" className="settings-action-button is-danger" data-testid="settings-leave-discard" onClick={onDiscard}>{t('settings.save.leaveWithout')}</button>
      <button type="button" className="settings-action-button is-primary" data-testid="settings-leave-save" disabled={busy} onClick={onSave}>{t('settings.save.saveLeave')}</button>
    </div>
  </dialog>, document.body)
}
