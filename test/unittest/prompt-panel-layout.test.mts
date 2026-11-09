/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeBottomHistoryResize,
  computeBottomSenderResize,
  computeOuterPanelResize,
  DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
  DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
  DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT,
  DEFAULT_PROMPT_PANEL_POSITION,
  DEFAULT_PROMPT_PANEL_RIGHT_WIDTH,
  DEFAULT_PROMPT_PANEL_WIDTH,
  isPromptPanelPosition,
  MAX_PROMPT_BOTTOM_HISTORY_WIDTH,
  MAX_PROMPT_BOTTOM_SENDER_WIDTH,
  MAX_PROMPT_PANEL_BOTTOM_HEIGHT,
  MAX_PROMPT_PANEL_WIDTH,
  MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH,
  MIN_PROMPT_BOTTOM_HISTORY_WIDTH,
  MIN_PROMPT_BOTTOM_SENDER_WIDTH,
  MIN_PROMPT_PANEL_BOTTOM_HEIGHT,
  MIN_PROMPT_PANEL_WIDTH,
  normalizePromptBottomHistoryWidth,
  normalizePromptBottomSenderWidth,
  normalizePromptPanelBottomHeight,
  normalizePromptPanelPosition,
  normalizePromptPanelRightWidth,
  normalizePromptPanelWidth,
  PROMPT_PANEL_POSITIONS,
  resolveMainContentLayout
} from '../../src/utils/prompt-panel-layout.ts'

test('PPL-U01: position type guard and normalizer accept only left, bottom, right and fall back to left', () => {
  assert.deepEqual(PROMPT_PANEL_POSITIONS, ['left', 'bottom', 'right'])
  assert.equal(DEFAULT_PROMPT_PANEL_POSITION, 'left')

  for (const pos of ['left', 'bottom', 'right'] as const) {
    assert.equal(isPromptPanelPosition(pos), true)
    assert.equal(normalizePromptPanelPosition(pos), pos)
  }

  for (const invalid of ['top', 'center', '', null, undefined, 0, 123, {}, [], true, Symbol('left')]) {
    assert.equal(isPromptPanelPosition(invalid), false, `Expected false for ${String(invalid)}`)
    assert.equal(normalizePromptPanelPosition(invalid), 'left', `Expected fallback 'left' for ${String(invalid)}`)
  }
})

test('PPL-U02: dimension normalizers preserve valid ranges [min, max] including [200, 320) and fall back on invalid inputs', () => {
  // Left width: default 320, min 200, max 900
  assert.equal(normalizePromptPanelWidth(undefined), DEFAULT_PROMPT_PANEL_WIDTH)
  assert.equal(normalizePromptPanelWidth(null), DEFAULT_PROMPT_PANEL_WIDTH)
  assert.equal(normalizePromptPanelWidth(NaN), DEFAULT_PROMPT_PANEL_WIDTH)
  assert.equal(normalizePromptPanelWidth('260'), DEFAULT_PROMPT_PANEL_WIDTH)
  assert.equal(normalizePromptPanelWidth(200), 200)
  assert.equal(normalizePromptPanelWidth(240), 240, 'Widths in [200, 320) must be preserved, not clobbered to 320')
  assert.equal(normalizePromptPanelWidth(320), 320)
  assert.equal(normalizePromptPanelWidth(150), MIN_PROMPT_PANEL_WIDTH)
  assert.equal(normalizePromptPanelWidth(1200), MAX_PROMPT_PANEL_WIDTH)

  // Right width: default 320, min 200, max 900
  assert.equal(normalizePromptPanelRightWidth(undefined), DEFAULT_PROMPT_PANEL_RIGHT_WIDTH)
  assert.equal(normalizePromptPanelRightWidth(245), 245)
  assert.equal(normalizePromptPanelRightWidth(100), MIN_PROMPT_PANEL_WIDTH)
  assert.equal(normalizePromptPanelRightWidth(1400), MAX_PROMPT_PANEL_WIDTH)

  // Bottom height: default 240, min 160, max 600
  assert.equal(normalizePromptPanelBottomHeight(undefined), DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT)
  assert.equal(normalizePromptPanelBottomHeight(180), 180)
  assert.equal(normalizePromptPanelBottomHeight(100), MIN_PROMPT_PANEL_BOTTOM_HEIGHT)
  assert.equal(normalizePromptPanelBottomHeight(800), MAX_PROMPT_PANEL_BOTTOM_HEIGHT)

  // Bottom history width: default 280, min 180, max 640
  assert.equal(normalizePromptBottomHistoryWidth(undefined), DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH)
  assert.equal(normalizePromptBottomHistoryWidth(210), 210)
  assert.equal(normalizePromptBottomHistoryWidth(120), MIN_PROMPT_BOTTOM_HISTORY_WIDTH)
  assert.equal(normalizePromptBottomHistoryWidth(900), MAX_PROMPT_BOTTOM_HISTORY_WIDTH)

  // Bottom sender width: default 240, min 180, max 600
  assert.equal(normalizePromptBottomSenderWidth(undefined), DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH)
  assert.equal(normalizePromptBottomSenderWidth(200), 200)
  assert.equal(normalizePromptBottomSenderWidth(90), MIN_PROMPT_BOTTOM_SENDER_WIDTH)
  assert.equal(normalizePromptBottomSenderWidth(900), MAX_PROMPT_BOTTOM_SENDER_WIDTH)
})

test('PPL-U03: outer panel resize calculator applies position-specific drag sign and clamping', () => {
  // Left mode: dragging right (+clientX) widens panel
  assert.equal(
    computeOuterPanelResize({ position: 'left', startSize: 320, startX: 320, startY: 200, clientX: 400, clientY: 200 }),
    400
  )
  assert.equal(
    computeOuterPanelResize({ position: 'left', startSize: 320, startX: 320, startY: 200, clientX: 50, clientY: 200 }),
    MIN_PROMPT_PANEL_WIDTH
  )
  assert.equal(
    computeOuterPanelResize({ position: 'left', startSize: 320, startX: 320, startY: 200, clientX: 1500, clientY: 200 }),
    MAX_PROMPT_PANEL_WIDTH
  )

  // Right mode: dragging left (-clientX) widens panel; dragging right (+clientX) narrows panel
  assert.equal(
    computeOuterPanelResize({ position: 'right', startSize: 320, startX: 900, startY: 200, clientX: 800, clientY: 200 }),
    420
  )
  assert.equal(
    computeOuterPanelResize({ position: 'right', startSize: 320, startX: 900, startY: 200, clientX: 980, clientY: 200 }),
    240
  )
  assert.equal(
    computeOuterPanelResize({ position: 'right', startSize: 320, startX: 900, startY: 200, clientX: 1200, clientY: 200 }),
    MIN_PROMPT_PANEL_WIDTH
  )
  assert.equal(
    computeOuterPanelResize({ position: 'right', startSize: 320, startX: 900, startY: 200, clientX: 100, clientY: 200 }),
    MAX_PROMPT_PANEL_WIDTH
  )

  // Bottom mode: dragging up (-clientY) increases height; dragging down (+clientY) decreases height
  assert.equal(
    computeOuterPanelResize({ position: 'bottom', startSize: 240, startX: 500, startY: 600, clientX: 500, clientY: 520 }),
    320
  )
  assert.equal(
    computeOuterPanelResize({ position: 'bottom', startSize: 240, startX: 500, startY: 600, clientX: 500, clientY: 650 }),
    190
  )
  assert.equal(
    computeOuterPanelResize({ position: 'bottom', startSize: 240, startX: 500, startY: 600, clientX: 500, clientY: 900 }),
    MIN_PROMPT_PANEL_BOTTOM_HEIGHT
  )
  assert.equal(
    computeOuterPanelResize({ position: 'bottom', startSize: 240, startX: 500, startY: 600, clientX: 500, clientY: 50 }),
    MAX_PROMPT_PANEL_BOTTOM_HEIGHT
  )
})

test('PPL-U04: bottom 3-column inner resizers clamp to min/max and preserve center editor minimum width', () => {
  // History column (left resizer): dragging right (+clientX) widens history
  assert.equal(
    computeBottomHistoryResize({ startWidth: 280, startX: 280, clientX: 350, containerWidth: 1200, senderWidth: 240 }),
    350
  )
  assert.equal(
    computeBottomHistoryResize({ startWidth: 280, startX: 280, clientX: 50, containerWidth: 1200, senderWidth: 240 }),
    MIN_PROMPT_BOTTOM_HISTORY_WIDTH
  )
  // In a narrow 800px container with senderWidth=240 and MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH=240,
  // max history width is 800 - 240 - 240 = 320
  assert.equal(
    computeBottomHistoryResize({ startWidth: 280, startX: 280, clientX: 600, containerWidth: 800, senderWidth: 240 }),
    800 - 240 - MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH
  )

  // Sender column (right resizer): dragging left (-clientX) widens sender; dragging right (+clientX) narrows sender
  assert.equal(
    computeBottomSenderResize({ startWidth: 240, startX: 960, clientX: 900, containerWidth: 1200, historyWidth: 280 }),
    300
  )
  assert.equal(
    computeBottomSenderResize({ startWidth: 240, startX: 960, clientX: 1100, containerWidth: 1200, historyWidth: 280 }),
    MIN_PROMPT_BOTTOM_SENDER_WIDTH
  )
  // In a narrow 800px container with historyWidth=280, max sender width is 800 - 280 - 240 = 280
  assert.equal(
    computeBottomSenderResize({ startWidth: 240, startX: 560, clientX: 200, containerWidth: 800, historyWidth: 280 }),
    800 - 280 - MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH
  )
})

test('PPL-U05: resolveMainContentLayout enforces Settings left-fixed row invariant regardless of promptPanelPosition', () => {
  assert.deepEqual(resolveMainContentLayout('left', false), {
    effectivePosition: 'left',
    direction: 'row',
    promptOrder: 1,
    terminalOrder: 2
  })
  assert.deepEqual(resolveMainContentLayout('right', false), {
    effectivePosition: 'right',
    direction: 'row',
    promptOrder: 2,
    terminalOrder: 1
  })
  assert.deepEqual(resolveMainContentLayout('bottom', false), {
    effectivePosition: 'bottom',
    direction: 'column',
    promptOrder: 2,
    terminalOrder: 1
  })

  // When showSettings is true, effectivePosition MUST always be 'left' and direction 'row'
  for (const pos of ['left', 'bottom', 'right'] as const) {
    assert.deepEqual(resolveMainContentLayout(pos, true), {
      effectivePosition: 'left',
      direction: 'row',
      promptOrder: 1,
      terminalOrder: 2
    })
  }
})
