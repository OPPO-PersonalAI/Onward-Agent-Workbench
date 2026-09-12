import assert from 'node:assert/strict'
import test from 'node:test'
import { deactivateResourcePackReferences } from '../../electron/shared/resource-pack-lifecycle.ts'

test('deactivating a theme pack restores matching built-in slots only', () => {
  const settings = {
    appearance: {
      schemaVersion: 1 as const,
      colorMode: 'light' as const,
      lightTheme: { source: 'pack' as const, packId: 'sample.theme', themeId: 'light' },
      darkTheme: { source: 'pack' as const, packId: 'other.theme', themeId: 'dark' },
      terminal: { source: 'application' as const }
    },
    localePacks: { schemaVersion: 1 as const, activePackByLocale: { 'zh-CN': 'sample.locale' } }
  }
  const next = deactivateResourcePackReferences(settings, 'sample.theme')
  assert.deepEqual(next.appearance.lightTheme, { source: 'builtin', id: 'onward-light' })
  assert.deepEqual(next.appearance.darkTheme, settings.appearance.darkTheme)
  assert.deepEqual(next.localePacks, settings.localePacks)
})

test('deactivating a locale pack returns every matching locale to the official dictionary', () => {
  const settings = {
    appearance: {
      schemaVersion: 1 as const,
      colorMode: 'dark' as const,
      lightTheme: { source: 'builtin' as const, id: 'onward-light' as const },
      darkTheme: { source: 'builtin' as const, id: 'graphite' as const },
      terminal: { source: 'application' as const }
    },
    localePacks: { schemaVersion: 1 as const, activePackByLocale: { en: 'sample.locale', 'zh-CN': 'sample.locale' } }
  }
  assert.deepEqual(deactivateResourcePackReferences(settings, 'sample.locale').localePacks.activePackByLocale, {})
})
