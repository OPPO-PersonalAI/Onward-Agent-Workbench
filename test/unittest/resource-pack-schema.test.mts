/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateLocaleOverlay, validateResourcePackManifest } from '../../electron/shared/resource-pack-schema.ts'

describe('resource pack schema', () => {
  it('accepts a bounded local theme manifest', () => {
    const result = validateResourcePackManifest({
      schemaVersion: 1,
      id: 'example.light',
      version: '1.0.0',
      kind: 'theme',
      displayName: 'Example Light',
      compatiblePackApi: 1,
      themes: [{ id: 'default', label: 'Default', kind: 'light', entry: 'themes/light.json' }]
    })
    assert.equal(result.ok, true)
  })

  it('rejects a path traversal entry before reading a resource', () => {
    const result = validateResourcePackManifest({
      schemaVersion: 1,
      id: 'example.light',
      version: '1.0.0',
      kind: 'theme',
      displayName: 'Example Light',
      compatiblePackApi: 1,
      themes: [{ id: 'default', label: 'Default', kind: 'light', entry: '../outside.json' }]
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'PACK_INVALID_MANIFEST')
  })

  it('rejects locale placeholder changes and protected confirmation copy', () => {
    const official = { 'common.greeting': 'Hello {{name}}', 'dialog.quit.title': 'Quit {{displayName}}' }
    const placeholders = validateLocaleOverlay({ 'common.greeting': '你好' }, official, new Set())
    assert.equal(placeholders.ok, false)
    if (!placeholders.ok) assert.equal(placeholders.error.code, 'PACK_PLACEHOLDER_MISMATCH')
    const protectedCopy = validateLocaleOverlay({ 'dialog.quit.title': '关闭 {{displayName}}' }, official, new Set(['dialog.quit.title']))
    assert.equal(protectedCopy.ok, false)
    if (!protectedCopy.ok) assert.equal(protectedCopy.error.code, 'PACK_PROTECTED_KEY')
  })
})
