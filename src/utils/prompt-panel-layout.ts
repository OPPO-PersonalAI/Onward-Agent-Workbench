/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type PromptPanelPosition = 'left' | 'bottom' | 'right'

export const PROMPT_PANEL_POSITIONS: readonly PromptPanelPosition[] = ['left', 'bottom', 'right'] as const
export const DEFAULT_PROMPT_PANEL_POSITION: PromptPanelPosition = 'bottom'

/**
 * Settings schema version that introduced the bottom default. Profiles saved by an
 * older schema are moved to 'bottom' exactly once; later loads respect the stored value.
 */
export const PROMPT_PANEL_BOTTOM_DEFAULT_SETTINGS_VERSION = 11

export const DEFAULT_PROMPT_PANEL_WIDTH = 320
export const DEFAULT_PROMPT_PANEL_RIGHT_WIDTH = 320
export const MIN_PROMPT_PANEL_WIDTH = 200
export const MAX_PROMPT_PANEL_WIDTH = 900

/**
 * Bottom-dock dimensions have no fixed design maximum: they are bounded only by the
 * live container (see `resolveBottomPanelLayout`). This ceiling exists purely to reject
 * corrupt persisted values; it is far above any real display size.
 */
export const PROMPT_BOTTOM_DIMENSION_SANITY_MAX = 8000

export const DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT = 240
export const MIN_PROMPT_PANEL_BOTTOM_HEIGHT = 160
/** Minimum height the Task area above a bottom-docked panel always keeps. */
export const MIN_PROMPT_BOTTOM_TERMINAL_AREA_HEIGHT = 160

export const DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH = 280
export const MIN_PROMPT_BOTTOM_HISTORY_WIDTH = 180

export const DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH = 240
export const MIN_PROMPT_BOTTOM_SENDER_WIDTH = 180

/** Minimum width of the text input area inside the bottom-docked editor column. */
export const MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH = 240
/**
 * Minimum width of the whole bottom-docked editor column without attachments. The
 * editor actions live in the Task sender column (see `resolvePromptEditorActionsPlacement`),
 * so the column is the text area alone.
 */
export const MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH = MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH
/** Width of each vertical column resizer between History | Editor | Sender. */
export const PROMPT_BOTTOM_COLUMN_RESIZER_WIDTH = 5

export const DEFAULT_PROMPT_BOTTOM_ATTACHMENT_WIDTH = 120
export const MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH = 96
/** Width of the resizer between the editor text area and the attachment column. */
export const PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH = 5

function clampInt(value: number, min: number, max: number): number {
  const effectiveMax = Math.max(min, max)
  return Math.max(min, Math.min(effectiveMax, Math.round(value)))
}

export function isPromptPanelPosition(value: unknown): value is PromptPanelPosition {
  return value === 'left' || value === 'bottom' || value === 'right'
}

export function normalizePromptPanelPosition(value: unknown): PromptPanelPosition {
  return isPromptPanelPosition(value) ? value : DEFAULT_PROMPT_PANEL_POSITION
}

function normalizeBoundedDimension(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return defaultValue
  }
  return clampInt(value, min, max)
}

export function normalizePromptPanelWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_PANEL_WIDTH,
    MIN_PROMPT_PANEL_WIDTH,
    MAX_PROMPT_PANEL_WIDTH
  )
}

export function normalizePromptPanelRightWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_PANEL_RIGHT_WIDTH,
    MIN_PROMPT_PANEL_WIDTH,
    MAX_PROMPT_PANEL_WIDTH
  )
}

export function normalizePromptPanelBottomHeight(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT,
    MIN_PROMPT_PANEL_BOTTOM_HEIGHT,
    PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  )
}

export function normalizePromptBottomHistoryWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
    MIN_PROMPT_BOTTOM_HISTORY_WIDTH,
    PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  )
}

export function normalizePromptBottomSenderWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
    MIN_PROMPT_BOTTOM_SENDER_WIDTH,
    PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  )
}

export function normalizePromptBottomAttachmentWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_BOTTOM_ATTACHMENT_WIDTH,
    MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH,
    PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  )
}

export interface LoadedPromptPanelPosition {
  position: PromptPanelPosition
  /** True when the one-time move to the bottom default was applied on this load. */
  migrated: boolean
}

/**
 * Resolve the dock position read from a persisted settings profile.
 * - Profile saved by a schema older than `PROMPT_PANEL_BOTTOM_DEFAULT_SETTINGS_VERSION`:
 *   moved to 'bottom' once, whatever it stored.
 * - Current profile, or a profile with no numeric version (fresh / unreadable):
 *   the stored value is normalized (invalid -> default 'bottom').
 */
export function resolveLoadedPromptPanelPosition(
  storedPosition: unknown,
  storedVersion: unknown
): LoadedPromptPanelPosition {
  const isLegacyProfile = typeof storedVersion === 'number'
    && Number.isFinite(storedVersion)
    && storedVersion < PROMPT_PANEL_BOTTOM_DEFAULT_SETTINGS_VERSION
  if (isLegacyProfile) {
    return { position: 'bottom', migrated: true }
  }
  return { position: normalizePromptPanelPosition(storedPosition), migrated: false }
}

export interface OuterPanelResizeParams {
  position: PromptPanelPosition
  startSize: number
  startX: number
  startY: number
  clientX: number
  clientY: number
  maxSize?: number
}

/**
 * Compute outer PromptNotebook panel dimension from drag coordinates.
 * - 'left': dragged on right edge (expanding moves right -> clientX - startX)
 * - 'right': dragged on left edge (expanding moves left -> startX - clientX)
 * - 'bottom': dragged on top edge (expanding moves up -> startY - clientY)
 */
export function computeOuterPanelResize(params: OuterPanelResizeParams): number {
  const { position, startSize, startX, startY, clientX, clientY, maxSize } = params
  if (position === 'bottom') {
    // No fixed design cap: the caller passes the live ceiling (container height minus
    // the Task area minimum, see `resolveBottomPanelMaxHeight`).
    const deltaY = startY - clientY
    const ceiling = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize > 0
      ? Math.min(PROMPT_BOTTOM_DIMENSION_SANITY_MAX, Math.round(maxSize))
      : PROMPT_BOTTOM_DIMENSION_SANITY_MAX
    return clampInt(startSize + deltaY, MIN_PROMPT_PANEL_BOTTOM_HEIGHT, ceiling)
  }
  const deltaX = position === 'right' ? startX - clientX : clientX - startX
  const ceiling = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize > 0
    ? Math.min(MAX_PROMPT_PANEL_WIDTH, Math.round(maxSize))
    : MAX_PROMPT_PANEL_WIDTH
  return clampInt(startSize + deltaX, MIN_PROMPT_PANEL_WIDTH, ceiling)
}

/** Horizontal space left for the three columns once both column resizers are drawn. */
function bottomColumnsSpace(containerWidth: number): number {
  return containerWidth - 2 * PROMPT_BOTTOM_COLUMN_RESIZER_WIDTH
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Minimum width the center editor column needs. With attachments present the
 * attachment column (plus its resizer) sits beside the text area, so the text area
 * still keeps `MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH`.
 */
export function resolveBottomEditorMinWidth(hasAttachments: boolean, attachmentWidth: number): number {
  if (!hasAttachments) return MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH
  const column = Math.max(MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH, Math.round(attachmentWidth))
  return MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH + PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH + column
}

export interface BottomHistoryResizeParams {
  startWidth: number
  startX: number
  clientX: number
  containerWidth?: number
  senderWidth?: number
  minEditorWidth?: number
}

/**
 * Compute left column (History pane) width in bottom 3-column mode.
 * Dragged on its right edge: moving right increases width (`clientX - startX`).
 * No fixed maximum: the only ceiling is the space left after the sender column,
 * both column resizers and the center editor minimum.
 */
export function computeBottomHistoryResize(params: BottomHistoryResizeParams): number {
  const {
    startWidth,
    startX,
    clientX,
    containerWidth,
    senderWidth = DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
    minEditorWidth = MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH
  } = params
  const deltaX = clientX - startX
  const dynamicMax = isPositiveFinite(containerWidth)
    ? Math.floor(bottomColumnsSpace(containerWidth) - senderWidth - minEditorWidth)
    : PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  return clampInt(startWidth + deltaX, MIN_PROMPT_BOTTOM_HISTORY_WIDTH, dynamicMax)
}

export interface BottomSenderResizeParams {
  startWidth: number
  startX: number
  clientX: number
  containerWidth?: number
  historyWidth?: number
  minEditorWidth?: number
}

/**
 * Compute right column (PromptSender pane) width in bottom 3-column mode.
 * Dragged on its left edge: moving left increases width (`startX - clientX`).
 * No fixed maximum; see `computeBottomHistoryResize`.
 */
export function computeBottomSenderResize(params: BottomSenderResizeParams): number {
  const {
    startWidth,
    startX,
    clientX,
    containerWidth,
    historyWidth = DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
    minEditorWidth = MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH
  } = params
  const deltaX = startX - clientX
  const dynamicMax = isPositiveFinite(containerWidth)
    ? Math.floor(bottomColumnsSpace(containerWidth) - historyWidth - minEditorWidth)
    : PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  return clampInt(startWidth + deltaX, MIN_PROMPT_BOTTOM_SENDER_WIDTH, dynamicMax)
}

export interface BottomAttachmentResizeParams {
  startWidth: number
  startX: number
  clientX: number
  /** Current width of the editor column body (text area + resizer + attachment column). */
  editorWidth?: number
}

/**
 * Compute the attachment column width inside the bottom-docked editor.
 * Dragged on its left edge: moving left increases width (`startX - clientX`).
 * The text area to its left always keeps `MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH`.
 */
export function computeBottomAttachmentResize(params: BottomAttachmentResizeParams): number {
  const { startWidth, startX, clientX, editorWidth } = params
  const deltaX = startX - clientX
  const dynamicMax = isPositiveFinite(editorWidth)
    ? Math.floor(editorWidth - PROMPT_BOTTOM_ATTACHMENT_RESIZER_WIDTH - MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH)
    : PROMPT_BOTTOM_DIMENSION_SANITY_MAX
  return clampInt(startWidth + deltaX, MIN_PROMPT_BOTTOM_ATTACHMENT_WIDTH, dynamicMax)
}

/** Live ceiling for the bottom panel height: the Task area above keeps its minimum. */
export function resolveBottomPanelMaxHeight(containerHeight: number | undefined): number | undefined {
  if (!isPositiveFinite(containerHeight)) return undefined
  return Math.max(MIN_PROMPT_PANEL_BOTTOM_HEIGHT, Math.floor(containerHeight - MIN_PROMPT_BOTTOM_TERMINAL_AREA_HEIGHT))
}

export interface BottomPanelLayoutParams {
  /** Live size of the container the bottom panel docks into; omitted before first measure. */
  containerWidth?: number
  containerHeight?: number
  storedHeight: number
  storedHistoryWidth: number
  storedSenderWidth: number
  minEditorWidth?: number
}

export interface BottomPanelLayout {
  height: number
  historyWidth: number
  senderWidth: number
  /** True when side columns are drawn narrower than their stored widths. */
  widthCompressed: boolean
  /** True when the panel is drawn shorter than its stored height. */
  heightCompressed: boolean
}

/**
 * Resolve the rendered bottom-panel geometry from stored (remembered) pixel values.
 *
 * Stored values are never rewritten here. When the container is too small, the side
 * columns give up space in proportion to how far each sits above its own minimum, and
 * the height is clamped to the live ceiling. Once the container grows back, the stored
 * values render unchanged again.
 */
export function resolveBottomPanelLayout(params: BottomPanelLayoutParams): BottomPanelLayout {
  const {
    containerWidth,
    containerHeight,
    storedHeight,
    storedHistoryWidth,
    storedSenderWidth,
    minEditorWidth = MIN_PROMPT_BOTTOM_EDITOR_COLUMN_WIDTH
  } = params

  let historyWidth = Math.max(MIN_PROMPT_BOTTOM_HISTORY_WIDTH, storedHistoryWidth)
  let senderWidth = Math.max(MIN_PROMPT_BOTTOM_SENDER_WIDTH, storedSenderWidth)
  let widthCompressed = false
  if (isPositiveFinite(containerWidth)) {
    const excess = historyWidth + senderWidth + minEditorWidth - bottomColumnsSpace(containerWidth)
    if (excess > 0) {
      const historySlack = historyWidth - MIN_PROMPT_BOTTOM_HISTORY_WIDTH
      const senderSlack = senderWidth - MIN_PROMPT_BOTTOM_SENDER_WIDTH
      const slack = historySlack + senderSlack
      if (slack > 0) {
        const ratio = Math.min(1, excess / slack)
        historyWidth -= historySlack * ratio
        senderWidth -= senderSlack * ratio
        widthCompressed = true
      }
    }
  }

  let height = Math.max(MIN_PROMPT_PANEL_BOTTOM_HEIGHT, storedHeight)
  let heightCompressed = false
  const maxHeight = resolveBottomPanelMaxHeight(containerHeight)
  if (maxHeight !== undefined && height > maxHeight) {
    height = maxHeight
    heightCompressed = true
  }

  return {
    height: Math.round(height),
    historyWidth: Math.round(historyWidth),
    senderWidth: Math.round(senderWidth),
    widthCompressed,
    heightCompressed
  }
}

export interface MainContentLayoutDescriptor {
  effectivePosition: PromptPanelPosition
  direction: 'row' | 'column'
  promptOrder: number
  terminalOrder: number
}

/**
 * Resolve `.main-content` layout direction and flex order.
 * Critical invariant: When `showSettings === true`, Settings is always docked on the left
 * (`direction: 'row'`), and PromptNotebook is hidden.
 */
export function resolveMainContentLayout(
  position: PromptPanelPosition,
  showSettings: boolean
): MainContentLayoutDescriptor {
  const normalized = normalizePromptPanelPosition(position)
  if (showSettings) {
    return {
      effectivePosition: 'left',
      direction: 'row',
      promptOrder: 1,
      terminalOrder: 2
    }
  }
  if (normalized === 'bottom') {
    return {
      effectivePosition: 'bottom',
      direction: 'column',
      promptOrder: 2,
      terminalOrder: 1
    }
  }
  if (normalized === 'right') {
    return {
      effectivePosition: 'right',
      direction: 'row',
      promptOrder: 2,
      terminalOrder: 1
    }
  }
  return {
    effectivePosition: 'left',
    direction: 'row',
    promptOrder: 1,
    terminalOrder: 2
  }
}

/**
 * Where the editor actions (color tags, add / cancel / save / save-as-new) render.
 * - `footer`: left/right docks keep the text-button row below the inputs.
 * - `sender-row`: the bottom dock renders them in the Task sender column, between
 *   the Task cards and the send buttons.
 * - `awaiting-slot`: bottom dock, but the sender column has not mounted its row yet
 *   (first commit after a dock switch); nothing renders until it arrives.
 */
export type PromptEditorActionsPlacement = 'footer' | 'sender-row' | 'awaiting-slot'

export function resolvePromptEditorActionsPlacement(
  position: PromptPanelPosition,
  senderRowAvailable: boolean
): PromptEditorActionsPlacement {
  if (position !== 'bottom') return 'footer'
  return senderRowAvailable ? 'sender-row' : 'awaiting-slot'
}
