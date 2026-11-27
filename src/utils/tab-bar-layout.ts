/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const TAB_BAR_PRESET_LAYOUTS = ['scroll', 'rows-2', 'rows-3', 'rows-4'] as const
export type TabBarPresetLayoutMode = typeof TAB_BAR_PRESET_LAYOUTS[number]
export type TabBarRowsLayoutMode = `rows-${number}`
export type TabBarLayoutMode = 'scroll' | TabBarRowsLayoutMode

/** Kept for compatibility with preset UI iterators. */
export const TAB_BAR_LAYOUT_MODES: readonly TabBarPresetLayoutMode[] = TAB_BAR_PRESET_LAYOUTS

export const DEFAULT_TAB_BAR_LAYOUT: TabBarLayoutMode = 'scroll'

export const MIN_TAB_BAR_ROWS = 2
export const MAX_TAB_BAR_ROWS = 20
export const DEFAULT_CUSTOM_TAB_BAR_ROWS = 5

export const TAB_BAR_SINGLE_ROW_HEIGHT = 38
export const TAB_BAR_MULTI_ROW_HEIGHT = 32
export const TAB_BAR_MULTI_ROW_MIN_TAB_WIDTH = 116

const ROWS_LAYOUT_RE = /^rows-([1-9]\d*)$/

/** Parse a `rows-<N>` layout string into its bounded row count, or null if invalid. */
export function parseTabBarRowCount(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = ROWS_LAYOUT_RE.exec(value)
  if (!match) return null
  const rows = Number(match[1])
  if (!Number.isSafeInteger(rows) || rows < MIN_TAB_BAR_ROWS || rows > MAX_TAB_BAR_ROWS) {
    return null
  }
  return rows
}

/** Clamp a row count to [MIN_TAB_BAR_ROWS, MAX_TAB_BAR_ROWS] and format as `rows-<N>`. */
export function clampTabBarRows(rows: number): number {
  if (!Number.isFinite(rows)) return DEFAULT_CUSTOM_TAB_BAR_ROWS
  return Math.max(MIN_TAB_BAR_ROWS, Math.min(MAX_TAB_BAR_ROWS, Math.round(rows)))
}

export function tabBarRowsLayout(rows: number): TabBarRowsLayoutMode {
  return `rows-${clampTabBarRows(rows)}`
}

export function isTabBarLayoutMode(value: unknown): value is TabBarLayoutMode {
  return value === 'scroll' || parseTabBarRowCount(value) !== null
}

export function isPresetTabBarLayout(mode: TabBarLayoutMode): mode is TabBarPresetLayoutMode {
  return mode === 'scroll' || mode === 'rows-2' || mode === 'rows-3' || mode === 'rows-4'
}

export function normalizeTabBarLayout(value: unknown): TabBarLayoutMode {
  return isTabBarLayoutMode(value) ? value : DEFAULT_TAB_BAR_LAYOUT
}

export function getTabBarMaxRows(mode: TabBarLayoutMode): number {
  if (mode === 'scroll') return 1
  return parseTabBarRowCount(mode) ?? 2
}

export function isMultiRowTabBarLayout(mode: TabBarLayoutMode): boolean {
  return mode !== 'scroll'
}

/**
 * Maximum total tab height (px) for multi-row layouts (row 1 is 38px, each
 * additional full-width row is 32px); null in single-row scroll mode.
 */
export function getTabBarMaxListHeight(mode: TabBarLayoutMode): number | null {
  if (!isMultiRowTabBarLayout(mode)) return null
  return getTabBarMaxRows(mode) * TAB_BAR_MULTI_ROW_HEIGHT
}

/** Compute how many tabs fit in Row 1 (center slot) and each full-width extra row. */
export function computeMultiRowCapacities(
  row1AvailableWidth: number,
  fullRowAvailableWidth: number,
  minTabWidth = TAB_BAR_MULTI_ROW_MIN_TAB_WIDTH
): { row1Capacity: number; fullRowCapacity: number } {
  const safeMin = Math.max(64, Math.floor(minTabWidth))
  const row1Capacity = Math.max(1, Math.floor(Math.max(0, row1AvailableWidth) / safeMin))
  const fullRowCapacity = Math.max(row1Capacity, Math.floor(Math.max(0, fullRowAvailableWidth) / safeMin))
  return { row1Capacity, fullRowCapacity }
}

export interface MultiRowTabSlice {
  startIndex: number
  endIndex: number
  visibleCapacity: number
  row1Start: number
  row1End: number
  extraRows: Array<{ start: number; end: number }>
  scrollRow: number
  maxScrollRow: number
  stepSize: number
  canScrollUp: boolean
  canScrollDown: boolean
  hasOverflow: boolean
  totalVirtualRows: number
}

/**
 * Slice tabs across Row 1 (narrower, between title and controls) and Rows 2..maxRows
 * (full window width). Vertical scrolling steps by `row1Capacity` so the leading tabs
 * of Row 2 flow seamlessly into Row 1 in sequential order.
 */
export function computeMultiRowTabSlice(
  totalTabs: number,
  maxRows: number,
  row1Capacity: number,
  fullRowCapacity: number,
  scrollRow: number
): MultiRowTabSlice {
  const safeTotal = Math.max(0, Math.floor(totalTabs))
  const safeMaxRows = Math.max(MIN_TAB_BAR_ROWS, Math.floor(maxRows))
  const safeRow1Cap = Math.max(1, Math.floor(row1Capacity))
  const safeFullCap = Math.max(1, Math.floor(fullRowCapacity))

  const visibleCapacity = safeRow1Cap + (safeMaxRows - 1) * safeFullCap
  const maxStartIndex = Math.max(0, safeTotal - visibleCapacity)
  const stepSize = safeRow1Cap
  const maxScrollRow = maxStartIndex === 0 ? 0 : Math.ceil(maxStartIndex / stepSize)
  const clampedScrollRow = Math.max(0, Math.min(maxScrollRow, Math.floor(Number.isFinite(scrollRow) ? scrollRow : 0)))
  const startIndex = Math.min(maxStartIndex, clampedScrollRow * stepSize)
  const endIndex = Math.min(safeTotal, startIndex + visibleCapacity)

  const row1Start = startIndex
  const row1End = Math.min(endIndex, startIndex + safeRow1Cap)

  const extraRows: Array<{ start: number; end: number }> = []
  let cursor = row1End
  while (cursor < endIndex && extraRows.length < safeMaxRows - 1) {
    const nextEnd = Math.min(endIndex, cursor + safeFullCap)
    extraRows.push({ start: cursor, end: nextEnd })
    cursor = nextEnd
  }

  const totalVirtualRows = safeTotal <= safeRow1Cap
    ? 1
    : 1 + Math.ceil((safeTotal - safeRow1Cap) / safeFullCap)

  return {
    startIndex,
    endIndex,
    visibleCapacity,
    row1Start,
    row1End,
    extraRows,
    scrollRow: clampedScrollRow,
    maxScrollRow,
    stepSize,
    canScrollUp: clampedScrollRow > 0,
    canScrollDown: clampedScrollRow < maxScrollRow,
    hasOverflow: maxStartIndex > 0,
    totalVirtualRows
  }
}

/**
 * Compute the minimal scrollRow change needed to bring `activeIndex` into view.
 * Leaves `currentScrollRow` untouched when the active tab is already visible.
 */
export function scrollRowForActiveTab(
  activeIndex: number,
  currentScrollRow: number,
  totalTabs: number,
  maxRows: number,
  row1Capacity: number,
  fullRowCapacity: number
): number {
  const current = computeMultiRowTabSlice(totalTabs, maxRows, row1Capacity, fullRowCapacity, currentScrollRow)
  if (!current.hasOverflow || activeIndex < 0 || activeIndex >= totalTabs) {
    return current.scrollRow
  }
  if (activeIndex >= current.startIndex && activeIndex < current.endIndex) {
    return current.scrollRow
  }
  if (activeIndex < current.startIndex) {
    return Math.max(0, Math.floor(activeIndex / current.stepSize))
  }
  // Active tab is below the current viewport: find the earliest scroll row that includes it.
  const minRequiredStart = Math.max(0, activeIndex - current.visibleCapacity + 1)
  return Math.min(current.maxScrollRow, Math.ceil(minRequiredStart / current.stepSize))
}
