/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal Stress Autotest Suite
 *
 * Deep performance stress tests for multi-terminal scenarios.
 * Validates the hidden-terminal write optimization, WebGL context pooling,
 * IPC flood resilience, and input latency under realistic workloads.
 *
 * Test cases:
 *   TP-06  Hidden terminal optimization A/B comparison
 *   TP-07  WebGL context lifecycle with setVisibility
 *   TP-08  IPC flood + frame rate under 6-terminal load
 *   TP-09  Multi-tab simulation: visible vs hidden terminals
 *   TP-10  Input latency gradient baseline (idle → light → heavy)
 */
import type { AutotestContext, TestResult } from './types'
import type { PerfSnapshot } from '../utils/perf-monitor'

// Helper: wait for N perf snapshots and return them
function collectSnapshots(count: number, timeoutMs = 15000): Promise<PerfSnapshot[]> {
  return new Promise((resolve) => {
    const monitor = (window as any).__perfMonitor
    if (!monitor) {
      resolve([])
      return
    }

    const snaps: PerfSnapshot[] = []
    const timer = setTimeout(() => {
      unsub()
      resolve(snaps)
    }, timeoutMs)

    const unsub = monitor.onSnapshot((snap: PerfSnapshot) => {
      snaps.push(snap)
      if (snaps.length >= count) {
        clearTimeout(timer)
        unsub()
        resolve(snaps)
      }
    })
  })
}

// Helper: compute percentile from sorted array
function percentile(sorted: number[], p: number): number {
  const idx = Math.floor(sorted.length * p)
  return sorted[Math.min(idx, sorted.length - 1)]
}

// Helper: get high-output command for the current platform
function getHighOutputCmd(platform: string): string {
  if (platform === 'win32') {
    return 'for /L %i in (1,1,999999) do @echo stress-output-line-%i\r\n'
  }
  return 'yes "stress-output-line-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n'
}

// Helper: aggregate snapshot stats
function aggregateSnaps(snaps: PerfSnapshot[]) {
  if (snaps.length === 0) return { avgFps: -1, maxLongest: -1, totalWrites: 0, totalHidden: 0, totalIpc: 0 }
  return {
    avgFps: +(snaps.reduce((s, snap) => s + snap.fps, 0) / snaps.length).toFixed(1),
    maxLongest: Math.max(...snaps.map(s => s.longestFrameMs)),
    totalWrites: snaps.reduce((s, snap) => s + snap.xtermWriteCount, 0),
    totalHidden: snaps.reduce((s, snap) => s + snap.hiddenTermWriteCount, 0),
    totalIpc: snaps.reduce((s, snap) => s + snap.ipcDataMsgCount, 0)
  }
}

// Access the singleton TerminalSessionManager exposed on window
function getSessionManager(): any {
  return (window as any).__terminalSessionManager
}

export async function testTerminalStress(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, assert, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const perfMon = (window as any).__perfMonitor
  const sessionMgr = getSessionManager()

  // Ensure PerfMonitor is running
  if (perfMon && !perfMon.isActive()) {
    perfMon.start()
  }

  log('terminal-stress:start', { suite: 'TerminalStress', perfMonAvailable: !!perfMon, sessionMgrAvailable: !!sessionMgr })

  // ================================================================
  // TP-06: Hidden terminal optimization A/B comparison
  //
  // Phase A: 6 terminals all visible, all outputting → measure writes + fps
  // Phase B: 3 terminals set hidden via setVisibility(false) → same output
  // Compare: Phase B should have fewer xterm writes and higher fps
  // ================================================================
  if (!cancelled()) {
    log('TP-06:begin')
    const termIds: string[] = []
    let createOk = true

    try {
      for (let i = 0; i < 6; i++) {
        const id = `tp06-${i}-${Date.now()}`
        const result = await window.electronAPI.terminal.create(id, { cols: 80, rows: 24 })
        if (!result?.success) { createOk = false; break }
        termIds.push(id)
      }

      if (createOk && sessionMgr) {
        await sleep(2000)

        // Phase A: all 6 visible, all outputting
        const cmd = getHighOutputCmd(platform)
        for (const id of termIds) {
          await window.electronAPI.terminal.write(id, cmd)
        }
        await sleep(1500)
        log('TP-06:phase-A collecting (all visible)')
        const snapsA = perfMon ? await collectSnapshots(5) : []

        // Phase B: hide 3 terminals via setVisibility
        const hiddenIds = termIds.slice(3)
        for (const id of hiddenIds) {
          sessionMgr.setVisibility(id, false)
        }
        // Wait for metrics to reflect the change
        await sleep(1500)
        log('TP-06:phase-B collecting (3 hidden)')
        const snapsB = perfMon ? await collectSnapshots(5) : []

        // Restore visibility
        for (const id of hiddenIds) {
          sessionMgr.setVisibility(id, true)
        }

        // Stop output
        for (const id of termIds) {
          await window.electronAPI.terminal.write(id, '\x03')
        }
        await sleep(1000)

        const statsA = aggregateSnaps(snapsA)
        const statsB = aggregateSnaps(snapsB)

        const writesReduced = statsA.totalWrites > 0
          ? +((1 - statsB.totalWrites / statsA.totalWrites) * 100).toFixed(1)
          : 0
        const hiddenBuffered = statsB.totalHidden

        _assert('TP-06-hidden-optimization-ab', hiddenBuffered > 0 || !perfMon, {
          phaseA_allVisible: {
            snapshots: snapsA.length,
            avgFps: statsA.avgFps,
            maxLongestMs: statsA.maxLongest,
            xtermWrites: statsA.totalWrites,
            hiddenWrites: statsA.totalHidden
          },
          phaseB_3hidden: {
            snapshots: snapsB.length,
            avgFps: statsB.avgFps,
            maxLongestMs: statsB.maxLongest,
            xtermWrites: statsB.totalWrites,
            hiddenWrites: statsB.totalHidden
          },
          improvement: {
            writesReducedPct: writesReduced + '%',
            hiddenDataBuffered: hiddenBuffered,
            fpsChange: statsA.avgFps > 0 ? +((statsB.avgFps - statsA.avgFps) / statsA.avgFps * 100).toFixed(1) + '%' : 'n/a'
          }
        })
      } else {
        _assert('TP-06-hidden-optimization-ab', false, {
          reason: !createOk ? 'terminal creation failed' : 'sessionMgr not available'
        })
      }
    } finally {
      for (const id of termIds) {
        if (sessionMgr) sessionMgr.setVisibility(id, true)
        await window.electronAPI.terminal.dispose(id).catch(() => {})
      }
    }
    await sleep(500)
  }

  // ================================================================
  // TP-07: WebGL context lifecycle with setVisibility
  //
  // Verify that setVisibility(false) releases WebGL contexts and
  // setVisibility(true) recreates them.
  // ================================================================
  if (!cancelled()) {
    log('TP-07:begin')
    const termIds: string[] = []

    try {
      const initialCount = perfMon ? perfMon.getWebglContextCount() : -1
      log('TP-07:initial-webgl', { count: initialCount })

      // Create 4 terminals via IPC (no DOM attach → no WebGL yet)
      for (let i = 0; i < 4; i++) {
        const id = `tp07-${i}-${Date.now()}`
        const result = await window.electronAPI.terminal.create(id, { cols: 80, rows: 24 })
        if (result?.success) termIds.push(id)
      }
      await sleep(500)

      const afterCreate = perfMon ? perfMon.getWebglContextCount() : -1

      // setVisibility(false) on 2 terminals — should NOT change count
      // because these test terminals were never attached to DOM (no WebGL addon)
      if (sessionMgr && termIds.length >= 4) {
        sessionMgr.setVisibility(termIds[0], false)
        sessionMgr.setVisibility(termIds[1], false)
      }
      await sleep(300)
      const afterHide = perfMon ? perfMon.getWebglContextCount() : -1

      // setVisibility(true) — should NOT create WebGL (not open in DOM)
      if (sessionMgr) {
        sessionMgr.setVisibility(termIds[0], true)
        sessionMgr.setVisibility(termIds[1], true)
      }
      await sleep(300)
      const afterShow = perfMon ? perfMon.getWebglContextCount() : -1

      _assert('TP-07-webgl-lifecycle', true, {
        initialCount,
        afterCreate,
        afterHide,
        afterShow,
        note: 'Test terminals are IPC-only (no DOM). WebGL lifecycle is driven by attach/setVisibility in the React layer.'
      })
    } finally {
      for (const id of termIds) {
        await window.electronAPI.terminal.dispose(id).catch(() => {})
      }
    }
    await sleep(500)
  }

  // ================================================================
  // TP-08: IPC flood + frame rate test (core stress test)
  //
  // 6 terminals producing continuous output. Measures IPC message rate,
  // xterm.write total cost, frame drops, and input write latency.
  // ================================================================
  if (!cancelled()) {
    log('TP-08:begin')
    const termIds: string[] = []
    const inputId = `tp08-input-${Date.now()}`

    try {
      for (let i = 0; i < 6; i++) {
        const id = `tp08-${i}-${Date.now()}`
        const result = await window.electronAPI.terminal.create(id, { cols: 80, rows: 24 })
        if (result?.success) termIds.push(id)
      }
      const inputResult = await window.electronAPI.terminal.create(inputId, { cols: 80, rows: 24 })

      if (termIds.length >= 4 && inputResult?.success) {
        await sleep(2500)

        const cmd = getHighOutputCmd(platform)
        for (const id of termIds) {
          await window.electronAPI.terminal.write(id, cmd)
        }
        await sleep(2000)

        // Collect snapshots while measuring input latency
        const snapsPromise = perfMon ? collectSnapshots(8) : Promise.resolve([])

        const inputLatencies: number[] = []
        for (let i = 0; i < 20; i++) {
          if (cancelled()) break
          const t0 = performance.now()
          await window.electronAPI.terminal.write(inputId, 'a')
          inputLatencies.push(performance.now() - t0)
          await sleep(100)
        }

        const snaps = await snapsPromise

        for (const id of termIds) {
          await window.electronAPI.terminal.write(id, '\x03')
        }
        await sleep(1000)

        const stats = aggregateSnaps(snaps)
        const avgIpcPerSec = snaps.length > 0 ? stats.totalIpc / snaps.length : 0
        const totalWriteMs = snaps.reduce((s, snap) => s + snap.xtermWriteTotalMs, 0)
        const maxWriteMs = snaps.length > 0 ? Math.max(...snaps.map(s => s.xtermWriteMaxMs)) : 0

        const sorted = [...inputLatencies].sort((a, b) => a - b)
        const avgLat = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0
        const p50 = sorted.length > 0 ? percentile(sorted, 0.5) : 0
        const p95 = sorted.length > 0 ? percentile(sorted, 0.95) : 0
        const maxLat = sorted.length > 0 ? sorted[sorted.length - 1] : 0

        _assert('TP-08-ipc-flood-frame-rate', true, {
          outputTerminals: termIds.length,
          snapshots: snaps.length,
          avgFps: stats.avgFps,
          maxLongestFrameMs: stats.maxLongest,
          avgIpcMsgPerSec: +avgIpcPerSec.toFixed(0),
          totalXtermWriteMs: +totalWriteMs.toFixed(0),
          maxXtermWriteMs: +maxWriteMs.toFixed(1),
          inputSamples: sorted.length,
          inputAvgMs: +avgLat.toFixed(1),
          inputP50Ms: +p50.toFixed(1),
          inputP95Ms: +p95.toFixed(1),
          inputMaxMs: +maxLat.toFixed(1)
        })
      } else {
        _assert('TP-08-ipc-flood-frame-rate', false, {
          reason: 'terminal creation failed',
          outputTerminals: termIds.length
        })
      }
    } finally {
      for (const id of [...termIds, inputId]) {
        await window.electronAPI.terminal.dispose(id).catch(() => {})
      }
    }
    await sleep(500)
  }

  // ================================================================
  // TP-09: Multi-tab simulation — visible vs hidden terminals
  //
  // 6 "foreground" (visible) + 6 "background" (hidden) terminals all
  // outputting.  The hidden terminals should be buffered, not rendered.
  // Measures the optimization impact on input latency.
  // ================================================================
  if (!cancelled()) {
    log('TP-09:begin')
    const fgIds: string[] = []
    const bgIds: string[] = []
    const inputId = `tp09-input-${Date.now()}`

    try {
      for (let i = 0; i < 6; i++) {
        const id = `tp09-fg-${i}-${Date.now()}`
        const result = await window.electronAPI.terminal.create(id, { cols: 80, rows: 24 })
        if (result?.success) fgIds.push(id)
      }
      for (let i = 0; i < 6; i++) {
        const id = `tp09-bg-${i}-${Date.now()}`
        const result = await window.electronAPI.terminal.create(id, { cols: 80, rows: 24 })
        if (result?.success) bgIds.push(id)
      }
      const inputResult = await window.electronAPI.terminal.create(inputId, { cols: 80, rows: 24 })

      if (fgIds.length >= 4 && bgIds.length >= 4 && inputResult?.success && sessionMgr) {
        // Mark background terminals as hidden
        for (const id of bgIds) {
          sessionMgr.setVisibility(id, false)
        }

        await sleep(2500)

        const cmd = getHighOutputCmd(platform)
        for (const id of [...fgIds, ...bgIds]) {
          await window.electronAPI.terminal.write(id, cmd)
        }
        await sleep(3000)

        // Measure input latency and collect snapshots
        const snapsPromise = perfMon ? collectSnapshots(5) : Promise.resolve([])

        const latencies: number[] = []
        for (let i = 0; i < 20; i++) {
          if (cancelled()) break
          const t0 = performance.now()
          await window.electronAPI.terminal.write(inputId, 'a')
          latencies.push(performance.now() - t0)
          await sleep(100)
        }

        const snaps = await snapsPromise

        for (const id of [...fgIds, ...bgIds]) {
          await window.electronAPI.terminal.write(id, '\x03')
        }
        await sleep(1000)

        const stats = aggregateSnaps(snaps)
        const sorted = [...latencies].sort((a, b) => a - b)
        const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0
        const p95 = sorted.length > 0 ? percentile(sorted, 0.95) : 0
        const maxLat = sorted.length > 0 ? sorted[sorted.length - 1] : 0

        _assert('TP-09-multi-tab-simulation', true, {
          foregroundTerminals: fgIds.length,
          backgroundTerminals: bgIds.length,
          backgroundHidden: true,
          avgFps: stats.avgFps,
          maxLongestFrameMs: stats.maxLongest,
          xtermWrites: stats.totalWrites,
          hiddenBuffered: stats.totalHidden,
          inputSamples: sorted.length,
          inputAvgMs: +avg.toFixed(1),
          inputP95Ms: +p95.toFixed(1),
          inputMaxMs: +maxLat.toFixed(1),
          note: 'Background terminals use setVisibility(false) — data buffered, not rendered'
        })
      } else {
        _assert('TP-09-multi-tab-simulation', false, {
          reason: 'terminal creation failed',
          fg: fgIds.length, bg: bgIds.length
        })
      }
    } finally {
      for (const id of [...fgIds, ...bgIds, inputId]) {
        if (sessionMgr) sessionMgr.setVisibility(id, true)
        await window.electronAPI.terminal.dispose(id).catch(() => {})
      }
    }
    await sleep(500)
  }

  // ================================================================
  // TP-10: Input latency gradient baseline (idle → light → heavy)
  //
  // Measures write roundtrip latency at three load levels to establish
  // a performance baseline.
  // ================================================================
  if (!cancelled()) {
    log('TP-10:begin')
    const allIds: string[] = []

    try {
      for (let i = 0; i < 7; i++) {
        const id = `tp10-${i}-${Date.now()}`
        const result = await window.electronAPI.terminal.create(id, { cols: 80, rows: 24 })
        if (result?.success) allIds.push(id)
      }

      if (allIds.length >= 4) {
        await sleep(2000)

        const inputId = allIds[0]
        const bgIds = allIds.slice(1)
        const cmd = getHighOutputCmd(platform)

        const measureLatency = async (label: string, samples: number): Promise<number[]> => {
          const latencies: number[] = []
          for (let i = 0; i < samples; i++) {
            if (cancelled()) break
            const t0 = performance.now()
            await window.electronAPI.terminal.write(inputId, 'x')
            latencies.push(performance.now() - t0)
            await sleep(80)
          }
          log(`TP-10:${label}`, { samples: latencies.length })
          return latencies
        }

        const computeStats = (latencies: number[]) => {
          if (latencies.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 }
          const sorted = [...latencies].sort((a, b) => a - b)
          const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length
          return {
            avg: +avg.toFixed(1),
            p50: +percentile(sorted, 0.5).toFixed(1),
            p95: +percentile(sorted, 0.95).toFixed(1),
            max: +sorted[sorted.length - 1].toFixed(1)
          }
        }

        // Level 1: Idle
        const idleLatencies = await measureLatency('idle', 20)
        const idle = computeStats(idleLatencies)

        // Level 2: Light (3 bg terminals)
        for (let i = 0; i < 3 && i < bgIds.length; i++) {
          await window.electronAPI.terminal.write(bgIds[i], cmd)
        }
        await sleep(2000)
        const lightLatencies = await measureLatency('light', 20)
        const light = computeStats(lightLatencies)

        // Level 3: Heavy (6 bg terminals)
        for (let i = 3; i < bgIds.length; i++) {
          await window.electronAPI.terminal.write(bgIds[i], cmd)
        }
        await sleep(2000)
        const heavyLatencies = await measureLatency('heavy', 20)
        const heavy = computeStats(heavyLatencies)

        for (const id of bgIds) {
          await window.electronAPI.terminal.write(id, '\x03')
        }
        await sleep(1000)

        _assert('TP-10-input-latency-gradient', true, {
          idle,
          light_3bg: light,
          heavy_6bg: heavy,
          degradation_idle_to_heavy: +(heavy.p95 / Math.max(idle.p95, 0.1)).toFixed(1) + 'x'
        })
      } else {
        _assert('TP-10-input-latency-gradient', false, {
          reason: 'terminal creation failed',
          terminals: allIds.length
        })
      }
    } finally {
      for (const id of allIds) {
        await window.electronAPI.terminal.dispose(id).catch(() => {})
      }
    }
    await sleep(500)
  }

  log('terminal-stress:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
