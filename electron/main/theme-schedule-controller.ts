/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThemeScheduleClock, ThemeSettings } from '../../src/types/theme'
import { resolveThemeSchedule } from '../../src/themes/theme-schedule.ts'

interface Options {
  settings: () => Pick<ThemeSettings, 'mode' | 'schedule'> & { availableIds: ReadonlySet<string> }
  now: () => number
  publish: (clock: ThemeScheduleClock) => void
  trace: (data: Record<string, unknown>) => void
}

/** One owned timeout; the minute backstop detects wall-clock/time-zone changes without renderer polling. */
export class ThemeScheduleController {
  private timer: ReturnType<typeof setTimeout> | null = null
  private sequence = 0
  private signature = ''
  private disposed = false
  private readonly options: Options

  constructor(options: Options) {
    this.options = options
    options.trace({ reason: 'start' })
  }

  clock(): ThemeScheduleClock {
    return { now: this.options.now(), sequence: ++this.sequence }
  }

  reconcile(reason: string): void {
    if (this.disposed) {
      this.options.trace({ reason: 'reconcile-skipped', cause: 'disposed' })
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const started = performance.now()
    const settings = this.options.settings()
    const clock = this.clock()
    const active = settings.mode === 'schedule'
    const decision = active ? resolveThemeSchedule(settings.schedule, clock.now, settings.availableIds) : null
    const day = new Date(clock.now)
    const signature = JSON.stringify([settings.mode, decision, day.toDateString(), day.getTimezoneOffset()])
    if (reason !== 'timer' || signature !== this.signature) {
      this.signature = signature
      this.options.trace({ reason, stage: 'publish', active, source: decision?.source, hasNext: decision?.nextAt != null,
        sequence: clock.sequence, durationMs: performance.now() - started })
      this.options.publish(clock)
    } else {
      this.options.trace({ reason: 'timer', stage: 'unchanged', durationMs: performance.now() - started })
    }
    if (active) {
      const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
      const deadline = Math.min(decision?.nextAt ?? Infinity, midnight)
      this.timer = setTimeout(() => this.reconcile('timer'), Math.max(1, Math.min(60000, deadline - clock.now)))
      this.timer.unref?.()
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.disposed = true
    this.options.trace({ reason: 'dispose' })
  }
}
