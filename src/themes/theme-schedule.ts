/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemeSchedule, ThemeTimeRange } from '../types/theme'

export const MAX_THEME_TIME_RANGES = 32
const DAY = 1440
const WEEK = DAY * 7
const MINUTE_MS = 60000

export function timeRangeValid(range: ThemeTimeRange): boolean {
  return Number.isInteger(range.start) && range.start >= 0 && range.start < DAY &&
    Number.isInteger(range.end) && range.end >= 0 && range.end < DAY && range.start !== range.end &&
    range.days.length > 0 && range.days.every(day => Number.isInteger(day) && day >= 0 && day < 7)
}

/** Split overnight Sunday-wrap ranges into a canonical weekly interval set. */
function intervals(range: ThemeTimeRange): Array<[number, number]> {
  if (!timeRangeValid(range)) return []
  return range.days.flatMap(day => {
    const start = day * DAY + range.start
    const end = day * DAY + range.end + (range.end < range.start ? DAY : 0)
    return end <= WEEK ? [[start, end] as [number, number]] : [[start, WEEK], [0, end - WEEK]] as Array<[number, number]>
  })
}

export function conflictingTimeRange(range: ThemeTimeRange, ranges: ThemeTimeRange[]): ThemeTimeRange | undefined {
  if (!range.enabled) return undefined
  const spans = intervals(range)
  return ranges.find(other => other.id !== range.id && other.enabled &&
    intervals(other).some(([a, b]) => spans.some(([c, d]) => a < d && c < b)))
}

export function activeTimeRange(ranges: ThemeTimeRange[], now: number): ThemeTimeRange | undefined {
  const date = new Date(now)
  const minute = date.getDay() * DAY + date.getHours() * 60 + date.getMinutes()
  return ranges.find(range => range.enabled && intervals(range).some(([start, end]) => minute >= start && minute < end))
}

/** Enumerate both occurrences of a repeated local time; a skipped local time has none. */
function localInstants(day: Date, minute: number): number[] {
  const nominal = Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minute / 60), minute % 60)
  const offsets = new Set([-DAY, 0, DAY].map(delta => new Date(day.getTime() + delta * MINUTE_MS).getTimezoneOffset()))
  return [...offsets].map(offset => nominal + offset * MINUTE_MS).filter(value => {
    const date = new Date(value)
    return date.getFullYear() === day.getFullYear() && date.getMonth() === day.getMonth() && date.getDate() === day.getDate() &&
      date.getHours() * 60 + date.getMinutes() === minute
  })
}

/** Calendar arithmetic, never fixed 24-hour duration arithmetic. Also visit DST jumps. */
export function nextTimeRangeBoundary(ranges: ThemeTimeRange[], now: number): number | null {
  const enabled = ranges.filter(range => range.enabled && timeRangeValid(range))
  if (!enabled.length || !Number.isFinite(now)) return null
  const candidates = new Set<number>()
  const today = new Date(now)
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    const tomorrow = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
    for (const range of enabled) {
      if (range.days.includes(day.getDay())) for (const value of localInstants(day, range.start)) candidates.add(value)
      const startDay = (day.getDay() + (range.end < range.start ? 6 : 0)) % 7
      if (range.days.includes(startDay)) for (const value of localInstants(day, range.end)) candidates.add(value)
    }
    if (day.getTimezoneOffset() !== tomorrow.getTimezoneOffset()) {
      let left = Math.floor(day.getTime() / MINUTE_MS)
      let right = Math.floor(tomorrow.getTime() / MINUTE_MS)
      while (right - left > 1) {
        const middle = Math.floor((left + right) / 2)
        if (new Date(middle * MINUTE_MS).getTimezoneOffset() === day.getTimezoneOffset()) left = middle
        else right = middle
      }
      const transition = right * MINUTE_MS
      if (activeTimeRange(enabled, transition - 1)?.id !== activeTimeRange(enabled, transition)?.id) candidates.add(transition)
    }
  }
  return [...candidates].filter(value => value > now).sort((a, b) => a - b)[0] ?? null
}

export function resolveThemeSchedule(schedule: ThemeSchedule, now: number, available: ReadonlySet<string>, includeBoundary = true) {
  const ranges = schedule.ranges.filter(range => available.has(range.themeId))
  const active = activeTimeRange(ranges, now)
  const temporary = schedule.temporary && available.has(schedule.temporary.themeId) &&
    now >= schedule.temporary.startsAt && now < schedule.temporary.until ? schedule.temporary : null
  return {
    themeId: temporary?.themeId ?? active?.themeId ?? schedule.fallbackThemeId,
    source: temporary ? 'temporary' as const : active ? 'range' as const : 'fallback' as const,
    rangeId: active?.id ?? null,
    nextAt: includeBoundary ? temporary?.until ?? nextTimeRangeBoundary(ranges, now) : null
  }
}

export function normalizeThemeSchedule(raw: unknown, fallbackThemeId: string, available: ReadonlySet<string>): ThemeSchedule {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const ranges: ThemeTimeRange[] = []
  const seen = new Set<string>()
  if (Array.isArray(input.ranges)) for (const item of input.ranges.slice(0, MAX_THEME_TIME_RANGES)) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) || seen.has(item.id) ||
      typeof item.themeId !== 'string' || !item.themeId || item.themeId.length > 256 || !Array.isArray(item.days)) continue
    const range: ThemeTimeRange = { id: item.id, themeId: item.themeId, start: item.start, end: item.end,
      days: [...new Set<number>(item.days.slice(0, 7).filter((day: unknown) => Number.isInteger(day) && Number(day) >= 0 && Number(day) < 7))].sort(), enabled: item.enabled === true }
    if (!timeRangeValid(range)) continue
    seen.add(range.id)
    // Corrupt overlap is retained as a disabled, repairable rule rather than hidden precedence.
    if (conflictingTimeRange(range, ranges)) range.enabled = false
    ranges.push(range)
  }
  const value = input.temporary as ThemeSchedule['temporary'] | undefined
  const temporary = value && available.has(value.themeId) && Number.isFinite(value.startsAt) && Number.isFinite(value.until) &&
    value.until > value.startsAt && value.until - value.startsAt <= 8 * DAY * MINUTE_MS
    ? { themeId: value.themeId, startsAt: value.startsAt, until: value.until } : null
  return { fallbackThemeId: typeof input.fallbackThemeId === 'string' && available.has(input.fallbackThemeId) ? input.fallbackThemeId : fallbackThemeId, ranges, temporary }
}

export interface ThemeDaySegment {
  start: number
  end: number
  themeId: string
  rangeId: string | null
}

/** Keep rule identity: adjacent equal palettes can still be edited independently. */
export function themeDaySegments(schedule: ThemeSchedule, weekday: number, available: ReadonlySet<string>) {
  const segments: ThemeDaySegment[] = []
  for (const range of schedule.ranges.filter(item => item.enabled && available.has(item.themeId))) {
    for (const [start, end] of intervals(range)) {
      const a = Math.max(0, start - weekday * DAY)
      const b = Math.min(DAY, end - weekday * DAY)
      if (a < b) segments.push({ start: a, end: b, themeId: range.themeId, rangeId: range.id })
    }
  }
  segments.sort((a, b) => a.start - b.start)
  const result: typeof segments = []
  let cursor = 0
  for (const segment of segments) {
    if (cursor < segment.start) result.push({ start: cursor, end: segment.start, themeId: schedule.fallbackThemeId, rangeId: null })
    result.push(segment)
    cursor = segment.end
  }
  if (cursor < DAY) result.push({ start: cursor, end: DAY, themeId: schedule.fallbackThemeId, rangeId: null })
  return result
}

/** A day segment edits its recurring owner, or the one shared fallback for every gap. */
export function updateThemeScheduleTarget(schedule: ThemeSchedule, rangeId: string | null, themeId: string, available: ReadonlySet<string>): ThemeSchedule | null {
  if (!available.has(themeId) || (rangeId !== null && !schedule.ranges.some(range => range.id === rangeId))) return null
  return { ...schedule, temporary: null,
    fallbackThemeId: rangeId === null ? themeId : schedule.fallbackThemeId,
    ranges: rangeId === null ? schedule.ranges : schedule.ranges.map(range => range.id === rangeId ? { ...range, themeId } : range) }
}

/** With no future enabled boundary, a card changes the explicit fallback instead. */
export function selectScheduledTheme(schedule: ThemeSchedule, themeId: string, now: number, available: ReadonlySet<string>): ThemeSchedule {
  const until = nextTimeRangeBoundary(schedule.ranges.filter(range => available.has(range.themeId)), now)
  return until === null ? { ...schedule, fallbackThemeId: themeId, temporary: null }
    : { ...schedule, temporary: { themeId, startsAt: now, until } }
}

export function minuteToTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

export function timeToMinute(value: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}
