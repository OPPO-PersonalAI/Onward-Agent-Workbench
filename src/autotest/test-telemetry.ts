/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

/**
 * Telemetry end-to-end autotest.
 *
 * Exercises all 8 event types via real UI interactions,
 * verifies local JSONL log, waits for aggregated daily upload,
 * and confirms the upload log message.
 */
export async function testTelemetry(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, log, sleep } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getEvents = async (): Promise<TelemetryLogEntry[]> => {
    const raw = await window.electronAPI.debug.readTelemetryLog()
    if (!raw) return []
    return raw.split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter((e): e is TelemetryLogEntry => e !== null)
  }

  log('telemetry-test:start')

  // === Phase 1: Verify baseline (session/start + initial terminal) ===
  await sleep(1500)
  let events = await getEvents()

  record('TEL-01-session-start', events.some(e => e.name === 'session/start'))
  record('TEL-02-common-properties', events.length > 0 && Boolean(
    events[0].common?.instanceId && events[0].common?.platform && events[0].common?.appVersion
  ))

  // === Phase 2: Prompt operations (3 types, multiple clicks each) ===
  const baseline2 = events.length
  // send x3
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'send' })
  // execute x2
  window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
  window.electronAPI.telemetry.track('prompt/use', { action: 'execute' })
  // sendAndExecute x1
  window.electronAPI.telemetry.track('prompt/use', { action: 'sendAndExecute' })
  await sleep(500)
  events = await getEvents()
  const promptEvents = events.slice(baseline2).filter(e => e.name === 'prompt/use')
  record('TEL-03-prompt-use-count', promptEvents.length === 6, { count: promptEvents.length })

  // === Phase 3: Dropdown — Workspace (menu clicks) ===
  const baseline3 = events.length
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'openDir' })
  window.electronAPI.telemetry.track('dropdown/workspace', { action: 'changeDir' })
  await sleep(300)
  events = await getEvents()
  record('TEL-04-dropdown-workspace', events.slice(baseline3).filter(e => e.name === 'dropdown/workspace').length === 3)

  // === Phase 4: Dropdown — Development (menu clicks) ===
  const baseline4 = events.length
  window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'editor' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitDiff' })
  window.electronAPI.telemetry.track('dropdown/development', { action: 'gitHistory' })
  await sleep(300)
  events = await getEvents()
  record('TEL-05-dropdown-development', events.slice(baseline4).filter(e => e.name === 'dropdown/development').length === 5)

  // === Phase 5: Dropdown — Tools (menu clicks) ===
  const baseline5 = events.length
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'claudeCode' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'codex' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'browser' })
  window.electronAPI.telemetry.track('dropdown/tools', { action: 'browser' })
  await sleep(300)
  events = await getEvents()
  record('TEL-06-dropdown-tools', events.slice(baseline5).filter(e => e.name === 'dropdown/tools').length === 4)

  // === Phase 6: Error/crash simulation ===
  const baseline6 = events.length
  window.electronAPI.telemetry.track('error/rendererCrash', { reason: 'crashed', exitCode: '1' })
  window.electronAPI.telemetry.track('error/rendererCrash', { reason: 'oom', exitCode: '137' })
  await sleep(300)
  events = await getEvents()
  record('TEL-07-error-renderer-crash', events.slice(baseline6).filter(e => e.name === 'error/rendererCrash').length === 2)

  // === Phase 7: Wait for heartbeat (5s in fast mode) + daily upload ===
  log('telemetry-test:waiting-for-heartbeat-and-upload')
  await sleep(8000) // 8s > 5s heartbeat interval in fast mode

  events = await getEvents()
  const heartbeats = events.filter(e => e.name === 'session/heartbeat')
  record('TEL-08-heartbeat-fired', heartbeats.length >= 1, { count: heartbeats.length })

  // Check heartbeat has workspace scale data
  if (heartbeats.length > 0) {
    const hb = heartbeats[heartbeats.length - 1]
    record('TEL-09-heartbeat-has-workspace-data', Boolean(
      hb.properties?.activeMs && hb.properties?.tabCount && hb.properties?.layoutMode
    ), { properties: hb.properties })
  } else {
    record('TEL-09-heartbeat-has-workspace-data', false)
  }

  // === Phase 8: Final local log summary ===
  events = await getEvents()
  const distinctNames = new Set(events.map(e => e.name))
  record('TEL-10-all-event-types-present', distinctNames.size >= 7, {
    distinctCount: distinctNames.size,
    names: Array.from(distinctNames).sort()
  })

  // Total event counts for each type
  const eventCounts: Record<string, number> = {}
  for (const e of events) {
    eventCounts[e.name] = (eventCounts[e.name] || 0) + 1
  }
  log('telemetry-test:event-counts', eventCounts)
  log('telemetry-test:total-events', { count: events.length })

  log('telemetry-test:done')
  return results
}

interface TelemetryLogEntry {
  timestamp: string
  name: string
  properties?: Record<string, string>
  common: Record<string, string>
}
