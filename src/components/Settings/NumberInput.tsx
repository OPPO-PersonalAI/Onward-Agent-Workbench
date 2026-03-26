/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react'
import { useI18n } from '../../i18n/useI18n'
import './NumberInput.css'

interface NumberInputProps {
  value: number | null
  onChange: (value: number | null) => void
  min: number
  max: number
  defaultValue: number
  placeholder?: string
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  defaultValue,
  placeholder
}: NumberInputProps) {
  const { t } = useI18n()

  const handleIncrement = useCallback(() => {
    const current = value ?? defaultValue
    const newValue = Math.min(max, current + 1)
    onChange(newValue)
  }, [value, defaultValue, max, onChange])

  const handleDecrement = useCallback(() => {
    const current = value ?? defaultValue
    const newValue = Math.max(min, current - 1)
    onChange(newValue)
  }, [value, defaultValue, min, onChange])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const inputValue = e.target.value
    if (inputValue === '') {
      onChange(null)
      return
    }
    const numValue = parseInt(inputValue, 10)
    if (!isNaN(numValue) && numValue >= min && numValue <= max) {
      onChange(numValue)
    }
  }, [min, max, onChange])

  return (
    <div className="number-input-wrapper">
      <button
        type="button"
        className="number-btn"
        onClick={handleDecrement}
        aria-label={t('common.decrease')}
      >
        −
      </button>
      <input
        type="number"
        className="number-input-field"
        value={value ?? ''}
        onChange={handleInputChange}
        placeholder={placeholder}
        min={min}
        max={max}
      />
      <button
        type="button"
        className="number-btn"
        onClick={handleIncrement}
        aria-label={t('common.increase')}
      >
        +
      </button>
    </div>
  )
}
