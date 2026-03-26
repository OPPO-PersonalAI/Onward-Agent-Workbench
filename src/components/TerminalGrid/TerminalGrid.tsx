/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { LayoutMode, TerminalInfo, TerminalShortcutAction } from '../../types/prompt'
import { TerminalDropdown } from '../TerminalDropdown'
import { GitDiffViewer } from '../GitDiffViewer'
import { GitHistoryViewer } from '../GitHistoryViewer'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_FAMILY } from '../../constants/terminal'
import { terminalSessionManager, TerminalSessionOptions, TerminalSessionStatus } from '../../terminal/terminal-session-manager'
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
  shouldAutoFocus?: () => boolean
  tabId?: string
  hidden?: boolean
  shortcutAction?: TerminalShortcutAction | null
}

interface TerminalGitInfo {
  cwd: string | null
  branch: string | null
  repoName: string | null
  status: 'clean' | 'modified' | 'added' | 'unknown' | null
}

const TERMINAL_PATH_SEGMENTS = 3

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
  shouldAutoFocus,
  tabId: _tabId,
  hidden = false,
  shortcutAction = null
}: TerminalGridProps) {
  // Performance instrumentation: track render count
  perfMonitor.recordReactRender()

  const { t } = useI18n()
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const hiddenRef = useRef(hidden)
  const containerRefCallbacks = useRef<Map<string, (el: HTMLDivElement | null) => void>>(new Map())
  const activeTerminalIdRef = useRef(activeTerminalId)
  const terminalIdsRef = useRef<string[]>([])
  const transitionRef = useRef(0)
  const getTerminalOptionsRef = useRef<(terminalId: string) => TerminalSessionOptions>(() => ({
    theme,
    fontSize,
    fontFamily,
    terminalStyle: null
  }))

  const { settings } = useSettings()

  const [displayLayoutMode, setDisplayLayoutMode] = useState<LayoutMode>(layoutMode)
  const [isTransitioning, setIsTransitioning] = useState(false)

  // Edit status
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const editingIdRef = useRef<string | null>(null)
  const focusRafRef = useRef<number | null>(null)

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

  // Terminal context menu state
  const [termCtxMenu, setTermCtxMenu] = useState<{ x: number; y: number; terminalId: string; hasSelection: boolean } | null>(null)
  const contextMenuListeners = useRef<Map<string, (e: MouseEvent) => void>>(new Map())

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  useEffect(() => {
    activeTerminalIdRef.current = activeTerminalId
  }, [activeTerminalId])

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

  const visibleTerminals = useMemo(() => {
    return terminals.slice(0, displayLayoutMode)
  }, [terminals, displayLayoutMode])

  const getTerminalOptions = useCallback((terminalId: string): TerminalSessionOptions => {
    return {
      theme,
      fontSize,
      fontFamily,
      terminalStyle: settings?.terminalStyles[terminalId] ?? null
    }
  }, [theme, fontSize, fontFamily, settings?.terminalStyles])

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
      terminalStyle: settings?.terminalStyles[terminalId] ?? null
    })
  }, [theme, fontSize, fontFamily, settings?.terminalStyles])

  const fitTerminal = useCallback((id: string) => {
    terminalSessionManager.fit(id)
  }, [])

  const fitAll = useCallback(() => {
    visibleTerminals.forEach(t => {
      fitTerminal(t.id)
    })
  }, [visibleTerminals, fitTerminal])

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

  // Focus on active terminal - triggered when activeTerminalId or layout changes
  useEffect(() => {
    if (!activeTerminalId || hidden || editingIdRef.current) return
    if (shouldAutoFocus && !shouldAutoFocus()) return

    const isVisible = visibleTerminals.some(t => t.id === activeTerminalId)
    if (!isVisible) return

    const scheduleFocus = () => {
      if (editingIdRef.current) return
      terminalSessionManager.focus(activeTerminalId)
    }

    focusRafRef.current = requestAnimationFrame(() => {
      focusRafRef.current = requestAnimationFrame(scheduleFocus)
    })

    return () => {
      if (focusRafRef.current !== null) {
        cancelAnimationFrame(focusRafRef.current)
        focusRafRef.current = null
      }
    }
  }, [activeTerminalId, hidden, visibleTerminals, editingId])

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

      if (activeTerminalIdRef.current === id && !hiddenRef.current) {
        if (shouldAutoFocus && !shouldAutoFocus()) return
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (editingIdRef.current) return
            terminalSessionManager.focus(id)
          })
        })
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
      <div className={`terminal-grid-wrapper ${hidden ? 'terminal-grid-hidden' : ''}`}>
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
                  <div className="terminal-grid-header-left">
                    <TerminalDropdown
                      terminalId={termInfo.id}
                      onViewGitDiff={() => handleViewGitDiff(termInfo.id)}
                      onViewGitHistory={() => handleViewGitHistory(termInfo.id)}
                      onChangeWorkDir={() => handleChangeWorkDir(termInfo.id)}
                      onOpenWorkDir={() => handleOpenWorkDir(termInfo.id)}
                      onOpenProjectEditor={() => onOpenProjectEditor(termInfo.id)}
                    />
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
                      <span className="terminal-grid-repo" title={t('terminalGrid.repoTitle', { repoName })}>
                        {repoName}
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
                        {branch}
                      </span>
                    )}
                  </div>
                  {compactCwd && (
                    <div
                      className="terminal-grid-cwd terminal-grid-copyable"
                      title={cwd || ''}
                      onDoubleClick={() => {
                        void handleCopyText(termInfo.id, t('terminalGrid.copyLabel.path'), cwd)
                      }}
                    >
                      <span className="terminal-grid-cwd-text">{compactCwd}</span>
                    </div>
                  )}
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
