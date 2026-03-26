/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { requestQuit } from './index'
import { tMain } from './localization'

/**
 * System Tray Manager
 * Provide status bar icon functionality on macOS
 */
export class TrayManager {
  private tray: Tray | null = null
  private mainWindow: BrowserWindow | null = null
  private displayName = 'Onward 2'

  /**
   * Initialize tray icon
   */
  init(mainWindow: BrowserWindow, displayName: string): void {
    // Tray is currently only enabled on macOS
    if (process.platform !== 'darwin') {
      console.log('[Tray] Skipped: not macOS')
      return
    }

    this.mainWindow = mainWindow
    this.displayName = displayName

    // Get icon path
    const iconPath = this.getIconPath()
    console.log('[Tray] Icon path:', iconPath)
    console.log('[Tray] app.isPackaged:', app.isPackaged)
    console.log('[Tray] process.resourcesPath:', process.resourcesPath)
    console.log('[Tray] Icon exists:', existsSync(iconPath))

    if (!iconPath || !existsSync(iconPath)) {
      console.warn('[Tray] Icon not found:', iconPath)
      return
    }

    // Create tray icon
    const icon = nativeImage.createFromPath(iconPath)
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true)
    }
    console.log('[Tray] Icon isEmpty:', icon.isEmpty())
    console.log('[Tray] Icon size:', icon.getSize())

    // macOS will automatically recognize it based on the file name "Template"
    this.tray = new Tray(icon)
    console.log('[Tray] Tray created')
    this.tray.setToolTip(this.displayName)

    // Left click: switch window display/hide
    this.tray.on('click', () => {
      this.toggleWindow()
    })

    // Right click: Show menu (use popUpContextMenu instead of setContextMenu)
    this.tray.on('right-click', () => {
      const contextMenu = this.buildContextMenu()
      this.tray?.popUpContextMenu(contextMenu)
    })

    console.log('[Tray] Initialized')
  }

  /**
   * Get icon path
   */
  private getIconPath(): string {
    const resourcesPath = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(__dirname, '../../resources')

    // Use the Template icon (macOS automatically adapts to dark/light mode)
    return join(resourcesPath, 'tray-icon-Template.png')
  }

  /**
   * Switch window display/hide
   */
  toggleWindow(): void {
    if (!this.mainWindow) return

    if (this.mainWindow.isVisible()) {
      this.hideWindow()
    } else {
      this.showWindow()
    }
  }

  /**
   * display window
   */
  showWindow(): void {
    if (!this.mainWindow) return

    // Restore window (if minimized)
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore()
    }

    this.mainWindow.show()
    this.mainWindow.focus()

    // macOS: Show Dock icon
    if (process.platform === 'darwin') {
      app.dock?.show()
    }
  }

  /**
   * Hide window
   */
  hideWindow(): void {
    if (!this.mainWindow) return

    this.mainWindow.hide()

    // macOS: Hide Dock Icon
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }
  }

  /**
   * Build right-click menu
   */
  private buildContextMenu(): Menu {
    const isVisible = this.mainWindow?.isVisible() ?? false

    return Menu.buildFromTemplate([
      {
        label: isVisible ? tMain('menu.hideWindow') : tMain('menu.showWindow'),
        click: () => this.toggleWindow()
      },
      { type: 'separator' },
      {
        label: tMain('menu.quitApp', { displayName: this.displayName }),
        click: async () => {
          await requestQuit()
        }
      }
    ])
  }

  /**
   * Destroy tray icon
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }
    this.mainWindow = null
  }
}

// Singleton pattern
let instance: TrayManager | null = null

export function getTrayManager(): TrayManager {
  if (!instance) {
    instance = new TrayManager()
  }
  return instance
}
