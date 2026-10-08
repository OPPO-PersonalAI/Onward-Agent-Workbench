/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { patchTaskFonts, resolveTaskFonts } from '../../src/themes/task-fonts.ts'
import type { GlobalTerminalStyle, TerminalStyleConfig } from '../../src/types/settings.d.ts'

const globalFonts = (): GlobalTerminalStyle => ({ fontFamily: 'monospace', fontSize: 18, gitDiffFontSize: 19 })
const taskFonts = (): TerminalStyleConfig => ({ terminalId: 'a', fontFamily: 'Task Mono', fontSize: 22, gitDiffFontSize: 17 })

test('TF-01: existing Tasks retain their fonts; new Tasks use global defaults', () => {
  const settings = { terminalStyles: { a: taskFonts() }, globalTerminalStyle: globalFonts() }
  assert.deepEqual(resolveTaskFonts(settings, 'a'), taskFonts())
  assert.deepEqual(resolveTaskFonts(settings, 'new'), { terminalId: 'new', ...globalFonts() })
  const result = resolveTaskFonts(settings, 'a')
  result.fontSize = 30
  assert.equal(settings.terminalStyles.a.fontSize, 22, 'Resolution must return an independent value')
})

test('TF-02: explicit Task resets keep default semantics rather than inheriting global fonts', () => {
  const reset = { terminalId: 'a', fontFamily: null, fontSize: null, gitDiffFontSize: null }
  const settings = { terminalStyles: { a: reset }, globalTerminalStyle: globalFonts() }
  assert.deepEqual(resolveTaskFonts(settings, 'a'), reset)
  assert.deepEqual(resolveTaskFonts({ ...settings, terminalStyles: {} }, 'a'), { terminalId: 'a', ...globalFonts() })
})

test('TF-03: legacy Task/global colors and theme overrides never cross the font boundary', () => {
  const settings = {
    theme: { taskOverrides: { dracula: { a: { foregroundColor: '#abcdef' } } } },
    terminalStyles: { a: { ...taskFonts(), foregroundColor: '#123456', backgroundColor: '#654321' } },
    globalTerminalStyle: { ...globalFonts(), foregroundColor: '#ffffff', backgroundColor: '#000000' }
  }
  const before = structuredClone(settings)
  assert.deepEqual(resolveTaskFonts(settings, 'a'), taskFonts())
  assert.deepEqual(resolveTaskFonts(settings, 'new'), { terminalId: 'new', ...globalFonts() })
  assert.deepEqual(settings, before)
})

test('TF-04: a font patch preserves omitted fields and ignores stale identity and colors', () => {
  const previous = Object.freeze({ ...taskFonts(), foregroundColor: '#abcdef', backgroundColor: '#000000' })
  const patch = Object.freeze({ terminalId: 'other', fontSize: 26, foregroundColor: '#ffffff', backgroundColor: '#112233' })
  assert.deepEqual(patchTaskFonts('a', previous, patch), { ...taskFonts(), fontSize: 26 })
  assert.equal(previous.fontSize, 22)
  assert.equal(patch.terminalId, 'other')
})

test('TF-05: null and explicit undefined reset only the supplied font field', () => {
  for (const field of ['fontFamily', 'fontSize', 'gitDiffFontSize'] as const) {
    for (const value of [null, undefined]) {
      assert.deepEqual(patchTaskFonts('a', taskFonts(), { [field]: value }), { ...taskFonts(), [field]: null })
    }
  }
  assert.deepEqual(patchTaskFonts('a', taskFonts(), {}), taskFonts())
})

test('TF-06: new font patches use the supplied global baseline or explicit null defaults', () => {
  assert.deepEqual(patchTaskFonts('new', globalFonts(), { fontFamily: 'New Mono' }), {
    terminalId: 'new', fontFamily: 'New Mono', fontSize: 18, gitDiffFontSize: 19
  })
  for (const previous of [null, undefined]) {
    assert.deepEqual(patchTaskFonts('new', previous, { fontSize: 20 }), {
      terminalId: 'new', fontFamily: null, fontSize: 20, gitDiffFontSize: null
    })
  }
})

test('TF-07: font edits and resets survive JSON reload independently for multiple Tasks', () => {
  const settings = {
    terminalStyles: { a: patchTaskFonts('a', taskFonts(), { fontFamily: null, gitDiffFontSize: 24 }), b: taskFonts() },
    globalTerminalStyle: globalFonts()
  }
  const loaded = JSON.parse(JSON.stringify(settings))
  assert.deepEqual(resolveTaskFonts(loaded, 'a'), { terminalId: 'a', fontFamily: null, fontSize: 22, gitDiffFontSize: 24 })
  assert.deepEqual(resolveTaskFonts(loaded, 'b'), { ...taskFonts(), terminalId: 'b' })
  assert.deepEqual(resolveTaskFonts(loaded, 'new'), { terminalId: 'new', ...globalFonts() })
})
