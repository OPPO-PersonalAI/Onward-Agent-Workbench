/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ThemeDefinition, ThemeSchedule, ThemeSettings, ThemeTimeRange } from '../../types/theme'
import { conflictingTimeRange, MAX_THEME_TIME_RANGES, minuteToTime, resolveThemeSchedule, timeRangeValid, timeToMinute } from '../../themes/theme-schedule'
import { ThemeScheduleTimeline } from './ThemeScheduleTimeline'
import { useI18n } from '../../i18n/useI18n'
import { useModalEscape } from '../../hooks/useModalEscape'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './ThemeScheduleEditor.css'

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const trace = (reason: string, extra: Record<string, unknown> = {}) =>
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_SCHEDULE, { reason, ...extra })

interface Props {
  settings: ThemeSettings
  available: ThemeDefinition[]
  now: number
  disabled: boolean
  onSave: (schedule: ThemeSchedule) => Promise<boolean>
  onEditing: (editing: boolean) => void
}

export function ThemeScheduleEditor({ settings, available, now, disabled, onSave, onEditing }: Props) {
  const { t, locale } = useI18n()
  const id = useId()
  const schedule = settings.schedule
  const [draft, setDraft] = useState<ThemeTimeRange | null>(null)
  const [picking, setPicking] = useState(false)
  const [error, setError] = useState('')
  const onPicking = useCallback((value: boolean) => { setPicking(value); if (value) setError(''); onEditing(value) }, [onEditing])
  const panel = useRef<HTMLElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const origin = useRef<HTMLButtonElement | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const ids = useMemo(() => new Set(available.map(theme => theme.id)), [available])
  const decision = useMemo(() => resolveThemeSchedule(schedule, now, ids), [schedule, now, ids])
  const name = (themeId: string) => {
    const theme = available.find(theme => theme.id === themeId)
    return theme ? settings.imported.some(item => item.id === themeId) ? `${theme.name} · ${themeId.slice(-8)}` : theme.name : t('settings.themes.schedule.missing')
  }
  const weekday = (day: number, long = false) => new Intl.DateTimeFormat(locale, { weekday: long ? 'long' : 'short' }).format(new Date(2026, 0, 4 + day, 12))
  const repeats = (days: number[]) => days.length === 7 ? t('settings.themes.schedule.everyday') : DAYS.filter(day => days.includes(day)).map(day => weekday(day)).join(' · ')
  const boundaryLabel = decision.nextAt === null ? '' : new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(decision.nextAt)
  const conflict = draft ? conflictingTimeRange(draft, schedule.ranges) : undefined
  const conflictText = (range: ThemeTimeRange) => t('settings.themes.schedule.conflict', { start: minuteToTime(range.start), end: minuteToTime(range.end) })
  const validation = !draft ? '' : !timeRangeValid(draft) ? t('settings.themes.schedule.invalid')
    : !ids.has(draft.themeId) ? t('settings.themes.schedule.missing') : conflict ? conflictText(conflict) : ''

  useEffect(() => {
    mounted.current = true
    trace('mount')
    return () => { mounted.current = false; onEditing(false); trace('unmount') }
  }, [onEditing])
  useEffect(() => { if (draft) panel.current?.focus() }, [draft?.id])

  const close = (reason: string) => {
    trace(reason)
    setDraft(null)
    setError('')
    onEditing(false)
    queueMicrotask(() => (origin.current?.isConnected ? origin.current : addButton.current)?.focus())
  }
  useModalEscape(Boolean(draft), () => {
    if (pending.current) trace('cancel-skipped', { cause: 'saving' })
    else close('cancel')
  }, 'theme-schedule')

  const save = async (next: ThemeSchedule, reason: string) => {
    if (pending.current || disabled) { trace('save-skipped', { cause: 'busy' }); return }
    pending.current = true
    setError('')
    trace(reason, { count: next.ranges.length })
    try {
      const ok = await onSave({ ...next, temporary: null })
      trace('save-result', { ok, mounted: mounted.current })
      if (mounted.current) {
        if (ok) close('saved')
        else setError(t('settings.themes.schedule.error'))
      }
    } catch {
      trace('save-error')
      if (mounted.current) setError(t('settings.themes.schedule.error'))
    } finally { pending.current = false }
  }
  const begin = (button: HTMLButtonElement, range?: ThemeTimeRange) => {
    origin.current = button
    setError('')
    setDraft(range ? { ...range, days: [...range.days] } : {
      id: crypto.randomUUID(), start: 9 * 60, end: 18 * 60, days: [...DAYS], enabled: true, themeId: 'light-modern'
    })
    onEditing(true)
    trace('edit-open', { existing: Boolean(range) })
  }

  return <section className="theme-schedule" data-testid="theme-schedule" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t('settings.themes.schedule.title')}</h3>
    <div className="theme-schedule-status" role="status" data-testid="schedule-status">
      <strong>{t('settings.themes.schedule.active', { name: name(decision.themeId) })}</strong>
      {decision.source !== 'temporary' && <span>{t(decision.source === 'range' ? 'settings.themes.schedule.rangeSource' : 'settings.themes.schedule.fallbackSource')}</span>}
      {boundaryLabel && <span>{t(decision.source === 'temporary' ? 'settings.themes.schedule.temporary' : 'settings.themes.schedule.next', { time: boundaryLabel })}</span>}
      {decision.source === 'temporary' && <button className="theme-button" data-testid="schedule-resume" disabled={disabled || Boolean(draft) || picking} onClick={() => void save(schedule, 'resume')}>{t('settings.themes.schedule.resume')}</button>}
    </div>
    <ThemeScheduleTimeline settings={settings} available={available} now={now} disabled={disabled || Boolean(draft)} onEditing={onPicking} onSave={onSave} />
    <fieldset disabled={disabled || Boolean(draft) || picking}>
      <h4 className="theme-schedule-rules-heading">{t('settings.themes.schedule.rules')}</h4>
      <label className="theme-select-field">
        <span>{t('settings.themes.schedule.fallback')}</span>
        <select data-testid="schedule-fallback" value={schedule.fallbackThemeId} onChange={event => void save({ ...schedule, fallbackThemeId: event.target.value }, 'fallback')}>
          {available.map(theme => <option key={theme.id} value={theme.id}>{name(theme.id)}</option>)}
        </select>
      </label>
      <ul className="theme-schedule-ranges">
        {schedule.ranges.map(range => <li key={range.id} data-testid="schedule-range" className={decision.rangeId === range.id ? 'is-active' : ''}>
          <button type="button" className="theme-schedule-range-edit" data-testid="schedule-edit" onClick={event => begin(event.currentTarget, range)} aria-label={`${t('settings.themes.schedule.edit')} ${minuteToTime(range.start)}–${minuteToTime(range.end)} · ${repeats(range.days)} · ${name(range.themeId)}`}>
            <strong>{minuteToTime(range.start)} – {minuteToTime(range.end)} {range.end < range.start && <small>{t('settings.themes.schedule.nextDay')}</small>}</strong>
            <span>{name(range.themeId)}</span><small>{repeats(range.days)}</small>
          </button>
          <input type="checkbox" role="switch" data-testid="schedule-toggle" checked={range.enabled} aria-label={`${t('settings.themes.schedule.enabled')} ${minuteToTime(range.start)}–${minuteToTime(range.end)} · ${repeats(range.days)} · ${name(range.themeId)}`} onChange={event => {
            const next = { ...range, enabled: event.target.checked }
            const overlap = conflictingTimeRange(next, schedule.ranges)
            if (overlap || (next.enabled && !ids.has(next.themeId))) {
              setError(overlap ? conflictText(overlap) : t('settings.themes.schedule.missing'))
              trace('toggle-rejected', { cause: overlap ? 'overlap' : 'missing-theme' })
              return
            }
            void save({ ...schedule, ranges: schedule.ranges.map(item => item.id === next.id ? next : item) }, 'toggle')
          }} />
        </li>)}
      </ul>
      {!schedule.ranges.length && <p className="theme-hint">{t('settings.themes.schedule.empty')}</p>}
      <button type="button" className="theme-button" data-testid="schedule-add" ref={addButton} disabled={schedule.ranges.length >= MAX_THEME_TIME_RANGES} onClick={event => begin(event.currentTarget)}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><path d="M8 2v12M2 8h12" /></svg>
        {t('settings.themes.schedule.add')}
      </button>
      {schedule.ranges.length >= MAX_THEME_TIME_RANGES && <p className="theme-hint">{t('settings.themes.schedule.limit', { count: MAX_THEME_TIME_RANGES })}</p>}
    </fieldset>
    {draft && <section className="theme-inline-panel theme-schedule-form" ref={panel} tabIndex={-1} aria-labelledby={`${id}-edit-title`} data-testid="schedule-editor">
      <h3 id={`${id}-edit-title`}>{t('settings.themes.schedule.edit')}</h3>
      <fieldset disabled={disabled}>
        <div className="theme-schedule-times">
          {(['start', 'end'] as const).map(field => <label className="theme-select-field" key={field}>
            <span>{t(`settings.themes.schedule.${field}`)}</span>
            <input type="time" step="60" data-testid={`schedule-${field}`} value={Number.isFinite(draft[field]) ? minuteToTime(draft[field]) : ''} onChange={event => setDraft({ ...draft, [field]: timeToMinute(event.target.value) })} />
          </label>)}
        </div>
        {draft.end < draft.start && <p className="theme-hint">{t('settings.themes.schedule.overnight')}</p>}
        <fieldset className="theme-schedule-repeat"><legend>{t('settings.themes.schedule.repeat')}</legend>
          <div className="theme-schedule-days">{DAYS.map(day => <button type="button" key={day} aria-pressed={draft.days.includes(day)} aria-label={weekday(day, true)} data-testid={`schedule-day-${day}`} onClick={() => {
            setDraft({ ...draft, days: draft.days.includes(day) ? draft.days.filter(item => item !== day) : [...draft.days, day] })
            trace('repeat-day')
          }}>{weekday(day)}</button>)}</div>
          <div className="theme-schedule-repeat-presets">{(['everyday', 'weekdays', 'weekends'] as const).map(preset => <button type="button" key={preset} className="theme-button" data-testid={`schedule-${preset}`} onClick={() => {
            setDraft({ ...draft, days: preset === 'everyday' ? [...DAYS] : preset === 'weekdays' ? [1, 2, 3, 4, 5] : [6, 0] })
            trace('repeat-preset', { preset })
          }}>{t(`settings.themes.schedule.${preset}`)}</button>)}</div>
        </fieldset>
        <label className="theme-select-field"><span>{t('settings.themes.schedule.theme')}</span>
          <select data-testid="schedule-theme" value={ids.has(draft.themeId) ? draft.themeId : ''} onChange={event => { setDraft({ ...draft, themeId: event.target.value }); trace('draft-theme') }}>
            {!ids.has(draft.themeId) && <option value="" disabled>{t('settings.themes.schedule.missing')}</option>}
            {available.map(theme => <option key={theme.id} value={theme.id}>{name(theme.id)}</option>)}
          </select>
        </label>
        {validation && <p className="theme-error" data-testid="schedule-validation" role="status">{validation}</p>}
        <p className="theme-hint">{t('settings.themes.schedule.editHint')}</p>
        <div className="theme-actions">
          {schedule.ranges.some(range => range.id === draft.id) && <button type="button" className="theme-button" data-testid="schedule-delete" onClick={() => void save({ ...schedule, ranges: schedule.ranges.filter(range => range.id !== draft.id) }, 'delete')}>{t('settings.themes.schedule.remove')}</button>}
          <button type="button" className="theme-button" data-testid="schedule-cancel" onClick={() => close('cancel')}>{t('common.cancel')}</button>
          <button type="button" className="theme-button theme-button-primary" data-testid="schedule-save" disabled={Boolean(validation)} onClick={() => void save({ ...schedule, ranges: [...schedule.ranges.filter(range => range.id !== draft.id), draft].sort((a, b) => a.start - b.start) }, 'save')}>{t('common.save')}</button>
        </div>
      </fieldset>
    </section>}
    {error && <p className="theme-error" role="alert" data-testid="schedule-error">{error}</p>}
    <p className="theme-hint">{t('settings.themes.schedule.cardHint')}</p>
  </section>
}
