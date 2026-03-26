/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { getTheme, ThemeName } from '../../themes/terminal-themes'
import { DEFAULT_TERMINAL_FONT_SIZE, DEFAULT_TERMINAL_FONT_FAMILY } from '../../constants/terminal'
import { requestOpenExternalHttpLink } from '../../utils/externalLink'
import { useI18n } from '../../i18n/useI18n'
import '@xterm/xterm/css/xterm.css'
import './Terminal.css'

interface TerminalProps {
  id: string
  isActive: boolean
  theme?: ThemeName
  fontSize?: number
  fontFamily?: string
}

export function Terminal({
  id,
  isActive,
  theme = 'vscode-dark',
  fontSize = DEFAULT_TERMINAL_FONT_SIZE,
  fontFamily = DEFAULT_TERMINAL_FONT_FAMILY
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const isInitialized = useRef(false)
  const { t } = useI18n()

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)

  const fit = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current && isActive) {
      try {
        fitAddonRef.current.fit()
        const { cols, rows } = terminalRef.current
        window.electronAPI.terminal.resize(id, cols, rows)
      } catch (e) {
        // Ignore fit errors during transitions
      }
    }
  }, [id, isActive])

  // Context menu action handlers
  const handleCopy = useCallback(() => {
    const selection = terminalRef.current?.getSelection()
    if (selection) {
      void navigator.clipboard.writeText(selection)
      terminalRef.current?.clearSelection()
    }
    setContextMenu(null)
  }, [])

  const handlePaste = useCallback(() => {
    void navigator.clipboard.readText().then((text) => {
      if (text && terminalRef.current) {
        // Use xterm.js paste() so bracketed paste mode is applied when
        // the child program supports it (e.g. Claude Code, zsh, fish).
        terminalRef.current.paste(text)
      }
    })
    setContextMenu(null)
    terminalRef.current?.focus()
  }, [])

  const handleSelectAll = useCallback(() => {
    terminalRef.current?.selectAll()
    setContextMenu(null)
  }, [])

  const handleClear = useCallback(() => {
    terminalRef.current?.clear()
    setContextMenu(null)
    terminalRef.current?.focus()
  }, [])

  // Close context menu on mousedown outside
  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = () => setContextMenu(null)
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [contextMenu])

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || isInitialized.current) return

    const terminal = new XTerm({
      theme: getTheme(theme),
      fontSize,
      fontFamily,
      cursorBlink: true,
      cursorStyle: 'block',
      allowProposedApi: true,
      scrollback: 10000,
      tabStopWidth: 4,
      rightClickSelectsWord: true
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      void requestOpenExternalHttpLink(uri).then((result) => {
        if (!result.success && result.error && !result.canceled && !result.blocked) {
          console.warn('[Terminal] Failed to open external link:', result.error)
        }
      })
    })
    const searchAddon = new SearchAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)

    // Windows/Linux: Ctrl+C copies selected text, otherwise sends interrupt;
    // Ctrl+V pastes from clipboard. On macOS Cmd+C/V handle copy/paste
    // natively, so we leave Ctrl+C as pure SIGINT.
    const isMac = /Mac OS X|Macintosh/.test(navigator.userAgent)
    if (!isMac) {
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true

        // Ctrl+C: copy selected text or send interrupt
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === 'c') {
          const selection = terminal.getSelection()
          if (selection) {
            void navigator.clipboard.writeText(selection)
            terminal.clearSelection()
            return false // prevent sending Ctrl+C to PTY
          }
          // No selection: let Ctrl+C pass through as interrupt
          return true
        }

        // Ctrl+V: paste from clipboard through xterm.js paste mechanism
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === 'v') {
          event.preventDefault()
          void navigator.clipboard.readText().then((text) => {
            if (text && terminal) {
              terminal.paste(text)
            }
          })
          return false // prevent default browser paste
        }

        return true
      })
    }

    terminal.open(containerRef.current)

    // Try to load WebGL addon for better performance
    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
    } catch (e) {
      console.warn('WebGL addon failed to load, using canvas renderer')
    }

    // Right-click context menu (attached on container to capture all xterm sub-elements)
    const container = containerRef.current
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const hasSelection = !!terminal.getSelection()
      setContextMenu({ x: e.clientX, y: e.clientY, hasSelection })
    }
    container.addEventListener('contextmenu', onContextMenu)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon
    isInitialized.current = true


    // Fit after initial render
    requestAnimationFrame(() => {
      fitAddon.fit()
      const { cols, rows } = terminal

      // Create PTY
      window.electronAPI.terminal.create(id, { cols, rows })
    })

    // Handle user input
    terminal.onData((data) => {
      window.electronAPI.terminal.write(id, data)
    })

    // Handle PTY output
    const unsubscribeData = window.electronAPI.terminal.onData((termId, data) => {
      if (termId === id && terminalRef.current) {
        terminalRef.current.write(data)
      }
    })

    // Handle PTY exit
    const unsubscribeExit = window.electronAPI.terminal.onExit((termId, exitCode) => {
      if (termId === id && terminalRef.current) {
        terminalRef.current.writeln(`\r\n[Process exited with code ${exitCode}]`)
      }
    })

    // Cleanup
    return () => {
      container.removeEventListener('contextmenu', onContextMenu)
      unsubscribeData()
      unsubscribeExit()
      window.electronAPI.terminal.dispose(id)
      terminal.dispose()
      isInitialized.current = false
    }
  }, [id, theme, fontSize, fontFamily])

  // Handle resize
  useEffect(() => {
    if (!isActive) return

    const handleResize = () => {
      fit()
    }

    window.addEventListener('resize', handleResize)

    // Fit when becoming active
    requestAnimationFrame(fit)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [isActive, fit])

  // Handle theme changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = getTheme(theme)
    }
  }, [theme])

  // Focus terminal when active
  useEffect(() => {
    if (isActive && terminalRef.current) {
      terminalRef.current.focus()
    }
  }, [isActive])

  return (
    <>
      <div
        ref={containerRef}
        className={`terminal-container ${isActive ? 'active' : 'hidden'}`}
      />
      {contextMenu && createPortal(
        <div
          className="terminal-context-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="terminal-context-item"
            onClick={handleCopy}
            disabled={!contextMenu.hasSelection}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6z" /><path d="M2 6a2 2 0 0 1 2-2v1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1h1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" /></svg>
            <span>{t('terminal.contextMenu.copy')}</span>
          </button>
          <button
            className="terminal-context-item"
            onClick={handlePaste}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M10 1.5a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-1zM5 1a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V1z" /><path d="M3 2.5A1.5 1.5 0 0 1 4.5 1h.585A1.98 1.98 0 0 0 5 2v1a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2c0-.068-.004-.135-.011-.2H11.5A1.5 1.5 0 0 1 13 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-11z" /></svg>
            <span>{t('terminal.contextMenu.paste')}</span>
          </button>
          <div className="terminal-context-separator" />
          <button
            className="terminal-context-item"
            onClick={handleSelectAll}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM0 2a2 2 0 0 1 3.937-.5H5.25a.75.75 0 0 1 0 1.5H3.937A2 2 0 0 1 0 2zm2 11a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm-2-1a2 2 0 0 0 3.937.5h6.126A2 2 0 1 0 12.5 10.063V5.937A2 2 0 1 0 12.063 3.5H5.937A2 2 0 0 0 2 .063v6.126A2 2 0 0 0 0 12zm12 2a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm1-13a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" /></svg>
            <span>{t('terminal.contextMenu.selectAll')}</span>
          </button>
          <button
            className="terminal-context-item"
            onClick={handleClear}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4L4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
            <span>{t('terminal.contextMenu.clear')}</span>
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
