/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react'
import { useSettings } from '../contexts/SettingsContext'
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  createTranslator,
  normalizeLocale,
  type TranslationKey,
  type TranslationParams
} from './core'

export function useI18n() {
  const { settings, updateLanguage } = useSettings()
  const locale = normalizeLocale(settings?.language ?? DEFAULT_LOCALE)

  const t = useCallback((key: TranslationKey, params?: TranslationParams) => {
    return createTranslator(locale)(key, params)
  }, [locale])

  return {
    locale,
    locales: SUPPORTED_LOCALES,
    t,
    updateLanguage
  }
}
