/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTranslator, DEFAULT_LOCALE, normalizeLocale, type AppLocale, type TranslationKey, type TranslationParams } from '../../src/i18n/core'
import { getSettingsStorage } from './settings-storage'

export function getCurrentLocale(): AppLocale {
  try {
    return normalizeLocale(getSettingsStorage().get().language)
  } catch {
    return DEFAULT_LOCALE
  }
}

export function tMain(key: TranslationKey, params?: TranslationParams): string {
  return createTranslator(getCurrentLocale())(key, params)
}
