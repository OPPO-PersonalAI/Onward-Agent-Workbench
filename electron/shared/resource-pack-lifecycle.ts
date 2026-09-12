/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppearanceSettingsV1, LocalePackSettingsV1 } from './appearance-schema'

export interface ResourcePackReferences {
  appearance: AppearanceSettingsV1
  localePacks: LocalePackSettingsV1
}

/**
 * Removes references to a pack without changing unrelated user preferences.
 * A removed active theme always lands on the matching built-in slot so a
 * deleted file can never be selected on the next paint or launch.
 */
export function deactivateResourcePackReferences<T extends ResourcePackReferences>(settings: T, packId: string): T {
  const appearance: AppearanceSettingsV1 = {
    ...settings.appearance,
    lightTheme: settings.appearance.lightTheme.source === 'pack' && settings.appearance.lightTheme.packId === packId
      ? { source: 'builtin', id: 'onward-light' }
      : settings.appearance.lightTheme,
    darkTheme: settings.appearance.darkTheme.source === 'pack' && settings.appearance.darkTheme.packId === packId
      ? { source: 'builtin', id: 'graphite' }
      : settings.appearance.darkTheme
  }
  const activePackByLocale = Object.fromEntries(
    Object.entries(settings.localePacks.activePackByLocale).filter(([, activePackId]) => activePackId !== packId)
  ) as LocalePackSettingsV1['activePackByLocale']

  return {
    ...settings,
    appearance,
    localePacks: { schemaVersion: 1, activePackByLocale }
  }
}
