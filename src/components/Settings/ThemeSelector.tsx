/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, type ChangeEvent } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_THEME_SETTINGS, THEME_PRESETS } from '../../constants/themes'
import { ColorPickerAdvanced } from './ColorPickerAdvanced'
import type { ThemeSettings, PresetThemeId } from '../../types/theme'
import type { TranslationKey } from '../../i18n/core'
import { useI18n } from '../../i18n/useI18n'
import { trackFeatureUse } from '../../telemetry/track-feature-use'
import type { AppearanceSettingsV1 } from '../../../electron/shared/appearance-schema'
import './ThemeSelector.css'

export function ThemeSelector() {
  const { settings, updateAppearance, updateTheme } = useSettings()
  const { t } = useI18n()

  const currentTheme = useMemo(() => {
    return settings?.theme ?? DEFAULT_THEME_SETTINGS
  }, [settings?.theme])

  const isCustomMode = currentTheme.mode === 'custom'
  const appearance = settings?.appearance

  const updateAppearancePatch = useCallback((patch: Partial<AppearanceSettingsV1>) => {
    if (!appearance) return
    updateAppearance({ ...appearance, ...patch })
  }, [appearance, updateAppearance])

  const handlePresetSelect = useCallback((id: PresetThemeId) => {
    if (id === 'onward-light') return
    const newTheme: ThemeSettings = {
      mode: 'preset',
      presetId: id,
      custom: currentTheme.custom
    }
    updateTheme(newTheme)
  }, [currentTheme.custom, updateTheme])

  const handleColorModeChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const colorMode = event.target.value as AppearanceSettingsV1['colorMode']
    if (colorMode !== 'light' && colorMode !== 'dark' && colorMode !== 'system') return
    updateAppearancePatch({ colorMode })
  }, [updateAppearancePatch])

  const handleTerminalPaletteChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    updateAppearancePatch({
      terminal: event.target.value === 'independent'
        ? { source: 'independent', paletteId: 'vscode-dark' }
        : { source: 'application' }
    })
  }, [updateAppearancePatch])

  const handleCustomToggle = useCallback(() => {
    if (isCustomMode) {
      // Switch back to default mode
      updateTheme({
        mode: 'preset',
        presetId: currentTheme.presetId,
        custom: currentTheme.custom
      })
    } else {
      // Switch to custom mode
      const accent = currentTheme.custom?.accent ?? '#3b82f6'
      updateTheme({
        mode: 'custom',
        presetId: currentTheme.presetId,
        custom: { accent }
      })
      // Product telemetry: user applied a custom accent (entered custom theme mode).
      trackFeatureUse('theme-custom')
    }
  }, [isCustomMode, currentTheme, updateTheme])

  const handleCustomColorChange = useCallback((accent: string) => {
    updateTheme({
      mode: 'custom',
      presetId: currentTheme.presetId,
      custom: { accent }
    })
  }, [currentTheme.presetId, updateTheme])

  return (
    <div className="theme-selector">
      <label className="theme-field-label" htmlFor="settings-color-mode-select">{t('settings.appearance.colorMode')}</label>
      <select
        id="settings-color-mode-select"
        className="onward-select theme-select"
        data-testid="settings-color-mode-select"
        value={appearance?.colorMode ?? 'dark'}
        onChange={handleColorModeChange}
      >
        <option value="light">{t('settings.appearance.mode.light')}</option>
        <option value="dark">{t('settings.appearance.mode.dark')}</option>
        <option value="system">{t('settings.appearance.mode.system')}</option>
      </select>

      <div className="theme-slot-summary">
        <span>{t('settings.appearance.lightTheme')}</span>
        <strong>{t('settings.theme.preset.onward-light.name')}</strong>
      </div>

      <span className="theme-field-label">{t('settings.appearance.darkTheme')}</span>
      <div className="theme-preset-grid">
        {THEME_PRESETS.filter(preset => preset.id !== 'onward-light').map(preset => {
          const isSelected = !isCustomMode && currentTheme.presetId === preset.id
          const nameKey = `settings.theme.preset.${preset.id}.name` as TranslationKey
          const descriptionKey = `settings.theme.preset.${preset.id}.description` as TranslationKey
          return (
            <button
              key={preset.id}
              className={`theme-preset-card ${isSelected ? 'selected' : ''}`}
              onClick={() => handlePresetSelect(preset.id)}
              title={t(descriptionKey)}
            >
              {/* Top 4 color bar preview */}
              <div className="theme-preview-bar">
                <span className="theme-preview-swatch" style={{ backgroundColor: preset.colors['--bg-0'] }} />
                <span className="theme-preview-swatch" style={{ backgroundColor: preset.colors['--bg-2'] }} />
                <span className="theme-preview-swatch" style={{ backgroundColor: preset.colors['--border-strong'] }} />
                <span className="theme-preview-swatch" style={{ backgroundColor: preset.colors['--accent'] }} />
              </div>
              {/* Theme name */}
              <span className="theme-preset-name">{t(nameKey)}</span>
              {/* Selected badge */}
              {isSelected && (
                <span className="theme-preset-check">
                  <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                    <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                  </svg>
                </span>
              )}
            </button>
          )
        })}
      </div>

      <label className="theme-field-label" htmlFor="settings-terminal-palette-select">{t('settings.appearance.terminalPalette')}</label>
      <select
        id="settings-terminal-palette-select"
        className="onward-select theme-select"
        data-testid="settings-terminal-palette-select"
        value={appearance?.terminal.source === 'independent' ? 'independent' : 'application'}
        onChange={handleTerminalPaletteChange}
      >
        <option value="application">{t('settings.appearance.terminal.application')}</option>
        <option value="independent">{t('settings.appearance.terminal.independent')}</option>
      </select>

      {/* Custom color area */}
      <div className="theme-custom-section">
        <div className="theme-custom-header">
          <span className="theme-custom-label">{t('settings.theme.customAccent')}</span>
          <button
            className={`theme-custom-toggle ${isCustomMode ? 'active' : ''}`}
            onClick={handleCustomToggle}
          >
            <span className="theme-toggle-track">
              <span className="theme-toggle-thumb" />
            </span>
          </button>
        </div>
        {isCustomMode && (
          <ColorPickerAdvanced
            value={currentTheme.custom?.accent ?? '#3b82f6'}
            onChange={handleCustomColorChange}
          />
        )}
      </div>
    </div>
  )
}
