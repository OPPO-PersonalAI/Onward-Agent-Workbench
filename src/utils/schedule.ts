/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptSchedule } from '../types/tab.d.ts'
import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type AppLocale } from '../i18n/core'

/**
 * Calculate the next execution time based on recurrence configuration
 */
export function computeNextExecution(schedule: PromptSchedule, fromTime?: number): number {
  const now = fromTime ?? Date.now()

  switch (schedule.scheduleType) {
    case 'absolute':
      return schedule.absoluteTime ?? now
    case 'relative':
      return schedule.createdAt + (schedule.relativeOffsetMs ?? 0)
    case 'recurring': {
      if (!schedule.recurrence) return now
      return computeNextRecurrence(schedule.recurrence, now)
    }
    default:
      return now
  }
}

/**
 * Calculate the next execution time from a given point in time based on the interval configuration
 * Always anchor startTime to avoid cumulative drift. startTime has expired and jumps to the next interval point.
 */
function computeNextRecurrence(config: { startTime: number; intervalMs: number }, fromTime: number): number {
  const { startTime, intervalMs } = config
  if (startTime > fromTime) return startTime
  const elapsed = fromTime - startTime
  const periods = Math.ceil(elapsed / intervalMs)
  return startTime + periods * intervalMs
}

/**
 * Format short time display
 * - Today: "09:00"
 * - Tomorrow: "Tomorrow 09:00"
 * - Further: "03/15 09:00"
 */
export function formatShortTime(timestamp: number, locale: AppLocale = DEFAULT_LOCALE): string {
  const date = new Date(timestamp)
  const now = new Date()
  const t = createTranslator(normalizeLocale(locale))
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const tomorrowStart = todayStart + 24 * 60 * 60 * 1000
  const dayAfterTomorrow = tomorrowStart + 24 * 60 * 60 * 1000

  const timeStr = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`

  if (timestamp >= todayStart && timestamp < tomorrowStart) {
    return timeStr
  }
  if (timestamp >= tomorrowStart && timestamp < dayAfterTomorrow) {
    return t('schedule.time.tomorrow', { time: timeStr })
  }
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}/${day} ${timeStr}`
}

/**
 * Generate scheduled task description text
 */
export function formatScheduleDescription(schedule: PromptSchedule, locale: AppLocale = DEFAULT_LOCALE): string {
  const t = createTranslator(normalizeLocale(locale))
  switch (schedule.scheduleType) {
    case 'absolute':
      return t('schedule.description.absolute', { time: formatShortTime(schedule.nextExecutionAt, locale) })
    case 'relative': {
      const ms = schedule.relativeOffsetMs ?? 0
      if (ms < 60 * 1000) {
        return t('schedule.description.secondsLater', { count: Math.round(ms / 1000) })
      }
      if (ms < 60 * 60 * 1000) {
        return t('schedule.description.minutesLater', { count: Math.round(ms / 60000) })
      }
      return t('schedule.description.hoursLater', { count: Math.round(ms / 3600000) })
    }
    case 'recurring': {
      if (!schedule.recurrence) return t('schedule.description.default')
      const { intervalMs } = schedule.recurrence
      if (intervalMs >= 3600000 && intervalMs % 3600000 === 0) {
        return t('schedule.description.everyHours', { count: intervalMs / 3600000 })
      }
      return t('schedule.description.everyMinutes', { count: Math.round(intervalMs / 60000) })
    }
    default:
      return t('schedule.description.default')
  }
}
