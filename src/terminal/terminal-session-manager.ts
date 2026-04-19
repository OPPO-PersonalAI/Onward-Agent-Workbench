/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { getTheme, ThemeName } from '../themes/terminal-themes'
import type { TerminalStyleConfig } from '../types/settings.d.ts'
import type { TerminalBufferOptions, TerminalBufferResult } from '../types/electron.d.ts'
import { requestOpenExternalHttpLink } from '../utils/externalLink'
import { perfMonitor } from '../utils/perf-monitor'

export type TerminalSessionStatus = 'idle' | 'initializing' | 'ready' | 'error' | 'disposed'

export interface TerminalSessionOptions {
  theme: ThemeName
  fontSize: number
  fontFamily: string
  terminalStyle?: TerminalStyleConfig | null
}

export interface TerminalFocusSessionDebugSnapshot {
  exists: boolean
  open: boolean | null
  status: TerminalSessionStatus | null
  visible: boolean | null
  hasContainer: boolean
  containerConnected: boolean
  containerWidth: number | null
  containerHeight: number | null
  containerDisplay: string | null
  hasTextarea: boolean
  textareaConnected: boolean
  textareaDisabled: boolean | null
  textareaTabIndex: number | null
  textareaDisplay: string | null
  terminalElementConnected: boolean
  activeElementMatchesTextarea: boolean
}

type TerminalBufferType = 'normal' | 'alternate'
// Viewport restore is only needed when the terminal's geometry/mount changes.
// Output is handled by xterm's native isUserScrolling — we don't intercept it.
type TerminalViewportRestoreReason = 'fit' | 'attach'

interface TerminalViewportRestoreState {
  followBottom: boolean
  viewportY: number
  bufferType: TerminalBufferType
  reason: TerminalViewportRestoreReason
  capturedAt: number
}

export interface TerminalViewportDebugState {
  terminalId: string
  bufferType: TerminalBufferType
  baseY: number
  viewportY: number
  rows: number
  cols: number
  isNearBottom: boolean
  userWantsBottom: boolean
  pendingRestore: TerminalViewportRestoreState | null
}

export interface TerminalSessionDebugState {
  terminalId: string
  status: TerminalSessionStatus
  open: boolean
  visible: boolean
  pendingDataChunks: number
  pendingDataBytes: number
}

interface TerminalSession {
  id: string
  terminal: XTerm
  fitAddon: FitAddon
  searchAddon: SearchAddon
  status: TerminalSessionStatus
  readyPromise: Promise<void> | null
  open: boolean
  container: HTMLDivElement | null
  lastCols: number
  lastRows: number
  lastFitWidth: number
  lastFitHeight: number
  webglAddon?: WebglAddon
  lastOptions: TerminalSessionOptions | null
  pendingViewportRestore: TerminalViewportRestoreState | null
  pendingRestoreAnimationFrame: number | null
  pendingGeometryRefreshAnimationFrame: number | null
  // Visibility-based rendering optimization
  visible: boolean
  pendingData: string[]
  pendingDataBytes: number
  interactiveBoostUntil: number
}

// Maximum bytes to buffer per hidden terminal before discarding old data.
// 512 KB is enough to hold several screens of output while preventing
// unbounded memory growth for long-running hidden sessions.
const PENDING_DATA_MAX_BYTES = 512 * 1024
const VISIBLE_PENDING_DATA_MAX_BYTES = 8 * 1024 * 1024
const VISIBLE_WRITE_MAX_CHUNK_BYTES = 256 * 1024

// Throttle interval for visible terminal writes.  Instead of calling
// terminal.write() on every IPC message (which can reach 18,000/s across
// 6 terminals and starve the main thread), we accumulate data per-session
// and flush once per interval via requestAnimationFrame.  50 ms ≈ 20 fps
// for terminal updates — visually smooth while leaving ~70% of each frame
// budget free for user input, React renders, and other UI work.
const VISIBLE_WRITE_THROTTLE_MS = 50
const INTERACTIVE_BOOST_WINDOW_MS = 250

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const AUTOFOLLOW_THRESHOLD_LINES = 2

function resolveTerminalFontFamily(options: TerminalSessionOptions): string {
  const styleFontFamily = options.terminalStyle?.fontFamily
  return styleFontFamily && styleFontFamily.trim() ? styleFontFamily : options.fontFamily
}

function resolveTerminalFontSize(options: TerminalSessionOptions): number {
  const styleFontSize = options.terminalStyle?.fontSize
  return typeof styleFontSize === 'number' && Number.isFinite(styleFontSize) && styleFontSize > 0
    ? styleFontSize
    : options.fontSize
}

function handleTerminalLinkClick(_event: MouseEvent, uri: string) {
  void requestOpenExternalHttpLink(uri).then((result) => {
    if (!result.success && result.error && !result.canceled && !result.blocked) {
      console.warn('[TerminalSessionManager] Failed to open external link:', result.error)
    }
  })
}

function buildTheme(options: TerminalSessionOptions) {
  const baseTheme = getTheme(options.theme)
  const terminalStyle = options.terminalStyle

  return {
    ...baseTheme,
    ...(terminalStyle?.foregroundColor && { foreground: terminalStyle.foregroundColor }),
    ...(terminalStyle?.backgroundColor && { background: terminalStyle.backgroundColor })
  }
}

export class TerminalSessionManager {
  private sessions: Map<string, TerminalSession> = new Map()
  private bufferRequestUnsubscribe: (() => void) | null = null
  // Centralized IPC listeners: single global listener dispatches by terminal ID via Map lookup
  private globalDataUnsubscribe: (() => void) | null = null
  private globalExitUnsubscribe: (() => void) | null = null
  // Visible-write throttle: sessions that have pending visible data to flush
  private dirtyVisibleSessions: Set<string> = new Set()
  private visibleFlushScheduled = false
  private lastVisibleFlushTime = 0
  private visibleFlushTimeoutId: number | null = null
  private visibleFlushAnimationFrameId: number | null = null
  private activeInteractiveTerminalId: string | null = null

  constructor() {
    this.registerBufferRequestListener()
    this.registerGlobalDataListener()
    this.registerGlobalExitListener()
  }

  /**
   * Single global listener for terminal:data IPC.
   * Dispatches to the correct session via Map.get() — O(1) per message
   * instead of O(N) when each session had its own listener filtering by ID.
   */
  // Small data threshold for the fast path — must match the main-process
  // TerminalDataBuffer.FAST_PATH_THRESHOLD so that interactive keystroke
  // echoes bypass BOTH the IPC buffer and the renderer throttle.
  private static readonly INTERACTIVE_FAST_PATH_BYTES = 128

  private registerGlobalDataListener(): void {
    this.globalDataUnsubscribe = window.electronAPI.terminal.onData((termId, data) => {
      const session = this.sessions.get(termId)
      if (!session) return

      perfMonitor.recordIpcData(data.length)

      const interactiveBoostActive = this.shouldUseInteractiveBoost(session)

      // Fast path: for visible terminals with no pending data, write small
      // interactive data (keystroke echoes) directly to xterm, bypassing
      // the 50 ms throttled flush.  This eliminates the renderer-side
      // latency for interactive typing while preserving viewport intent
      // (autofollow / manual scroll restoration).
      if (
        session.visible &&
        session.terminal &&
        (
          interactiveBoostActive ||
          (
            data.length <= TerminalSessionManager.INTERACTIVE_FAST_PATH_BYTES &&
            session.pendingDataBytes === 0
          )
        )
      ) {
        if (interactiveBoostActive && session.pendingDataBytes > 0) {
          this.flushPendingData(session)
        }
        this.writeTerminalData(session, data)

        // Still record input latency for the perf monitor
        const ksTs = (session as any)._lastKeystrokeTs as number | undefined
        if (ksTs && data.length <= 16) {
          perfMonitor.recordInputLatency(performance.now() - ksTs)
          ;(session as any)._lastKeystrokeTs = undefined
        }
        return
      }

      // Slow path: buffer data for throttled flush.
      // Visible terminals are flushed on a throttled schedule (every 50ms);
      // hidden terminals keep buffering until they become visible.
      session.pendingData.push(data)
      session.pendingDataBytes += data.length

      if (!session.visible) {
        this.trimPendingData(session, PENDING_DATA_MAX_BYTES)
        perfMonitor.recordHiddenTermWrite(data.length)
        return
      }

      this.trimPendingData(session, VISIBLE_PENDING_DATA_MAX_BYTES)

      // Visible: mark dirty and schedule a throttled flush
      this.dirtyVisibleSessions.add(termId)
      this.scheduleVisibleFlush()

      // Input latency: time from keystroke to echo arrival
      const ksTs = (session as any)._lastKeystrokeTs as number | undefined
      if (ksTs && data.length <= 16) {
        perfMonitor.recordInputLatency(performance.now() - ksTs)
        ;(session as any)._lastKeystrokeTs = undefined
      }
    })
  }

  /**
   * Schedule a batched flush of all dirty visible sessions.
   * Uses requestAnimationFrame gated by a minimum interval so that:
   *  - Writes are aligned with the browser's paint cycle
   *  - The main thread is free between flushes for input events & React
   *  - At most ~20 flush cycles per second (50 ms apart)
   */
  private scheduleVisibleFlush(): void {
    if (this.visibleFlushScheduled) return
    this.visibleFlushScheduled = true

    const elapsed = performance.now() - this.lastVisibleFlushTime
    const delay = Math.max(0, VISIBLE_WRITE_THROTTLE_MS - elapsed)
    const scheduleFlush = () => {
      // Prefer rAF for normal paint-aligned updates, but keep a timeout
      // fallback so visible PTY data still flushes when the window is
      // backgrounded or frame scheduling is throttled.
      this.visibleFlushAnimationFrameId = requestAnimationFrame(() => {
        this.visibleFlushAnimationFrameId = null
        this.flushVisibleSessions()
      })
      this.visibleFlushTimeoutId = window.setTimeout(() => {
        this.visibleFlushTimeoutId = null
        this.flushVisibleSessions()
      }, 32)
    }

    if (delay <= 0) {
      scheduleFlush()
      return
    }

    this.visibleFlushTimeoutId = window.setTimeout(() => {
      this.visibleFlushTimeoutId = null
      scheduleFlush()
    }, delay)
  }

  private flushVisibleSessions(): void {
    if (!this.visibleFlushScheduled) return
    this.visibleFlushScheduled = false
    if (this.visibleFlushTimeoutId !== null) {
      window.clearTimeout(this.visibleFlushTimeoutId)
      this.visibleFlushTimeoutId = null
    }
    if (this.visibleFlushAnimationFrameId !== null) {
      cancelAnimationFrame(this.visibleFlushAnimationFrameId)
      this.visibleFlushAnimationFrameId = null
    }
    this.lastVisibleFlushTime = performance.now()
    const requeue: string[] = []

    for (const termId of this.dirtyVisibleSessions) {
      const session = this.sessions.get(termId)
      if (!session || session.pendingData.length === 0) continue

      const merged = this.consumePendingDataChunk(session, VISIBLE_WRITE_MAX_CHUNK_BYTES)
      if (!merged) continue

      this.writeTerminalData(session, merged)

      if (session.pendingData.length > 0) {
        requeue.push(termId)
      }
    }
    this.dirtyVisibleSessions.clear()
    requeue.forEach((termId) => this.dirtyVisibleSessions.add(termId))
    if (this.dirtyVisibleSessions.size > 0) {
      this.scheduleVisibleFlush()
    }
  }

  /**
   * Single global listener for terminal:exit IPC.
   */
  private registerGlobalExitListener(): void {
    this.globalExitUnsubscribe = window.electronAPI.terminal.onExit((termId, exitCode) => {
      const session = this.sessions.get(termId)
      if (!session) return

      session.terminal.writeln(`\r\n[Process exited with code ${exitCode}]`)
      session.terminal.writeln('\r\n[Press any key to restart...]')

      // Clean up dead PTY in main process
      window.electronAPI.terminal.dispose(termId)

      // Reset session state so ensureReady can re-create
      session.status = 'idle'
      session.readyPromise = null

      // Wait for any key press to restart
      const disposable = session.terminal.onData(() => {
        disposable.dispose()
        this.restartShell(termId)
      })
    })
  }

  private registerBufferRequestListener(): void {
    this.bufferRequestUnsubscribe = window.electronAPI.terminal.onGetBufferRequest(
      (requestId: string, terminalId: string, options?: TerminalBufferOptions) => {
        const result = this.getBufferContent(terminalId, options)
        window.electronAPI.terminal.sendBufferResponse(requestId, result)
      }
    )
  }

  private isNearBottom(baseY: number, viewportY: number): boolean {
    return baseY - viewportY <= AUTOFOLLOW_THRESHOLD_LINES
  }

  private getActiveViewportState(session: TerminalSession) {
    const buffer = session.terminal.buffer.active
    return {
      bufferType: buffer.type as TerminalBufferType,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY
    }
  }

  private captureViewportIntent(
    session: TerminalSession,
    reason: TerminalViewportRestoreReason
  ): TerminalViewportRestoreState | null {
    if (!session.open) return null
    if (session.pendingViewportRestore) return session.pendingViewportRestore

    const viewport = this.getActiveViewportState(session)
    // "At bottom" before fit/attach means the user expects auto-follow; preserve
    // that intent across the geometry change. Otherwise preserve the exact line.
    const followBottom = this.isNearBottom(viewport.baseY, viewport.viewportY)
    const pending: TerminalViewportRestoreState = {
      followBottom,
      viewportY: viewport.viewportY,
      bufferType: viewport.bufferType,
      reason,
      capturedAt: Date.now()
    }

    session.pendingViewportRestore = pending
    return pending
  }

  private clearPendingRestoreAnimationFrame(session: TerminalSession): void {
    if (session.pendingRestoreAnimationFrame !== null) {
      cancelAnimationFrame(session.pendingRestoreAnimationFrame)
      session.pendingRestoreAnimationFrame = null
    }
  }

  private clearPendingGeometryRefreshAnimationFrame(session: TerminalSession): void {
    if (session.pendingGeometryRefreshAnimationFrame !== null) {
      cancelAnimationFrame(session.pendingGeometryRefreshAnimationFrame)
      session.pendingGeometryRefreshAnimationFrame = null
    }
  }

  private scheduleGeometryRefresh(session: TerminalSession): void {
    if (!session.open || !session.container || session.status === 'disposed') return

    this.clearPendingGeometryRefreshAnimationFrame(session)
    const sessionId = session.id

    session.pendingGeometryRefreshAnimationFrame = requestAnimationFrame(() => {
      const currentSession = this.sessions.get(sessionId)
      if (!currentSession || currentSession.status === 'disposed') return

      currentSession.pendingGeometryRefreshAnimationFrame = null
      this.forceFit(sessionId)
    })
  }

  private applyPendingViewportRestore(
    session: TerminalSession,
    _reason: TerminalViewportRestoreReason
  ): void {
    const pending = session.pendingViewportRestore
    if (!pending || session.status === 'disposed') return

    const before = this.getActiveViewportState(session)
    // Don't try to restore across an alternate-buffer boundary: the target
    // viewportY doesn't map to the other buffer's coordinate space.
    if (before.bufferType !== pending.bufferType) {
      session.pendingViewportRestore = null
      return
    }

    if (pending.followBottom) {
      session.terminal.scrollToBottom()
    } else {
      const targetLine = Math.max(0, Math.min(pending.viewportY, before.baseY))
      session.terminal.scrollToLine(targetLine)
    }

    session.pendingViewportRestore = null
  }

  private schedulePendingViewportRestore(
    session: TerminalSession,
    reason: TerminalViewportRestoreReason
  ): void {
    if (!session.pendingViewportRestore || !session.open) return
    this.clearPendingRestoreAnimationFrame(session)
    session.pendingRestoreAnimationFrame = requestAnimationFrame(() => {
      session.pendingRestoreAnimationFrame = null
      this.applyPendingViewportRestore(session, reason)
    })
  }

  getBufferContent(id: string, options?: TerminalBufferOptions): TerminalBufferResult {
    const session = this.sessions.get(id)
    if (!session) {
      return { success: false, terminalId: id, error: `Terminal ${id} does not exist` }
    }

    const mode = options?.mode ?? 'tail-lines'
    const trimTrailingEmpty = options?.trimTrailingEmpty !== false
    const bufferTarget = options?.buffer ?? 'active'

    try {
      // Detect the currently activated buffer type
      const activeBufferType = session.terminal.buffer.active.type as 'normal' | 'alternate'

      // Select the buffer to read based on bufferTarget
      let buffer
      if (bufferTarget === 'normal') {
        buffer = session.terminal.buffer.normal
      } else if (bufferTarget === 'alternate') {
        buffer = session.terminal.buffer.alternate
      } else {
        buffer = session.terminal.buffer.active
      }

      const totalLines = buffer.length

      // Read buffer contents line by line
      const lines: string[] = []
      for (let i = 0; i < totalLines; i++) {
        const line = buffer.getLine(i)
        if (line) {
          lines.push(line.translateToString(true))
        }
      }

      // Remove trailing blank lines
      if (trimTrailingEmpty) {
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop()
        }
      }

      let content: string
      let returnedLines: number
      let returnedChars: number
      let truncated = false

      if (mode === 'tail-chars') {
        const lastChars = options?.lastChars ?? 500
        const fullContent = lines.join('\n')
        if (fullContent.length > lastChars) {
          content = fullContent.slice(-lastChars)
          truncated = true
        } else {
          content = fullContent
        }
        returnedChars = content.length
        returnedLines = content.split('\n').length
      } else {
        // tail-lines (default)
        const lastLines = options?.lastLines ?? 100
        const offset = options?.offset ?? 0

        // offset represents the number of lines skipped from the end, used to incrementally read earlier content
        // For example offset=0, lines=100 → last 100 lines
        //      offset=100, lines=100 → lines 101-200 from the last
        const endIndex = offset > 0 ? lines.length - offset : lines.length
        const startIndex = Math.max(0, endIndex - lastLines)

        if (endIndex <= 0) {
          // offset is out of range, no more content
          content = ''
          returnedLines = 0
        } else {
          const sliced = lines.slice(startIndex, endIndex)
          content = sliced.join('\n')
          returnedLines = sliced.length
          truncated = startIndex > 0
        }
        returnedChars = content.length
      }

      return {
        success: true,
        terminalId: id,
        content,
        totalLines: lines.length,
        returnedLines,
        returnedChars,
        truncated,
        capturedAt: Date.now(),
        bufferType: activeBufferType
      }
    } catch (error) {
      return { success: false, terminalId: id, error: String(error) }
    }
  }

  private applyOptions(session: TerminalSession, options: TerminalSessionOptions) {
    const previousOptions = session.lastOptions
    const previousFontFamily = previousOptions
      ? resolveTerminalFontFamily(previousOptions)
      : String(session.terminal.options.fontFamily ?? '')
    const previousFontSize = previousOptions
      ? resolveTerminalFontSize(previousOptions)
      : Number(session.terminal.options.fontSize ?? options.fontSize)
    const nextFontFamily = resolveTerminalFontFamily(options)
    const nextFontSize = resolveTerminalFontSize(options)
    const fontMetricsChanged = previousFontFamily !== nextFontFamily || previousFontSize !== nextFontSize

    session.terminal.options.theme = buildTheme(options)
    session.terminal.options.fontFamily = nextFontFamily
    session.terminal.options.fontSize = nextFontSize
    session.lastOptions = options

    if (fontMetricsChanged) {
      this.scheduleGeometryRefresh(session)
    }
  }

  getViewportDebugState(id: string): TerminalViewportDebugState | null {
    const session = this.sessions.get(id)
    if (!session) return null

    const viewport = this.getActiveViewportState(session)
    const nearBottom = this.isNearBottom(viewport.baseY, viewport.viewportY)
    return {
      terminalId: id,
      bufferType: viewport.bufferType,
      baseY: viewport.baseY,
      viewportY: viewport.viewportY,
      rows: session.terminal.rows,
      cols: session.terminal.cols,
      isNearBottom: nearBottom,
      // In the simplified model there is no separate "user wants bottom" flag:
      // auto-follow intent is synonymous with currently being near the bottom,
      // which is exactly what xterm's isUserScrolling toggles on.
      userWantsBottom: nearBottom,
      pendingRestore: session.pendingViewportRestore
    }
  }

  getSessionDebugState(id: string): TerminalSessionDebugState | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return {
      terminalId: id,
      status: session.status,
      open: session.open,
      visible: session.visible,
      pendingDataChunks: session.pendingData.length,
      pendingDataBytes: session.pendingDataBytes
    }
  }

  scrollToTop(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    this.clearPendingRestoreAnimationFrame(session)
    session.pendingViewportRestore = null
    session.terminal.scrollToTop()
    return true
  }

  scrollToBottom(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    this.clearPendingRestoreAnimationFrame(session)
    this.clearPendingGeometryRefreshAnimationFrame(session)
    session.pendingViewportRestore = null
    session.terminal.scrollToBottom()
    return true
  }

  /**
   * Scroll the terminal by a relative number of lines as if the user did it.
   * `lines < 0` scrolls up (xterm sets isUserScrolling=true), `lines > 0`
   * scrolls down (xterm clears the flag when it reaches the bottom).
   * This is the correct way for tests to simulate a real wheel / PageUp.
   */
  scrollLinesAsUser(id: string, lines: number): boolean {
    const session = this.sessions.get(id)
    if (!session?.open || !Number.isFinite(lines) || lines === 0) return false
    session.terminal.scrollLines(lines)
    return true
  }

  private createSession(id: string, options: TerminalSessionOptions): TerminalSession {
    const terminal = new XTerm({
      theme: buildTheme(options),
      fontSize: resolveTerminalFontSize(options),
      fontFamily: resolveTerminalFontFamily(options),
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 10000,
      tabStopWidth: 4,
      rightClickSelectsWord: true,
      // Auto-follow semantics live entirely in xterm: when the user hasn't
      // scrolled away, output stays pinned to the bottom; when they have,
      // their position is preserved. Typing snaps back to the bottom.
      scrollOnUserInput: true
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon(handleTerminalLinkClick)
    const searchAddon = new SearchAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)

    // Windows / Linux: Ctrl+C copies selected text, otherwise sends interrupt;
    // Ctrl+V pastes from clipboard. On macOS these shortcuts are handled by
    // Cmd+C / Cmd+V natively, so we leave Ctrl+C as pure SIGINT.
    const isMac = /Mac OS X|Macintosh/.test(navigator.userAgent)
    if (!isMac) {
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyC') {
          if (terminal.hasSelection()) {
            if (event.type === 'keydown') {
              void navigator.clipboard.writeText(terminal.getSelection())
              terminal.clearSelection()
            }
            return false
          }
        }

        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'KeyV') {
          if (event.type === 'keydown') {
            event.preventDefault()
            void navigator.clipboard.readText().then((text) => {
              if (text) {
                // Use xterm.js paste() so bracketed paste mode is applied
                terminal.paste(text)
              }
            })
          }
          return false
        }

        return true
      })
    }

    terminal.onData((data) => {
      // Record keystroke timestamp for input latency measurement.
      // The matching echo arrives in registerGlobalDataListener.
      if (data.length <= 4) {
        // Only track short inputs (keystrokes) — not pasted blocks
        ;(session as any)._lastKeystrokeTs = performance.now()
      }
      this.activateInteractiveBoost(id)
      window.electronAPI.terminal.write(id, data)
    })

    // Note: onData and onExit IPC listeners are handled by a single global
    // listener in the manager (registerGlobalDataListener / registerGlobalExitListener)
    // to avoid O(N) per-message overhead.

    const session: TerminalSession = {
      id,
      terminal,
      fitAddon,
      searchAddon,
      status: 'idle',
      readyPromise: null,
      open: false,
      container: null,
      lastCols: DEFAULT_COLS,
      lastRows: DEFAULT_ROWS,
      lastFitWidth: 0,
      lastFitHeight: 0,
      lastOptions: options,
      pendingViewportRestore: null,
      pendingRestoreAnimationFrame: null,
      pendingGeometryRefreshAnimationFrame: null,
      visible: true,
      pendingData: [],
      pendingDataBytes: 0,
      interactiveBoostUntil: 0
    }

    this.sessions.set(id, session)
    return session
  }

  private getCreateSize(session: TerminalSession) {
    if (session.open) {
      try {
        session.fitAddon.fit()
        const { cols, rows } = session.terminal
        if (cols > 0 && rows > 0) {
          session.lastCols = cols
          session.lastRows = rows
        }
      } catch (e) {
        // Ignore fit errors during transitions
      }
    }

    return { cols: session.lastCols || DEFAULT_COLS, rows: session.lastRows || DEFAULT_ROWS }
  }

  getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Paste text into a terminal through xterm.js's paste() mechanism.
   *
   * This is the correct way to send multi-line content because xterm.js
   * applies bracketed paste mode when the child program has enabled it
   * (e.g. Claude Code sends \x1b[?2004h). Within bracketed paste markers,
   * \r\n is safe — the child treats the block as pasted text rather than
   * interpreting each \r as Enter.
   */
  paste(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.terminal.paste(data)
    return true
  }

  isBracketedPasteEnabled(id: string): boolean | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return session.terminal.modes.bracketedPasteMode
  }

  ensureSession(id: string, options: TerminalSessionOptions): TerminalSession {
    const existing = this.sessions.get(id)
    if (existing) {
      this.applyOptions(existing, options)
      return existing
    }

    return this.createSession(id, options)
  }

  updateOptions(id: string, options: TerminalSessionOptions): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.applyOptions(session, options)
  }

  /**
   * Toggle visibility for a terminal session.
   *
   * When a terminal becomes hidden (e.g., user switches to another tab),
   * incoming PTY data is buffered instead of written to xterm.js, and the
   * WebGL context is released to free GPU resources.
   *
   * When it becomes visible again, buffered data is flushed to xterm.js
   * and the WebGL context is re-created.
   */
  setVisibility(id: string, visible: boolean): void {
    const session = this.sessions.get(id)
    if (!session || session.visible === visible) return

    session.visible = visible

    // Sync the main-process IPC data buffer: enable fast-path for visible
    // terminals (low-latency keystroke echoes), disable for hidden ones
    // (avoid high-rate unbatched IPC traffic with no user-visible benefit).
    window.electronAPI.terminal.setBufferFastPath(id, visible)

    if (visible) {
      // Flush buffered data that accumulated while hidden
      this.flushPendingData(session)
      // Only touch WebGL/fit for fully initialized terminals
      if (session.open && session.status === 'ready') {
        this.ensureWebglAddon(session)
        this.fit(id)
      }
    } else {
      // Release WebGL context to free GPU resources for visible terminals.
      // Only release if the terminal is fully open — avoid interfering with
      // terminals that are still initializing.
      if (session.open) {
        this.releaseWebglAddon(session)
      }
    }
  }

  private flushPendingData(session: TerminalSession): void {
    if (session.pendingData.length === 0) return

    const merged = this.consumePendingDataChunk(session, PENDING_DATA_MAX_BYTES)
    if (!merged) return

    this.writeTerminalData(session, merged)

    if (session.pendingData.length > 0) {
      this.flushPendingData(session)
    }
  }

  private trimPendingData(session: TerminalSession, maxBytes: number): void {
    while (session.pendingDataBytes > maxBytes && session.pendingData.length > 1) {
      const dropped = session.pendingData.shift()!
      session.pendingDataBytes -= dropped.length
    }

    if (session.pendingDataBytes <= maxBytes || session.pendingData.length === 0) return

    const retained = session.pendingData[0].slice(-maxBytes)
    session.pendingData[0] = retained
    session.pendingDataBytes = retained.length
  }

  private consumePendingDataChunk(session: TerminalSession, maxBytes: number): string | null {
    if (session.pendingData.length === 0) return null

    const chunks: string[] = []
    let chunkBytes = 0

    while (session.pendingData.length > 0 && chunkBytes < maxBytes) {
      const next = session.pendingData[0]
      const remaining = maxBytes - chunkBytes

      if (next.length <= remaining) {
        chunks.push(next)
        chunkBytes += next.length
        session.pendingData.shift()
        continue
      }

      if (remaining <= 0) break

      chunks.push(next.slice(0, remaining))
      session.pendingData[0] = next.slice(remaining)
      chunkBytes += remaining
      break
    }

    if (chunkBytes === 0) return null

    session.pendingDataBytes = Math.max(0, session.pendingDataBytes - chunkBytes)
    return chunks.length === 1 ? chunks[0] : chunks.join('')
  }

  private ensureWebglAddon(session: TerminalSession): void {
    if (session.webglAddon || !session.open) return
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        console.warn(`[TerminalSession ${session.id}] WebGL context lost, attempting recovery`)
        webglAddon.dispose()
        session.webglAddon = undefined
        perfMonitor.decrementWebglContextCount()
        // Delay re-creation so xterm.js finishes its internal renderer fallback
        setTimeout(() => {
          if (session.status !== 'disposed' && session.visible && session.open) {
            this.ensureWebglAddon(session)
          }
        }, 100)
      })
      session.terminal.loadAddon(webglAddon)
      session.webglAddon = webglAddon
      perfMonitor.incrementWebglContextCount()
    } catch {
      // Canvas fallback is fine
    }
  }

  private releaseWebglAddon(session: TerminalSession): void {
    if (!session.webglAddon) return
    session.webglAddon.dispose()
    session.webglAddon = undefined
    perfMonitor.decrementWebglContextCount()
  }

  attach(id: string, container: HTMLDivElement, options: TerminalSessionOptions): void {
    const session = this.ensureSession(id, options)
    session.container = container

    if (!session.open) {
      session.terminal.open(container)
      session.open = true

      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          console.warn(`[TerminalSession ${session.id}] WebGL context lost during attach, attempting recovery`)
          webglAddon.dispose()
          session.webglAddon = undefined
          perfMonitor.decrementWebglContextCount()
          // Delay re-creation so xterm.js finishes its internal renderer fallback
          setTimeout(() => {
            if (session.status !== 'disposed' && session.visible && session.open) {
              this.ensureWebglAddon(session)
            }
          }, 100)
        })
        session.terminal.loadAddon(webglAddon)
        session.webglAddon = webglAddon
        perfMonitor.incrementWebglContextCount()
      } catch (e) {
        console.warn('WebGL addon failed to load, using canvas renderer')
      }
    } else if (session.terminal.element && session.terminal.element.parentElement !== container) {
      this.captureViewportIntent(session, 'attach')
      while (container.firstChild) {
        container.removeChild(container.firstChild)
      }
      container.appendChild(session.terminal.element)
    }

    this.fit(id)
    this.schedulePendingViewportRestore(session, 'attach')
  }

  detach(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.container || !session.terminal.element) return

    if (session.terminal.element.parentElement === session.container) {
      session.container.removeChild(session.terminal.element)
    }
    session.container = null
  }

  private syncPtySize(session: TerminalSession, force = false): void {
    const { cols, rows } = session.terminal
    if (cols <= 0 || rows <= 0) return

    const prevCols = session.lastCols
    const prevRows = session.lastRows
    session.lastCols = cols
    session.lastRows = rows

    if (session.status === 'ready' && (force || cols !== prevCols || rows !== prevRows)) {
      window.electronAPI.terminal.resize(session.id, cols, rows)
    }
  }

  fit(id: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.open) return
    const container = session.container
    if (!container) return

    const width = container.clientWidth
    const height = container.clientHeight
    if (width <= 0 || height <= 0) return
    if (width === session.lastFitWidth && height === session.lastFitHeight) {
      this.schedulePendingViewportRestore(session, 'fit')
      return
    }
    this.captureViewportIntent(session, 'fit')
    session.lastFitWidth = width
    session.lastFitHeight = height

    try {
      session.fitAddon.fit()
      this.syncPtySize(session)
    } catch (e) {
      // Ignore fit errors during transitions
    }

    this.schedulePendingViewportRestore(session, 'fit')
  }

  forceFit(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    session.lastFitWidth = 0
    session.lastFitHeight = 0
    this.fit(id)
    return true
  }

  remount(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open || !session.container || !session.lastOptions) return false

    const container = session.container
    const options = session.lastOptions
    this.detach(id)
    this.attach(id, container, options)
    return true
  }

  private getTextareaElementForSession(session: TerminalSession): HTMLTextAreaElement | null {
    if (!session.container) return null
    return session.container.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
  }

  getTextareaElement(id: string): HTMLTextAreaElement | null {
    const session = this.sessions.get(id)
    if (!session) return null
    return this.getTextareaElementForSession(session)
  }

  isFocused(id: string): boolean {
    const textarea = this.getTextareaElement(id)
    return textarea !== null && document.activeElement === textarea
  }

  getFocusedTerminalId(): string | null {
    for (const [id] of this.sessions) {
      if (this.isFocused(id)) {
        return id
      }
    }
    return null
  }

  getFocusDebugSnapshot(id: string): TerminalFocusSessionDebugSnapshot {
    const session = this.sessions.get(id)
    if (!session) {
      return {
        exists: false,
        open: null,
        status: null,
        visible: null,
        hasContainer: false,
        containerConnected: false,
        containerWidth: null,
        containerHeight: null,
        containerDisplay: null,
        hasTextarea: false,
        textareaConnected: false,
        textareaDisabled: null,
        textareaTabIndex: null,
        textareaDisplay: null,
        terminalElementConnected: false,
        activeElementMatchesTextarea: false
      }
    }

    const container = session.container
    const textarea = this.getTextareaElementForSession(session)
    const terminalElement = session.terminal.element

    return {
      exists: true,
      open: session.open,
      status: session.status,
      visible: session.visible,
      hasContainer: container !== null,
      containerConnected: container?.isConnected ?? false,
      containerWidth: container?.clientWidth ?? null,
      containerHeight: container?.clientHeight ?? null,
      containerDisplay: container ? window.getComputedStyle(container).display : null,
      hasTextarea: textarea !== null,
      textareaConnected: textarea?.isConnected ?? false,
      textareaDisabled: textarea?.disabled ?? null,
      textareaTabIndex: textarea?.tabIndex ?? null,
      textareaDisplay: textarea ? window.getComputedStyle(textarea).display : null,
      terminalElementConnected: terminalElement?.isConnected ?? false,
      activeElementMatchesTextarea: textarea !== null && document.activeElement === textarea
    }
  }

  focus(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session?.open) return false
    this.activeInteractiveTerminalId = id

    const textarea = this.getTextareaElementForSession(session)
    if (textarea) {
      // preventScroll is critical: the xterm helper-textarea lives at
      // `left:-9999em; top:0`, so a plain focus() triggers the browser's
      // automatic scrollIntoView, which walks up through every
      // overflow:auto|scroll ancestor (.xterm-viewport is one of them) and
      // snaps its scrollTop to 0 — causing the terminal to "jump to the top
      // of where this Task started". See xterm.js issue #1981.
      textarea.focus({ preventScroll: true })
      if (document.activeElement === textarea) {
        return true
      }
    }

    // xterm's own Terminal.focus() already uses { preventScroll: true }
    // internally (CoreBrowserTerminal.ts), so this fallback is safe.
    session.terminal.focus()

    const focusedTextarea = this.getTextareaElementForSession(session)
    return focusedTextarea !== null && document.activeElement === focusedTextarea
  }

  focusIfNeeded(id: string): boolean {
    if (this.isFocused(id)) {
      return true
    }
    return this.focus(id)
  }

  async ensureReady(id: string, options: TerminalSessionOptions): Promise<void> {
    const session = this.ensureSession(id, options)

    if (session.status === 'ready') return
    if (session.status === 'disposed') return
    if (session.readyPromise) return session.readyPromise

    session.status = 'initializing'

    session.readyPromise = (async () => {
      const { cols, rows } = this.getCreateSize(session)
      const result = await window.electronAPI.terminal.create(id, { cols, rows })

      if (session.status === 'disposed') {
        window.electronAPI.terminal.dispose(id)
        return
      }

      if (!result?.success) {
        session.status = 'error'
        throw new Error(result?.error || 'Failed to create terminal')
      }

      session.status = 'ready'
      this.syncPtySize(session, true)
    })()

    session.readyPromise.catch(() => {
      if (session.status !== 'disposed') {
        session.readyPromise = null
      }
    })

    return session.readyPromise
  }

  private restartShell(id: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.lastOptions) return

    this.clearPendingRestoreAnimationFrame(session)
    session.pendingViewportRestore = null
    session.terminal.clear()
    session.terminal.reset()

    void this.ensureReady(id, session.lastOptions)
  }

  dispose(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return

    session.status = 'disposed'
    session.readyPromise = null
    session.pendingData = []
    session.pendingDataBytes = 0
    this.dirtyVisibleSessions.delete(id)
    this.clearPendingRestoreAnimationFrame(session)
    this.clearPendingGeometryRefreshAnimationFrame(session)

    // Data/exit IPC listeners are global; no per-session cleanup needed
    window.electronAPI.terminal.dispose(id)
    if (session.webglAddon) {
      session.webglAddon.dispose()
      session.webglAddon = undefined
      perfMonitor.decrementWebglContextCount()
    }
    session.terminal.dispose()

    if (this.activeInteractiveTerminalId === id) {
      this.activeInteractiveTerminalId = null
    }
    this.sessions.delete(id)
  }

  private writeTerminalData(session: TerminalSession, data: string): void {
    // Just hand the bytes to xterm. xterm's native isUserScrolling handles
    // auto-follow: if the user is at the bottom we stay at the bottom; if they
    // scrolled up we keep their position. No programmatic scroll on output.
    const t0 = performance.now()
    session.terminal.write(data)
    perfMonitor.recordXtermWrite(performance.now() - t0)
  }

  private activateInteractiveBoost(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.interactiveBoostUntil = performance.now() + INTERACTIVE_BOOST_WINDOW_MS
    this.activeInteractiveTerminalId = id
    window.electronAPI.terminal.notifyInteractiveInput(id)
  }

  private shouldUseInteractiveBoost(session: TerminalSession): boolean {
    return (
      session.visible &&
      this.activeInteractiveTerminalId === session.id &&
      performance.now() < session.interactiveBoostUntil
    )
  }
}

export const terminalSessionManager = new TerminalSessionManager()

// Expose for E2E testing via CDP (Chrome DevTools Protocol)
;(window as any).__terminalSessionManager = terminalSessionManager
