/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Suppress EPIPE errors on stdout/stderr when the parent process closes the pipe
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return
    throw err
  })
}

import { app, BrowserWindow, nativeImage, Menu, dialog } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { registerIpcHandlers, cleanupIpcHandlers, setupWindowShortcuts } from './ipc-handlers'
import { getTrayManager } from './tray-manager'
import { getAppInfo, initializeAppIdentity } from './app-info'
import { ptyManager } from './pty-manager'
import { isSameAppNavigation, openExternalUrlWithConfirm } from './external-link-guard'
import { startApiServer, stopApiServer } from './api-server'
import { tMain } from './localization'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

if (process.env.ONWARD_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

// Exit confirmation dialog (exported for use by tray-manager)
export async function confirmQuit(): Promise<boolean> {
  const { displayName } = getAppInfo()
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [tMain('common.cancel'), tMain('menu.quitApp', { displayName })],
    defaultId: 0,
    cancelId: 0,
    title: tMain('dialog.quit.title', { displayName }),
    message: tMain('dialog.quit.message', { displayName }),
    detail: tMain('dialog.quit.detail')
  })
  return response === 1
}

// Exit the request entry in a unified manner to ensure that the confirmation box only pops up once
export async function requestQuit(): Promise<void> {
  if (isQuitting) return
  if (await confirmQuit()) {
    isQuitting = true
    const shutdownResult = await ptyManager.shutdownAll()
    if (shutdownResult.timedOut > 0) {
      console.warn(
        `[PTY] shutdown timed out: ${shutdownResult.timedOut}/${shutdownResult.total}`
      )
    }
    app.quit()
  }
}

// Build menu template
function buildMenuTemplate(displayName: string): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    // macOS: Custom appMenu (for custom exit behavior)
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: tMain('menu.quitApp', { displayName }),
          accelerator: 'CommandOrControl+Q',
          click: async () => {
            await requestQuit()
          }
        }
      ]
    })
  }

  // All platforms: Added Edit menu (uses system role, enables standard editing shortcuts)
  template.push({ role: 'editMenu' })

  return template
}

// Get application icon path
function getIconPath(): string {
  // In development mode, __dirname is out/main, so you need to go up two levels to the project root directory
  const resourcesPath = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources')

  if (process.platform === 'win32') {
    return join(resourcesPath, 'icon.ico')
  }
  // macOS and Linux both use PNG
  return join(resourcesPath, 'icon.png')
}

function createWindow(displayName: string): void {
  const iconPath = getIconPath()
  const shouldLog = process.env.ONWARD_DEBUG === '1' || process.env.ELECTRON_ENABLE_LOGGING === '1'
  const log = (...args: unknown[]) => {
    if (shouldLog) {
      console.log(...args)
    }
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    icon: iconPath,
    title: displayName,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false // Required for node-pty
    }
  })

  mainWindow.on('ready-to-show', () => {
    log('[Window] ready-to-show')
    mainWindow?.show()
  })

  if (mainWindow.webContents) {
    mainWindow.webContents.on('did-finish-load', async () => {
      log('[Window] did-finish-load', mainWindow?.webContents.getURL())
      if (shouldLog && mainWindow) {
        const logDomInfo = async (label: string) => {
          try {
            const info = await mainWindow.webContents.executeJavaScript(`(() => {
              const root = document.getElementById('root')
              const rootRect = root ? root.getBoundingClientRect() : null
              const bodyStyle = window.getComputedStyle(document.body)
              const rootStyle = root ? window.getComputedStyle(root) : null
              return {
                title: document.title,
                hasElectronAPI: typeof window.electronAPI !== 'undefined',
                rootChildCount: root ? root.childElementCount : -1,
                rootText: root?.innerText?.slice(0, 200) ?? '',
                rootRect: rootRect ? {
                  width: Math.round(rootRect.width),
                  height: Math.round(rootRect.height)
                } : null,
                styleSheetsCount: document.styleSheets.length,
                bodyBg: bodyStyle.backgroundColor,
                bodyColor: bodyStyle.color,
                rootColor: rootStyle?.color ?? null,
                bodyOpacity: bodyStyle.opacity,
                rootOpacity: rootStyle?.opacity ?? null,
                rootVisibility: rootStyle?.visibility ?? null
              }
            })()`, true)
            log(`[Window] dom-info ${label}`, info)
          } catch (error) {
            log(`[Window] dom-info ${label} error`, error)
          }
        }

        await logDomInfo('t=0')
        setTimeout(() => void logDomInfo('t=1000'), 1000)
        setTimeout(() => void logDomInfo('t=3000'), 3000)
      }

      if (process.env.ONWARD_DEBUG_CAPTURE === '1' && mainWindow) {
        const capture = (label: string, delay: number) => {
          setTimeout(async () => {
            try {
              const image = await mainWindow.webContents.capturePage()
              const outputPath = join(app.getPath('temp'), `onward-debug-${label}.png`)
              writeFileSync(outputPath, image.toPNG())
              log('[Window] capturePage saved', outputPath)
            } catch (error) {
              log('[Window] capturePage error', error)
            }
          }, delay)
        }

        capture('t1', 1500)
        capture('t2', 5000)
      }
    })
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log('[Window] did-fail-load', { errorCode, errorDescription, validatedURL })
    })
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log('[Window] render-process-gone', details)
    })
    mainWindow.webContents.on('unresponsive', () => {
      log('[Window] renderer unresponsive')
    })
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      log('[Renderer]', { level, message, line, sourceId })
    })
  }

  // macOS: Intercept close event, hide window instead of closing
  mainWindow.on('close', (e) => {
    if (isQuitting) return

    if (process.platform === 'darwin') {
      e.preventDefault()
      mainWindow?.hide()
      app.dock?.hide()
      return
    }

    // Windows / Linux: Confirm to exit before closing the window
    e.preventDefault()
    void requestQuit()
  })

  mainWindow.webContents.on('will-navigate', (event, nextUrl) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (isSameAppNavigation(currentUrl, nextUrl)) {
      return
    }
    event.preventDefault()
    void openExternalUrlWithConfirm(mainWindow, nextUrl)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalUrlWithConfirm(mainWindow, details.url)
    return { action: 'deny' }
  })

  // Register IPC handlers
  registerIpcHandlers(mainWindow, {
    onSettingsChanged: () => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(displayName)))
    }
  })

  // Set up window shortcuts (before-input-event)
  setupWindowShortcuts(mainWindow)

  // Load the app
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const appInfo = initializeAppIdentity()

  // Set up the application menu (contains the Edit menu to enable standard editing shortcuts)
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(appInfo.displayName)))

  // Set macOS Dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath()
    console.log('[Dock] Icon path:', iconPath)

    const fs = require('fs')
    console.log('[Dock] File exists:', fs.existsSync(iconPath))

    const icon = nativeImage.createFromPath(iconPath)
    console.log('[Dock] Icon size:', icon.getSize())

    if (!icon.isEmpty()) {
      app.dock.setIcon(icon)
      console.log('[Dock] Icon set!')
    } else {
      console.log('[Dock] Icon is empty, not setting')
    }
  }

  createWindow(appInfo.displayName)

  // Initialize system tray
  if (mainWindow) {
    getTrayManager().init(mainWindow, appInfo.displayName)
  }

  // Start HTTP API Server (for use by onward-bridge CLI)
  if (mainWindow) {
    startApiServer(mainWindow).catch((error) => {
      console.error('[API Server] Failed to start:', error)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else if (mainWindow) {
      // macOS: Show window when clicking Dock icon
      getTrayManager().showWindow()
    }
  })
})

app.on('window-all-closed', () => {
  cleanupIpcHandlers()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (e) => {
  // If you have confirmed to exit, continue directly.
  if (isQuitting) return

  // Prevent default exit and show confirmation dialog
  e.preventDefault()

  await requestQuit()
})

// Move the cleanup logic to will-quit (it will be triggered after confirming the exit)
app.on('will-quit', () => {
  stopApiServer()
  cleanupIpcHandlers()
  getTrayManager().destroy()
})
