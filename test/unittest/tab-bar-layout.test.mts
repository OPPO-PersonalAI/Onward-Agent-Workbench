/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampTabBarRows,
  computeMultiRowCapacities,
  computeMultiRowTabSlice,
  DEFAULT_CUSTOM_TAB_BAR_ROWS,
  DEFAULT_TAB_BAR_LAYOUT,
  getTabBarMaxListHeight,
  getTabBarMaxRows,
  isMultiRowTabBarLayout,
  isPresetTabBarLayout,
  isTabBarLayoutMode,
  MAX_TAB_BAR_ROWS,
  MIN_TAB_BAR_ROWS,
  normalizeTabBarLayout,
  parseTabBarRowCount,
  scrollRowForActiveTab,
  TAB_BAR_LAYOUT_MODES,
  TAB_BAR_MULTI_ROW_HEIGHT,
  tabBarRowsLayout
} from '../../src/utils/tab-bar-layout.ts'

test('TBL-U01: layout mode guard and normalization accept presets and custom rows 2..20', () => {
  assert.deepEqual(TAB_BAR_LAYOUT_MODES, ['scroll', 'rows-2', 'rows-3', 'rows-4'])
  assert.equal(DEFAULT_TAB_BAR_LAYOUT, 'scroll')
  assert.equal(DEFAULT_CUSTOM_TAB_BAR_ROWS, 5)

  for (const mode of ['scroll', 'rows-2', 'rows-3', 'rows-4', 'rows-5', 'rows-8', 'rows-20'] as const) {
    assert.equal(isTabBarLayoutMode(mode), true, mode)
    assert.equal(normalizeTabBarLayout(mode), mode, mode)
  }
  assert.equal(isPresetTabBarLayout('scroll'), true)
  assert.equal(isPresetTabBarLayout('rows-4'), true)
  assert.equal(isPresetTabBarLayout('rows-5'), false)
  assert.equal(parseTabBarRowCount('rows-6'), 6)
  assert.equal(tabBarRowsLayout(1), `rows-${MIN_TAB_BAR_ROWS}`)
  assert.equal(tabBarRowsLayout(99), `rows-${MAX_TAB_BAR_ROWS}`)
  assert.equal(clampTabBarRows(Number.NaN), DEFAULT_CUSTOM_TAB_BAR_ROWS)

  for (const invalid of [undefined, null, '', 'wrap', 'rows-0', 'rows-1', 'rows-02', 'rows-21', 'rows-99', 2, {}, []]) {
    assert.equal(isTabBarLayoutMode(invalid), false, String(invalid))
    assert.equal(normalizeTabBarLayout(invalid), 'scroll', String(invalid))
  }
})

test('TBL-U02: row count and max list height map accurately for scroll, presets, and custom row counts', () => {
  assert.equal(isMultiRowTabBarLayout('scroll'), false)
  assert.equal(getTabBarMaxRows('scroll'), 1)
  assert.equal(getTabBarMaxListHeight('scroll'), null)

  for (const [mode, rows] of [['rows-2', 2], ['rows-3', 3], ['rows-4', 4], ['rows-6', 6], ['rows-12', 12]] as const) {
    assert.equal(isMultiRowTabBarLayout(mode), true)
    assert.equal(getTabBarMaxRows(mode), rows)
    assert.equal(getTabBarMaxListHeight(mode), rows * TAB_BAR_MULTI_ROW_HEIGHT)
  }
})

test('TBL-U03: multi-row capacity calculation enforces >=1 on Row 1 and wider full rows below', () => {
  const wide = computeMultiRowCapacities(942, 1424, 116)
  assert.equal(wide.row1Capacity, 8)
  assert.equal(wide.fullRowCapacity, 12)

  const tiny = computeMultiRowCapacities(40, 200, 116)
  assert.equal(tiny.row1Capacity, 1)
  assert.equal(tiny.fullRowCapacity, 1)
})

test('TBL-U04: computeMultiRowTabSlice expands full-width rows 2..N and reflows sequentially on vertical scroll', () => {
  // Fits on Row 1 only: zero extra rows rendered.
  const fitsRow1 = computeMultiRowTabSlice(6, 4, 8, 12, 0)
  assert.equal(fitsRow1.row1Start, 0)
  assert.equal(fitsRow1.row1End, 6)
  assert.deepEqual(fitsRow1.extraRows, [])
  assert.equal(fitsRow1.hasOverflow, false)

  // 38 tabs across 4 rows (8 + 12 + 12 + 12 = 44 slots): all 38 visible with no scroll.
  const fit38 = computeMultiRowTabSlice(38, 4, 8, 12, 0)
  assert.equal(fit38.hasOverflow, false)
  assert.equal(fit38.row1Start, 0)
  assert.equal(fit38.row1End, 8)
  assert.deepEqual(fit38.extraRows, [
    { start: 8, end: 20 },
    { start: 20, end: 32 },
    { start: 32, end: 38 }
  ])

  // 60 tabs across 4 rows (visibleCapacity = 44): scrolling down reflows Row 2's start into Row 1.
  const top = computeMultiRowTabSlice(60, 4, 8, 12, 0)
  assert.equal(top.hasOverflow, true)
  assert.equal(top.canScrollUp, false)
  assert.equal(top.canScrollDown, true)
  assert.equal(top.maxScrollRow, 2)
  assert.equal(top.row1Start, 0)
  assert.equal(top.row1End, 8)
  assert.equal(top.extraRows[0].start, 8)

  const mid = computeMultiRowTabSlice(60, 4, 8, 12, 1)
  assert.equal(mid.row1Start, 8, 'First item of previous Row 2 climbs into Row 1 start')
  assert.equal(mid.row1End, 16)
  assert.deepEqual(mid.extraRows, [
    { start: 16, end: 28 },
    { start: 28, end: 40 },
    { start: 40, end: 52 }
  ])

  const bottom = computeMultiRowTabSlice(60, 4, 8, 12, 99)
  assert.equal(bottom.scrollRow, 2)
  assert.equal(bottom.canScrollDown, false)
  assert.equal(bottom.row1Start, 16)
  assert.equal(bottom.endIndex, 60)
})

test('TBL-U05: scrollRowForActiveTab keeps viewport stable when visible and jumps cleanly when off-screen', () => {
  // 60 tabs, 4 rows, caps 8 / 12 (visibleCapacity 44).
  assert.equal(scrollRowForActiveTab(10, 0, 60, 4, 8, 12), 0, 'Already visible: no jump')
  assert.equal(scrollRowForActiveTab(50, 0, 60, 4, 8, 12), 1, 'Scrolls down minimally to include index 50')
  assert.equal(scrollRowForActiveTab(59, 0, 60, 4, 8, 12), 2, 'Scrolls to bottom for final tab')
  assert.equal(scrollRowForActiveTab(3, 2, 60, 4, 8, 12), 0, 'Scrolls back to top for Tab 4')
})
