/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react'
import { TabItem } from './TabItem'
import { useAppState } from '../../hooks/useAppState'
import { useI18n } from '../../i18n/useI18n'
import './TabBar.css'

interface ConfirmDialogState {
  isOpen: boolean
  tabId: string
  tabName: string
}

export function TabBar() {
  const { t } = useI18n()
  const {
    state,
    createTab,
    closeTab,
    switchTab,
    renameTab,
    reorderTabs,
    canCreateTab,
    getTabDisplayName,
    hasRunningTerminals
  } = useAppState()
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    isOpen: false,
    tabId: '',
    tabName: ''
  })
  const [appName, setAppName] = useState('Onward 2')
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)

  const platform = window.electronAPI.platform

  useEffect(() => {
    let isActive = true
    window.electronAPI.appInfo.get()
      .then((info) => {
        if (isActive && info?.displayName) {
          setAppName(info.displayName)
        }
      })
      .catch(() => {})
    return () => {
      isActive = false
    }
  }, [])

  const highlightName = appName.startsWith('Onward') ? 'Onward' : null
  const restName = highlightName ? appName.slice(highlightName.length) : appName

  const handleCloseTab = (tabId: string, tabIndex: number) => {
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab) return

    // If there is a running terminal, display a confirmation dialog box
    if (hasRunningTerminals(tabId)) {
      setConfirmDialog({
        isOpen: true,
        tabId,
        tabName: getTabDisplayName(tab, tabIndex)
      })
      return
    }

    closeTab(tabId)
  }

  // Handle drag start
  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index)
  }, [])

  // Handling drag-and-drop entry
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== index) {
      setDragOverIndex(index)
    }
  }, [draggedIndex])

  // Handle drag and leave
  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null)
  }, [])

  // Handle placement
  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault()
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderTabs(draggedIndex, toIndex)
    }
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [draggedIndex, reorderTabs])

  // Process drag end
  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [])

  const handleConfirmClose = () => {
    closeTab(confirmDialog.tabId)
    setConfirmDialog({ isOpen: false, tabId: '', tabName: '' })
  }

  const handleCancelClose = () => {
    setConfirmDialog({ isOpen: false, tabId: '', tabName: '' })
  }

  return (
    <>
      <div className={`tab-bar platform-${platform}`}>
        {/* Left placeholder: macOS window button */}
        <div className="tab-bar-left">
          <div className="tab-bar-traffic-lights" />
        </div>

        {/* Middle area: LOGO + Tab list (centered) */}
        <div className="tab-bar-center">
          {/* Application title */}
          <div className="tab-bar-title">
            {highlightName ? (
              <span className="app-name"><span className="app-name-highlight">{highlightName}</span>{restName}</span>
            ) : (
              <span className="app-name">{appName}</span>
            )}
          </div>

          {/* Tab list */}
          <div className="tab-list">
            {state.tabs.map((tab, index) => (
              <TabItem
                key={tab.id}
                name={getTabDisplayName(tab, index)}
                customName={tab.customName}
                isActive={tab.id === state.activeTabId}
                isOnly={state.tabs.length === 1}
                isDragOver={dragOverIndex === index}
                isDragging={draggedIndex === index}
                onSelect={() => switchTab(tab.id)}
                onClose={() => handleCloseTab(tab.id, index)}
                onRename={(customName) => renameTab(tab.id, customName)}
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
              />
            ))}
          </div>

          {/* New Tab button */}
          <button
            className={`tab-add-btn ${!canCreateTab() ? 'disabled' : ''}`}
            onClick={() => createTab()}
            disabled={!canCreateTab()}
            title={canCreateTab() ? t('tabBar.newTab') : t('tabBar.maxTabsReached')}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
              <path d="M7.5 3v3.5H11v1H7.5V11h-1V7.5H3v-1h3.5V3h1z" />
            </svg>
          </button>
        </div>

        {/* Right placeholder: drag area */}
        <div className="tab-bar-right">
          <div className="tab-bar-drag-region" />
        </div>
      </div>

      {/* Confirm to close dialog */}
      {confirmDialog.isOpen && (
        <div className="confirm-dialog-overlay" onClick={handleCancelClose}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-dialog-title">{t('tabBar.confirmClose.title', { tabName: confirmDialog.tabName })}</div>
            <div className="confirm-dialog-message">
              {t('tabBar.confirmClose.message')}
            </div>
            <div className="confirm-dialog-actions">
              <button className="confirm-dialog-btn cancel" onClick={handleCancelClose}>
                {t('common.cancel')}
              </button>
              <button className="confirm-dialog-btn confirm" onClick={handleConfirmClose}>
                {t('tabBar.confirmClose.action')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
