/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import './types/electron.d.ts'
import { DEFAULT_LOCALE, type AppLocale } from './i18n/core'
import { loadBundledEditorLocale } from './monaco-nls'

async function bootstrap(): Promise<void> {
  const settings = await window.electronAPI?.settings.load().catch(() => null)
  const locale: AppLocale = settings?.language === 'zh-CN' ? 'zh-CN' : DEFAULT_LOCALE
  window.__onwardEditorLocaleAtBoot = locale
  document.documentElement.lang = locale
  const editorLocale = await loadBundledEditorLocale(locale)
  if (!editorLocale.loaded) {
    console.warn(`Monaco locale ${locale} is unavailable in the installed Monaco bundle; editor menus remain English.`)
  }
  await import('./monaco-env')
  const { mountApp } = await import('./mount-app')
  mountApp()
}

void bootstrap()
