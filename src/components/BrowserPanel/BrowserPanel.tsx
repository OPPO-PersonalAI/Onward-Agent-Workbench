/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/useI18n'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import './BrowserPanel.css'

interface BrowserPanelProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  initialUrl?: string | null
  onUrlChange?: (url: string) => void
  forceHidden?: boolean
  isActive?: boolean
}

let browserIdCounter = 0
let sharedRememberCookies = true
const rememberCookiesSubscribers = new Set<(rememberCookies: boolean) => void>()

function subscribeRememberCookies(callback: (rememberCookies: boolean) => void): () => void {
  rememberCookiesSubscribers.add(callback)
  return () => {
    rememberCookiesSubscribers.delete(callback)
  }
}

function updateSharedRememberCookies(next: boolean): void {
  sharedRememberCookies = next
  for (const callback of rememberCookiesSubscribers) {
    callback(next)
  }
}

export function BrowserPanel({
  isOpen,
  onClose,
  terminalId,
  initialUrl,
  onUrlChange,
  forceHidden = false,
  isActive = true
}: BrowserPanelProps) {
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [inputUrl, setInputUrl] = useState('')
  const [title, setTitle] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isViewReady, setIsViewReady] = useState(false)
  const [hasVisibleView, setHasVisibleView] = useState(false)
  const [rememberCookies, setRememberCookies] = useState(sharedRememberCookies)

  const placeholderRef = useRef<HTMLDivElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number>(0)
  const browserIdRef = useRef<string | null>(null)
  const forceHiddenRef = useRef(forceHidden)
  const hasVisibleViewRef = useRef(false)

  useSubpageEscape({ isOpen: isOpen && !forceHidden && isActive, onEscape: onClose })

  useEffect(() => {
    setRememberCookies(sharedRememberCookies)
    return subscribeRememberCookies(setRememberCookies)
  }, [])

  const syncBounds = useCallback(() => {
    const id = browserIdRef.current
    const placeholder = placeholderRef.current
    if (!id || !placeholder) return

    if (forceHiddenRef.current || !hasVisibleViewRef.current) {
      void window.electronAPI.browser.hide(id)
      return
    }

    const rect = placeholder.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      void window.electronAPI.browser.hide(id)
      return
    }

    void window.electronAPI.browser.show(id)
    void window.electronAPI.browser.setBounds(id, {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }, [])

  const scheduleSyncBounds = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = requestAnimationFrame(syncBounds)
  }, [syncBounds])

  useEffect(() => {
    forceHiddenRef.current = forceHidden
    if (isOpen && isViewReady) {
      scheduleSyncBounds()
    }
  }, [forceHidden, isOpen, isViewReady, scheduleSyncBounds])

  useEffect(() => {
    hasVisibleViewRef.current = hasVisibleView
    if (isOpen && isViewReady) {
      scheduleSyncBounds()
    }
  }, [hasVisibleView, isOpen, isViewReady, scheduleSyncBounds])

  useEffect(() => {
    if (!isOpen) return

    const id = `browser-${terminalId}-${++browserIdCounter}`
    const startUrl = (initialUrl ?? '').trim()
    const shouldShowView = startUrl.length > 0

    browserIdRef.current = id
    setUrl(startUrl)
    setInputUrl(startUrl)
    setTitle('')
    setIsLoading(shouldShowView)
    setCanGoBack(false)
    setCanGoForward(false)
    setIsFullscreen(false)
    setIsViewReady(false)
    setHasVisibleView(shouldShowView)
    hasVisibleViewRef.current = shouldShowView

    window.electronAPI.browser.create(id, startUrl || undefined).then((result) => {
      if (browserIdRef.current !== id || !result.success) return
      setIsViewReady(true)
      requestAnimationFrame(() => {
        syncBounds()
        requestAnimationFrame(syncBounds)
      })
    })

    return () => {
      browserIdRef.current = null
      hasVisibleViewRef.current = false
      setIsViewReady(false)
      setHasVisibleView(false)
      window.electronAPI.browser.destroy(id).catch(() => {
        // Ignore destroy races during teardown.
      })
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isOpen, syncBounds, terminalId])

  useEffect(() => {
    if (!isOpen || !isViewReady) return

    const placeholder = placeholderRef.current
    if (!placeholder) return

    const observer = new ResizeObserver(scheduleSyncBounds)
    observer.observe(placeholder)
    window.addEventListener('resize', scheduleSyncBounds)
    scheduleSyncBounds()

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleSyncBounds)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isOpen, isViewReady, scheduleSyncBounds])

  useEffect(() => {
    if (!isOpen) return

    const unsubUrl = window.electronAPI.browser.onUrlChanged((id, nextUrl) => {
      if (id !== browserIdRef.current) return
      setUrl(nextUrl)
      setInputUrl(nextUrl)
      onUrlChange?.(nextUrl)
      const shouldShowView = nextUrl.trim() !== '' && nextUrl !== 'about:blank'
      setHasVisibleView(shouldShowView)
    })

    const unsubTitle = window.electronAPI.browser.onTitleChanged((id, nextTitle) => {
      if (id !== browserIdRef.current) return
      setTitle(nextTitle)
    })

    const unsubLoading = window.electronAPI.browser.onLoadingChanged((id, loading) => {
      if (id !== browserIdRef.current) return
      setIsLoading(loading)
    })

    const unsubNav = window.electronAPI.browser.onNavStateChanged((id, state) => {
      if (id !== browserIdRef.current) return
      setCanGoBack(state.canGoBack)
      setCanGoForward(state.canGoForward)
    })

    const unsubFullscreen = window.electronAPI.browser.onFullscreenChanged((id, fullscreen) => {
      if (id !== browserIdRef.current) return
      setIsFullscreen(fullscreen)
      if (!fullscreen) {
        requestAnimationFrame(syncBounds)
      }
    })

    const unsubEscape = window.electronAPI.browser.onEscapePressed((id) => {
      if (id !== browserIdRef.current) return
      onClose()
    })

    return () => {
      unsubUrl()
      unsubTitle()
      unsubLoading()
      unsubNav()
      unsubFullscreen()
      unsubEscape()
    }
  }, [isOpen, onClose, onUrlChange, syncBounds])

  const handleNavigate = useCallback(async (targetUrl: string) => {
    const id = browserIdRef.current
    if (!id || !targetUrl.trim()) return

    const success = await window.electronAPI.browser.navigate(id, targetUrl.trim())
    if (success) {
      setHasVisibleView(true)
      scheduleSyncBounds()
    }
  }, [scheduleSyncBounds])

  const handleGoBack = useCallback(() => {
    const id = browserIdRef.current
    if (id) {
      void window.electronAPI.browser.goBack(id)
    }
  }, [])

  const handleGoForward = useCallback(() => {
    const id = browserIdRef.current
    if (id) {
      void window.electronAPI.browser.goForward(id)
    }
  }, [])

  const handleReload = useCallback(() => {
    const id = browserIdRef.current
    if (!id) return

    if (isLoading) {
      void window.electronAPI.browser.stop(id)
      return
    }

    void window.electronAPI.browser.reload(id)
  }, [isLoading])

  const handleShowCookieMenu = useCallback(async () => {
    const result = await window.electronAPI.browser.showCookieMenu({
      rememberCookies,
      labels: {
        remember: t('browserPanel.rememberCookies'),
        clearDay: t('browserPanel.clearCookiesDay'),
        clearWeek: t('browserPanel.clearCookiesWeek'),
        clearAll: t('browserPanel.clearCookiesAll')
      }
    })
    if (!result) return

    if (result.action === 'toggleRemember') {
      const next = result.rememberCookies ?? false
      updateSharedRememberCookies(next)
      void window.electronAPI.browser.setRememberCookies(next)
    } else if (result.action === 'clear') {
      void window.electronAPI.browser.clearCookies(86400)
    } else if (result.action === 'clearWeek') {
      void window.electronAPI.browser.clearCookies(604800)
    } else if (result.action === 'clearAll') {
      void window.electronAPI.browser.clearCookies()
    }
  }, [rememberCookies, t])

  if (!isOpen) return null

  return (
    <div className={`browser-panel-cell${isFullscreen ? ' fullscreen' : ''}`}>
      <div className="browser-panel-nav">
        <button
          className="browser-panel-nav-btn"
          onClick={handleGoBack}
          disabled={!canGoBack}
          title={t('browserPanel.back')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z" />
          </svg>
        </button>

        <button
          className="browser-panel-nav-btn"
          onClick={handleGoForward}
          disabled={!canGoForward}
          title={t('browserPanel.forward')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>

        <button
          className="browser-panel-nav-btn"
          onClick={handleReload}
          title={isLoading ? t('browserPanel.stop') : t('browserPanel.reload')}
        >
          {isLoading ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 0-.192.41l1.966 2.36a.25.25 0 0 0 .384 0l1.966-2.36A.25.25 0 0 0 4.466 9z" />
              <path d="M8 3a5 5 0 0 1 4.546 2.914.5.5 0 1 0 .908-.428A6 6 0 0 0 2.11 5.84L1.58 4.39A.5.5 0 0 0 .64 4.61l1.2 3.6a.5.5 0 0 0 .638.316l3.6-1.2a.5.5 0 1 0-.316-.948L3.9 7.077A5 5 0 0 1 8 3zm6.42 5.39a.5.5 0 0 0-.638-.316l-3.6 1.2a.5.5 0 1 0 .316.948l1.862-.62A5 5 0 0 1 8 13a5 5 0 0 1-4.546-2.914.5.5 0 0 0-.908.428A6 6 0 0 0 13.89 10.16l.53 1.45a.5.5 0 1 0 .94-.22l-1.2-3.6a.5.5 0 0 0-.26-.28z" />
            </svg>
          )}
        </button>

        <input
          ref={urlInputRef}
          className="browser-panel-url-input"
          type="text"
          value={inputUrl}
          onChange={(event) => setInputUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void handleNavigate(inputUrl)
              urlInputRef.current?.blur()
            } else if (event.key === 'Escape') {
              event.stopPropagation()
              urlInputRef.current?.blur()
            }
          }}
          onFocus={(event) => event.target.select()}
          placeholder={t('browserPanel.urlPlaceholder')}
          spellCheck={false}
          title={title || url || ''}
        />

        <button
          className="browser-panel-nav-btn"
          onClick={handleShowCookieMenu}
          title={t('browserPanel.cookieMenu')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M6 7.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm4.5.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm-.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z" />
            <path d="M8 0a7.963 7.963 0 0 0-4.075 1.114c-.162.067-.31.175-.437.32A8 8 0 1 0 8 0zm3.25 14.201A6.97 6.97 0 0 1 8 15a6.97 6.97 0 0 1-3.25-.799 7.024 7.024 0 0 1-2.578-2.17A6.96 6.96 0 0 1 1 8c0-1.235.32-2.395.883-3.403A7.018 7.018 0 0 1 8 1a7.018 7.018 0 0 1 6.117 3.597A6.96 6.96 0 0 1 15 8a6.96 6.96 0 0 1-1.172 3.88 7.026 7.026 0 0 1-2.578 2.321z" />
          </svg>
        </button>

        <button className="browser-panel-nav-btn close-btn" onClick={onClose} title={t('browserPanel.close')}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      </div>

      {isLoading && <div className="browser-panel-loading-bar" />}

      <div ref={placeholderRef} className="browser-panel-placeholder">
        {!isViewReady && (
          <div className="browser-panel-placeholder-hint">
            {t('browserPanel.initializing')}
          </div>
        )}
        {isViewReady && !hasVisibleView && !isLoading && (
          <div className="browser-panel-placeholder-hint">
            {t('browserPanel.startBrowsing')}
          </div>
        )}
      </div>
    </div>
  )
}
