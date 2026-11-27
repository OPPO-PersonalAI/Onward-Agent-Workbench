/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { TabItem } from './TabItem'
import { useAppState } from '../../hooks/useAppState'
import { useSettings } from '../../contexts/SettingsContext'
import { useModalEscape } from '../../hooks/useModalEscape'
import { useI18n } from '../../i18n/useI18n'
import type { TranslationKey } from '../../i18n/core'
import { perfTrace, perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import {
  clampTabBarRows,
  computeMultiRowCapacities,
  computeMultiRowTabSlice,
  DEFAULT_CUSTOM_TAB_BAR_ROWS,
  getTabBarMaxRows,
  isMultiRowTabBarLayout,
  isPresetTabBarLayout,
  MAX_TAB_BAR_ROWS,
  MIN_TAB_BAR_ROWS,
  normalizeTabBarLayout,
  scrollRowForActiveTab,
  TAB_BAR_PRESET_LAYOUTS,
  tabBarRowsLayout,
  type TabBarLayoutMode,
  type TabBarPresetLayoutMode
} from '../../utils/tab-bar-layout'
import { switchTabShortcutKey } from '../../utils/tab-shortcuts'
import { formatAcceleratorDisplay } from '../../utils/shortcut-display'
import type { UpdaterStatus } from '../../types/electron.d.ts'
import './TabBar.css'
import { PromptLeaderIndicator } from '../PromptNotebook/PromptLeaderIndicator'

interface ConfirmDialogState {
  isOpen: boolean
  tabId: string
  tabName: string
}

type TabBarPopover = 'layout' | 'all' | null

interface PopoverCoords {
  top: number
  right: number
}

const LAYOUT_OPTION_COPY: Record<TabBarPresetLayoutMode, { labelKey: TranslationKey; descKey: TranslationKey; shortKey: TranslationKey }> = {
  scroll: {
    labelKey: 'tabBar.layout.scroll',
    descKey: 'tabBar.layout.scrollDesc',
    shortKey: 'tabBar.layout.scrollShort'
  },
  'rows-2': {
    labelKey: 'tabBar.layout.rows2',
    descKey: 'tabBar.layout.rows2Desc',
    shortKey: 'tabBar.layout.rows2'
  },
  'rows-3': {
    labelKey: 'tabBar.layout.rows3',
    descKey: 'tabBar.layout.rows3Desc',
    shortKey: 'tabBar.layout.rows3'
  },
  'rows-4': {
    labelKey: 'tabBar.layout.rows4',
    descKey: 'tabBar.layout.rows4Desc',
    shortKey: 'tabBar.layout.rows4'
  }
}

const MAC_TRAFFIC_LIGHTS_WIDTH = 78
const RIGHT_SLOT_MIN_WIDTH = 68
const MULTI_ROW_VSCROLL_RAIL_WIDTH = 16
const WHEEL_STEP_THRESHOLD_PX = 32

function formatShortcutForPlatform(accelerator: string | null | undefined, platform: string): string | null {
  const formatted = formatAcceleratorDisplay(accelerator, platform)
  return formatted || null
}

export function TabBar() {
  const { t } = useI18n()
  const {
    state,
    createTab,
    closeTab,
    switchTab,
    renameTab,
    reorderTabs,
    getTabDisplayName,
    hasRunningTerminals
  } = useAppState()
  const { settings, updateTabBarLayout } = useSettings()
  const tabBarLayout = normalizeTabBarLayout(settings?.tabBarLayout)
  const isMultiRow = isMultiRowTabBarLayout(tabBarLayout)
  const maxRows = getTabBarMaxRows(tabBarLayout)
  const isCustomRowsActive = !isPresetTabBarLayout(tabBarLayout)

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    tabId: '',
    tabName: ''
  })
  const [appName, setAppName] = useState('Onward 2')
  const [updateStatus, setUpdateStatus] = useState<UpdaterStatus | null>(null)
  const [isRestartingForUpdate, setIsRestartingForUpdate] = useState(false)
  const [threadpoolStalled, setThreadpoolStalled] = useState(false)
  const [stallBannerDismissed, setStallBannerDismissed] = useState(false)
  const [isRelaunchingForRecovery, setIsRelaunchingForRecovery] = useState(false)
  const [gpuFallbackActive, setGpuFallbackActive] = useState(false)
  const [gpuFallbackBannerDismissed, setGpuFallbackBannerDismissed] = useState(false)
  const [previousSessionNotice, setPreviousSessionNotice] = useState<{
    kind: 'abnormal' | 'corrupt' | 'terminated-jobs'
    terminatedActiveJobs: number
    lastSeenAt: string | null
  } | null>(null)
  const [previousSessionNoticeDismissed, setPreviousSessionNoticeDismissed] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [scrollState, setScrollState] = useState({ hasOverflow: false, canLeft: false, canRight: false })
  const [openPopover, setOpenPopover] = useState<TabBarPopover>(null)
  const [popoverCoords, setPopoverCoords] = useState<PopoverCoords>({ top: 42, right: 12 })
  const [allTabsQuery, setAllTabsQuery] = useState('')
  const [allTabsHighlighted, setAllTabsHighlighted] = useState(0)
  const [customRowsMemory, setCustomRowsMemory] = useState<number>(
    isCustomRowsActive ? maxRows : DEFAULT_CUSTOM_TAB_BAR_ROWS
  )
  const [customRowsInputText, setCustomRowsInputText] = useState<string | null>(null)
  const [multiRowCaps, setMultiRowCaps] = useState({ row1Capacity: 6, fullRowCapacity: 10 })
  const [multiRowScrollRow, setMultiRowScrollRow] = useState(0)

  const tabBarRef = useRef<HTMLDivElement>(null)
  const titleClusterRef = useRef<HTMLDivElement>(null)
  const actionsClusterRef = useRef<HTMLDivElement>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const layoutBtnRef = useRef<HTMLButtonElement>(null)
  const allTabsBtnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const allTabsSearchRef = useRef<HTMLInputElement>(null)
  const wheelDeltaRef = useRef(0)
  const wheelResetTimerRef = useRef<number | null>(null)

  const platform = window.electronAPI.platform

  useEffect(() => {
    if (isCustomRowsActive) {
      setCustomRowsMemory(maxRows)
    }
  }, [isCustomRowsActive, maxRows])

  const measureMultiRowCapacities = useCallback(() => {
    const barEl = tabBarRef.current
    if (!barEl) return
    const barWidth = barEl.clientWidth
    if (barWidth <= 0) return
    const leftFixed = platform === 'darwin' ? MAC_TRAFFIC_LIGHTS_WIDTH : 0
    const titleWidth = titleClusterRef.current?.offsetWidth ?? 0
    const actionsWidth = actionsClusterRef.current?.offsetWidth ?? 96
    const row1Available = Math.max(0, barWidth - leftFixed - titleWidth - actionsWidth - RIGHT_SLOT_MIN_WIDTH)
    const fullAvailable = Math.max(0, barWidth - MULTI_ROW_VSCROLL_RAIL_WIDTH)
    const next = computeMultiRowCapacities(row1Available, fullAvailable)
    setMultiRowCaps(prev => (
      prev.row1Capacity === next.row1Capacity && prev.fullRowCapacity === next.fullRowCapacity
        ? prev
        : next
    ))
  }, [platform])

  useEffect(() => {
    if (!isMultiRow) return
    measureMultiRowCapacities()
    const barEl = tabBarRef.current
    if (!barEl || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      measureMultiRowCapacities()
    })
    observer.observe(barEl)
    if (titleClusterRef.current) observer.observe(titleClusterRef.current)
    if (actionsClusterRef.current) observer.observe(actionsClusterRef.current)
    return () => {
      observer.disconnect()
    }
  }, [isMultiRow, measureMultiRowCapacities, appName, state.tabs.length])

  const multiRowSlice = useMemo(() => {
    if (!isMultiRow) return null
    return computeMultiRowTabSlice(
      state.tabs.length,
      maxRows,
      multiRowCaps.row1Capacity,
      multiRowCaps.fullRowCapacity,
      multiRowScrollRow
    )
  }, [isMultiRow, state.tabs.length, maxRows, multiRowCaps.row1Capacity, multiRowCaps.fullRowCapacity, multiRowScrollRow])

  const hasExtraRows = Boolean(multiRowSlice && multiRowSlice.extraRows.length > 0)

  // Keep the active tab in view in multi-row mode whenever active tab, tab count, layout, or geometry changes.
  useEffect(() => {
    if (!isMultiRow) {
      setMultiRowScrollRow(0)
      return
    }
    const activeIndex = state.tabs.findIndex(tab => tab.id === state.activeTabId)
    setMultiRowScrollRow(prev => scrollRowForActiveTab(
      activeIndex,
      prev,
      state.tabs.length,
      maxRows,
      multiRowCaps.row1Capacity,
      multiRowCaps.fullRowCapacity
    ))
  }, [isMultiRow, state.activeTabId, state.tabs, maxRows, multiRowCaps.row1Capacity, multiRowCaps.fullRowCapacity])

  useEffect(() => () => {
    if (wheelResetTimerRef.current !== null) {
      window.clearTimeout(wheelResetTimerRef.current)
    }
  }, [])

  const syncScrollIndicators = useCallback(() => {
    const el = tabListRef.current
    if (!el || isMultiRow) {
      setScrollState(prev => (prev.hasOverflow || prev.canLeft || prev.canRight)
        ? { hasOverflow: false, canLeft: false, canRight: false }
        : prev)
      return
    }
    const hasOverflow = el.scrollWidth > el.clientWidth + 2
    const canLeft = hasOverflow && el.scrollLeft > 2
    const canRight = hasOverflow && (el.scrollLeft + el.clientWidth < el.scrollWidth - 2)
    setScrollState(prev => (
      prev.hasOverflow === hasOverflow && prev.canLeft === canLeft && prev.canRight === canRight
        ? prev
        : { hasOverflow, canLeft, canRight }
    ))
  }, [isMultiRow])

  useEffect(() => {
    const el = tabListRef.current
    if (!el) return
    syncScrollIndicators()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      syncScrollIndicators()
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [syncScrollIndicators, state.tabs.length, tabBarLayout])

  // Keep the active tab visible after tab creation, shortcut switch, or layout change in scroll mode.
  useEffect(() => {
    if (isMultiRow) return
    const listEl = tabListRef.current
    if (!listEl || !state.activeTabId) return
    const activeEl = listEl.querySelector<HTMLElement>(`.tab-item[data-tab-id="${CSS.escape(state.activeTabId)}"]`)
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
    }
    syncScrollIndicators()
  }, [isMultiRow, state.activeTabId, state.tabs.length, tabBarLayout, syncScrollIndicators])

  const computePopoverCoords = useCallback((anchor: HTMLElement | null): PopoverCoords => {
    if (!anchor) return { top: 42, right: 12 }
    const rect = anchor.getBoundingClientRect()
    const right = Math.max(8, Math.round(window.innerWidth - rect.right))
    const top = Math.round(rect.bottom + 6)
    return { top, right }
  }, [])

  const closePopover = useCallback(() => {
    setOpenPopover(prev => {
      if (prev === 'all') {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_TAB_ALL_LIST_TOGGLED, {
          action: 'close',
          tabCount: state.tabs.length
        })
      }
      return null
    })
  }, [state.tabs.length])

  useModalEscape(openPopover !== null, closePopover, 'tab-bar-popover')

  const openPopoverAnchored = useCallback((kind: Exclude<TabBarPopover, null>, source: 'button' | 'shortcut') => {
    const anchor = kind === 'layout' ? layoutBtnRef.current : allTabsBtnRef.current
    setPopoverCoords(computePopoverCoords(anchor))
    setOpenPopover(prev => {
      const next = source === 'shortcut' ? kind : (prev === kind ? null : kind)
      if (kind === 'all') {
        perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_TAB_ALL_LIST_TOGGLED, {
          action: next === 'all' ? 'open' : 'close',
          source,
          tabCount: state.tabs.length
        })
      }
      if (next === 'all') {
        setAllTabsQuery('')
        const activeIdx = state.tabs.findIndex(tab => tab.id === state.activeTabId)
        setAllTabsHighlighted(activeIdx >= 0 ? activeIdx : 0)
      }
      return next
    })
  }, [computePopoverCoords, state.activeTabId, state.tabs])

  // Global shortcut `searchTabs` opens the All-Tabs searchable popover.
  useEffect(() => {
    const onSearchOpen = () => {
      openPopoverAnchored('all', 'shortcut')
    }
    window.addEventListener('onward:tab-bar-search-open', onSearchOpen)
    return () => {
      window.removeEventListener('onward:tab-bar-search-open', onSearchOpen)
    }
  }, [openPopoverAnchored])

  useEffect(() => {
    if (openPopover === 'all') {
      requestAnimationFrame(() => {
        allTabsSearchRef.current?.focus()
        allTabsSearchRef.current?.select()
      })
    }
  }, [openPopover])

  // Dismiss popovers on outside click or window resize.
  useEffect(() => {
    if (!openPopover) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (
        popoverRef.current?.contains(target) ||
        layoutBtnRef.current?.contains(target) ||
        allTabsBtnRef.current?.contains(target)
      ) {
        return
      }
      closePopover()
    }
    const onResize = () => {
      const anchor = openPopover === 'layout' ? layoutBtnRef.current : allTabsBtnRef.current
      setPopoverCoords(computePopoverCoords(anchor))
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('resize', onResize)
    }
  }, [openPopover, closePopover, computePopoverCoords])

  useEffect(() => {
    let isActive = true
    window.electronAPI.appInfo.get()
      .then((info) => {
        if (isActive && info?.displayName) {
          setAppName(info.displayName)
        }
      })
      .catch(() => {})
    return () => {
      isActive = false
    }
  }, [])

  useEffect(() => {
    let isActive = true
    window.electronAPI.updater.getStatus()
      .then((status) => {
        if (isActive) {
          setUpdateStatus(status)
        }
      })
      .catch(() => {})

    const unsubscribe = window.electronAPI.updater.onStatusChanged((status) => {
      setUpdateStatus(status)
    })

    return () => {
      isActive = false
      unsubscribe()
    }
  }, [])

  // Threadpool-watchdog banner: the main process broadcasts when its libuv
  // threadpool stalls (async fs/dns dead until restart — terminal input,
  // log generation and update checks are all degraded). Restarting kills
  // running shells, so the banner only *offers* the restart.
  useEffect(() => {
    const unsubscribe = window.electronAPI.system?.onThreadpoolHealthChanged?.((info) => {
      setThreadpoolStalled(info.status === 'stalled')
      if (info.status !== 'stalled') {
        setStallBannerDismissed(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [])

  // GPU-crash sticky-fallback banner: the terminal session manager blew
  // the session fuse (2nd GPU crash) and switched terminals to the DOM
  // renderer. Renderer-local signal — no IPC involved.
  useEffect(() => {
    const onGpuFallback = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail
      setGpuFallbackActive(Boolean(detail?.active))
    }
    window.addEventListener('onward:gpu-renderer-fallback', onGpuFallback)
    return () => {
      window.removeEventListener('onward:gpu-renderer-fallback', onGpuFallback)
    }
  }, [])

  // Previous-session notice (session ledger): the last instance either died
  // without a clean-shutdown mark, or its quit knowingly terminated running
  // tasks. One-shot query at mount; dismiss is session-local.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI?.system
      ?.getPreviousSessionNotice?.()
      .then((notice) => {
        if (!cancelled && notice) setPreviousSessionNotice(notice)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const highlightName = appName.startsWith('Onward') ? 'Onward' : null
  const restName = highlightName ? appName.slice(highlightName.length) : appName
  const showStallBanner = threadpoolStalled && !stallBannerDismissed
  const showGpuFallbackBanner = !showStallBanner && gpuFallbackActive && !gpuFallbackBannerDismissed
  // Infrastructure degradation outranks the update banner; never stack any two.
  const showUpdateBanner = !showStallBanner && !showGpuFallbackBanner && updateStatus?.phase === 'downloaded' && !updateStatus.bannerDismissed
  // Lowest banner priority: informational, shown only when nothing else is.
  const showPreviousSessionBanner =
    !showStallBanner && !showGpuFallbackBanner && !showUpdateBanner &&
    previousSessionNotice !== null && !previousSessionNoticeDismissed
  const installableVersion = updateStatus?.phase === 'downloaded' ? updateStatus.targetVersion : null

  const filteredAllTabs = useMemo(() => {
    const query = allTabsQuery.trim().toLocaleLowerCase()
    return state.tabs
      .map((tab, index) => ({
        tab,
        index,
        displayName: getTabDisplayName(tab, index),
        shortcutDisplay: formatShortcutForPlatform(settings?.shortcuts[switchTabShortcutKey(index + 1)], platform)
      }))
      .filter(entry => {
        if (!query) return true
        return (
          entry.displayName.toLocaleLowerCase().includes(query) ||
          String(entry.index + 1).includes(query)
        )
      })
  }, [allTabsQuery, state.tabs, getTabDisplayName, settings?.shortcuts, platform])

  useEffect(() => {
    setAllTabsHighlighted(prev => {
      if (filteredAllTabs.length === 0) return 0
      return Math.min(prev, filteredAllTabs.length - 1)
    })
  }, [filteredAllTabs.length])

  const handleRelaunchForRecovery = useCallback(async () => {
    setIsRelaunchingForRecovery(true)
    try {
      const result = await window.electronAPI.system.relaunchApp()
      if (!result.success) {
        setIsRelaunchingForRecovery(false)
      }
    } catch {
      setIsRelaunchingForRecovery(false)
    }
  }, [])

  const handleRestartToUpdate = useCallback(async () => {
    setIsRestartingForUpdate(true)
    try {
      const result = await window.electronAPI.updater.restartToUpdate()
      if (!result.success) {
        setIsRestartingForUpdate(false)
      }
    } catch {
      setIsRestartingForUpdate(false)
    }
  }, [])

  const handleDismissUpdateBanner = useCallback(async () => {
    try {
      const status = await window.electronAPI.updater.dismissBanner()
      setUpdateStatus(status)
    } catch {
      // ignore dismiss failures
    }
  }, [])

  const handleCloseTab = (tabId: string, tabIndex: number) => {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    // If there is a running terminal, display a confirmation dialog box
    if (hasRunningTerminals(tabId)) {
      setConfirmDialog({
        isOpen: true,
        tabId,
        tabName: getTabDisplayName(tab, tabIndex)
      })
      return
    }

    closeTab(tabId)
  }

  // Handle drag start
  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index)
  }, [])

  // Handling drag-and-drop entry
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }, [draggedIndex])

  // Handle drag and leave
  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null)
  }, [])

  // Handle placement
  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderTabs(draggedIndex, toIndex)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [draggedIndex, reorderTabs])

  // Process drag end
  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [])

  const handleConfirmClose = () => {
    closeTab(confirmDialog.tabId)
    setConfirmDialog({ isOpen: false, tabId: '', tabName: '' })
  }

  const handleCancelClose = useCallback(() => {
    setConfirmDialog({ isOpen: false, tabId: '', tabName: '' })
  }, [])

  useModalEscape(confirmDialog.isOpen, handleCancelClose, 'tab-close-confirm')

  const handleTabListWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (isMultiRow) return
    const el = tabListRef.current
    if (!el || el.scrollWidth <= el.clientWidth + 1) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY
      syncScrollIndicators()
    }
  }, [isMultiRow, syncScrollIndicators])

  const stepMultiRowScroll = useCallback((deltaRows: number) => {
    if (!multiRowSlice || !multiRowSlice.hasOverflow) return
    setMultiRowScrollRow(prev => Math.max(0, Math.min(multiRowSlice.maxScrollRow, prev + deltaRows)))
  }, [multiRowSlice])

  const handleMultiRowWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!isMultiRow || !multiRowSlice || !multiRowSlice.hasOverflow) return
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
    if ((e.deltaY < 0 && !multiRowSlice.canScrollUp) || (e.deltaY > 0 && !multiRowSlice.canScrollDown)) {
      wheelDeltaRef.current = 0
      return
    }
    wheelDeltaRef.current += e.deltaY
    if (wheelResetTimerRef.current !== null) {
      window.clearTimeout(wheelResetTimerRef.current)
    }
    wheelResetTimerRef.current = window.setTimeout(() => {
      wheelDeltaRef.current = 0
      wheelResetTimerRef.current = null
    }, 180)
    if (Math.abs(wheelDeltaRef.current) >= WHEEL_STEP_THRESHOLD_PX) {
      const steps = Math.trunc(wheelDeltaRef.current / WHEEL_STEP_THRESHOLD_PX)
      wheelDeltaRef.current -= steps * WHEEL_STEP_THRESHOLD_PX
      stepMultiRowScroll(steps)
    }
  }, [isMultiRow, multiRowSlice, stepMultiRowScroll])

  const handleVScrollTrackClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!multiRowSlice || !multiRowSlice.hasOverflow) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.height <= 0) return
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    setMultiRowScrollRow(Math.round(ratio * multiRowSlice.maxScrollRow))
  }, [multiRowSlice])

  const handleVScrollThumbMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!multiRowSlice || !multiRowSlice.hasOverflow) return
    e.preventDefault()
    e.stopPropagation()
    const track = e.currentTarget.parentElement
    if (!track) return
    const trackRect = track.getBoundingClientRect()
    const maxScroll = multiRowSlice.maxScrollRow
    const updateFromClientY = (clientY: number) => {
      if (trackRect.height <= 0) return
      const ratio = Math.max(0, Math.min(1, (clientY - trackRect.top) / trackRect.height))
      setMultiRowScrollRow(Math.round(ratio * maxScroll))
    }
    const onMove = (moveEvent: MouseEvent) => updateFromClientY(moveEvent.clientY)
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [multiRowSlice])

  const scrollTabsBy = useCallback((delta: number) => {
    const el = tabListRef.current
    if (!el) return
    el.scrollLeft += delta
    syncScrollIndicators()
  }, [syncScrollIndicators])

  const handleSelectFromAllTabs = useCallback((tabId: string) => {
    if (tabId !== state.activeTabId) {
      perfTrace(PERF_TRACE_EVENT.RENDERER_TAB_SWITCH, {
        fromActive: 1,
        tabCount: state.tabs.length
      })
    }
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_TAB_ALL_LIST_TOGGLED, {
      action: 'select',
      tabCount: state.tabs.length
    })
    switchTab(tabId)
    setOpenPopover(null)
  }, [state.activeTabId, state.tabs.length, switchTab])

  const applyCustomRowCount = useCallback((rawRows: number) => {
    const clamped = clampTabBarRows(rawRows)
    setCustomRowsMemory(clamped)
    setCustomRowsInputText(null)
    updateTabBarLayout(tabBarRowsLayout(clamped), 'tab-bar')
  }, [updateTabBarLayout])

  const renderTabNode = (tab: (typeof state.tabs)[number], absoluteIndex: number) => (
    <TabItem
      key={tab.id}
      tabId={tab.id}
      tabIndex={absoluteIndex + 1}
      name={getTabDisplayName(tab, absoluteIndex)}
      customName={tab.customName}
      shortcutDisplay={formatShortcutForPlatform(
        settings?.shortcuts[switchTabShortcutKey(absoluteIndex + 1)],
        platform
      )}
      isActive={tab.id === state.activeTabId}
      isOnly={state.tabs.length === 1}
      isDragOver={dragOverIndex === absoluteIndex}
      isDragging={draggedIndex === absoluteIndex}
      onSelect={() => {
        if (tab.id !== state.activeTabId) {
          perfTrace(PERF_TRACE_EVENT.RENDERER_TAB_SWITCH, {
            fromActive: state.activeTabId === tab.id ? 0 : 1,
            tabCount: state.tabs.length
          })
        }
        switchTab(tab.id)
      }}
      onClose={() => handleCloseTab(tab.id, absoluteIndex)}
      onRename={(customName) => renameTab(tab.id, customName)}
      onDragStart={() => handleDragStart(absoluteIndex)}
      onDragOver={(e) => handleDragOver(e, absoluteIndex)}
      onDragLeave={handleDragLeave}
      onDrop={(e) => handleDrop(e, absoluteIndex)}
      onDragEnd={handleDragEnd}
    />
  )

  const currentLayoutLabel = isPresetTabBarLayout(tabBarLayout)
    ? t(LAYOUT_OPTION_COPY[tabBarLayout].labelKey)
    : t('tabBar.layout.customShort', { rows: String(maxRows) })

  const row1Tabs = isMultiRow && multiRowSlice
    ? state.tabs.slice(multiRowSlice.row1Start, multiRowSlice.row1End).map((tab, offset) => ({
        tab,
        index: multiRowSlice.row1Start + offset
      }))
    : state.tabs.map((tab, index) => ({ tab, index }))

  const tabBarClassName = [
    'tab-bar',
    `platform-${platform}`,
    isMultiRow ? 'tab-bar--multi-row' : 'tab-bar--scroll',
    hasExtraRows ? 'tab-bar--has-extra-rows' : '',
    `tab-bar--${tabBarLayout}`
  ].filter(Boolean).join(' ')

  const vScrollThumbPct = multiRowSlice && multiRowSlice.hasOverflow
    ? Math.max(20, Math.round((maxRows / Math.max(maxRows, multiRowSlice.totalVirtualRows)) * 100))
    : 100
  const vScrollThumbTopPct = multiRowSlice && multiRowSlice.maxScrollRow > 0
    ? Math.round((multiRowSlice.scrollRow / multiRowSlice.maxScrollRow) * (100 - vScrollThumbPct))
    : 0

  return (
    <>
      <div
        ref={tabBarRef}
        className={tabBarClassName}
        data-tab-bar-layout={tabBarLayout}
        data-tab-bar-max-rows={maxRows}
        data-tab-bar-extra-rows={multiRowSlice?.extraRows.length ?? 0}
        data-tab-bar-scroll-row={multiRowSlice?.scrollRow ?? 0}
        onWheel={handleMultiRowWheel}
      >
        {/* Top row: traffic lights + title/banners + Row 1 tabs + pinned actions + leader indicator */}
        <div className="tab-bar-top-row">
          {/* Left placeholder: macOS window button */}
          <div className="tab-bar-left">
            <div className="tab-bar-traffic-lights" />
          </div>

          {/* Middle area: LOGO + Row 1 Tab list + pinned controls */}
          <div className="tab-bar-center">
            <div ref={titleClusterRef} className="tab-bar-title-cluster">
              {/* Application title */}
              <div className="tab-bar-title">
                {highlightName ? (
                  <span className="app-name"><span className="app-name-highlight">{highlightName}</span>{restName}</span>
                ) : (
                  <span className="app-name">{appName}</span>
                )}
                {installableVersion && (
                  <span className="tab-bar-installable-version">
                    {t('tabBar.updateReady.installableVersion', { version: installableVersion })}
                  </span>
                )}
              </div>

              {showStallBanner && (
                <div className="tab-bar-update-banner tab-bar-stall-banner" role="alert" aria-live="assertive">
                  <span className="tab-bar-update-text">
                    {t('tabBar.threadpoolStall.message')}
                  </span>
                  <button
                    className="tab-bar-update-action"
                    type="button"
                    onClick={handleRelaunchForRecovery}
                    disabled={isRelaunchingForRecovery}
                    title={t('tabBar.threadpoolStall.restart')}
                  >
                    {isRelaunchingForRecovery ? t('tabBar.threadpoolStall.restarting') : t('tabBar.threadpoolStall.restart')}
                  </button>
                  <button
                    className="tab-bar-update-close"
                    type="button"
                    onClick={() => setStallBannerDismissed(true)}
                    title={t('tabBar.threadpoolStall.dismiss')}
                    aria-label={t('tabBar.threadpoolStall.dismiss')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <line x1="9" y1="3" x2="3" y2="9" />
                      <line x1="3" y1="3" x2="9" y2="9" />
                    </svg>
                  </button>
                </div>
              )}

              {showGpuFallbackBanner && (
                <div className="tab-bar-update-banner tab-bar-stall-banner" role="alert" aria-live="assertive" data-testid="gpu-fallback-banner">
                  <span className="tab-bar-update-text">
                    {t('tabBar.gpuFallback.message')}
                  </span>
                  <button
                    className="tab-bar-update-action"
                    type="button"
                    onClick={handleRelaunchForRecovery}
                    disabled={isRelaunchingForRecovery}
                    title={t('tabBar.gpuFallback.restart')}
                  >
                    {isRelaunchingForRecovery ? t('tabBar.gpuFallback.restarting') : t('tabBar.gpuFallback.restart')}
                  </button>
                  <button
                    className="tab-bar-update-close"
                    type="button"
                    onClick={() => setGpuFallbackBannerDismissed(true)}
                    title={t('tabBar.gpuFallback.dismiss')}
                    aria-label={t('tabBar.gpuFallback.dismiss')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <line x1="9" y1="3" x2="3" y2="9" />
                      <line x1="3" y1="3" x2="9" y2="9" />
                    </svg>
                  </button>
                </div>
              )}

              {showPreviousSessionBanner && previousSessionNotice && (
                <div className="tab-bar-update-banner" role="status" aria-live="polite" data-testid="previous-session-banner">
                  <span className="tab-bar-update-text">
                    {previousSessionNotice.kind === 'terminated-jobs'
                      ? t('tabBar.previousSession.terminatedJobs', {
                          count: String(previousSessionNotice.terminatedActiveJobs)
                        })
                      : t('tabBar.previousSession.abnormal')}
                  </span>
                  <button
                    className="tab-bar-update-close"
                    type="button"
                    onClick={() => setPreviousSessionNoticeDismissed(true)}
                    title={t('tabBar.previousSession.dismiss')}
                    aria-label={t('tabBar.previousSession.dismiss')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <line x1="9" y1="3" x2="3" y2="9" />
                      <line x1="3" y1="3" x2="9" y2="9" />
                    </svg>
                  </button>
                </div>
              )}

              {showUpdateBanner && (
                <div className="tab-bar-update-banner" role="status" aria-live="polite">
                  <span className="tab-bar-update-text">
                    {t('tabBar.updateReady.message', { version: updateStatus?.targetVersion || '' })}
                  </span>
                  <button
                    className="tab-bar-update-action"
                    type="button"
                    onClick={handleRestartToUpdate}
                    disabled={isRestartingForUpdate}
                    title={t('tabBar.updateReady.restart')}
                  >
                    {isRestartingForUpdate ? t('tabBar.updateReady.restarting') : t('tabBar.updateReady.restart')}
                  </button>
                  <button
                    className="tab-bar-update-close"
                    type="button"
                    onClick={handleDismissUpdateBanner}
                    title={t('tabBar.updateReady.dismiss')}
                    aria-label={t('tabBar.updateReady.dismiss')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
                      <line x1="9" y1="3" x2="3" y2="9" />
                      <line x1="3" y1="3" x2="9" y2="9" />
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Row 1 tab list (horizontal scroll in scroll mode; grid-filled first row in multi-row mode) */}
            <div className="tab-list-shell">
              {!isMultiRow && scrollState.hasOverflow && (
                <button
                  type="button"
                  className="tab-scroll-btn tab-scroll-btn--left"
                  data-testid="tab-bar-scroll-left"
                  onClick={() => scrollTabsBy(-220)}
                  disabled={!scrollState.canLeft}
                  title={t('tabBar.scrollLeft')}
                  aria-label={t('tabBar.scrollLeft')}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="7.5 2.5 4 6 7.5 9.5" />
                  </svg>
                </button>
              )}

              <div className="tab-list-viewport">
                {!isMultiRow && scrollState.canLeft && (
                  <div className="tab-list-fade tab-list-fade--left" aria-hidden="true" />
                )}
                <div
                  ref={tabListRef}
                  className={`tab-list${hasExtraRows ? ' tab-list--grid-row1' : ''}`}
                  style={hasExtraRows ? { gridTemplateColumns: `repeat(${multiRowCaps.row1Capacity}, minmax(0, 1fr))` } : undefined}
                  onScroll={syncScrollIndicators}
                  onWheel={handleTabListWheel}
                >
                  {row1Tabs.map(({ tab, index }) => renderTabNode(tab, index))}
                </div>
                {!isMultiRow && scrollState.canRight && (
                  <div className="tab-list-fade tab-list-fade--right" aria-hidden="true" />
                )}
              </div>

              {!isMultiRow && scrollState.hasOverflow && (
                <button
                  type="button"
                  className="tab-scroll-btn tab-scroll-btn--right"
                  data-testid="tab-bar-scroll-right"
                  onClick={() => scrollTabsBy(220)}
                  disabled={!scrollState.canRight}
                  title={t('tabBar.scrollRight')}
                  aria-label={t('tabBar.scrollRight')}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4.5 2.5 8 6 4.5 9.5" />
                  </svg>
                </button>
              )}
            </div>

            {/* Pinned right-side actions: New Tab + Layout Switcher + All Tabs List */}
            <div ref={actionsClusterRef} className="tab-bar-actions">
              <button
                type="button"
                className="tab-add-btn"
                onClick={() => {
                  perfTrace(PERF_TRACE_EVENT.RENDERER_TAB_CREATE, {
                    tabCountBefore: state.tabs.length
                  })
                  createTab()
                }}
                title={t('tabBar.newTab')}
                aria-label={t('tabBar.newTab')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M7.5 3v3.5H11v1H7.5V11h-1V7.5H3v-1h3.5V3h1z" />
                </svg>
              </button>

              <button
                ref={layoutBtnRef}
                type="button"
                className={`tab-bar-tool-btn${openPopover === 'layout' || isMultiRow ? ' is-active' : ''}`}
                data-testid="tab-bar-layout-btn"
                aria-haspopup="menu"
                aria-expanded={openPopover === 'layout'}
                title={`${t('tabBar.layout.buttonTitle')} (${currentLayoutLabel})`}
                aria-label={t('tabBar.layout.buttonTitle')}
                onClick={() => openPopoverAnchored('layout', 'button')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  {isMultiRow ? (
                    <>
                      <rect x="2" y="2.5" width="12" height="2.4" rx="0.8" />
                      <rect x="2" y="6.8" width="12" height="2.4" rx="0.8" />
                      <rect x="2" y="11.1" width="8.5" height="2.4" rx="0.8" />
                    </>
                  ) : (
                    <>
                      <rect x="2" y="3" width="12" height="3" rx="0.9" />
                      <path d="M4.5 11h7M6.3 9.2 4.5 11l1.8 1.8M9.7 9.2 11.5 11l-1.8 1.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                    </>
                  )}
                </svg>
              </button>

              <button
                ref={allTabsBtnRef}
                type="button"
                className={`tab-bar-tool-btn tab-bar-all-btn${openPopover === 'all' ? ' is-active' : ''}`}
                data-testid="tab-bar-all-btn"
                aria-haspopup="dialog"
                aria-expanded={openPopover === 'all'}
                title={t('tabBar.allTabs.buttonTitle')}
                aria-label={t('tabBar.allTabs.buttonTitle')}
                onClick={() => openPopoverAnchored('all', 'button')}
              >
                <span className="tab-bar-all-count">{state.tabs.length}</span>
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2.5 4.5 6 8 9.5 4.5" />
                </svg>
              </button>
            </div>
          </div>

          {/* Right placeholder: drag area */}
          <div className="tab-bar-right">
            <div className="tab-bar-drag-region" />
            <PromptLeaderIndicator />
          </div>
        </div>

        {/* Full-width multi-row expansion area (fills under both title and right controls) */}
        {isMultiRow && multiRowSlice && multiRowSlice.extraRows.length > 0 && (
          <div className="tab-bar-extra-area" data-testid="tab-bar-extra-area">
            <div className="tab-bar-extra-rows">
              {multiRowSlice.extraRows.map((rowSlice, rowIdx) => (
                <div
                  key={`extra-row-${rowIdx}`}
                  className="tab-bar-extra-row"
                  data-testid={`tab-bar-extra-row-${rowIdx + 2}`}
                  style={{ gridTemplateColumns: `repeat(${multiRowCaps.fullRowCapacity}, minmax(0, 1fr))` }}
                >
                  {state.tabs.slice(rowSlice.start, rowSlice.end).map((tab, offset) =>
                    renderTabNode(tab, rowSlice.start + offset)
                  )}
                </div>
              ))}
            </div>

            {multiRowSlice.hasOverflow && (
              <div className="tab-bar-vscroll-rail" data-testid="tab-bar-vscroll-rail">
                <button
                  type="button"
                  className="tab-bar-vscroll-btn"
                  data-testid="tab-bar-scroll-up"
                  disabled={!multiRowSlice.canScrollUp}
                  title={t('tabBar.layout.scrollUp')}
                  aria-label={t('tabBar.layout.scrollUp')}
                  onClick={() => stepMultiRowScroll(-1)}
                >
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2 6.5 5 3.5 8 6.5" />
                  </svg>
                </button>
                <div
                  className="tab-bar-vscroll-track"
                  data-testid="tab-bar-vscroll-track"
                  onClick={handleVScrollTrackClick}
                >
                  <div
                    className="tab-bar-vscroll-thumb"
                    data-testid="tab-bar-vscroll-thumb"
                    onMouseDown={handleVScrollThumbMouseDown}
                    style={{
                      height: `${vScrollThumbPct}%`,
                      top: `${vScrollThumbTopPct}%`
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="tab-bar-vscroll-btn"
                  data-testid="tab-bar-scroll-down"
                  disabled={!multiRowSlice.canScrollDown}
                  title={t('tabBar.layout.scrollDown')}
                  aria-label={t('tabBar.layout.scrollDown')}
                  onClick={() => stepMultiRowScroll(1)}
                >
                  <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="2 3.5 5 6.5 8 3.5" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Layout Switcher Popover */}
      {openPopover === 'layout' && (
        <div
          ref={popoverRef}
          className="tab-bar-popover tab-bar-layout-popover"
          data-testid="tab-bar-layout-popover"
          role="menu"
          aria-label={t('tabBar.layout.title')}
          style={{ top: `${popoverCoords.top}px`, right: `${popoverCoords.right}px` }}
        >
          <div className="tab-bar-popover-header">
            <span>{t('tabBar.layout.title')}</span>
          </div>
          <div className="tab-bar-layout-list">
            {TAB_BAR_PRESET_LAYOUTS.map(mode => {
              const selected = tabBarLayout === mode
              const copy = LAYOUT_OPTION_COPY[mode]
              return (
                <button
                  key={mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`tab-bar-layout-item${selected ? ' is-selected' : ''}`}
                  data-testid={`tab-bar-layout-option-${mode}`}
                  onClick={() => {
                    updateTabBarLayout(mode, 'tab-bar')
                    setOpenPopover(null)
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    {mode === 'scroll' && (
                      <>
                        <rect x="1.5" y="3" width="13" height="3" rx="0.8" />
                        <path d="M4 11h8M6 9l-2 2 2 2M10 9l2 2-2 2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                      </>
                    )}
                    {mode === 'rows-2' && (
                      <>
                        <rect x="1.5" y="3.5" width="13" height="3.2" rx="0.8" />
                        <rect x="1.5" y="9.3" width="13" height="3.2" rx="0.8" />
                      </>
                    )}
                    {mode === 'rows-3' && (
                      <>
                        <rect x="1.5" y="2.2" width="13" height="2.6" rx="0.7" />
                        <rect x="1.5" y="6.7" width="13" height="2.6" rx="0.7" />
                        <rect x="1.5" y="11.2" width="13" height="2.6" rx="0.7" />
                      </>
                    )}
                    {mode === 'rows-4' && (
                      <>
                        <rect x="1.5" y="1.6" width="13" height="2" rx="0.6" />
                        <rect x="1.5" y="5.1" width="13" height="2" rx="0.6" />
                        <rect x="1.5" y="8.6" width="13" height="2" rx="0.6" />
                        <rect x="1.5" y="12.1" width="13" height="2" rx="0.6" />
                      </>
                    )}
                  </svg>
                  <span className="tab-bar-layout-item-copy">
                    <span className="tab-bar-layout-item-name">{t(copy.labelKey)}</span>
                    <span className="tab-bar-layout-item-desc">{t(copy.descKey)}</span>
                  </span>
                  {selected && (
                    <svg className="tab-bar-layout-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
                    </svg>
                  )}
                </button>
              )
            })}

            <div className="tab-bar-popover-separator" />

            {/* Custom row count selector */}
            <div
              className={`tab-bar-layout-custom${isCustomRowsActive ? ' is-selected' : ''}`}
              data-testid="tab-bar-layout-option-custom"
            >
              <button
                type="button"
                className="tab-bar-layout-custom-main"
                onClick={() => applyCustomRowCount(customRowsMemory)}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <rect x="1.5" y="2" width="13" height="2" rx="0.6" />
                  <rect x="1.5" y="5.5" width="13" height="2" rx="0.6" />
                  <rect x="1.5" y="9" width="8" height="2" rx="0.6" />
                  <path d="M12.2 9.5v4.5M10 11.75h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span className="tab-bar-layout-item-copy">
                  <span className="tab-bar-layout-item-name">{t('tabBar.layout.custom')}</span>
                  <span className="tab-bar-layout-item-desc">
                    {t('tabBar.layout.customDesc', {
                      min: String(MIN_TAB_BAR_ROWS),
                      max: String(MAX_TAB_BAR_ROWS)
                    })}
                  </span>
                </span>
              </button>
              <div className="tab-bar-layout-custom-stepper" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="tab-bar-rows-step-btn"
                  data-testid="tab-bar-layout-custom-dec"
                  disabled={customRowsMemory <= MIN_TAB_BAR_ROWS}
                  aria-label="-"
                  onClick={() => applyCustomRowCount(customRowsMemory - 1)}
                >
                  −
                </button>
                <input
                  type="number"
                  className="tab-bar-rows-input"
                  data-testid="tab-bar-layout-custom-input"
                  min={MIN_TAB_BAR_ROWS}
                  max={MAX_TAB_BAR_ROWS}
                  value={customRowsInputText ?? String(customRowsMemory)}
                  aria-label={t('tabBar.layout.customInputLabel')}
                  onChange={(e) => {
                    const raw = e.target.value
                    setCustomRowsInputText(raw)
                    const parsed = Number.parseInt(raw, 10)
                    if (Number.isFinite(parsed) && parsed >= MIN_TAB_BAR_ROWS && parsed <= MAX_TAB_BAR_ROWS) {
                      setCustomRowsMemory(parsed)
                      updateTabBarLayout(tabBarRowsLayout(parsed), 'tab-bar')
                    }
                  }}
                  onBlur={(e) => {
                    if (customRowsInputText !== null) {
                      const parsed = Number.parseInt(e.target.value, 10)
                      if (Number.isFinite(parsed)) {
                        applyCustomRowCount(parsed)
                      } else {
                        setCustomRowsInputText(null)
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const parsed = Number.parseInt(e.currentTarget.value, 10)
                      if (Number.isFinite(parsed)) {
                        applyCustomRowCount(parsed)
                      } else {
                        setCustomRowsInputText(null)
                      }
                      setOpenPopover(null)
                    }
                  }}
                />
                <button
                  type="button"
                  className="tab-bar-rows-step-btn"
                  data-testid="tab-bar-layout-custom-inc"
                  disabled={customRowsMemory >= MAX_TAB_BAR_ROWS}
                  aria-label="+"
                  onClick={() => applyCustomRowCount(customRowsMemory + 1)}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating All-Tabs Searchable Popover */}
      {openPopover === 'all' && (
        <div
          ref={popoverRef}
          className="tab-bar-popover tab-bar-all-popover"
          data-testid="tab-bar-all-popover"
          role="dialog"
          aria-label={t('tabBar.allTabs.title', { count: String(state.tabs.length) })}
          style={{ top: `${popoverCoords.top}px`, right: `${popoverCoords.right}px` }}
        >
          <div className="tab-bar-popover-header">
            <span>{t('tabBar.allTabs.title', { count: String(state.tabs.length) })}</span>
          </div>
          <div className="tab-bar-all-search-wrap">
            <input
              ref={allTabsSearchRef}
              type="search"
              className="tab-bar-all-search"
              data-testid="tab-bar-all-search"
              value={allTabsQuery}
              placeholder={t('tabBar.allTabs.searchPlaceholder')}
              aria-label={t('tabBar.allTabs.searchPlaceholder')}
              onChange={(e) => {
                setAllTabsQuery(e.target.value)
                setAllTabsHighlighted(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && filteredAllTabs.length > 0) {
                  e.preventDefault()
                  setAllTabsHighlighted(prev => (prev + 1) % filteredAllTabs.length)
                } else if (e.key === 'ArrowUp' && filteredAllTabs.length > 0) {
                  e.preventDefault()
                  setAllTabsHighlighted(prev => (prev - 1 + filteredAllTabs.length) % filteredAllTabs.length)
                } else if (e.key === 'Enter' && filteredAllTabs[allTabsHighlighted]) {
                  e.preventDefault()
                  handleSelectFromAllTabs(filteredAllTabs[allTabsHighlighted].tab.id)
                }
              }}
            />
          </div>
          <div className="tab-bar-all-list">
            {filteredAllTabs.length > 0 ? filteredAllTabs.map((entry, idx) => {
              const isActive = entry.tab.id === state.activeTabId
              const isHighlighted = idx === allTabsHighlighted
              return (
                <button
                  key={entry.tab.id}
                  type="button"
                  className={`tab-bar-all-item${isActive ? ' is-active' : ''}${isHighlighted ? ' is-highlighted' : ''}`}
                  data-testid={`tab-bar-all-item-${entry.index + 1}`}
                  onMouseEnter={() => setAllTabsHighlighted(idx)}
                  onClick={() => handleSelectFromAllTabs(entry.tab.id)}
                >
                  <span className="tab-bar-all-index">{entry.index + 1}</span>
                  <span className="tab-bar-all-name">{entry.displayName}</span>
                  {entry.shortcutDisplay && (
                    <span className="tab-bar-all-shortcut">{entry.shortcutDisplay}</span>
                  )}
                </button>
              )
            }) : (
              <div className="tab-bar-all-empty" role="status">
                {t('tabBar.allTabs.empty')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Confirm to close dialog */}
      {confirmDialog.isOpen && (
        <div className="confirm-dialog-overlay">
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('tabBar.confirmClose.title', { tabName: confirmDialog.tabName })}</div>
            <div className="confirm-dialog-message">
              {t('tabBar.confirmClose.message')}
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelClose}>
                {t('common.cancel')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmClose}>
                {t('tabBar.confirmClose.action')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
