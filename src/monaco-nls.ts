/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppLocale } from './i18n/core'

export interface MonacoLocaleLoadResult {
  locale: AppLocale
  loaded: boolean
  reason?: 'not-bundled-by-monaco'
}

/**
 * Monaco 0.55.1's published ESM package contains English messages only; it
 * does not ship an NLS module that is safe to mix with this exact build.
 * Keep the whitelist explicit so adding a same-version local NLS later cannot
 * accidentally execute a resource-pack file or alter the editor at runtime.
 */
export async function loadBundledEditorLocale(locale: AppLocale): Promise<MonacoLocaleLoadResult> {
  if (locale === 'en') return { locale, loaded: true }
  return { locale, loaded: false, reason: 'not-bundled-by-monaco' }
}
