/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { LayoutMode } from '../../types/prompt'
import { useI18n } from '../../i18n/useI18n'
import './Sidebar.css'

interface SidebarProps {
  activePanel: 'prompt' | 'settings' | null
  layoutMode: LayoutMode
  onPanelChange: (panel: 'prompt' | 'settings' | null) => void
  onLayoutChange: (mode: LayoutMode) => void
}

export function Sidebar({
  activePanel,
  layoutMode,
  onPanelChange,
  onLayoutChange
}: SidebarProps) {
  const { t } = useI18n()

  const handlePromptToggle = () => {
    onPanelChange(activePanel === 'prompt' ? null : 'prompt')
  }

  const handleSettingsToggle = () => {
    onPanelChange(activePanel === 'settings' ? null : 'settings')
  }

  return (
    <div className="sidebar">
      {/* Prompt notebook switching button */}
      <button
        className={`sidebar-btn ${activePanel === 'prompt' ? 'active' : ''}`}
        onClick={handlePromptToggle}
        title={t('sidebar.promptNotebook')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
      </button>

      <div className="sidebar-divider" />

      {/* Layout toggle button group */}
      <button
        className={`sidebar-btn ${layoutMode === 1 ? 'active' : ''}`}
        onClick={() => onLayoutChange(1)}
        title={t('sidebar.layout.single')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${layoutMode === 2 ? 'active' : ''}`}
        onClick={() => onLayoutChange(2)}
        title={t('sidebar.layout.double')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${layoutMode === 4 ? 'active' : ''}`}
        onClick={() => onLayoutChange(4)}
        title={t('sidebar.layout.quad')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>

      <button
        className={`sidebar-btn ${layoutMode === 6 ? 'active' : ''}`}
        onClick={() => onLayoutChange(6)}
        title={t('sidebar.layout.six')}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
          <line x1="15" y1="3" x2="15" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>

      {/* Spacer Push the Settings button to the bottom */}
      <div className="sidebar-spacer" />

      {/* Settings button */}
      <button
        className={`sidebar-btn ${activePanel === 'settings' ? 'active' : ''}`}
        onClick={handleSettingsToggle}
        title={t('sidebar.settings')}
        data-testid="sidebar-settings-button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  )
}
