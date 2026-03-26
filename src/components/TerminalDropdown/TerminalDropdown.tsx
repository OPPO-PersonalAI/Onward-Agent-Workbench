/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/useI18n'
import './TerminalDropdown.css'

interface TerminalDropdownProps {
  terminalId: string
  onViewGitDiff: () => void
  onViewGitHistory: () => void
  onChangeWorkDir: () => void
  onOpenWorkDir: () => void
  onOpenProjectEditor: () => void
}

export function TerminalDropdown({
  terminalId: _terminalId,
  onViewGitDiff,
  onViewGitHistory,
  onChangeWorkDir,
  onOpenWorkDir,
  onOpenProjectEditor
}: TerminalDropdownProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Click outside to close menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [isOpen])

  // Handling menu item clicks
  const handleMenuItemClick = (action: () => void) => {
    setIsOpen(false)
    action()
  }

  return (
    <div className="terminal-dropdown" ref={dropdownRef}>
      <button
        className={`terminal-dropdown-trigger ${isOpen ? 'open' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setIsOpen(!isOpen)
        }}
        title={t('terminalDropdown.title')}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          className="terminal-dropdown-icon"
        >
          <circle cx="2" cy="6" r="1.2" fill="currentColor" />
          <circle cx="6" cy="6" r="1.2" fill="currentColor" />
          <circle cx="10" cy="6" r="1.2" fill="currentColor" />
        </svg>
      </button>

      {isOpen && (
        <div className="terminal-dropdown-menu">
          <div
            className="terminal-dropdown-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuItemClick(onViewGitDiff)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.5 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4 5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm6.5 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM9 11a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0z"/>
              <path d="M5.5 8v4.5h1V8h-1zm4-2.5V1h-1v4.5h1z"/>
              <path d="M5.5 7.5h4v1h-4v-1z"/>
            </svg>
            <span>{t('terminalDropdown.viewGitDiff')}</span>
          </div>

          <div
            className="terminal-dropdown-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuItemClick(onViewGitHistory)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3 2.75A.75.75 0 0 1 3.75 2h6.5a.75.75 0 0 1 .75.75v1.5H14a.75.75 0 0 1 .75.75v7.25a.75.75 0 0 1-.75.75H7.75a.75.75 0 0 1-.75-.75V11H3.75A.75.75 0 0 1 3 10.25Z" />
              <path d="M4.5 5.5A.5.5 0 0 1 5 5h5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5zm0 2A.5.5 0 0 1 5 7h5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5zm0 2A.5.5 0 0 1 5 9h3.5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5z" />
            </svg>
            <span>{t('terminalDropdown.viewGitHistory')}</span>
          </div>

          <div
            className="terminal-dropdown-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuItemClick(onChangeWorkDir)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zm-.5 10H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z"/>
            </svg>
            <span>{t('terminalDropdown.changeWorkDir')}</span>
          </div>

          <div
            className="terminal-dropdown-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuItemClick(onOpenWorkDir)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zM14 13H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z"/>
              <path d="M8 5.5a.5.5 0 0 1 .5.5v2.5H11a.5.5 0 0 1 0 1H8.5V12a.5.5 0 0 1-1 0V9.5H5a.5.5 0 0 1 0-1h2.5V6a.5.5 0 0 1 .5-.5z"/>
            </svg>
            <span>{t('terminalDropdown.openWorkDir')}</span>
          </div>

          <div
            className="terminal-dropdown-item"
            onClick={(e) => {
              e.stopPropagation()
              handleMenuItemClick(onOpenProjectEditor)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2.5 2.75A.75.75 0 0 1 3.25 2h4.19c.2 0 .39.08.53.22l1.06 1.06c.14.14.33.22.53.22h3.24a.75.75 0 0 1 .75.75v9.5a.75.75 0 0 1-.75.75H3.25a.75.75 0 0 1-.75-.75v-11zm1.5.75v9.5h8.5V4.5h-3.5a1 1 0 0 1-.7-.3L7 2.5H4z" />
              <path d="M6.25 6.5a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5H8.5v3.25a.75.75 0 0 1-1.5 0V7.25H7a.75.75 0 0 1-.75-.75z" />
            </svg>
            <span>{t('terminalDropdown.projectEditor')}</span>
          </div>
        </div>
      )}
    </div>
  )
}
