/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { nativeTheme, type BrowserWindow } from 'electron'
import {
  DEFAULT_APPEARANCE,
  resolveAppearanceDescriptor,
  type AppearanceSettingsV1,
  type ThemeKind
} from '../shared/appearance-schema'
import { IPC } from '../shared/ipc-channels'

export interface AppearanceSnapshot {
  revision: number
  kind: ThemeKind
}

function windowBackground(kind: ThemeKind): string {
  return kind === 'light' ? '#f5f7fa' : '#101012'
}

class AppearanceService {
  private appearance: AppearanceSettingsV1 = DEFAULT_APPEARANCE
  private revision = 0
  private kind: ThemeKind = 'dark'
  private window: BrowserWindow | null = null
  private listening = false

  configure(appearance: AppearanceSettingsV1): AppearanceSnapshot {
    this.appearance = appearance
    nativeTheme.themeSource = appearance.colorMode
    this.ensureNativeThemeListener()
    return this.refresh()
  }

  attachWindow(window: BrowserWindow): AppearanceSnapshot {
    this.window = window
    const snapshot = this.refresh()
    window.setBackgroundColor(windowBackground(snapshot.kind))
    return snapshot
  }

  snapshot(): AppearanceSnapshot {
    return { revision: this.revision, kind: this.kind }
  }

  private ensureNativeThemeListener(): void {
    if (this.listening) return
    this.listening = true
    nativeTheme.on('updated', () => this.refresh())
  }

  private refresh(): AppearanceSnapshot {
    const nextKind = resolveAppearanceDescriptor(this.appearance, nativeTheme.shouldUseDarkColors).kind
    if (nextKind === this.kind && this.revision > 0) return this.snapshot()
    this.kind = nextKind
    this.revision += 1
    const snapshot = this.snapshot()
    if (this.window && !this.window.isDestroyed()) {
      this.window.setBackgroundColor(windowBackground(snapshot.kind))
      this.window.webContents.send(IPC.APPEARANCE_SNAPSHOT_UPDATED, snapshot)
    }
    return snapshot
  }
}

export const appearanceService = new AppearanceService()
