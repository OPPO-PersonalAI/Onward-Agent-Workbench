/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAppearance, resolveAppearanceTheme, type LegacyThemeSettings } from '../../electron/shared/appearance-schema.ts'

const legacyPreset: LegacyThemeSettings = { mode: 'preset', presetId: 'pine', custom: null }

describe('appearance schema', () => {
  it('migrates an existing preset without changing its dark visual identity', () => {
    const result = normalizeAppearance(undefined, legacyPreset, { existingUser: true })
    assert.deepEqual(result.appearance, {
      schemaVersion: 1,
      colorMode: 'dark',
      lightTheme: { source: 'builtin', id: 'onward-light' },
      darkTheme: { source: 'builtin', id: 'pine' },
      terminal: { source: 'independent', paletteId: 'vscode-dark' }
    })
  })

  it('migrates a valid custom accent only into the dark slot', () => {
    const result = normalizeAppearance(undefined, {
      mode: 'custom', presetId: 'graphite', custom: { accent: '#AABBCC' }
    }, { existingUser: true })
    assert.deepEqual(result.appearance.darkTheme, { source: 'legacy-custom', accent: '#aabbcc' })
    assert.deepEqual(result.appearance.lightTheme, { source: 'builtin', id: 'onward-light' })
  })

  it('repairs invalid fields independently without resetting a valid slot', () => {
    const result = normalizeAppearance({
      schemaVersion: 1,
      colorMode: 'system',
      lightTheme: { source: 'builtin', id: 'onward-light' },
      darkTheme: { source: 'builtin', id: 'onward-light' },
      terminal: { source: 'independent', paletteId: 'not-allowed' }
    }, legacyPreset, { existingUser: true })
    assert.equal(result.appearance.colorMode, 'system')
    assert.deepEqual(result.appearance.lightTheme, { source: 'builtin', id: 'onward-light' })
    assert.deepEqual(result.appearance.darkTheme, { source: 'builtin', id: 'graphite' })
    assert.deepEqual(result.appearance.terminal, { source: 'application' })
  })

  it('keeps a requested pack reference for later recovery', () => {
    const result = normalizeAppearance({
      schemaVersion: 1,
      colorMode: 'light',
      lightTheme: { source: 'pack', packId: 'trusted.theme', themeId: 'light-v1' },
      darkTheme: { source: 'builtin', id: 'graphite' },
      terminal: { source: 'application' }
    }, legacyPreset, { existingUser: true })
    assert.deepEqual(resolveAppearanceTheme(result.appearance, 'light'), {
      source: 'pack', packId: 'trusted.theme', themeId: 'light-v1'
    })
  })
})
