/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo } from 'react'
import type { TranslationKey } from '../../i18n/core'
import { useI18n } from '../../i18n/useI18n'

interface FontSelectorProps {
  value: string | null
  onChange: (value: string | null) => void
  dataTestId?: string
}

// List of commonly used terminal fonts (cross-platform)
const TERMINAL_FONTS: Array<{ value: string; fallbackLabel: string; labelKey?: TranslationKey }> = [
  { value: '', labelKey: 'settings.font.systemDefault', fallbackLabel: 'System default' },
  // Cross-platform monospaced fonts
  { value: 'SF Mono', fallbackLabel: 'SF Mono' },
  { value: 'Monaco', fallbackLabel: 'Monaco' },
  { value: 'Menlo', fallbackLabel: 'Menlo' },
  { value: 'Consolas', fallbackLabel: 'Consolas' },
  { value: 'Cascadia Code', fallbackLabel: 'Cascadia Code' },
  { value: 'Cascadia Mono', fallbackLabel: 'Cascadia Mono' },
  { value: 'Fira Code', fallbackLabel: 'Fira Code' },
  { value: 'Fira Mono', fallbackLabel: 'Fira Mono' },
  { value: 'JetBrains Mono', fallbackLabel: 'JetBrains Mono' },
  { value: 'Source Code Pro', fallbackLabel: 'Source Code Pro' },
  { value: 'Ubuntu Mono', fallbackLabel: 'Ubuntu Mono' },
  { value: 'DejaVu Sans Mono', fallbackLabel: 'DejaVu Sans Mono' },
  { value: 'Liberation Mono', fallbackLabel: 'Liberation Mono' },
  { value: 'Courier New', fallbackLabel: 'Courier New' },
  { value: 'Lucida Console', fallbackLabel: 'Lucida Console' },
  { value: 'monospace', labelKey: 'settings.font.monospaceGeneric', fallbackLabel: 'monospace (generic)' }
]

export function FontSelector({
  value,
  onChange,
  dataTestId
}: FontSelectorProps) {
  const { t } = useI18n()

  // Get recommended fonts for the current platform
  const platformFonts = useMemo(() => {
    const platform = window.electronAPI?.platform || 'darwin'

    // Adjust font order according to platform
    if (platform === 'darwin') {
      // macOS: SF Mono, Monaco, Menlo preferred
      return TERMINAL_FONTS
    } else if (platform === 'win32') {
      // Windows: Consolas, Cascadia Code preferred
      const windowsFirst = ['Consolas', 'Cascadia Code', 'Cascadia Mono']
      return [
        TERMINAL_FONTS[0],
        ...TERMINAL_FONTS.filter(f => windowsFirst.includes(f.value)),
        ...TERMINAL_FONTS.filter(f => f.value && !windowsFirst.includes(f.value))
      ]
    } else {
      // Linux: Ubuntu Mono, DejaVu Sans Mono preferred
      const linuxFirst = ['Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono']
      return [
        TERMINAL_FONTS[0],
        ...TERMINAL_FONTS.filter(f => linuxFirst.includes(f.value)),
        ...TERMINAL_FONTS.filter(f => f.value && !linuxFirst.includes(f.value))
      ]
    }
  }, [])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const newValue = e.target.value
    onChange(newValue || null)
  }, [onChange])

  return (
    <select
      className="font-selector onward-select onward-select--control"
      value={value || ''}
      onChange={handleChange}
      data-testid={dataTestId}
    >
      {platformFonts.map(font => (
        <option
          key={font.value}
          value={font.value}
          style={{ fontFamily: font.value || 'inherit' }}
        >
          {font.labelKey ? t(font.labelKey) : font.fallbackLabel}
        </option>
      ))}
    </select>
  )
}
