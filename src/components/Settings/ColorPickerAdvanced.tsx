/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { useI18n } from '../../i18n/useI18n'

interface ColorPickerAdvancedProps {
  value: string
  onChange: (hex: string) => void
}

function isValidHex(color: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(color)
}

export function ColorPickerAdvanced({ value, onChange }: ColorPickerAdvancedProps) {
  const { t } = useI18n()
  const [inputValue, setInputValue] = useState(value)
  const [isInvalid, setIsInvalid] = useState(false)
  const colorInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setInputValue(value)
    setIsInvalid(false)
  }, [value])

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value
    setInputValue(newColor)
    setIsInvalid(false)
    onChange(newColor.toLowerCase())
  }, [onChange])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    setInputValue(raw)

    const normalized = raw.startsWith('#') ? raw : `#${raw}`
    if (isValidHex(normalized)) {
      setIsInvalid(false)
      onChange(normalized.toLowerCase())
    } else {
      setIsInvalid(true)
    }
  }, [onChange])

  const handleBlur = useCallback(() => {
    const normalized = inputValue.startsWith('#') ? inputValue : `#${inputValue}`
    if (isValidHex(normalized)) {
      setInputValue(normalized.toLowerCase())
      setIsInvalid(false)
    }
  }, [inputValue])

  const handlePreviewClick = useCallback(() => {
    colorInputRef.current?.click()
  }, [])

  return (
    <div className="color-picker-advanced">
      <div
        className="color-picker-advanced-preview"
        style={{ backgroundColor: isValidHex(inputValue.startsWith('#') ? inputValue : `#${inputValue}`) ? (inputValue.startsWith('#') ? inputValue : `#${inputValue}`) : value }}
        onClick={handlePreviewClick}
        title={t('settings.color.pick')}
      />
      <input
        ref={colorInputRef}
        type="color"
        value={value}
        onChange={handleColorChange}
        style={{ display: 'none' }}
      />
      <input
        type="text"
        className={`color-picker-advanced-input ${isInvalid ? 'invalid' : ''}`}
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleBlur}
        placeholder="#3b82f6"
        maxLength={7}
      />
    </div>
  )
}
