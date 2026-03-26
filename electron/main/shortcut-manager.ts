/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { globalShortcut, BrowserWindow, app } from 'electron'
import { getSettingsStorage, ShortcutConfig } from './settings-storage'
import { findReservedShortcutKey, normalizeAccelerator } from './reserved-shortcuts'

/**
 * Shortcut action type
 * Note: only activateAndFocusPrompt is a true global shortcut
 * Other shortcuts are now handled by the renderer process's window-level shortcuts
 */
type ShortcutAction =
  | { type: 'focusTerminal'; index: number }
  | { type: 'switchTab'; index: number }
  | { type: 'activateAndFocusPrompt' }
  | { type: 'addToHistory' }
  | { type: 'focusPromptEditor' }

/**
 * Shortcut callback type
 */
type ShortcutCallback = (action: ShortcutAction) => void

/**
 * Shortcut manager
 * Manage registration and unregistration of global shortcuts
 */
class ShortcutManager {
  private mainWindow: BrowserWindow | null = null
  private registeredShortcuts: Set<string> = new Set()
  private callback: ShortcutCallback | null = null

  /**
   * Set main window reference
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Set shortcut trigger callbacks
   */
  setCallback(callback: ShortcutCallback): void {
    this.callback = callback
  }

  /**
   * Trigger shortcut action
   */
  private triggerAction(action: ShortcutAction): void {
    // If activated and focused, two-way switching is achieved
    if (action.type === 'activateAndFocusPrompt') {
      this.handleActivateAndFocusPrompt()
      return
    }

    // Send events to the rendering process
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('shortcut:triggered', action)
    }

    // callback
    if (this.callback) {
      this.callback(action)
    }
  }

  /**
   * Handle the "wake and focus" shortcut with bidirectional toggling
   */
  private handleActivateAndFocusPrompt(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }

    // Check if the window is visible and in the foreground
    const isVisible = this.mainWindow.isVisible()
    const isFocused = this.mainWindow.isFocused()

    if (isVisible && isFocused) {
      // Currently visible and focused, hidden window
      if (process.platform === 'darwin') {
        this.mainWindow.hide()
        app.dock?.hide()
      } else {
        this.mainWindow.minimize()
      }
    } else if (isVisible && !isFocused) {
      // Visible but not focused, focused window
      this.activateWindow()
    } else {
      // Invisible, show window
      this.activateWindow()
      // Send an event to let the rendering process focus on the last terminal
      this.mainWindow.webContents.send('shortcut:activated')
    }
  }

  /**
   * Activate window
   */
  private activateWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return
    }

    // Restore window (if minimized)
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore()
    }

    // display window
    this.mainWindow.show()

    // focus window
    this.mainWindow.focus()

    // macOS special handling: bringing apps to the foreground
    if (process.platform === 'darwin') {
      app.dock?.show()
      app.focus({ steal: true })
    }
  }

  /**
   * Register a single shortcut
   */
  private registerShortcut(accelerator: string, action: ShortcutAction): boolean {
    if (!accelerator || this.registeredShortcuts.has(accelerator)) {
      return false
    }

    try {
      const success = globalShortcut.register(accelerator, () => {
        this.triggerAction(action)
      })

      if (success) {
        this.registeredShortcuts.add(accelerator)
        console.log(`Registered shortcut: ${accelerator}`)
        return true
      } else {
        console.warn(`Failed to register shortcut: ${accelerator} (already in use by another application)`)
        return false
      }
    } catch (error) {
      console.error(`Error registering shortcut ${accelerator}:`, error)
      return false
    }
  }

  /**
   * Unregister all shortcuts
   */
  unregisterAll(): void {
    for (const accelerator of this.registeredShortcuts) {
      try {
        globalShortcut.unregister(accelerator)
        console.log(`Unregistered shortcut: ${accelerator}`)
      } catch (error) {
        console.error(`Error unregistering shortcut ${accelerator}:`, error)
      }
    }
    this.registeredShortcuts.clear()
  }

  /**
   * Register all global shortcuts from settings
   * Note: only "Wake/Hide" is a true global shortcut
   * Other shortcuts (terminal focus, tab switching, add to history, focus editor)
   * Now handled by the renderer process's window-level shortcuts
   */
  registerFromSettings(): boolean {
    // Unregister all existing shortcuts first
    this.unregisterAll()

    const settings = getSettingsStorage()
    const shortcuts = settings.get().shortcuts

    let allSuccess = true

    // Only register global shortcuts: wake and focus
    if (shortcuts.activateAndFocusPrompt) {
      const success = this.registerShortcut(shortcuts.activateAndFocusPrompt, { type: 'activateAndFocusPrompt' })
      if (!success) allSuccess = false
    }

    return allSuccess
  }

  /**
   * Check whether the shortcut is occupied by another application
   */
  isShortcutAvailable(accelerator: string): boolean {
    if (!accelerator) return true

    // If it has been registered by this application, return true (can be reassigned)
    if (this.registeredShortcuts.has(accelerator)) {
      return true
    }

    // Try to register to check if it is available
    try {
      const success = globalShortcut.register(accelerator, () => {})
      if (success) {
        globalShortcut.unregister(accelerator)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Check whether shortcuts conflict with existing settings
   */
  checkConflict(accelerator: string, excludeKey?: keyof ShortcutConfig): string | null {
    if (!accelerator) return null

    const reservedKey = findReservedShortcutKey(accelerator)
    if (reservedKey) {
      return reservedKey
    }

    const settings = getSettingsStorage()
    const shortcuts = settings.get().shortcuts
    const normalized = normalizeAccelerator(accelerator)

    for (const [key, value] of Object.entries(shortcuts)) {
      if (!value || key === excludeKey) continue
      if (normalizeAccelerator(value) === normalized) {
        return key as keyof ShortcutConfig
      }
    }

    return null
  }

  /**
   * Get the number of registered shortcuts
   */
  getRegisteredCount(): number {
    return this.registeredShortcuts.size
  }

  /**
   * Get the list of registered shortcuts
   */
  getRegisteredShortcuts(): string[] {
    return Array.from(this.registeredShortcuts)
  }
}

// Singleton pattern
let instance: ShortcutManager | null = null

export function getShortcutManager(): ShortcutManager {
  if (!instance) {
    instance = new ShortcutManager()
  }
  return instance
}

export type { ShortcutAction, ShortcutCallback }
