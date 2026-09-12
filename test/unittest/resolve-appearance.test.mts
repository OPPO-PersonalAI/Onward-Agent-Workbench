/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_APPEARANCE, resolveAppearanceDescriptor } from '../../electron/shared/appearance-schema.ts'

describe('resolved appearance', () => {
  it('selects system light without changing the stored dark slot', () => {
    const resolved = resolveAppearanceDescriptor({ ...DEFAULT_APPEARANCE, colorMode: 'system' }, false)
    assert.equal(resolved.kind, 'light')
    assert.equal(resolved.terminalFollowsApplication, true)
  })

  it('preserves an independent legacy terminal palette in light mode', () => {
    const resolved = resolveAppearanceDescriptor({
      ...DEFAULT_APPEARANCE,
      colorMode: 'light',
      terminal: { source: 'independent', paletteId: 'vscode-dark' }
    }, false)
    assert.equal(resolved.kind, 'light')
    assert.equal(resolved.terminalFollowsApplication, false)
  })
})
