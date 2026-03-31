/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { ShortcutInput } from './ShortcutInput'
import { ColorPicker } from './ColorPicker'
import { FontSelector } from './FontSelector'
import { NumberInput } from './NumberInput'
import { ThemeSelector } from './ThemeSelector'
import { DEFAULT_TERMINAL_FONT_SIZE, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE } from '../../constants/terminal'
import { DEFAULT_GIT_DIFF_FONT_SIZE, MIN_GIT_DIFF_FONT_SIZE, MAX_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import type { ShortcutConfig, TerminalStyleConfig, GlobalTerminalStyle } from '../../types/settings'
import type { TranslationKey } from '../../i18n/core'
import { useI18n } from '../../i18n/useI18n'
import './Settings.css'

interface SettingsProps {
  terminals: { id: string; title: string; customName?: string | null }[]
  onClose: () => void
  width: number
  onWidthChange: (width: number) => void
}

// Shortcut configuration items
interface ShortcutItem {
  key: keyof ShortcutConfig
  labelKey: TranslationKey
  labelParams?: { index: number }
}

// Shortcut groups
const SHORTCUT_GROUPS: { titleKey: TranslationKey; descriptionKey?: TranslationKey; items: ShortcutItem[] }[] = [
  {
    titleKey: 'settings.group.globalShortcuts',
    descriptionKey: 'settings.group.globalShortcuts.description',
    items: [
      { key: 'activateAndFocusPrompt', labelKey: 'settings.shortcut.togglePrompt' }
    ]
  },
  {
    titleKey: 'settings.group.windowShortcuts',
    descriptionKey: 'settings.group.windowShortcuts.description',
    items: [
      { key: 'focusPromptEditor', labelKey: 'settings.shortcut.focusPromptEditor' },
      { key: 'addToHistory', labelKey: 'settings.shortcut.addToHistory' }
    ]
  },
  {
    titleKey: 'settings.group.terminalActions',
    descriptionKey: 'settings.group.terminalActions.description',
    items: [
      { key: 'terminalGitDiff', labelKey: 'settings.shortcut.viewGitDiff' },
      { key: 'terminalGitHistory', labelKey: 'settings.shortcut.viewGitHistory' },
      { key: 'terminalChangeWorkDir', labelKey: 'settings.shortcut.changeWorkDir' },
      { key: 'terminalOpenWorkDir', labelKey: 'settings.shortcut.openWorkDir' },
      { key: 'terminalProjectEditor', labelKey: 'settings.shortcut.openProjectEditor' }
    ]
  },
  {
    titleKey: 'settings.group.terminalFocus',
    items: [
      { key: 'focusTerminal1', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 1 } },
      { key: 'focusTerminal2', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 2 } },
      { key: 'focusTerminal3', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 3 } },
      { key: 'focusTerminal4', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 4 } },
      { key: 'focusTerminal5', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 5 } },
      { key: 'focusTerminal6', labelKey: 'settings.shortcut.focusTask', labelParams: { index: 6 } }
    ]
  },
  {
    titleKey: 'settings.group.tabSwitch',
    items: [
      { key: 'switchTab1', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 1 } },
      { key: 'switchTab2', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 2 } },
      { key: 'switchTab3', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 3 } },
      { key: 'switchTab4', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 4 } },
      { key: 'switchTab5', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 5 } },
      { key: 'switchTab6', labelKey: 'settings.shortcut.switchTab', labelParams: { index: 6 } }
    ]
  }
]

export function Settings({ terminals, onClose, width, onWidthChange }: SettingsProps) {
  const {
    settings,
    updateShortcut,
    updateTerminalStyle,
    getTerminalStyle,
    applyStyleGlobally
  } = useSettings()
  const { t, locale, locales, updateLanguage } = useI18n()
  const [selectedTerminalId, setSelectedTerminalId] = useState<string>(
    terminals[0]?.id || ''
  )
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Get the style of the currently selected terminal
  const currentTerminalStyle = useMemo(() => {
    return getTerminalStyle(selectedTerminalId)
  }, [selectedTerminalId, getTerminalStyle])


  // Handle shortcut changes
  const handleShortcutChange = useCallback((key: keyof ShortcutConfig, value: string | null) => {
    updateShortcut(key, value)
  }, [updateShortcut])

  // Handling terminal style changes
  const handleStyleChange = useCallback((key: keyof TerminalStyleConfig, value: string | number | null) => {
    if (!selectedTerminalId) return
    updateTerminalStyle(selectedTerminalId, { [key]: value } as Partial<TerminalStyleConfig>)
  }, [selectedTerminalId, updateTerminalStyle])


  // Handling terminal selection changes
  const handleTerminalSelect = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedTerminalId(e.target.value)
  }, [])

  // Handling font size changes
  const handleFontSizeChange = useCallback((value: number | null) => {
    handleStyleChange('fontSize', value)
  }, [handleStyleChange])


  const handleGitDiffFontSizeChange = useCallback((value: number | null) => {
    handleStyleChange('gitDiffFontSize', value)
  }, [handleStyleChange])

  const handleApplyGlobally = useCallback((field: keyof GlobalTerminalStyle) => {
    if (!currentTerminalStyle) return
    applyStyleGlobally(field, currentTerminalStyle[field])
  }, [applyStyleGlobally, currentTerminalStyle])

  const handleLanguageChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    updateLanguage(e.target.value as typeof locale)
  }, [updateLanguage])

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  // Handle drag move and end
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      // Calculate the distance from the right edge to the mouse (since the Settings panel is on the right)
      const containerRect = containerRef.current.getBoundingClientRect()
      const newWidth = containerRect.right - e.clientX
      // Limit width range to 300-600px
      const clampedWidth = Math.max(300, Math.min(600, newWidth))
      onWidthChange(clampedWidth)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, onWidthChange])

  return (
    <div
      ref={containerRef}
      className={`settings-container ${isDragging ? 'is-dragging' : ''}`}
      style={{ width: `${width}px` }}
    >
      {/* Drag strip */}
      <div
        className="settings-resize-handle"
        onMouseDown={handleDragStart}
      />
      {/* Header */}
      <div className="settings-header">
        <span className="settings-title">{t('settings.title')}</span>
        <button className="settings-close-btn" onClick={onClose} title={t('settings.close')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="settings-content">
        {/* Version Info */}
        <div className="settings-version">
          <span className="settings-version-number">v2.0.1</span>
          <span className="settings-version-label">{t('settings.versionLabel')}</span>
          <span className="settings-version-copyright">Copyright 2026 OPPO</span>
        </div>

        {/* Language Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.language.label')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              <div className="settings-row">
                <span className="settings-row-label">{t('settings.language.selectLabel')}</span>
                <div className="settings-row-input">
                  <select
                    className="font-selector"
                    value={locale}
                    onChange={handleLanguageChange}
                    aria-label={t('settings.language.selectLabel')}
                  >
                    {locales.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Appearance Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.appearance')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              <ThemeSelector />
            </div>
          </div>
        </div>

        {/* Shortcuts Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.shortcuts')}</div>
          <div className="settings-section-content">
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.titleKey} className="settings-group">
                <div className="settings-group-title">{t(group.titleKey)}</div>
                {group.descriptionKey && (
                  <div className="settings-group-description">{t(group.descriptionKey)}</div>
                )}
                {group.items.map(item => (
                  <div key={item.key} className="settings-row">
                    <span className="settings-row-label">{t(item.labelKey, item.labelParams)}</span>
                    <div className="settings-row-input">
                      <ShortcutInput
                        value={settings?.shortcuts[item.key] || null}
                        onChange={(value) => handleShortcutChange(item.key, value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Agent Terminal Section */}
        <div className="settings-section">
          <div className="settings-section-title">{t('settings.section.agentTerminal')}</div>
          <div className="settings-section-content">
            <div className="settings-group">
              {/* Terminal Selector */}
              <div className="terminal-selector-wrapper">
                <span className="terminal-selector-label">{t('settings.terminal.select')}</span>
                <select
                  className="terminal-selector"
                  value={selectedTerminalId}
                  onChange={handleTerminalSelect}
                >
                  {terminals.length === 0 ? (
                    <option value="">{t('settings.terminal.none')}</option>
                  ) : (
                    terminals.map(terminal => (
                      <option key={terminal.id} value={terminal.id}>
                        {terminal.title}
                      </option>
                    ))
                  )}
                </select>
              </div>

              {terminals.length > 0 && selectedTerminalId && (
                <>
                  {/* Apply globally hint */}
                  <div className="apply-globally-hint">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 0 1 4.47 10.002L8 9.5V2zM3.53 12.002A6 6 0 0 1 8 2v7.5l4.47 2.502A6 6 0 0 1 3.53 12.002z" />
                    </svg>
                    <span>{t('settings.terminal.applyGloballyHint')}</span>
                  </div>

                  {/* Foreground Color */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.foregroundColor')}</span>
                    <div className="settings-row-input">
                      <ColorPicker
                        value={currentTerminalStyle?.foregroundColor || null}
                        onChange={(value) => handleStyleChange('foregroundColor', value)}
                        defaultValue="#cccccc"
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('foregroundColor')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 0 1 4.47 10.002L8 9.5V2zM3.53 12.002A6 6 0 0 1 8 2v7.5l4.47 2.502A6 6 0 0 1 3.53 12.002z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Background Color */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.backgroundColor')}</span>
                    <div className="settings-row-input">
                      <ColorPicker
                        value={currentTerminalStyle?.backgroundColor || null}
                        onChange={(value) => handleStyleChange('backgroundColor', value)}
                        defaultValue="#1e1e1e"
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('backgroundColor')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 0 1 4.47 10.002L8 9.5V2zM3.53 12.002A6 6 0 0 1 8 2v7.5l4.47 2.502A6 6 0 0 1 3.53 12.002z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Font Family */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.fontFamily')}</span>
                    <div className="settings-row-input">
                      <FontSelector
                        value={currentTerminalStyle?.fontFamily || null}
                        onChange={(value) => handleStyleChange('fontFamily', value)}
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('fontFamily')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 0 1 4.47 10.002L8 9.5V2zM3.53 12.002A6 6 0 0 1 8 2v7.5l4.47 2.502A6 6 0 0 1 3.53 12.002z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Font Size */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.fontSize')}</span>
                    <div className="settings-row-input">
                      <NumberInput
                        value={currentTerminalStyle?.fontSize ?? null}
                        onChange={handleFontSizeChange}
                        min={MIN_TERMINAL_FONT_SIZE}
                        max={MAX_TERMINAL_FONT_SIZE}
                        defaultValue={DEFAULT_TERMINAL_FONT_SIZE}
                        placeholder={String(DEFAULT_TERMINAL_FONT_SIZE)}
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('fontSize')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 0 1 4.47 10.002L8 9.5V2zM3.53 12.002A6 6 0 0 1 8 2v7.5l4.47 2.502A6 6 0 0 1 3.53 12.002z" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Git Diff / Project Editor Font Size */}
                  <div className="settings-row">
                    <span className="settings-row-label">{t('settings.terminal.editorFontSize')}</span>
                    <div className="settings-row-input">
                      <NumberInput
                        value={currentTerminalStyle?.gitDiffFontSize ?? null}
                        onChange={handleGitDiffFontSizeChange}
                        min={MIN_GIT_DIFF_FONT_SIZE}
                        max={MAX_GIT_DIFF_FONT_SIZE}
                        defaultValue={DEFAULT_GIT_DIFF_FONT_SIZE}
                        placeholder={String(DEFAULT_GIT_DIFF_FONT_SIZE)}
                      />
                      <button
                        className="settings-apply-global-btn"
                        type="button"
                        onClick={() => handleApplyGlobally('gitDiffFontSize')}
                        title={t('settings.terminal.applyGlobally')}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1a6 6 0 0 1 4.47 10.002L8 9.5V2zM3.53 12.002A6 6 0 0 1 8 2v7.5l4.47 2.502A6 6 0 0 1 3.53 12.002z" />
                        </svg>
                      </button>
                    </div>
                  </div>


                </>
              )}

              {terminals.length === 0 && (
                <div className="settings-empty">
                  {t('settings.terminal.createFirst')}
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
