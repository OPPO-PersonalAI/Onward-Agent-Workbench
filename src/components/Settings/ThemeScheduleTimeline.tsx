/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ThemeDefinition, ThemeSchedule, ThemeSettings } from '../../types/theme'
import { minuteToTime, themeDaySegments, updateThemeScheduleTarget, type ThemeDaySegment } from '../../themes/theme-schedule'
import { useI18n } from '../../i18n/useI18n'
import { useModalEscape } from '../../hooks/useModalEscape'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'

interface Props {
  settings: ThemeSettings
  available: ThemeDefinition[]
  now: number
  disabled: boolean
  onEditing: (editing: boolean) => void
  onSave: (schedule: ThemeSchedule) => Promise<boolean>
}

const trace = (reason: string, extra: Record<string, unknown> = {}) =>
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_THEME_TIMELINE, { reason, ...extra })
const segmentKey = (segment: ThemeDaySegment) => `${segment.rangeId ?? 'fallback'}:${segment.start}:${segment.end}`

/** Decorative palette sample only: no token processing, editor or terminal instances. */
function ThemeSample({ theme, overrides }: { theme?: ThemeDefinition; overrides?: Record<string, string> }) {
  const color = (key: string) => overrides?.[key] ?? theme?.colors[key]
  const style = {
    '--sample-bg': color('editor.background') ?? (theme?.kind === 'light' ? '#ffffff' : '#1f1f1f'),
    '--sample-fg': color('editor.foreground') ?? (theme?.kind === 'light' ? '#333333' : '#cccccc'),
    '--sample-accent': color('onward.accent') ?? color('focusBorder') ?? '#0078d4'
  } as CSSProperties
  return <span className="theme-schedule-sample" style={style} aria-hidden="true">
    <span className="theme-schedule-sample-bar"><i /><i /><i /></span>
    <span className="theme-schedule-sample-body"><i /><i /><i /></span>
  </span>
}

export function ThemeScheduleTimeline({ settings, available, now, disabled, onEditing, onSave }: Props) {
  const { t, locale } = useI18n()
  const id = useId()
  const [target, setTarget] = useState<ThemeDaySegment | null>(null)
  const [error, setError] = useState('')
  const [returnFocus, setReturnFocus] = useState(false)
  const root = useRef<HTMLElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const origin = useRef<HTMLButtonElement | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const catalog = useMemo(() => new Map(available.map(theme => [theme.id, theme])), [available])
  const ids = useMemo(() => new Set(catalog.keys()), [catalog])
  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'short' })
    return Array.from({ length: 7 }, (_, day) => formatter.format(new Date(2026, 0, 4 + day, 12)))
  }, [locale])
  const date = new Date(now)
  const segments = useMemo(() => themeDaySegments(settings.schedule, new Date(now).getDay(), ids), [settings.schedule, now, ids])
  const time = date.getHours() * 60 + date.getMinutes()
  const temporary = settings.schedule.temporary
  const overridden = Boolean(temporary && now >= temporary.startsAt && now < temporary.until && ids.has(temporary.themeId))
  const owner = settings.schedule.ranges.find(range => range.id === target?.rangeId)
  const targetThemeId = target?.rangeId === null ? settings.schedule.fallbackThemeId : owner?.themeId
  const name = (themeId: string) => catalog.get(themeId)?.name ?? t('settings.themes.schedule.missing')

  useEffect(() => {
    mounted.current = true
    trace('mount')
    return () => { mounted.current = false; onEditing(false); trace('unmount') }
  }, [onEditing])

  useEffect(() => {
    if (!target) return
    const selected = picker.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
    ;(selected ?? picker.current?.querySelector<HTMLButtonElement>('[data-theme-choice]'))?.focus({ preventScroll: true })
    picker.current?.scrollIntoView({ block: 'nearest' })
  }, [target])

  useLayoutEffect(() => {
    if (!returnFocus || target || disabled) return
    const connected = Boolean(origin.current?.isConnected)
    const button = connected ? origin.current : root.current?.querySelector<HTMLButtonElement>('[data-testid="schedule-segment"]')
    button?.focus({ preventScroll: true })
    setReturnFocus(false)
    trace('focus-returned', { originConnected: connected, focused: document.activeElement === button })
  }, [returnFocus, target, disabled])

  useEffect(() => {
    if (target && !segments.some(segment => segmentKey(segment) === segmentKey(target))) {
      trace('target-dismissed', { cause: 'day-or-rule-changed' })
      setTarget(null)
      setError('')
      onEditing(false)
      setReturnFocus(true)
    }
  }, [segments, target, onEditing])

  const close = (reason: string) => {
    if (pending.current) { trace('close-skipped', { cause: 'saving' }); return }
    trace(reason)
    setTarget(null)
    setError('')
    onEditing(false)
    setReturnFocus(true)
  }
  useModalEscape(Boolean(target), () => close('cancel'), 'theme-schedule-picker')

  const choose = async (themeId: string) => {
    if (!target || disabled || pending.current) { trace('choose-skipped', { cause: 'busy' }); return }
    if (themeId === targetThemeId) { close('unchanged'); return }
    const next = updateThemeScheduleTarget(settings.schedule, target.rangeId, themeId, ids)
    if (!next) { trace('target-rejected'); setError(t('settings.themes.schedule.targetMissing')); return }
    pending.current = true
    setError('')
    const started = performance.now()
    trace('choose', { scope: target.rangeId === null ? 'fallback' : 'range' })
    let ok = false
    try { ok = await onSave(next) }
    catch { trace('save-error') }
    finally {
      pending.current = false
      trace('save-result', { ok, mounted: mounted.current, durationMs: performance.now() - started })
    }
    if (!mounted.current) return
    if (ok) close('saved')
    else setError(t('settings.themes.schedule.error'))
  }

  return <section ref={root} className="theme-schedule-timeline" data-testid="schedule-timeline" aria-labelledby={`${id}-title`}>
    <div className="theme-schedule-day-heading">
      <h4 id={`${id}-title`}>{t('settings.themes.schedule.today')}</h4>
      <span>{new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)}</span>
    </div>
    <p className="theme-schedule-day-hint">{t('settings.themes.schedule.todayHint')}</p>
    <ol className="theme-schedule-day-items">
      {segments.map(segment => {
        const selected = target !== null && segmentKey(target) === segmentKey(segment)
        const current = !overridden && time >= segment.start && time < segment.end
        return <li key={segmentKey(segment)} className={selected ? 'is-editing' : ''}>
          <button type="button" className={`theme-schedule-day-option${current ? ' is-current' : ''}`} data-testid="schedule-segment"
            data-start={segment.start} data-end={segment.end} data-range-id={segment.rangeId ?? 'fallback'}
            aria-expanded={selected} aria-controls={selected ? `${id}-picker` : undefined} aria-current={current ? 'time' : undefined}
            aria-label={t('settings.themes.schedule.changeTheme', { start: minuteToTime(segment.start), end: minuteToTime(segment.end), name: name(segment.themeId) })}
            disabled={disabled} onClick={event => {
              if (selected) { close('dismiss'); return }
              origin.current = event.currentTarget
              setTarget(segment)
              setError('')
              onEditing(true)
              trace('open', { scope: segment.rangeId === null ? 'fallback' : 'range', count: segments.length })
            }}>
            <span className="theme-schedule-day-time"><span>{minuteToTime(segment.start)}</span><span>{minuteToTime(segment.end)}</span></span>
            <ThemeSample theme={catalog.get(segment.themeId)} overrides={settings.overrides[segment.themeId]} />
            <span className="theme-schedule-day-label"><strong data-testid="schedule-segment-name">{name(segment.themeId)}</strong>
              <span>{segment.rangeId === null ? t('settings.themes.schedule.fallback') : t('settings.themes.schedule.recurring')}
                {current && <b className="theme-schedule-now">{t('settings.themes.schedule.now')}</b>}</span>
            </span>
            <svg className="theme-schedule-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
          </button>
          {selected && <div className="theme-schedule-picker" id={`${id}-picker`} ref={picker} role="dialog" aria-labelledby={`${id}-picker-title`} data-testid="schedule-theme-picker">
            <div className="theme-schedule-picker-heading"><div><h4 id={`${id}-picker-title`}>{t('settings.themes.schedule.chooseTheme')}</h4>
              <span>{minuteToTime(segment.start)} – {minuteToTime(segment.end)}</span></div>
              <button type="button" className="theme-schedule-picker-close" data-testid="schedule-picker-close" disabled={disabled} onClick={() => close('cancel')} aria-label={t('common.close')}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
              </button>
            </div>
            {owner && <p className="theme-schedule-picker-rule" data-testid="schedule-picker-rule">
              {minuteToTime(owner.start)} – {minuteToTime(owner.end)}{owner.end < owner.start && ` (${t('settings.themes.schedule.nextDay')})`}
              {' · '}{owner.days.length === 7 ? t('settings.themes.schedule.everyday') : [1, 2, 3, 4, 5, 6, 0].filter(day => owner.days.includes(day)).map(day => weekdays[day]).join(' · ')}
            </p>}
            <p className="theme-schedule-picker-scope" data-testid="schedule-picker-scope">{t(segment.rangeId === null ? 'settings.themes.schedule.fallbackScope' : 'settings.themes.schedule.rangeScope')}</p>
            <div className="theme-schedule-picker-options" role="group" aria-label={t('settings.themes.schedule.chooseTheme')} onKeyDown={event => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
              const index = options.indexOf(document.activeElement as HTMLButtonElement)
              if (index < 0) return
              event.preventDefault()
              options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
            }}>
              {available.map(theme => <button type="button" key={theme.id} data-theme-choice={theme.id} data-testid={`schedule-choice-${theme.id}`}
                aria-pressed={theme.id === targetThemeId} disabled={disabled} onClick={() => void choose(theme.id)}>
                <ThemeSample theme={theme} overrides={settings.overrides[theme.id]} />
                <span className="theme-schedule-choice-name">{theme.name}{settings.imported.some(item => item.id === theme.id) && <small>{theme.id.slice(-8)}</small>}</span>
                <span className="theme-schedule-choice-check" aria-hidden="true">{theme.id === targetThemeId && <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 8 3 3 7-7" /></svg>}</span>
              </button>)}
            </div>
            {error && <p className="theme-error" role="alert" data-testid="schedule-picker-error">{error}</p>}
          </div>}
        </li>
      })}
    </ol>
  </section>
}
