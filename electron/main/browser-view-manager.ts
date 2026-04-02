/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, WebContentsView, session } from 'electron'

const BROWSER_PARTITION = 'persist:browser'

function isAllowedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === 'about:blank'
}

interface BrowserViewInfo {
  view: WebContentsView
  attached: boolean
  isFullscreen: boolean
  savedBounds: { x: number; y: number; width: number; height: number } | null
}

class BrowserViewManager {
  private readonly views = new Map<string, BrowserViewInfo>()
  private mainWindow: BrowserWindow | null = null
  private sessionInitialized = false
  private rememberCookies = true

  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.initSession()
  }

  create(id: string, url?: string): { success: boolean; id: string; error?: string } {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return { success: false, id, error: 'Main window is not initialized' }
    }
    if (this.views.has(id)) {
      return { success: false, id, error: `Browser view ${id} already exists` }
    }

    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: BROWSER_PARTITION,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true
      }
    })

    const info: BrowserViewInfo = {
      view,
      attached: false,
      isFullscreen: false,
      savedBounds: null
    }
    this.views.set(id, info)
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    this.setupEventForwarding(id, info)

    if (url && url !== 'about:blank') {
      void view.webContents.loadURL(url)
    }

    return { success: true, id }
  }

  destroy(id: string): boolean {
    const info = this.views.get(id)
    if (!info) return false

    try {
      if (info.attached && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.contentView.removeChildView(info.view)
      }
    } catch {
      // Ignore detach failures during shutdown.
    }

    info.attached = false

    try {
      if (!info.view.webContents.isDestroyed()) {
        info.view.webContents.close()
      }
    } catch {
      // Ignore destroy failures during shutdown.
    }

    this.views.delete(id)
    if (this.views.size === 0 && !this.rememberCookies) {
      void this.clearCookies().catch(() => {
        // Ignore cookie cleanup failures during browser view teardown.
      })
    }
    return true
  }

  navigate(id: string, input: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false

    const normalizedUrl = this.normalizeUrl(input)
    if (!normalizedUrl) return false

    void info.view.webContents.loadURL(normalizedUrl)
    return true
  }

  goBack(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    if (!info.view.webContents.navigationHistory.canGoBack()) return false
    info.view.webContents.navigationHistory.goBack()
    return true
  }

  goForward(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    if (!info.view.webContents.navigationHistory.canGoForward()) return false
    info.view.webContents.navigationHistory.goForward()
    return true
  }

  reload(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    info.view.webContents.reload()
    return true
  }

  stop(id: string): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false
    info.view.webContents.stop()
    return true
  }

  setBounds(id: string, rect: { x: number; y: number; width: number; height: number }): boolean {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return false

    if (info.isFullscreen) {
      info.savedBounds = rect
      return true
    }

    info.view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
    return true
  }

  show(id: string): boolean {
    const info = this.views.get(id)
    if (!info || !this.mainWindow || this.mainWindow.isDestroyed()) return false
    if (info.attached) return true

    try {
      this.mainWindow.contentView.addChildView(info.view)
      info.attached = true
      return true
    } catch {
      return false
    }
  }

  hide(id: string): boolean {
    const info = this.views.get(id)
    if (!info || !this.mainWindow || this.mainWindow.isDestroyed()) return false
    if (!info.attached) return true

    try {
      this.mainWindow.contentView.removeChildView(info.view)
      info.attached = false
      return true
    } catch {
      return false
    }
  }

  getNavState(id: string): {
    canGoBack: boolean
    canGoForward: boolean
    url: string
    title: string
    isLoading: boolean
  } | null {
    const info = this.views.get(id)
    if (!info || info.view.webContents.isDestroyed()) return null

    const wc = info.view.webContents
    return {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      url: wc.getURL(),
      title: wc.getTitle(),
      isLoading: wc.isLoading()
    }
  }

  async clearCookies(maxAge?: number): Promise<{ removed: number }> {
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    const cookies = await browserSession.cookies.get({})

    if (!maxAge) {
      await browserSession.clearStorageData({ storages: ['cookies'] })
      return { removed: cookies.length }
    }

    const cutoff = Date.now() / 1000 - maxAge
    let removed = 0
    for (const cookie of cookies) {
      if (!cookie.expirationDate || cookie.expirationDate >= cutoff || !cookie.domain) {
        continue
      }

      const cookieUrl = `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`
      try {
        await browserSession.cookies.remove(cookieUrl, cookie.name)
        removed += 1
      } catch {
        // Ignore per-cookie removal failures and continue clearing the rest.
      }
    }

    return { removed }
  }

  setRememberCookies(rememberCookies: boolean): { rememberCookies: boolean } {
    this.rememberCookies = rememberCookies
    return { rememberCookies: this.rememberCookies }
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) {
      this.destroy(id)
    }
  }

  private initSession(): void {
    if (this.sessionInitialized) return
    this.sessionInitialized = true

    const browserSession = session.fromPartition(BROWSER_PARTITION)

    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
    browserSession.on('will-download', (event) => {
      event.preventDefault()
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      if (!isAllowedUrl(details.url)) {
        callback({ cancel: true })
        return
      }
      callback({})
    })
  }

  private setupEventForwarding(id: string, info: BrowserViewInfo): void {
    const wc = info.view.webContents
    const send = (channel: string, ...args: unknown[]) => {
      try {
        this.mainWindow?.webContents.send(channel, id, ...args)
      } catch {
        // Ignore renderer shutdown races.
      }
    }

    wc.setWindowOpenHandler((details) => {
      if (isAllowedUrl(details.url)) {
        void wc.loadURL(details.url)
      }
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      if (!isAllowedUrl(url)) {
        event.preventDefault()
      }
    })

    wc.on('will-frame-navigate', (event, details: unknown) => {
      const url = typeof details === 'string'
        ? details
        : typeof (details as { url?: unknown })?.url === 'string'
          ? (details as { url: string }).url
          : null
      if (url && !isAllowedUrl(url)) {
        event.preventDefault()
      }
    })

    wc.on('did-navigate', (_event, url) => {
      send('browser:url-changed', url)
      this.sendNavState(id)
    })

    wc.on('did-navigate-in-page', (_event, url) => {
      send('browser:url-changed', url)
      this.sendNavState(id)
    })

    wc.on('page-title-updated', (_event, title) => {
      send('browser:title-changed', title)
    })

    wc.on('did-start-loading', () => {
      send('browser:loading-changed', true)
      this.sendNavState(id)
    })

    wc.on('did-stop-loading', () => {
      send('browser:loading-changed', false)
      this.sendNavState(id)
    })

    wc.on('enter-html-full-screen', () => {
      if (!this.mainWindow || this.mainWindow.isDestroyed()) return

      info.isFullscreen = true
      info.savedBounds = info.view.getBounds()
      const contentBounds = this.mainWindow.getContentBounds()
      info.view.setBounds({
        x: 0,
        y: 0,
        width: contentBounds.width,
        height: contentBounds.height
      })
      send('browser:fullscreen-changed', true)
    })

    wc.on('leave-html-full-screen', () => {
      info.isFullscreen = false
      if (info.savedBounds) {
        info.view.setBounds(info.savedBounds)
        info.savedBounds = null
      }
      send('browser:fullscreen-changed', false)
    })

    wc.on('before-input-event', (event, input) => {
      if (
        input.type === 'keyDown' &&
        input.key === 'Escape' &&
        !input.meta &&
        !input.control &&
        !input.alt
      ) {
        if (!info.isFullscreen) {
          send('browser:escape-pressed')
          event.preventDefault()
        }
      }
    })
  }

  private sendNavState(id: string): void {
    const navState = this.getNavState(id)
    if (!navState) return

    try {
      this.mainWindow?.webContents.send('browser:nav-state-changed', id, {
        canGoBack: navState.canGoBack,
        canGoForward: navState.canGoForward
      })
    } catch {
      // Ignore renderer shutdown races.
    }
  }

  private normalizeUrl(input: string): string | null {
    const trimmed = input.trim()
    if (!trimmed) return null
    if (trimmed === 'about:blank') return trimmed

    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return new URL(trimmed).toString()
      } catch {
        return null
      }
    }

    if (/^(localhost|[\d.]+)(:\d+)?(\/.*)?$/i.test(trimmed) || /^[^\s]+\.[^\s]+$/.test(trimmed)) {
      try {
        return new URL(`https://${trimmed}`).toString()
      } catch {
        return null
      }
    }

    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
}

export const browserViewManager = new BrowserViewManager()
