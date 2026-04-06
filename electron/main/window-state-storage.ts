/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, screen } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800
const MIN_WIDTH = 600
const MIN_HEIGHT = 400

interface WindowState {
  x: number | undefined
  y: number | undefined
  width: number
  height: number
  isMaximized: boolean
  isFullScreen: boolean
  updatedAt: number
}

class WindowStateStorage {
  private storagePath: string
  private state: WindowState

  constructor() {
    this.storagePath = join(app.getPath('userData'), 'window-state.json')
    this.state = this.load()
  }

  private load(): WindowState {
    try {
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(data) as Partial<WindowState>
        return this.validate(parsed)
      }
    } catch (error) {
      console.error('[WindowState] Failed to load:', error)
    }
    return this.getDefault()
  }

  private getDefault(): WindowState {
    return {
      x: undefined,
      y: undefined,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      isMaximized: false,
      isFullScreen: false,
      updatedAt: 0
    }
  }

  private validate(state: Partial<WindowState>): WindowState {
    let width = typeof state.width === 'number' && state.width >= MIN_WIDTH
      ? state.width : DEFAULT_WIDTH
    let height = typeof state.height === 'number' && state.height >= MIN_HEIGHT
      ? state.height : DEFAULT_HEIGHT

    const isMaximized = state.isMaximized === true
    const isFullScreen = state.isFullScreen === true

    let x: number | undefined
    let y: number | undefined

    if (typeof state.x === 'number' && typeof state.y === 'number') {
      // Verify the saved position is visible on a connected display
      const rect = { x: state.x, y: state.y, width, height }
      if (this.isRectVisible(rect)) {
        x = state.x
        y = state.y
      }
    }

    // Clamp window size to the target display's work area so an oversized window
    // (e.g. saved on a large external monitor) does not open mostly off-screen.
    if (!isMaximized && !isFullScreen) {
      try {
        const targetDisplay = (x !== undefined && y !== undefined)
          ? screen.getDisplayMatching({ x, y, width, height })
          : screen.getPrimaryDisplay()
        const { width: areaW, height: areaH } = targetDisplay.workArea
        width = Math.min(width, areaW)
        height = Math.min(height, areaH)
      } catch {
        // screen API may not be ready yet; skip clamping
      }
    }

    return { x, y, width, height, isMaximized, isFullScreen, updatedAt: state.updatedAt ?? 0 }
  }

  private isRectVisible(rect: { x: number; y: number; width: number; height: number }): boolean {
    try {
      const displays = screen.getAllDisplays()
      // Check if at least part of the window (top-left 100x100 area) overlaps any display
      for (const display of displays) {
        const { x, y, width, height } = display.workArea
        const overlapX = rect.x < x + width && rect.x + 100 > x
        const overlapY = rect.y < y + height && rect.y + 100 > y
        if (overlapX && overlapY) return true
      }
    } catch {
      // screen API might not be available before app is ready
    }
    return false
  }

  get(): WindowState {
    return { ...this.state }
  }

  save(bounds: { x: number; y: number; width: number; height: number },
       isMaximized: boolean, isFullScreen: boolean): void {
    this.state = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(bounds.width, MIN_WIDTH),
      height: Math.max(bounds.height, MIN_HEIGHT),
      isMaximized,
      isFullScreen,
      updatedAt: Date.now()
    }
    this.persist()
  }

  private persist(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('[WindowState] Failed to save:', error)
    }
  }
}

let instance: WindowStateStorage | null = null

export function getWindowStateStorage(): WindowStateStorage {
  if (!instance) {
    instance = new WindowStateStorage()
  }
  return instance
}
