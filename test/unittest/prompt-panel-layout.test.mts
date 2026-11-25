/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeBottomAttachmentResize,
  computeBottomHistoryResize,
  computeBottomSenderResize,
  computeOuterPanelResize,
  DEFAULT_PROMPT_BOTTOM_ATTACHMENT_WIDTH,
  DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
  DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
  DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT,
  DEFAULT_PROMPT_PANEL_POSITION,
  DEFAULT_PROMPT_PANEL_RIGHT_WIDTH,
  DEFAULT_PROMPT_PANEL_WIDTH,
  isPromptPanelPosition,
  MAX_PROMPT_PANEL_WIDTH,
  MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH,
  MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH,
  MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH,
  MIN_PROMPT_BOTTOM_HISTORY_WIDTH,
  MIN_PROMPT_BOTTOM_SENDER_WIDTH,
  MIN_PROMPT_PANEL_BOTTOM_HEIGHT,
  MIN_PROMPT_BOTTOM_TERMINAL_AREA_HEIGHT,
  MIN_PROMPT_PANEL_WIDTH,
  normalizePromptBottomAttachmentWidth,
  normalizePromptBottomHistoryWidth,
  normalizePromptBottomSenderWidth,
  normalizePromptPanelBottomHeight,
  normalizePromptPanelPosition,
  normalizePromptPanelRightWidth,
  normalizePromptPanelWidth,
  PROMPT_BOTTOM_ACTION_RAIL_WIDTH,
  PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH,
  PROMPT_BOTTOM_COLUMN_RESIZER_WIDTH,
  PROMPT_BOTTOM_DIMENSION_SANITY_MAX,
  PROMPT_PANEL_BOTTOM_DEFAULT_SETTINGS_VERSION,
  PROMPT_PANEL_POSITIONS,
  resolveBottomEditorMinWidth,
  resolveBottomPanelLayout,
  resolveBottomPanelMaxHeight,
  resolveLoadedPromptPanelPosition,
  resolveMainContentLayout
} from '../../src/utils/prompt-panel-layout.ts'

const COLUMN_RESIZERS = 2 * PROMPT_BOTTOM_COLUMN_RESIZER_WIDTH

test('PPL-U01: position type guard and normalizer accept only left, bottom, right and fall back to bottom', () => {
  assert.deepEqual(PROMPT_PANEL_POSITIONS, ['left', 'bottom', 'right'])
  assert.equal(DEFAULT_PROMPT_PANEL_POSITION, 'bottom')

  for (const pos of ['left', 'bottom', 'right'] as const) {
    assert.equal(isPromptPanelPosition(pos), true)
    assert.equal(normalizePromptPanelPosition(pos), pos)
  }

  for (const invalid of ['top', 'center', '', null, undefined, 0, 123, {}, [], true, Symbol('left')]) {
    assert.equal(isPromptPanelPosition(invalid), false, `Expected false for ${String(invalid)}`)
    assert.equal(normalizePromptPanelPosition(invalid), 'bottom', `Expected fallback 'bottom' for ${String(invalid)}`)
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

  // Bottom-dock dimensions: no fixed design maximum. Values above the former caps
  // (600 / 640 / 600) survive a load; only corrupt values beyond the sanity ceiling clamp.
  assert.equal(normalizePromptPanelBottomHeight(undefined), DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT)
  assert.equal(normalizePromptPanelBottomHeight(180), 180)
  assert.equal(normalizePromptPanelBottomHeight(100), MIN_PROMPT_PANEL_BOTTOM_HEIGHT)
  assert.equal(normalizePromptPanelBottomHeight(800), 800)
  assert.equal(normalizePromptPanelBottomHeight(99999), PROMPT_BOTTOM_DIMENSION_SANITY_MAX)

  assert.equal(normalizePromptBottomHistoryWidth(undefined), DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH)
  assert.equal(normalizePromptBottomHistoryWidth(210), 210)
  assert.equal(normalizePromptBottomHistoryWidth(120), MIN_PROMPT_BOTTOM_HISTORY_WIDTH)
  assert.equal(normalizePromptBottomHistoryWidth(900), 900)
  assert.equal(normalizePromptBottomHistoryWidth(1600), 1600)
  assert.equal(normalizePromptBottomHistoryWidth(99999), PROMPT_BOTTOM_DIMENSION_SANITY_MAX)

  assert.equal(normalizePromptBottomSenderWidth(undefined), DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH)
  assert.equal(normalizePromptBottomSenderWidth(200), 200)
  assert.equal(normalizePromptBottomSenderWidth(90), MIN_PROMPT_BOTTOM_SENDER_WIDTH)
  assert.equal(normalizePromptBottomSenderWidth(900), 900)
  assert.equal(normalizePromptBottomSenderWidth(-5), DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH)

  assert.equal(normalizePromptBottomAttachmentWidth(undefined), DEFAULT_PROMPT_BOTTOM_ATTACHMENT_WIDTH)
  assert.equal(normalizePromptBottomAttachmentWidth('160'), DEFAULT_PROMPT_BOTTOM_ATTACHMENT_WIDTH)
  assert.equal(normalizePromptBottomAttachmentWidth(40), MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH)
  assert.equal(normalizePromptBottomAttachmentWidth(300), 300)
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
  // No fixed 600 cap: without a live ceiling only the sanity bound applies ...
  assert.equal(
    computeOuterPanelResize({ position: 'bottom', startSize: 240, startX: 500, startY: 900, clientX: 500, clientY: 50 }),
    240 + 850
  )
  // ... and with a live ceiling (container height minus the Task area minimum) that wins.
  assert.equal(
    computeOuterPanelResize({ position: 'bottom', startSize: 240, startX: 500, startY: 900, clientX: 500, clientY: 50, maxSize: 700 }),
    700
  )
  // Left/right keep their fixed 900px maximum even with a larger live ceiling.
  assert.equal(
    computeOuterPanelResize({ position: 'left', startSize: 320, startX: 320, startY: 0, clientX: 2000, clientY: 0, maxSize: 3000 }),
    MAX_PROMPT_PANEL_WIDTH
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
  // In a narrow 800px container the ceiling is what remains after the sender column,
  // both column resizers and the center editor minimum (text area + action rail).
  assert.equal(
    computeBottomHistoryResize({ startWidth: 280, startX: 280, clientX: 600, containerWidth: 800, senderWidth: 240 }),
    800 - COLUMN_RESIZERS - 240 - MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH
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
  assert.equal(
    computeBottomSenderResize({ startWidth: 240, startX: 560, clientX: 200, containerWidth: 800, historyWidth: 280 }),
    800 - COLUMN_RESIZERS - 280 - MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH
  )
})

test('PPL-U06: bottom side columns have no fixed maximum (former 640 / 600 caps removed)', () => {
  // A 2560px container lets History grow far past 640.
  assert.equal(
    computeBottomHistoryResize({ startWidth: 280, startX: 280, clientX: 1280, containerWidth: 2560, senderWidth: 240 }),
    1280
  )
  assert.equal(
    computeBottomSenderResize({ startWidth: 240, startX: 2000, clientX: 1100, containerWidth: 2560, historyWidth: 280 }),
    1140
  )
  // The live ceiling still protects the editor minimum, including a wider minimum when
  // attachments are present.
  const minWithAttachments = resolveBottomEditorMinWidth(true, 200)
  assert.equal(
    computeBottomHistoryResize({ startWidth: 280, startX: 0, clientX: 5000, containerWidth: 2560, senderWidth: 240, minEditorWidth: minWithAttachments }),
    2560 - COLUMN_RESIZERS - 240 - minWithAttachments
  )
})

test('PPL-U07: editor minimum width always reserves the action rail, and the attachment column only when attachments exist', () => {
  // The icon action rail is a fixed 48px column next to the 240px text area minimum.
  assert.equal(PROMPT_BOTTOM_ACTION_RAIL_WIDTH, 48)
  assert.equal(MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH, MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH + PROMPT_BOTTOM_ACTION_RAIL_WIDTH)
  assert.equal(resolveBottomEditorMinWidth(false, 400), MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH)
  assert.equal(
    resolveBottomEditorMinWidth(true, 150),
    MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH + PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH + 150
  )
  // A stored width below the column minimum reserves the minimum column instead.
  assert.equal(
    resolveBottomEditorMinWidth(true, 10),
    MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH + PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH + MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH
  )
})

test('PPL-U08: attachment column resize grows leftward and keeps the text area minimum plus the action rail', () => {
  // Dragging the left edge left (-clientX) widens the column.
  assert.equal(computeBottomAttachmentResize({ startWidth: 120, startX: 900, clientX: 840, editorWidth: 800 }), 180)
  // Dragging right narrows it down to its minimum.
  assert.equal(computeBottomAttachmentResize({ startWidth: 120, startX: 900, clientX: 1000, editorWidth: 800 }), MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH)
  // Ceiling: editor body width minus resizer minus text area minimum minus action rail.
  assert.equal(
    computeBottomAttachmentResize({ startWidth: 120, startX: 900, clientX: 0, editorWidth: 800 }),
    800 - PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH - MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH - PROMPT_BOTTOM_ACTION_RAIL_WIDTH
  )
})

test('PPL-U09: rendered bottom layout compresses on a narrow container without rewriting stored values', () => {
  const stored = { storedHeight: 300, storedHistoryWidth: 900, storedSenderWidth: 500 }

  // Wide container: stored values render unchanged.
  const wide = resolveBottomPanelLayout({ ...stored, containerWidth: 2400, containerHeight: 1200 })
  assert.deepEqual(wide, { height: 300, historyWidth: 900, senderWidth: 500, widthCompressed: false, heightCompressed: false })

  // Narrow container: side columns give up space in proportion to their slack above
  // their minimums, and the editor keeps exactly its minimum.
  const narrow = resolveBottomPanelLayout({ ...stored, containerWidth: 1000, containerHeight: 1200 })
  assert.equal(narrow.widthCompressed, true)
  assert.equal(narrow.historyWidth + narrow.senderWidth + MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH, 1000 - COLUMN_RESIZERS)
  const historySlack = 900 - MIN_PROMPT_BOTTOM_HISTORY_WIDTH
  const senderSlack = 500 - MIN_PROMPT_BOTTOM_SENDER_WIDTH
  const giveUp = (900 + 500 + MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH) - (1000 - COLUMN_RESIZERS)
  assert.equal(narrow.historyWidth, Math.round(900 - historySlack * giveUp / (historySlack + senderSlack)))
  assert.equal(narrow.senderWidth, Math.round(500 - senderSlack * giveUp / (historySlack + senderSlack)))

  // Container restored: the remembered geometry comes back unchanged (inputs untouched).
  assert.deepEqual(resolveBottomPanelLayout({ ...stored, containerWidth: 2400, containerHeight: 1200 }), wide)

  // Very narrow container: columns floor at their minimums.
  const tiny = resolveBottomPanelLayout({ ...stored, containerWidth: 500, containerHeight: 1200 })
  assert.equal(tiny.historyWidth, MIN_PROMPT_BOTTOM_HISTORY_WIDTH)
  assert.equal(tiny.senderWidth, MIN_PROMPT_BOTTOM_SENDER_WIDTH)

  // Before the first measurement (no container) nothing is compressed.
  assert.deepEqual(resolveBottomPanelLayout(stored), { height: 300, historyWidth: 900, senderWidth: 500, widthCompressed: false, heightCompressed: false })

  // Attachments raise the editor minimum, which compresses the side columns further.
  const withAttachments = resolveBottomPanelLayout({ ...stored, containerWidth: 1800, containerHeight: 1200, minEditorWidth: resolveBottomEditorMinWidth(true, 300) })
  assert.equal(withAttachments.widthCompressed, true)
  assert.equal(withAttachments.historyWidth + withAttachments.senderWidth + resolveBottomEditorMinWidth(true, 300), 1800 - COLUMN_RESIZERS)
})

test('PPL-U10: bottom height has no fixed cap and is clamped only by the live Task-area minimum', () => {
  assert.equal(resolveBottomPanelMaxHeight(undefined), undefined)
  assert.equal(resolveBottomPanelMaxHeight(1000), 1000 - MIN_PROMPT_BOTTOM_TERMINAL_AREA_HEIGHT)
  // Never below the panel's own minimum.
  assert.equal(resolveBottomPanelMaxHeight(200), MIN_PROMPT_PANEL_BOTTOM_HEIGHT)

  const tall = resolveBottomPanelLayout({ storedHeight: 700, storedHistoryWidth: 280, storedSenderWidth: 240, containerWidth: 1600, containerHeight: 1200 })
  assert.equal(tall.height, 700, 'Heights above the former 600px cap render when they fit')
  assert.equal(tall.heightCompressed, false)

  const short = resolveBottomPanelLayout({ storedHeight: 700, storedHistoryWidth: 280, storedSenderWidth: 240, containerWidth: 1600, containerHeight: 600 })
  assert.equal(short.height, 600 - MIN_PROMPT_BOTTOM_TERMINAL_AREA_HEIGHT)
  assert.equal(short.heightCompressed, true)
})

test('PPL-U11: loaded dock position migrates profiles older than the bottom-default schema exactly once', () => {
  assert.equal(PROMPT_PANEL_BOTTOM_DEFAULT_SETTINGS_VERSION, 11)
  // Older profiles: every stored position (and an absent one) moves to bottom.
  for (const stored of ['left', 'right', 'bottom', undefined, 'bogus']) {
    for (const version of [1, 7, 10]) {
      assert.deepEqual(resolveLoadedPromptPanelPosition(stored, version), { position: 'bottom', migrated: true }, `${String(stored)}@v${version}`)
    }
  }
  // Current and newer profiles: the stored choice is respected.
  for (const version of [11, 12]) {
    assert.deepEqual(resolveLoadedPromptPanelPosition('left', version), { position: 'left', migrated: false })
    assert.deepEqual(resolveLoadedPromptPanelPosition('right', version), { position: 'right', migrated: false })
    assert.deepEqual(resolveLoadedPromptPanelPosition('bottom', version), { position: 'bottom', migrated: false })
    assert.deepEqual(resolveLoadedPromptPanelPosition('bogus', version), { position: 'bottom', migrated: false })
  }
  // No numeric version (fresh or unreadable profile): normalized, never flagged as migrated.
  assert.deepEqual(resolveLoadedPromptPanelPosition('left', undefined), { position: 'left', migrated: false })
  assert.deepEqual(resolveLoadedPromptPanelPosition(undefined, '10'), { position: 'bottom', migrated: false })
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
