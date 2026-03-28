/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { LayoutMode, TerminalInfo, TerminalShortcutAction, TerminalFocusRequest } from '../../types/prompt'
import { TerminalDropdown } from '../TerminalDropdown'
import { GitDiffViewer } from '../GitDiffViewer'
import { GitHistoryViewer } from '../GitHistoryViewer'
import { BrowserPanel } from '../BrowserPanel/BrowserPanel'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_FAMILY } from '../../constants/terminal'
import { terminalSessionManager, TerminalSessionOptions, TerminalSessionStatus } from '../../terminal/terminal-session-manager'
import { focusCoordinator } from '../../terminal/focus-coordinator'
import type { TerminalDebugApi } from '../../autotest/types'
import { perfMonitor } from '../../utils/perf-monitor'
import { useI18n } from '../../i18n/useI18n'
import '@xterm/xterm/css/xterm.css'
import './TerminalGrid.css'

const DEBUG_TERMINAL_GRID = Boolean(window.electronAPI?.debug?.enabled)

function debugLog(...args: unknown[]) {
  if (!DEBUG_TERMINAL_GRID) return
  console.log('[TerminalGrid]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore
  }
}

interface TerminalGridProps {
  layoutMode: LayoutMode
  terminals: TerminalInfo[]
  activeTerminalId: string | null
  theme?: TerminalSessionOptions['theme']
  fontSize?: number
  fontFamily?: string
  onTerminalFocus: (id: string) => void
  onTerminalRename: (id: string, newTitle: string) => void
  onOpenProjectEditor: (terminalId: string) => void
  tabId?: string
  hidden?: boolean
  shortcutAction?: TerminalShortcutAction | null
  focusRequest?: TerminalFocusRequest | null
  projectEditorOpen?: boolean
}

interface TerminalGitInfo {
  cwd: string | null
  branch: string | null
  repoName: string | null
  status: 'clean' | 'modified' | 'added' | 'unknown' | null
}

const TERMINAL_PATH_SEGMENTS = 3
const FOCUS_REQUEST_MAX_ATTEMPTS = 12
const FOCUS_REQUEST_RETRY_MS = 50

export const TerminalGrid = memo(function TerminalGrid({
  layoutMode,
  terminals,
  activeTerminalId,
  theme = 'vscode-dark',
  fontSize = DEFAULT_TERMINAL_FONT_SIZE,
  fontFamily = DEFAULT_TERMINAL_FONT_FAMILY,
  onTerminalFocus,
  onTerminalRename,
  onOpenProjectEditor,
  tabId: _tabId,
  hidden = false,
  shortcutAction = null,
  focusRequest = null,
  projectEditorOpen = false
}: TerminalGridProps) {
  // Performance instrumentation: track render count
  perfMonitor.recordReactRender()

  const { t } = useI18n()
  const gridWrapperRef = useRef<HTMLDivElement | null>(null)
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const hiddenRef = useRef(hidden)
  const containerRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const terminalIdsRef = useRef<string[]>([])
  const visibleTerminalIdsRef = useRef<string[]>([])
  const transitionRef = useRef(0)
  const getTerminalOptionsRef = useRef<(terminalId: string) => TerminalSessionOptions>(() => ({
    theme,
    fontSize,
    fontFamily,
    terminalStyle: null
  }))

  const { getTerminalStyle } = useSettings()

  const [displayLayoutMode, setDisplayLayoutMode] = useState<LayoutMode>(layoutMode)
  const [isTransitioning, setIsTransitioning] = useState(false)

  // Edit status
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const editingIdRef = useRef<string | null>(null)
  const focusRafRef = useRef<number | null>(null)
  const focusRetryTimerRef = useRef<number | null>(null)
  const latestFocusRequestRef = useRef<TerminalFocusRequest | null>(focusRequest)
  const lastHandledFocusTokenRef = useRef<number | null>(null)

  // Git Diff Viewer Status
  const [gitDiffOpen, setGitDiffOpen] = useState(false)
  const [gitDiffTerminalId, setGitDiffTerminalId] = useState<string | null>(null)
  const [gitDiffCwd, setGitDiffCwd] = useState<string | null>(null)
  const [gitHistoryOpen, setGitHistoryOpen] = useState(false)
  const [gitHistoryTerminalId, setGitHistoryTerminalId] = useState<string | null>(null)
  const [gitHistoryCwd, setGitHistoryCwd] = useState<string | null>(null)
  const [terminalInfos, setTerminalInfos] = useState<Record<string, TerminalGitInfo>>({})
  const [copyNotice, setCopyNotice] = useState<{ terminalId: string; message: string } | null>(null)
  const copyNoticeTimerRef = useRef<number | null>(null)
  const lastShortcutTokenRef = useRef<number | null>(null)
  const [terminalStatuses, setTerminalStatuses] = useState<Record<string, TerminalSessionStatus>>({})
  const globalOverlayActive = gitDiffOpen || gitHistoryOpen || projectEditorOpen
  const [browserOpenTerminals, setBrowserOpenTerminals] = useState<Set<string>>(new Set())
  const [lastBrowserUrls, setLastBrowserUrls] = useState<Record<string, string>>({})

  // Terminal context menu state
  const [termCtxMenu, setTermCtxMenu] = useState<{ x: number; y: number; terminalId: string; hasSelection: boolean } | null>(null)
  const contextMenuListeners = useRef<Map<string, (e: MouseEvent) => void>>(new Map())

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  useEffect(() => {
    editingIdRef.current = editingId
  }, [editingId])

  useEffect(() => {
    terminalIdsRef.current = terminals.map(t => t.id)
  }, [terminals])

  useEffect(() => {
    setTerminalStatuses(prev => {
      const next: Record<string, TerminalSessionStatus> = {}
      terminals.forEach(term => {
        next[term.id] = prev[term.id] ?? 'idle'
      })
      return next
    })
  }, [terminals])

  useEffect(() => {
    setTerminalInfos(prev => {
      const next: Record<string, TerminalGitInfo> = {}
      terminals.forEach(term => {
        if (prev[term.id]) {
          next[term.id] = prev[term.id]
        }
      })
      return next
    })
  }, [terminals])

  useEffect(() => {
    const validTerminalIds = new Set(terminals.map(term => term.id))

    setBrowserOpenTerminals(prev => {
      const next = new Set<string>()
      prev.forEach(id => {
        if (validTerminalIds.has(id)) {
          next.add(id)
        }
      })
      return next
    })

    setLastBrowserUrls(prev => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([terminalId]) => validTerminalIds.has(terminalId))
      )
      return next
    })
  }, [terminals])

  const visibleTerminals = useMemo(() => {
    return terminals.slice(0, displayLayoutMode)
  }, [terminals, displayLayoutMode])

  useEffect(() => {
    visibleTerminalIdsRef.current = visibleTerminals.map(term => term.id)
  }, [visibleTerminals])

  useEffect(() => {
    latestFocusRequestRef.current = focusRequest
  }, [focusRequest])

  const getTerminalOptions = useCallback((terminalId: string): TerminalSessionOptions => {
    return {
      theme,
      fontSize,
      fontFamily,
      terminalStyle: getTerminalStyle(terminalId)
    }
  }, [theme, fontSize, fontFamily, getTerminalStyle])

  const formatCompactPath = useCallback((cwd: string): string => {
    const trimmed = cwd.trim()
    if (!trimmed) return ''
    const separator = trimmed.includes('\\') ? '\\' : '/'
    const segments = trimmed.split(/[\\/]+/).filter(Boolean)
    if (segments.length === 0) return trimmed

    if (segments.length <= TERMINAL_PATH_SEGMENTS) {
      const hasRoot = trimmed.startsWith(separator)
      return `${hasRoot ? separator : ''}${segments.join(separator)}`
    }

    return `...${separator}${segments.slice(-TERMINAL_PATH_SEGMENTS).join(separator)}`
  }, [])

  const showCopyNotice = useCallback((terminalId: string, message: string) => {
    setCopyNotice({ terminalId, message })
    if (copyNoticeTimerRef.current) {
      window.clearTimeout(copyNoticeTimerRef.current)
    }
    copyNoticeTimerRef.current = window.setTimeout(() => {
      setCopyNotice(null)
    }, 2000)
  }, [])

  useEffect(() => {
    return () => {
      if (copyNoticeTimerRef.current) {
        window.clearTimeout(copyNoticeTimerRef.current)
      }
    }
  }, [])

  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // ignore
    }

    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.left = '-9999px'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }, [])

  const handleCopyText = useCallback(async (terminalId: string, label: string, text: string | null) => {
    if (!text) return
    const success = await copyTextToClipboard(text)
    if (success) {
      showCopyNotice(terminalId, t('terminalGrid.copyNotice', { label, text }))
    }
  }, [copyTextToClipboard, showCopyNotice, t])

  // Terminal context menu handlers
  const handleTermCtxCopy = useCallback(() => {
    if (!termCtxMenu) return
    const session = terminalSessionManager.getSession(termCtxMenu.terminalId)
    if (session) {
      const selection = session.terminal.getSelection()
      if (selection) {
        void navigator.clipboard.writeText(selection)
        session.terminal.clearSelection()
      }
    }
    setTermCtxMenu(null)
  }, [termCtxMenu])

  const handleTermCtxPaste = useCallback(() => {
    if (!termCtxMenu) return
    const termId = termCtxMenu.terminalId
    void navigator.clipboard.readText().then((text) => {
      if (text) {
        // Use xterm.js paste() so bracketed paste mode is applied
        terminalSessionManager.paste(termId, text)
      }
    })
    setTermCtxMenu(null)
    terminalSessionManager.focus(termId)
  }, [termCtxMenu])

  const handleTermCtxSelectAll = useCallback(() => {
    if (!termCtxMenu) return
    const session = terminalSessionManager.getSession(termCtxMenu.terminalId)
    session?.terminal.selectAll()
    setTermCtxMenu(null)
  }, [termCtxMenu])

  const handleTermCtxClear = useCallback(() => {
    if (!termCtxMenu) return
    const termId = termCtxMenu.terminalId
    const session = terminalSessionManager.getSession(termId)
    session?.terminal.clear()
    setTermCtxMenu(null)
    terminalSessionManager.focus(termId)
  }, [termCtxMenu])

  // Close terminal context menu on mousedown outside
  useEffect(() => {
    if (!termCtxMenu) return
    const handleMouseDown = () => setTermCtxMenu(null)
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [termCtxMenu])

  const applyTerminalInfoUpdate = useCallback((terminalId: string, info: TerminalGitInfo | null) => {
    if (!info) return
    setTerminalInfos(prev => {
      const current = prev[terminalId]
      if (
        current?.cwd === info.cwd &&
        current?.branch === info.branch &&
        current?.repoName === info.repoName &&
        current?.status === info.status
      ) {
        return prev
      }
      return { ...prev, [terminalId]: info }
    })
  }, [])

  const setTerminalStatus = useCallback((terminalId: string, status: TerminalSessionStatus) => {
    setTerminalStatuses(prev => {
      if (prev[terminalId] === status) return prev
      return { ...prev, [terminalId]: status }
    })
  }, [])

  // Notify TerminalSessionManager of visibility changes so hidden terminals
  // can skip xterm.write() and release WebGL contexts.
  // Only reacts to the `hidden` prop (tab switch), NOT to visibleTerminals
  // changes (layout transition), to avoid disposing WebGL during init.
  useEffect(() => {
    const ids = terminals.map(term => term.id)
    ids.forEach(id => terminalSessionManager.setVisibility(id, !hidden))
  }, [hidden, terminals])

  useEffect(() => {
    if (hidden || visibleTerminals.length === 0) return
    const ids = visibleTerminals.map(term => term.id)
    ids.forEach((terminalId) => {
      void window.electronAPI.git.subscribeTerminalInfo(terminalId)
    })
    return () => {
      ids.forEach((terminalId) => {
        void window.electronAPI.git.unsubscribeTerminalInfo(terminalId)
      })
    }
  }, [visibleTerminals, hidden])

  useEffect(() => {
    if (hidden || !activeTerminalId) return
    const isVisible = visibleTerminals.some(term => term.id === activeTerminalId)
    if (!isVisible) return
    void window.electronAPI.git.notifyTerminalFocus(activeTerminalId)
  }, [activeTerminalId, hidden, visibleTerminals])

  useEffect(() => {
    const unsubscribe = window.electronAPI.git.onTerminalInfo((terminalId, info) => {
      applyTerminalInfoUpdate(terminalId, info)
    })
    return () => {
      unsubscribe()
    }
  }, [applyTerminalInfoUpdate])

  useEffect(() => {
    getTerminalOptionsRef.current = (terminalId: string) => ({
      theme,
      fontSize,
      fontFamily,
      terminalStyle: getTerminalStyle(terminalId)
    })
  }, [theme, fontSize, fontFamily, getTerminalStyle])

  const fitTerminal = useCallback((id: string) => {
    terminalSessionManager.fit(id)
  }, [])

  const fitAll = useCallback(() => {
    visibleTerminals.forEach(t => {
      fitTerminal(t.id)
    })
  }, [visibleTerminals, fitTerminal])

  const cancelPendingFocus = useCallback(() => {
    if (focusRafRef.current !== null) {
      cancelAnimationFrame(focusRafRef.current)
      focusRafRef.current = null
    }
    if (focusRetryTimerRef.current !== null) {
      window.clearTimeout(focusRetryTimerRef.current)
      focusRetryTimerRef.current = null
    }
  }, [])

  const attemptFocusRequest = useCallback((request: TerminalFocusRequest, attempt: number) => {
    if (latestFocusRequestRef.current?.token !== request.token) {
      debugLog('focus-request:drop-stale-token', {
        request,
        latest: latestFocusRequestRef.current
      })
      return
    }

    if (hiddenRef.current || editingIdRef.current) {
      debugLog('focus-request:skip-hidden-or-editing', {
        request,
        hidden: hiddenRef.current,
        editingId: editingIdRef.current
      })
      return
    }

    const isVisible = visibleTerminalIdsRef.current.includes(request.terminalId)
    if (!isVisible) {
      debugLog('focus-request:skip-invisible', {
        request,
        visibleTerminalIds: visibleTerminalIdsRef.current
      })
      return
    }

    const focused = terminalSessionManager.focusIfNeeded(request.terminalId)
    debugLog('focus-request:attempt', {
      request,
      attempt,
      focused,
      snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
    })
    if (focused) {
      lastHandledFocusTokenRef.current = request.token
      return
    }

    if (attempt + 1 >= FOCUS_REQUEST_MAX_ATTEMPTS) {
      debugLog('focus-request:exhausted', {
        request,
        attempt,
        snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
      })
      return
    }

    focusRetryTimerRef.current = window.setTimeout(() => {
      focusRetryTimerRef.current = null
      focusRafRef.current = requestAnimationFrame(() => {
        focusRafRef.current = null
        attemptFocusRequest(request, attempt + 1)
      })
    }, FOCUS_REQUEST_RETRY_MS)
  }, [])

  const scheduleFocusRequest = useCallback((request: TerminalFocusRequest | null) => {
    cancelPendingFocus()
    if (!request) return

    if (hiddenRef.current || editingIdRef.current) {
      debugLog('focus-request:not-scheduled-hidden-or-editing', {
        request,
        hidden: hiddenRef.current,
        editingId: editingIdRef.current
      })
      return
    }

    const isVisible = visibleTerminalIdsRef.current.includes(request.terminalId)
    if (!isVisible) {
      debugLog('focus-request:not-scheduled-invisible', {
        request,
        visibleTerminalIds: visibleTerminalIdsRef.current
      })
      return
    }

    if (!focusCoordinator.shouldApplyFocusRequest(request.reason)) {
      debugLog('focus-request:suppressed', {
        request,
        pointer: focusCoordinator.getDebugState()
      })
      lastHandledFocusTokenRef.current = request.token
      return
    }

    if (lastHandledFocusTokenRef.current === request.token && terminalSessionManager.isFocused(request.terminalId)) {
      debugLog('focus-request:already-focused', {
        request,
        snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
      })
      return
    }

    debugLog('focus-request:scheduled', {
      request,
      snapshot: terminalSessionManager.getFocusDebugSnapshot(request.terminalId)
    })
    focusRafRef.current = requestAnimationFrame(() => {
      focusRafRef.current = requestAnimationFrame(() => {
        focusRafRef.current = null
        attemptFocusRequest(request, 0)
      })
    })
  }, [attemptFocusRequest, cancelPendingFocus])

  const adaptiveCollapseRef = useRef<ResizeObserver | null>(null)

  useLayoutEffect(() => {
    if (hidden) return
    const wrapper = gridWrapperRef.current
    if (!wrapper) return

    const checkOverflow = () => {
      const cells = wrapper.querySelectorAll('.terminal-grid-cell')
      cells.forEach((cell) => {
        const headerLeft = cell.querySelector('.terminal-grid-header-left') as HTMLElement | null
        if (!headerLeft) return

        const cwdEl = headerLeft.querySelector('.terminal-grid-adaptive-cwd')
        const repoEl = headerLeft.querySelector('.terminal-grid-adaptive-repo')
        const branchEl = headerLeft.querySelector('.terminal-grid-branch')

        cwdEl?.classList.remove('adaptive-force-collapsed')
        repoEl?.classList.remove('adaptive-force-collapsed')
        branchEl?.classList.remove('branch-allow-shrink')

        void headerLeft.offsetWidth

        if (headerLeft.scrollWidth > headerLeft.clientWidth + 1) {
          cwdEl?.classList.add('adaptive-force-collapsed')
          void headerLeft.offsetWidth

          if (headerLeft.scrollWidth > headerLeft.clientWidth + 1) {
            repoEl?.classList.add('adaptive-force-collapsed')
            void headerLeft.offsetWidth

            if (headerLeft.scrollWidth > headerLeft.clientWidth + 1) {
              branchEl?.classList.add('branch-allow-shrink')
            }
          }
        }
      })
    }

    checkOverflow()

    const observer = new ResizeObserver(checkOverflow)
    adaptiveCollapseRef.current = observer
    const cells = wrapper.querySelectorAll('.terminal-grid-cell')
    cells.forEach((cell) => observer.observe(cell))

    return () => {
      observer.disconnect()
      adaptiveCollapseRef.current = null
    }
  }, [editingId, hidden, terminalInfos, visibleTerminals])

  // Clean up terminal resources (when Tab is destroyed)
  useEffect(() => {
    return () => {
      terminalIdsRef.current.forEach(id => {
        terminalSessionManager.dispose(id)
      })
    }
  }, [])

  // Handling window size changes
  useEffect(() => {
    const handleResize = () => {
      requestAnimationFrame(fitAll)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [fitAll])

  // Refit when layout changes
  useEffect(() => {
    requestAnimationFrame(fitAll)
  }, [displayLayoutMode, fitAll])

  // Theme changes and terminal style changes
  useEffect(() => {
    terminals.forEach(term => {
      terminalSessionManager.updateOptions(term.id, getTerminalOptions(term.id))
    })
  }, [terminals, getTerminalOptions])

  // Layout switching: When adding, wait for the initialization to be completed before switching the display.
  useEffect(() => {
    if (layoutMode === displayLayoutMode) return

    if (layoutMode < displayLayoutMode) {
      setDisplayLayoutMode(layoutMode)
      setIsTransitioning(false)
      return
    }

    if (terminals.length < layoutMode) {
      setIsTransitioning(true)
      return
    }

    const epoch = ++transitionRef.current
    setIsTransitioning(true)

    const targetTerminals = terminals.slice(0, layoutMode)

    targetTerminals.forEach(term => {
      const sessionStatus = terminalSessionManager.getSession(term.id)?.status
      if (sessionStatus !== 'ready') {
        setTerminalStatus(term.id, 'initializing')
      }
    })

    Promise.all(
      targetTerminals.map(term => terminalSessionManager.ensureReady(term.id, getTerminalOptions(term.id)))
    )
      .then(() => {
        if (transitionRef.current !== epoch) return
        targetTerminals.forEach(term => setTerminalStatus(term.id, 'ready'))
        setDisplayLayoutMode(layoutMode)
        setIsTransitioning(false)
      })
      .catch((error) => {
        console.error('Failed to initialize terminals:', error)
        targetTerminals.forEach(term => setTerminalStatus(term.id, 'error'))
        if (transitionRef.current !== epoch) return
        setIsTransitioning(false)
      })
  }, [layoutMode, displayLayoutMode, terminals, getTerminalOptions])

  useEffect(() => {
    scheduleFocusRequest(focusRequest)
    return () => {
      cancelPendingFocus()
    }
  }, [focusRequest, hidden, visibleTerminals, editingId, scheduleFocusRequest, cancelPendingFocus])

  // Save the container ref and mount the terminal
  const setContainerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      containerRefs.current.set(id, el)
      const options = getTerminalOptionsRef.current(id)

      terminalSessionManager.attach(id, el, options)
      const existingStatus = terminalSessionManager.getSession(id)?.status
      if (existingStatus !== 'ready') {
        setTerminalStatus(id, 'initializing')
      }
      terminalSessionManager.ensureReady(id, options)
        .then(() => {
          setTerminalStatus(id, 'ready')
        })
        .catch((error) => {
          console.error('Failed to create terminal:', error)
          setTerminalStatus(id, 'error')
        })

      // Attach right-click context menu listener
      const onContextMenu = (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const session = terminalSessionManager.getSession(id)
        const hasSelection = session ? session.terminal.hasSelection() : false
        setTermCtxMenu({ x: e.clientX, y: e.clientY, terminalId: id, hasSelection })
      }
      el.addEventListener('contextmenu', onContextMenu)
      contextMenuListeners.current.set(id, onContextMenu)

      const pendingRequest = latestFocusRequestRef.current
      if (pendingRequest?.terminalId === id) {
        scheduleFocusRequest(pendingRequest)
      }
    } else {
      // Remove context menu listener on detach
      const prevEl = containerRefs.current.get(id)
      const listener = contextMenuListeners.current.get(id)
      if (prevEl && listener) {
        prevEl.removeEventListener('contextmenu', listener)
        contextMenuListeners.current.delete(id)
      }
      containerRefs.current.delete(id)
      terminalSessionManager.detach(id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getContainerRef = useCallback((id: string) => {
    const cached = containerRefCallbacks.current.get(id)
    if (cached) return cached
    const handler = (el: HTMLDivElement | null) => {
      setContainerRef(id, el)
    }
    containerRefCallbacks.current.set(id, handler)
    return handler
  }, [setContainerRef])

  const retryTerminal = useCallback((terminalId: string) => {
    const options = getTerminalOptionsRef.current(terminalId)
    setTerminalStatus(terminalId, 'initializing')
    terminalSessionManager.ensureReady(terminalId, options)
      .then(() => setTerminalStatus(terminalId, 'ready'))
      .catch(() => setTerminalStatus(terminalId, 'error'))
  }, [setTerminalStatus])

  const handleOpenBrowser = useCallback((terminalId: string, initialUrl?: string | null) => {
    if (typeof initialUrl === 'string' && initialUrl.trim()) {
      setLastBrowserUrls(prev => ({ ...prev, [terminalId]: initialUrl.trim() }))
    }
    setBrowserOpenTerminals(prev => {
      if (prev.has(terminalId)) return prev
      const next = new Set(prev)
      next.add(terminalId)
      return next
    })
  }, [])

  const handleCloseBrowser = useCallback((terminalId: string) => {
    setBrowserOpenTerminals(prev => {
      if (!prev.has(terminalId)) return prev
      const next = new Set(prev)
      next.delete(terminalId)
      return next
    })
    terminalSessionManager.focus(terminalId)
  }, [])

  const handleToggleBrowser = useCallback((terminalId: string) => {
    setBrowserOpenTerminals(prev => {
      const next = new Set(prev)
      if (next.has(terminalId)) {
        next.delete(terminalId)
      } else {
        next.add(terminalId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return

    const debugWindow = window as Window & { __onwardTerminalDebug?: TerminalDebugApi }
    const resolveTerminalId = (terminalId?: string) =>
      terminalId ?? activeTerminalIdRef.current ?? terminalIdsRef.current[0] ?? null

    const api: TerminalDebugApi = {
      getTerminalIds: () => [...terminalIdsRef.current],
      getActiveTerminalId: () => activeTerminalIdRef.current,
      getViewportState: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        return terminalSessionManager.getViewportDebugState(resolved)
      },
      getTailText: (terminalId, lastLines = 20) => {
        const resolved = resolveTerminalId(terminalId)
        if (!resolved) return null
        const result = terminalSessionManager.getBufferContent(resolved, {
          mode: 'tail-lines',
          lastLines,
          trimTrailingEmpty: false
        })
        return result.success ? (result.content ?? '') : null
      },
      scrollToTop: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.scrollToTop(resolved) : false
      },
      scrollToBottom: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.scrollToBottom(resolved) : false
      },
      forceFit: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.forceFit(resolved) : false
      },
      remountTerminal: (terminalId) => {
        const resolved = resolveTerminalId(terminalId)
        return resolved ? terminalSessionManager.remount(resolved) : false
      }
    }

    debugWindow.__onwardTerminalDebug = api
    return () => {
      if (debugWindow.__onwardTerminalDebug === api) {
        delete debugWindow.__onwardTerminalDebug
      }
    }
  }, [activeTerminalId, terminals])

  // Start editing the title (editing the custom name part)
  const handleStartEdit = useCallback((id: string, currentCustomName: string | null) => {
    setEditingId(id)
    setEditingTitle(currentCustomName || '')
  }, [])

  // Finish editing (null value clears custom name)
  const handleFinishEdit = useCallback(() => {
    if (editingId) {
      onTerminalRename(editingId, editingTitle.trim())
    }
    setEditingId(null)
    setEditingTitle('')
  }, [editingId, editingTitle, onTerminalRename])

  // Cancel edit
  const handleCancelEdit = useCallback(() => {
    setEditingId(null)
    setEditingTitle('')
  }, [])

  // Handle keyboard events
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleFinishEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }, [handleFinishEdit, handleCancelEdit])

  // Focus input box
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // View Git Diff — always opens from the Git repository root
  const handleViewGitDiff = useCallback(async (terminalId: string) => {
    const terminalCwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    // Resolve to the root directory of the Git repository to ensure that diff is always executed in the root directory
    const cwd = terminalCwd
      ? await window.electronAPI.git.resolveRepoRoot(terminalCwd)
      : terminalCwd
    debugLog('gitdiff:view', { terminalId, terminalCwd, cwd })
    setGitDiffTerminalId(terminalId)
    setGitDiffCwd(cwd)
    setGitDiffOpen(true)
    setGitHistoryOpen(false)
  }, [])

  const handleViewGitHistory = useCallback(async (terminalId: string) => {
    const terminalCwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    // Resolve to git repo root so the path format matches what getHistory returns
    // (git uses forward slashes; raw terminal CWD on Windows uses backslashes)
    const cwd = terminalCwd
      ? await window.electronAPI.git.resolveRepoRoot(terminalCwd)
      : terminalCwd
    setGitHistoryTerminalId(terminalId)
    setGitHistoryCwd(cwd)
    setGitHistoryOpen(true)
    setGitDiffOpen(false)
  }, [])

  // Close the Git Diff viewer
  const handleCloseGitDiff = useCallback(() => {
    debugLog('gitdiff:close')
    setGitDiffOpen(false)
    setGitDiffTerminalId(null)
    setGitDiffCwd(null)
  }, [])

  useEffect(() => {
    const handleOpenGitDiff = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      debugLog('gitdiff:event:open', { terminalId })
      if (!terminals.some(term => term.id === terminalId)) return
      handleViewGitDiff(terminalId)
    }

    const handleCloseGitDiffEvent = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      debugLog('gitdiff:event:close', { terminalId })
      if (!terminals.some(term => term.id === terminalId)) return
      handleCloseGitDiff()
    }

    window.addEventListener('git-diff:open', handleOpenGitDiff as EventListener)
    window.addEventListener('git-diff:close', handleCloseGitDiffEvent as EventListener)
    return () => {
      window.removeEventListener('git-diff:open', handleOpenGitDiff as EventListener)
      window.removeEventListener('git-diff:close', handleCloseGitDiffEvent as EventListener)
    }
  }, [handleCloseGitDiff, handleViewGitDiff, hidden, terminals])

  useEffect(() => {
    const handleOpenGitHistory = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      if (!terminals.some(term => term.id === terminalId)) return
      handleViewGitHistory(terminalId)
    }

    window.addEventListener('git-history:open', handleOpenGitHistory as EventListener)
    return () => {
      window.removeEventListener('git-history:open', handleOpenGitHistory as EventListener)
    }
  }, [handleViewGitHistory, hidden, terminals])

  useEffect(() => {
    const handleOpenBrowserEvent = (event: Event) => {
      if (hidden) return
      const customEvent = event as CustomEvent<{ terminalId?: string; url?: string }>
      const terminalId = customEvent.detail?.terminalId
      if (!terminalId) return
      if (!terminals.some(term => term.id === terminalId)) return
      handleOpenBrowser(terminalId, customEvent.detail?.url ?? null)
    }

    window.addEventListener('browser:open', handleOpenBrowserEvent as EventListener)
    return () => {
      window.removeEventListener('browser:open', handleOpenBrowserEvent as EventListener)
    }
  }, [handleOpenBrowser, hidden, terminals])

  const handleCloseGitHistory = useCallback(() => {
    setGitHistoryOpen(false)
    setGitHistoryTerminalId(null)
    setGitHistoryCwd(null)
  }, [])

  // Change working directory
  const handleChangeWorkDir = useCallback(async (terminalId: string) => {
    const result = await window.electronAPI.dialog.openDirectory()
    if (result.success && result.path) {
      const cdCommand = `cd "${result.path}"\r`
      window.electronAPI.terminal.write(terminalId, cdCommand)
      onTerminalFocus(terminalId)
      window.setTimeout(() => {
        void window.electronAPI.git.notifyTerminalActivity(terminalId)
      }, 300)
    }
  }, [onTerminalFocus])

  const handleOpenWorkDir = useCallback(async (terminalId: string) => {
    let cwd = terminalInfos[terminalId]?.cwd || null
    if (!cwd) {
      try {
        cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
      } catch {
        cwd = null
      }
    }
    if (!cwd) return

    const result = await window.electronAPI.shell.openPath(cwd)
    if (!result.success && result.error) {
      console.error('Failed to open work directory:', result.error)
    }
  }, [terminalInfos])

  useEffect(() => {
    if (hidden || !shortcutAction) return
    if (lastShortcutTokenRef.current === shortcutAction.token) return
    const isTargetVisible = visibleTerminals.some(term => term.id === shortcutAction.terminalId)
    if (!isTargetVisible) return

    lastShortcutTokenRef.current = shortcutAction.token
    switch (shortcutAction.action) {
      case 'gitDiff':
        void handleViewGitDiff(shortcutAction.terminalId)
        break
      case 'gitHistory':
        void handleViewGitHistory(shortcutAction.terminalId)
        break
      case 'changeWorkDir':
        void handleChangeWorkDir(shortcutAction.terminalId)
        break
      case 'openWorkDir':
        void handleOpenWorkDir(shortcutAction.terminalId)
        break
      case 'projectEditor':
        onOpenProjectEditor(shortcutAction.terminalId)
        break
    }
  }, [shortcutAction, hidden, visibleTerminals, handleViewGitDiff, handleViewGitHistory, handleChangeWorkDir, handleOpenWorkDir, onOpenProjectEditor])

  const handleTerminalFocus = useCallback((terminalId: string) => {
    void window.electronAPI.git.notifyTerminalFocus(terminalId)
    onTerminalFocus(terminalId)
  }, [onTerminalFocus])

  return (
    <>
      <div ref={gridWrapperRef} className={`terminal-grid-wrapper ${hidden ? 'terminal-grid-hidden' : ''}`}>
        <div className="terminal-grid" data-layout={displayLayoutMode}>
          {visibleTerminals.map((termInfo, index) => {
            const terminalInfo = terminalInfos[termInfo.id]
            const terminalStatus = terminalStatuses[termInfo.id] ?? 'idle'
            const showTerminalOverlay = terminalStatus === 'initializing' || terminalStatus === 'error'
            const cwd = terminalInfo?.cwd || null
            const branch = terminalInfo?.branch || null
            const repoName = terminalInfo?.repoName || null
            const status = terminalInfo?.status ?? null
            const compactCwd = cwd ? formatCompactPath(cwd) : ''
            const branchStatusClass = status && status !== 'clean'
              ? `terminal-grid-branch--${status}`
              : ''
            const branchClassName = branchStatusClass
              ? `terminal-grid-branch ${branchStatusClass}`
              : 'terminal-grid-branch'

            return (
              <div
                key={termInfo.id}
                className={`terminal-grid-cell ${activeTerminalId === termInfo.id ? 'active' : ''}`}
                data-terminal-id={termInfo.id}
                onClick={() => handleTerminalFocus(termInfo.id)}
              >
                <div className="terminal-grid-header">
                  <TerminalDropdown
                    terminalId={termInfo.id}
                    onViewGitDiff={() => handleViewGitDiff(termInfo.id)}
                    onViewGitHistory={() => handleViewGitHistory(termInfo.id)}
                    onChangeWorkDir={() => handleChangeWorkDir(termInfo.id)}
                    onOpenWorkDir={() => handleOpenWorkDir(termInfo.id)}
                    onOpenProjectEditor={() => onOpenProjectEditor(termInfo.id)}
                    onToggleBrowser={() => handleToggleBrowser(termInfo.id)}
                    isBrowserOpen={browserOpenTerminals.has(termInfo.id)}
                  />
                  <div className="terminal-grid-header-left">
                    {editingId === termInfo.id ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        className="terminal-grid-title-input"
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={handleFinishEdit}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        placeholder={t('terminalGrid.placeholderTask', { index: index + 1 })}
                      />
                    ) : (
                      <span
                        className="terminal-grid-title"
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          handleStartEdit(termInfo.id, termInfo.customName)
                        }}
                        title={t('terminalGrid.editTitle')}
                      >
                        {termInfo.title}
                      </span>
                    )}
                    {repoName && (
                      <span
                        className="terminal-grid-adaptive-repo terminal-grid-copyable"
                        title={t('terminalGrid.repoTitle', { repoName })}
                        onDoubleClick={() => {
                          void handleCopyText(termInfo.id, t('terminalGrid.copyLabel.repo'), repoName)
                        }}
                      >
                        <span className="terminal-grid-adaptive-expanded">{repoName}</span>
                        <span className="terminal-grid-adaptive-collapsed">
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M8.186 1.113a.5.5 0 0 0-.372 0L1.846 3.5 8 5.961 14.154 3.5 8.186 1.113zM15 4.239l-6.5 2.6v7.922l6.5-2.6V4.24zM7.5 14.762V6.838L1 4.239v7.923l6.5 2.6zM7.443.184a1.5 1.5 0 0 1 1.114 0l7.129 2.852A.5.5 0 0 1 16 3.5v8.662a1 1 0 0 1-.629.928l-7.185 2.874a.5.5 0 0 1-.372 0L.63 13.09a1 1 0 0 1-.63-.928V3.5a.5.5 0 0 1 .314-.464L7.443.184z" />
                          </svg>
                          <span className="terminal-grid-adaptive-hover-text">{repoName}</span>
                        </span>
                      </span>
                    )}
                    {branch && (
                      <span
                        className={`${branchClassName} terminal-grid-copyable`}
                        title={t('terminalGrid.branchTitle', { branch })}
                        onDoubleClick={() => {
                          void handleCopyText(termInfo.id, t('terminalGrid.copyLabel.branch'), branch)
                        }}
                      >
                        <span className="terminal-grid-branch-name">{branch}</span>
                      </span>
                    )}
                    {compactCwd && (
                      <span
                        className="terminal-grid-adaptive-cwd terminal-grid-copyable"
                        title={cwd || ''}
                        onDoubleClick={() => {
                          void handleCopyText(termInfo.id, t('terminalGrid.copyLabel.path'), cwd)
                        }}
                      >
                        <span className="terminal-grid-adaptive-expanded">{compactCwd}</span>
                        <span className="terminal-grid-adaptive-collapsed">
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" />
                          </svg>
                          <span className="terminal-grid-adaptive-hover-text">{compactCwd}</span>
                        </span>
                      </span>
                    )}
                  </div>
                </div>
                {copyNotice?.terminalId === termInfo.id && (
                  <div
                    className="terminal-grid-copy-notice"
                    role="status"
                    aria-live="polite"
                    title={copyNotice.message}
                  >
                    {copyNotice.message}
                  </div>
                )}
                <div
                  ref={getContainerRef(termInfo.id)}
                  className="terminal-grid-container"
                />
                <BrowserPanel
                  isOpen={browserOpenTerminals.has(termInfo.id)}
                  onClose={() => handleCloseBrowser(termInfo.id)}
                  terminalId={termInfo.id}
                  initialUrl={lastBrowserUrls[termInfo.id] || null}
                  onUrlChange={(nextUrl) => {
                    setLastBrowserUrls(prev => ({ ...prev, [termInfo.id]: nextUrl }))
                  }}
                  forceHidden={hidden || globalOverlayActive}
                />
                {showTerminalOverlay && (
                  <div
                    className={`terminal-grid-cell-overlay ${terminalStatus === 'error' ? 'is-error' : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="terminal-grid-cell-overlay-title">
                      {terminalStatus === 'error'
                        ? t('terminalGrid.overlay.errorTitle')
                        : t('terminalGrid.overlay.initializingTitle')}
                    </div>
                    <div className="terminal-grid-cell-overlay-desc">
                      {terminalStatus === 'error'
                        ? t('terminalGrid.overlay.errorDescription')
                        : t('terminalGrid.overlay.initializingDescription')}
                    </div>
                    {terminalStatus === 'error' && (
                      <button
                        className="terminal-grid-cell-overlay-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          retryTerminal(termInfo.id)
                        }}
                      >
                        {t('terminalGrid.overlay.retry')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {isTransitioning && (
          <div className="terminal-grid-overlay">
            {t('terminalGrid.overlay.gridInitializing')}
          </div>
        )}
      </div>

      {!hidden && (
        <GitDiffViewer
          isOpen={gitDiffOpen}
          onClose={handleCloseGitDiff}
          terminalId={gitDiffTerminalId || ''}
          cwd={gitDiffCwd}
          displayMode="panel"
        />
      )}
      {!hidden && (
        <GitHistoryViewer
          isOpen={gitHistoryOpen}
          onClose={handleCloseGitHistory}
          terminalId={gitHistoryTerminalId || ''}
          cwd={gitHistoryCwd}
          displayMode="panel"
        />
      )}
      {termCtxMenu && createPortal(
        <div
          className="terminal-context-menu"
          style={{ position: 'fixed', left: termCtxMenu.x, top: termCtxMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="terminal-context-item"
            onClick={handleTermCtxCopy}
            disabled={!termCtxMenu.hasSelection}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6z" /><path d="M2 6a2 2 0 0 1 2-2v1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1h1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" /></svg>
            <span>{t('terminal.contextMenu.copy')}</span>
          </button>
          <button
            className="terminal-context-item"
            onClick={handleTermCtxPaste}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 1.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1zM5 1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V1z" /><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h.585A1.98 1.98 0 0 0 5 2v1a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2c0-.068-.004-.135-.011-.2H11.5A1.5 1.5 0 0 1 13 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11z" /></svg>
            <span>{t('terminal.contextMenu.paste')}</span>
          </button>
          <div className="terminal-context-separator" />
          <button
            className="terminal-context-item"
            onClick={handleTermCtxSelectAll}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM0 2a2 2 0 0 1 3.937-.5H5.25a.75.75 0 0 1 0 1.5H3.937A2 2 0 0 1 0 2zm2 11a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-2-1a2 2 0 0 0 3.937.5h6.126A2 2 0 1 0 12.5 10.063V5.937A2 2 0 1 0 12.063 3.5H5.937A2 2 0 0 0 2 .063v6.126A2 2 0 0 0 0 12zm12 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm1-13a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" /></svg>
            <span>{t('terminal.contextMenu.selectAll')}</span>
          </button>
          <button
            className="terminal-context-item"
            onClick={handleTermCtxClear}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
            <span>{t('terminal.contextMenu.clear')}</span>
          </button>
        </div>,
        document.body
      )}
    </>
  )
})
