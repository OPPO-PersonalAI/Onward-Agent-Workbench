/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { perfTraceDiagnostic } from './perf-trace'
import { PERF_TRACE_EVENT } from './perf-trace-names'

export type SettingsLeaveReason = 'category' | 'close' | 'shortcut' | 'quit'
let guard: ((reason: SettingsLeaveReason) => Promise<boolean>) | null = null

export function registerSettingsLeaveGuard(next: NonNullable<typeof guard>): () => void {
  guard = next
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'registered' })
  return () => {
    if (guard === next) guard = null
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'unregistered' })
  }
}

export function requestSettingsLeave(reason: SettingsLeaveReason): Promise<boolean> {
  perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_SETTINGS_LEAVE, { stage: 'requested', reason, registered: Boolean(guard) })
  return guard ? guard(reason) : Promise.resolve(true)
}
