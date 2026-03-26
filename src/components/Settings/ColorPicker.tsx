/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { useI18n } from '../../i18n/useI18n'

interface ColorPickerProps {
  value: string | null
  onChange: (value: string | null) => void
  defaultValue?: string
}

// Verify color format
function isValidColor(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color)
}

// Normalized color values
function normalizeColor(color: string): string {
  if (color.startsWith('#')) {
    return color.toLowerCase()
  }
  return `#${color}`.toLowerCase()
}

export function ColorPicker({
  value,
  onChange,
  defaultValue = '#ffffff'
}: ColorPickerProps) {
  const { t } = useI18n()
  const [inputValue, setInputValue] = useState(value || '')
  const [isInvalid, setIsInvalid] = useState(false)
  const colorInputRef = useRef<HTMLInputElement>(null)

  // Synchronize external value changes
  useEffect(() => {
    setInputValue(value || '')
    setIsInvalid(false)
  }, [value])

  // Handling color picker changes
  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value
    setInputValue(newColor)
    setIsInvalid(false)
    onChange(normalizeColor(newColor))
  }, [onChange])

  // Handle text input changes
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setInputValue(newValue)

    // Try to standardize and validate
    const normalized = newValue.startsWith('#') ? newValue : `#${newValue}`
    if (isValidColor(normalized)) {
      setIsInvalid(false)
      onChange(normalizeColor(normalized))
    } else if (newValue === '' || newValue === '#') {
      setIsInvalid(false)
      onChange(null)
    } else {
      setIsInvalid(true)
    }
  }, [onChange])

  // Handling input loses focus
  const handleBlur = useCallback(() => {
    if (!inputValue || inputValue === '#') {
      setInputValue('')
      setIsInvalid(false)
      onChange(null)
      return
    }

    const normalized = inputValue.startsWith('#') ? inputValue : `#${inputValue}`
    if (isValidColor(normalized)) {
      setInputValue(normalizeColor(normalized))
      setIsInvalid(false)
    }
  }, [inputValue, onChange])

  // Click on the color preview to open the selector
  const handlePreviewClick = useCallback(() => {
    colorInputRef.current?.click()
  }, [])

  const previewColor = value || defaultValue

  return (
    <div className="color-picker-wrapper">
      <div
        className="color-preview"
        style={{ backgroundColor: previewColor }}
        onClick={handlePreviewClick}
        title={t('settings.color.pick')}
      />
      <input
        ref={colorInputRef}
        type="color"
        value={value || defaultValue}
        onChange={handleColorChange}
        style={{ display: 'none' }}
      />
      <input
        type="text"
        className={`color-input ${isInvalid ? 'invalid' : ''}`}
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleBlur}
        placeholder={defaultValue}
        maxLength={7}
      />
    </div>
  )
}
