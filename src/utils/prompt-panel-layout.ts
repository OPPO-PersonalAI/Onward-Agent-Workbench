/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type PromptPanelPosition = 'left' | 'bottom' | 'right'

export const PROMPT_PANEL_POSITIONS: readonly PromptPanelPosition[] = ['left', 'bottom', 'right'] as const
export const DEFAULT_PROMPT_PANEL_POSITION: PromptPanelPosition = 'left'

export const DEFAULT_PROMPT_PANEL_WIDTH = 320
export const DEFAULT_PROMPT_PANEL_RIGHT_WIDTH = 320
export const MIN_PROMPT_PANEL_WIDTH = 200
export const MAX_PROMPT_PANEL_WIDTH = 900

export const DEFAULT_PROMPT_PANEL_BOTTOM_HEIGHT = 240
export const MIN_PROMPT_PANEL_BOTTOM_HEIGHT = 160
export const MAX_PROMPT_PANEL_BOTTOM_HEIGHT = 600

export const DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH = 280
export const MIN_PROMPT_BOTTOM_HISTORY_WIDTH = 180
export const MAX_PROMPT_BOTTOM_HISTORY_WIDTH = 640

export const DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH = 240
export const MIN_PROMPT_BOTTOM_SENDER_WIDTH = 180
export const MAX_PROMPT_BOTTOM_SENDER_WIDTH = 600

export const MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH = 240

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
    MAX_PROMPT_PANEL_BOTTOM_HEIGHT
  )
}

export function normalizePromptBottomHistoryWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH,
    MIN_PROMPT_BOTTOM_HISTORY_WIDTH,
    MAX_PROMPT_BOTTOM_HISTORY_WIDTH
  )
}

export function normalizePromptBottomSenderWidth(value: unknown): number {
  return normalizeBoundedDimension(
    value,
    DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH,
    MIN_PROMPT_BOTTOM_SENDER_WIDTH,
    MAX_PROMPT_BOTTOM_SENDER_WIDTH
  )
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
    const deltaY = startY - clientY
    const ceiling = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize > 0
      ? Math.min(MAX_PROMPT_PANEL_BOTTOM_HEIGHT, Math.round(maxSize))
      : MAX_PROMPT_PANEL_BOTTOM_HEIGHT
    return clampInt(startSize + deltaY, MIN_PROMPT_PANEL_BOTTOM_HEIGHT, ceiling)
  }
  const deltaX = position === 'right' ? startX - clientX : clientX - startX
  const ceiling = typeof maxSize === 'number' && Number.isFinite(maxSize) && maxSize > 0
    ? Math.min(MAX_PROMPT_PANEL_WIDTH, Math.round(maxSize))
    : MAX_PROMPT_PANEL_WIDTH
  return clampInt(startSize + deltaX, MIN_PROMPT_PANEL_WIDTH, ceiling)
}

export interface BottomHistoryResizeParams {
  startWidth: number
  startX: number
  clientX: number
  containerWidth?: number
  senderWidth?: number
}

/**
 * Compute left column (History pane) width in bottom 3-column mode.
 * Dragged on its right edge: moving right increases width (`clientX - startX`).
 * Preserves at least `MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH` for the center editor.
 */
export function computeBottomHistoryResize(params: BottomHistoryResizeParams): number {
  const { startWidth, startX, clientX, containerWidth, senderWidth = DEFAULT_PROMPT_BOTTOM_SENDER_WIDTH } = params
  const deltaX = clientX - startX
  const dynamicMax =
    typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0
      ? Math.min(
          MAX_PROMPT_BOTTOM_HISTORY_WIDTH,
          Math.floor(containerWidth - senderWidth - MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH)
        )
      : MAX_PROMPT_BOTTOM_HISTORY_WIDTH
  return clampInt(startWidth + deltaX, MIN_PROMPT_BOTTOM_HISTORY_WIDTH, dynamicMax)
}

export interface BottomSenderResizeParams {
  startWidth: number
  startX: number
  clientX: number
  containerWidth?: number
  historyWidth?: number
}

/**
 * Compute right column (PromptSender pane) width in bottom 3-column mode.
 * Dragged on its left edge: moving left increases width (`startX - clientX`).
 * Preserves at least `MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH` for the center editor.
 */
export function computeBottomSenderResize(params: BottomSenderResizeParams): number {
  const { startWidth, startX, clientX, containerWidth, historyWidth = DEFAULT_PROMPT_BOTTOM_HISTORY_WIDTH } = params
  const deltaX = startX - clientX
  const dynamicMax =
    typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0
      ? Math.min(
          MAX_PROMPT_BOTTOM_SENDER_WIDTH,
          Math.floor(containerWidth - historyWidth - MIN_PROMPT_BOTTOM_CENTER_EDITOR_WIDTH)
        )
      : MAX_PROMPT_BOTTOM_SENDER_WIDTH
  return clampInt(startWidth + deltaX, MIN_PROMPT_BOTTOM_SENDER_WIDTH, dynamicMax)
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
