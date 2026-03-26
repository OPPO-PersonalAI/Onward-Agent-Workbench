/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react'
import { Terminal } from '../Terminal/Terminal'
import { ThemeName } from '../../themes/terminal-themes'
import { useI18n } from '../../i18n/useI18n'
import './TerminalTabs.css'

interface TabInfo {
  id: string
  title: string
}

interface TerminalTabsProps {
  theme?: ThemeName
}

let tabCounter = 0

function generateTabId(): string {
  return `terminal-${++tabCounter}-${Date.now()}`
}

export function TerminalTabs({ theme = 'vscode-dark' }: TerminalTabsProps) {
  const { t } = useI18n()
  const [tabs, setTabs] = useState<TabInfo[]>(() => [
    { id: generateTabId(), title: 'Terminal 1' }
  ])
  const [activeTabId, setActiveTabId] = useState<string>(tabs[0].id)

  const createTab = useCallback(() => {
    const newTab: TabInfo = {
      id: generateTabId(),
      title: `Terminal ${tabCounter}`
    }
    setTabs((prev) => [...prev, newTab])
    setActiveTabId(newTab.id)
  }, [])

  const closeTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation()

    setTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId)

      // If closing the active tab, switch to another
      if (tabId === activeTabId && newTabs.length > 0) {
        const closedIndex = prev.findIndex((t) => t.id === tabId)
        const newActiveIndex = Math.min(closedIndex, newTabs.length - 1)
        setActiveTabId(newTabs[newActiveIndex].id)
      }

      return newTabs
    })
  }, [activeTabId])

  const selectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId)
  }, [])

  return (
    <div className="terminal-tabs-container">
      <div className="tabs-header">
        <div className="tabs-list">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
              onClick={() => selectTab(tab.id)}
            >
              <span className="tab-icon">&#62;_</span>
              <span className="tab-title">{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  className="tab-close"
                  onClick={(e) => closeTab(tab.id, e)}
                  title={t('terminalTabs.closeTerminal')}
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
        <button className="add-tab-btn" onClick={createTab} title={t('terminalTabs.newTerminal')}>
          +
        </button>
      </div>
      <div className="terminals-container">
        {tabs.map((tab) => (
          <Terminal
            key={tab.id}
            id={tab.id}
            isActive={tab.id === activeTabId}
            theme={theme}
          />
        ))}
      </div>
    </div>
  )
}
