import assert from 'node:assert/strict'
import test from 'node:test'
import { loadBundledEditorLocale } from '../../src/monaco-nls.ts'

test('Monaco NLS loader never sources a locale module from an external resource pack', async () => {
  assert.deepEqual(await loadBundledEditorLocale('en'), { locale: 'en', loaded: true })
  assert.deepEqual(await loadBundledEditorLocale('zh-CN'), {
    locale: 'zh-CN', loaded: false, reason: 'not-bundled-by-monaco'
  })
})
