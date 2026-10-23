/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeTimeRange, conflictingTimeRange, MAX_THEME_TIME_RANGES, minuteToTime, nextTimeRangeBoundary, normalizeThemeSchedule, resolveThemeSchedule, selectScheduledTheme, themeDaySegments, timeRangeValid, timeToMinute, updateThemeScheduleTarget } from '../../src/themes/theme-schedule.ts'
import { normalizeThemeSettings, resolveTheme } from '../../src/themes/theme-engine.ts'
import { ThemeScheduleController } from '../../electron/main/theme-schedule-controller.ts'
import type { ThemeSchedule, ThemeTimeRange } from '../../src/types/theme'
import { translate } from '../../src/i18n/core.ts'

const available = new Set(['dark-modern', 'light-modern', 'nord', 'dracula'])
const range = (patch: Partial<ThemeTimeRange> = {}): ThemeTimeRange => ({ id: 'day', themeId: 'light-modern', start: 540, end: 1080, days: [1, 2, 3, 4, 5], enabled: true, ...patch })
const schedule = (ranges = [range()]): ThemeSchedule => ({ fallbackThemeId: 'nord', ranges, temporary: null })
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime()

test('SCH-U08: both dictionaries interpolate active names, expiry, conflicts and limits', () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    assert(translate(locale, 'settings.themes.schedule.active', { name: 'Nord' }).includes('Nord'))
    assert(translate(locale, 'settings.themes.schedule.temporary', { time: '18:00' }).includes('18:00'))
    assert(translate(locale, 'settings.themes.schedule.next', { time: '18:00' }).includes('18:00'))
    assert(translate(locale, 'settings.themes.schedule.conflict', { start: '09:00', end: '18:00' }).includes('09:00–18:00'))
    assert(translate(locale, 'settings.themes.schedule.limit', { count: 32 }).includes('32'))
  }
})

test('SCH-U01: exact half-open boundaries, disabled rules, weekdays and overnight week wrap', () => {
  const ranges = [range(), range({ id: 'night', start: 1320, end: 420, days: [5, 6], themeId: 'dracula' })]
  for (const [day, hour, minute, expected] of [
    [19, 8, 59, undefined], [19, 9, 0, 'day'], [19, 17, 59, 'day'], [19, 18, 0, undefined],
    [23, 22, 0, 'night'], [24, 6, 59, 'night'], [24, 7, 0, undefined], [24, 12, 0, undefined],
    [25, 0, 0, 'night'], [25, 7, 0, undefined], [26, 0, 0, undefined]
  ] as const) assert.equal(activeTimeRange(ranges, local(day, hour, minute))?.id, expected)
  assert.equal(activeTimeRange([range({ enabled: false })], local(19, 12)), undefined)
  assert.equal(nextTimeRangeBoundary([], local(19, 12)), null)
  assert.equal(nextTimeRangeBoundary(ranges, local(23, 23)), local(24, 7))
  assert.equal(nextTimeRangeBoundary(ranges, local(25, 7)), local(26, 9))
})

test('SCH-U02: overlaps span weekdays and midnight; adjacency and disabled overlap are allowed', () => {
  const night = range({ id: 'night', start: 1320, end: 420, days: [6] })
  assert.equal(conflictingTimeRange(range({ start: 360, end: 480, days: [0] }), [night]), night)
  assert.equal(conflictingTimeRange(range({ start: 420, end: 480, days: [0] }), [night]), undefined)
  assert.equal(conflictingTimeRange(range({ start: 360, end: 480, days: [1] }), [night]), undefined)
  assert.equal(conflictingTimeRange(range({ enabled: false }), [range({ id: 'other' })]), undefined)
  assert.equal(conflictingTimeRange(range(), [range()]), undefined, 'Editing a range excludes itself')
  for (const patch of [{ end: 540 }, { start: -1 }, { start: 0.5 }, { end: 1440 }, { days: [] }, { days: [7] }]) {
    assert.equal(timeRangeValid(range(patch)), false)
  }
})

test('SCH-U03: temporary choice survives round trip, expires at either edge, and skips missing themes', () => {
  const base = schedule()
  const during = selectScheduledTheme(base, 'dracula', local(19, 12), available)
  assert.equal(during.temporary?.until, local(19, 18))
  const reloaded = normalizeThemeSchedule(JSON.parse(JSON.stringify(during)), 'dark-modern', available)
  for (const [now, expected, source] of [
    [local(19, 11), 'light-modern', 'range'], [local(19, 12), 'dracula', 'temporary'],
    [local(19, 18), 'nord', 'fallback'], [local(20, 9), 'light-modern', 'range']
  ] as const) {
    const resolved = resolveThemeSchedule(reloaded, now, available)
    assert.equal(resolved.themeId, expected)
    assert.equal(resolved.source, source)
  }
  assert.equal(selectScheduledTheme(base, 'dracula', local(19, 8), available).temporary?.until, local(19, 9))
  assert.equal(resolveThemeSchedule(during, local(19, 12), new Set(['nord'])).themeId, 'nord')
  assert.deepEqual(selectScheduledTheme(schedule([]), 'dracula', local(19, 8), available), { ...schedule([]), fallbackThemeId: 'dracula' })
})

test('SCH-U04: storage bounds, repairable missing/overlapping rules, migration and independent defaults', () => {
  const raw = { fallbackThemeId: 'gone', ranges: [range(), range({ id: 'overlap' }), range({ id: 'gone', themeId: 'deleted', days: [0] }), range({ id: 'invalid', end: 540 }), range()], temporary: { themeId: 'dracula', startsAt: 1, until: Infinity } }
  const normalized = normalizeThemeSchedule(raw, 'nord', available)
  assert.equal(normalized.fallbackThemeId, 'nord')
  assert.equal(normalized.temporary, null)
  assert.deepEqual(normalized.ranges.map(item => [item.id, item.enabled]), [['day', true], ['overlap', false], ['gone', true]])
  assert.deepEqual(normalizeThemeSchedule(normalized, 'nord', available), normalized)
  assert.equal(normalizeThemeSchedule({ ranges: Array.from({ length: 200 }, (_, i) => range({ id: String(i), enabled: false })) }, 'nord', available).ranges.length, MAX_THEME_TIME_RANGES)
  for (const mode of ['manual', 'system'] as const) {
    const migrated = normalizeThemeSettings({ version: 3, mode, themeId: 'nord' })
    assert.equal(migrated.version, 4)
    assert.equal(migrated.mode, mode)
    assert.deepEqual(migrated.schedule, { fallbackThemeId: 'nord', ranges: [], temporary: null })
  }
  const a = normalizeThemeSettings(undefined), b = normalizeThemeSettings(undefined)
  a.schedule.ranges.push(range())
  assert.equal(b.schedule.ranges.length, 0)
  const scheduled = normalizeThemeSettings({ version: 4, mode: 'schedule', schedule: schedule() })
  assert.equal(resolveTheme(scheduled, true, local(19, 10)).id, 'light-modern')
  assert.equal(resolveTheme(scheduled, false, local(19, 20)).id, 'nord')
})

test('SCH-U05: timeline covers exactly one day, including previous-day tail and fallback gaps', () => {
  const value = schedule([range({ id: 'night', start: 1320, end: 420, days: [6], themeId: 'dracula' })])
  assert.deepEqual(themeDaySegments(value, 0, available), [
    { start: 0, end: 420, themeId: 'dracula', rangeId: 'night' }, { start: 420, end: 1440, themeId: 'nord', rangeId: null }
  ])
  assert.deepEqual(themeDaySegments(value, 6, available), [
    { start: 0, end: 1320, themeId: 'nord', rangeId: null }, { start: 1320, end: 1440, themeId: 'dracula', rangeId: 'night' }
  ])
  for (const minute of [0, 1, 59, 60, 720, 1439]) assert.equal(timeToMinute(minuteToTime(minute)), minute)
  for (const invalid of ['', '24:00', '01:60', '1:05', '12:30:00']) assert(Number.isNaN(timeToMinute(invalid)))
})

test('SCH-U09: equal-colored adjacent segments retain separate editable owners', () => {
  const value = schedule([
    range({ id: 'first', start: 540, end: 541, days: [1], themeId: 'nord' }),
    range({ id: 'second', start: 541, end: 542, days: [1], themeId: 'nord' })
  ])
  assert.deepEqual(themeDaySegments(value, 1, available), [
    { start: 0, end: 540, themeId: 'nord', rangeId: null },
    { start: 540, end: 541, themeId: 'nord', rangeId: 'first' },
    { start: 541, end: 542, themeId: 'nord', rangeId: 'second' },
    { start: 542, end: 1440, themeId: 'nord', rangeId: null }
  ])
  const changed = updateThemeScheduleTarget(value, 'second', 'dracula', available)!
  assert.equal(changed.ranges[0].themeId, 'nord')
  assert.equal(changed.ranges[1].themeId, 'dracula')
  assert.equal(changed.fallbackThemeId, 'nord')
  assert.equal(value.ranges[1].themeId, 'nord', 'Input is immutable')
  assert.deepEqual({ ...changed.ranges[1], themeId: 'nord' }, value.ranges[1])
})

test('SCH-U10: overnight tail edits its recurring owner; gaps share one fallback; invalid targets are rejected', () => {
  const value = schedule([range({ id: 'night', start: 1320, end: 420, days: [5, 6], themeId: 'dracula' })])
  value.temporary = { themeId: 'light-modern', startsAt: local(23, 23), until: local(24, 7) }
  const tail = themeDaySegments(value, 0, available)[0]
  const changed = updateThemeScheduleTarget(value, tail.rangeId, 'nord', available)!
  assert.deepEqual(changed.ranges[0], { ...value.ranges[0], themeId: 'nord' })
  assert.equal(changed.temporary, null)
  assert(value.temporary, 'Original temporary choice is untouched')
  assert.equal(resolveThemeSchedule(changed, local(23, 23), available).themeId, 'nord')
  assert.equal(resolveThemeSchedule(changed, local(25, 6), available).themeId, 'nord')
  const fallback = updateThemeScheduleTarget(value, null, 'light-modern', available)!
  assert.deepEqual(fallback.ranges, value.ranges)
  assert.equal(resolveThemeSchedule(fallback, local(19, 12), available).themeId, 'light-modern')
  assert.equal(resolveThemeSchedule(fallback, local(26, 18), available).themeId, 'light-modern')
  assert.equal(updateThemeScheduleTarget(value, 'deleted', 'nord', available), null)
  assert.equal(updateThemeScheduleTarget(value, 'night', 'deleted', available), null)
  assert.equal(updateThemeScheduleTarget(value, null, 'deleted', available), null)
})

test('SCH-U06: DST gaps, repeated hours and half-hour transitions use real local instants', () => {
  const previous = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const gap = [range({ start: 150, end: 210, days: [0] })]
    assert.equal(nextTimeRangeBoundary(gap, Date.parse('2026-03-08T01:59:00-05:00')), Date.parse('2026-03-08T03:00:00-04:00'))
    assert.equal(activeTimeRange(gap, Date.parse('2026-03-08T03:00:00-04:00'))?.id, 'day')
    const repeated = [range({ start: 90, end: 120, days: [0] })]
    assert.equal(nextTimeRangeBoundary(repeated, Date.parse('2026-11-01T01:45:00-04:00')), Date.parse('2026-11-01T01:00:00-05:00'))
    assert.equal(nextTimeRangeBoundary(repeated, Date.parse('2026-11-01T01:00:00-05:00')), Date.parse('2026-11-01T01:30:00-05:00'))
    assert.equal(activeTimeRange(repeated, Date.parse('2026-11-01T01:45:00-05:00'))?.id, 'day')
    process.env.TZ = 'Australia/Lord_Howe'
    const halfHour = [range({ start: 135, end: 180, days: [0] })]
    assert.equal(nextTimeRangeBoundary(halfHour, Date.parse('2026-10-04T01:59:00+10:30')), Date.parse('2026-10-04T02:30:00+11:00'))
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('SCH-U07: one owned timer, five boundary/resume cycles, clock jumps and teardown', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = local(19, 8, 59) + 59000
  let settings = normalizeThemeSettings({ version: 4, mode: 'schedule', schedule: schedule() })
  const published: Array<{ now: number; sequence: number }> = []
  const traces: Record<string, unknown>[] = []
  let reads = 0
  const controller = new ThemeScheduleController({ settings: () => { reads++; return { ...settings, availableIds: available } }, now: () => now, publish: clock => published.push(clock), trace: data => traces.push(data) })
  t.after(() => controller.dispose())
  controller.reconcile('startup')
  for (let trial = 0; trial < 5; trial++) controller.reconcile('settings')
  const before = reads
  now = local(19, 9)
  t.mock.timers.tick(1000)
  assert.equal(reads, before + 1, 'Reconciliation replaces the previous timeout')
  assert.equal(published.at(-1)?.now, now)
  for (let trial = 0; trial < 5; trial++) {
    now = local(19 + trial, 18)
    controller.reconcile('resume')
    assert.equal(resolveTheme(settings, true, published.at(-1)!.now).id, 'nord')
    now = local(19 + trial, 10)
    controller.reconcile('focus')
    assert.equal(resolveTheme(settings, true, published.at(-1)!.now).id, 'light-modern')
  }
  const count = published.length
  now += 60000
  t.mock.timers.tick(60000)
  assert.equal(published.length, count, 'An unchanged backstop does not cross IPC')
  assert(published.every((clock, index) => index === 0 || clock.sequence > published[index - 1].sequence))
  settings = { ...settings, mode: 'manual' }
  controller.reconcile('settings')
  const stopped = reads
  t.mock.timers.tick(120000)
  assert.equal(reads, stopped, 'Manual mode has no timer')
  controller.dispose()
  controller.reconcile('resume')
  assert.equal(reads, stopped)
  assert(traces.some(event => event.reason === 'dispose'))
})
