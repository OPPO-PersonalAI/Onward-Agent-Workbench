/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight renderer-side performance monitor.
 *
 * Activated when ONWARD_DEBUG=1.  Collects counters at 1-second granularity
 * and prints a structured log line.  Also exposed as window.__perfMonitor
 * so autotest / DevTools can query snapshots programmatically.
 */

export interface PerfSnapshot {
  ts: number
  fps: number
  frameDrops: number
  longestFrameMs: number
  xtermWriteCount: number
  xtermWriteTotalMs: number
  xtermWriteMaxMs: number
  ipcDataMsgCount: number
  ipcDataBytes: number
  hiddenTermWriteCount: number
  hiddenTermWriteBytes: number
  webglContextCount: number
  reactRenderCount: number
  inputLatencySamples: number
  inputLatencyAvgMs: number
  inputLatencyMaxMs: number
}

class PerfMonitor {
  private active = false
  private rafId = 0
  private reportTimer: ReturnType<typeof setInterval> | null = null

  // Frame rate tracking
  private lastFrameTime = 0
  private frameCount = 0
  private frameDropCount = 0
  private longestFrame = 0

  // xterm.write() tracking
  private xtermWriteCount = 0
  private xtermWriteTotalMs = 0
  private xtermWriteMaxMs = 0

  // IPC message tracking
  private ipcDataMsgCount = 0
  private ipcDataBytes = 0

  // Hidden terminal write tracking
  private hiddenTermWriteCount = 0
  private hiddenTermWriteBytes = 0

  // WebGL context count (set externally, not reset per interval)
  private _webglContextCount = 0

  // React render count
  private _reactRenderCount = 0

  // Input latency tracking
  private inputLatencies: number[] = []

  // Snapshot history (last 60 seconds)
  private history: PerfSnapshot[] = []
  private static readonly MAX_HISTORY = 60

  // Callbacks for snapshot events (used by autotest)
  private onSnapshotCallbacks: Array<(snap: PerfSnapshot) => void> = []

  start(): void {
    if (this.active) return
    this.active = true
    this.lastFrameTime = performance.now()
    this.tick()
    this.reportTimer = setInterval(() => this.report(), 1000)
  }

  stop(): void {
    this.active = false
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    if (this.reportTimer) {
      clearInterval(this.reportTimer)
      this.reportTimer = null
    }
  }

  isActive(): boolean {
    return this.active
  }

  // --- Counter increment methods (called from instrumented code) ---

  recordXtermWrite(durationMs: number): void {
    this.xtermWriteCount++
    this.xtermWriteTotalMs += durationMs
    if (durationMs > this.xtermWriteMaxMs) this.xtermWriteMaxMs = durationMs
  }

  recordIpcData(bytes: number): void {
    this.ipcDataMsgCount++
    this.ipcDataBytes += bytes
  }

  recordHiddenTermWrite(bytes: number): void {
    this.hiddenTermWriteCount++
    this.hiddenTermWriteBytes += bytes
  }

  setWebglContextCount(count: number): void {
    this._webglContextCount = count
  }

  incrementWebglContextCount(): void {
    this._webglContextCount++
  }

  decrementWebglContextCount(): void {
    this._webglContextCount = Math.max(0, this._webglContextCount - 1)
  }

  recordReactRender(): void {
    this._reactRenderCount++
  }

  recordInputLatency(latencyMs: number): void {
    this.inputLatencies.push(latencyMs)
  }

  // --- Snapshot & reporting ---

  onSnapshot(cb: (snap: PerfSnapshot) => void): () => void {
    this.onSnapshotCallbacks.push(cb)
    return () => {
      const idx = this.onSnapshotCallbacks.indexOf(cb)
      if (idx >= 0) this.onSnapshotCallbacks.splice(idx, 1)
    }
  }

  getHistory(): PerfSnapshot[] {
    return [...this.history]
  }

  getLastSnapshot(): PerfSnapshot | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null
  }

  getWebglContextCount(): number {
    return this._webglContextCount
  }

  private tick = (): void => {
    if (!this.active) return
    const now = performance.now()
    const delta = now - this.lastFrameTime
    this.lastFrameTime = now
    this.frameCount++
    // >33.3ms means below 30fps threshold — count as a frame drop
    if (delta > 33.3) this.frameDropCount++
    if (delta > this.longestFrame) this.longestFrame = delta
    this.rafId = requestAnimationFrame(this.tick)
  }

  private report(): void {
    const inputCount = this.inputLatencies.length
    let inputAvg = 0
    let inputMax = 0
    if (inputCount > 0) {
      const sum = this.inputLatencies.reduce((a, b) => a + b, 0)
      inputAvg = sum / inputCount
      inputMax = Math.max(...this.inputLatencies)
    }

    const snap: PerfSnapshot = {
      ts: Date.now(),
      fps: this.frameCount,
      frameDrops: this.frameDropCount,
      longestFrameMs: +this.longestFrame.toFixed(1),
      xtermWriteCount: this.xtermWriteCount,
      xtermWriteTotalMs: +this.xtermWriteTotalMs.toFixed(1),
      xtermWriteMaxMs: +this.xtermWriteMaxMs.toFixed(1),
      ipcDataMsgCount: this.ipcDataMsgCount,
      ipcDataBytes: this.ipcDataBytes,
      hiddenTermWriteCount: this.hiddenTermWriteCount,
      hiddenTermWriteBytes: this.hiddenTermWriteBytes,
      webglContextCount: this._webglContextCount,
      reactRenderCount: this._reactRenderCount,
      inputLatencySamples: inputCount,
      inputLatencyAvgMs: +inputAvg.toFixed(1),
      inputLatencyMaxMs: +inputMax.toFixed(1)
    }

    // Log to console
    const ipcMB = (snap.ipcDataBytes / (1024 * 1024)).toFixed(2)
    console.log(
      `[PerfMon] fps=${snap.fps} drops=${snap.frameDrops} longest=${snap.longestFrameMs}ms` +
      ` writes=${snap.xtermWriteCount} writeMax=${snap.xtermWriteMaxMs}ms` +
      ` ipc=${snap.ipcDataMsgCount} ipcMB=${ipcMB}` +
      ` hidden=${snap.hiddenTermWriteCount}` +
      ` webgl=${snap.webglContextCount} renders=${snap.reactRenderCount}` +
      (inputCount > 0 ? ` inputAvg=${snap.inputLatencyAvgMs}ms inputMax=${snap.inputLatencyMaxMs}ms` : '')
    )

    // Store in history
    this.history.push(snap)
    if (this.history.length > PerfMonitor.MAX_HISTORY) {
      this.history.shift()
    }

    // Notify subscribers
    for (const cb of this.onSnapshotCallbacks) {
      try { cb(snap) } catch { /* ignore */ }
    }

    // Reset per-interval counters
    this.frameCount = 0
    this.frameDropCount = 0
    this.longestFrame = 0
    this.xtermWriteCount = 0
    this.xtermWriteTotalMs = 0
    this.xtermWriteMaxMs = 0
    this.ipcDataMsgCount = 0
    this.ipcDataBytes = 0
    this.hiddenTermWriteCount = 0
    this.hiddenTermWriteBytes = 0
    this._reactRenderCount = 0
    this.inputLatencies = []
  }
}

// Singleton instance
export const perfMonitor = new PerfMonitor()

// Auto-start when debug mode is enabled
if (typeof window !== 'undefined') {
  try {
    const debugEnabled = (window as any).electronAPI?.debug?.enabled
    if (debugEnabled) {
      perfMonitor.start()
    }
  } catch {
    // Ignore — may be called before electronAPI is available
  }

  // Expose for DevTools / autotest
  ;(window as any).__perfMonitor = perfMonitor
}
