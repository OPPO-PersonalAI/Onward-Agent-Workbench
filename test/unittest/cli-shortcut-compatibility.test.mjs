/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ROOT, PLATFORMS, contracts, historicalContracts, repairs, clipboards, createHarness, observe, compareDelivery, baselineVerdict, auditContracts
} from '../autotest/cli-shortcut-compatibility-support.mjs'

const STRICT = process.argv.includes('--strict')
const REPORT = process.argv.includes('--report')
const audit = auditContracts()

test('CLI-KB-01: documented contracts have explicit sources, contexts, and bounded known gaps', () => {
  assert.match(contracts.reviewedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(new Set(contracts.cases.map(item => item.id)).size, contracts.cases.length)
  const products = new Set()
  for (const item of contracts.cases) {
    assert(item.context && item.expect)
    assert(Boolean(item.entry) !== Boolean(item.strokes), `${item.id}: one entry kind is required`)
    assert(item.sources.length > 0)
    for (const id of item.sources) {
      const source = contracts.sources[id]
      assert(source?.product && source.scope)
      assert.equal(new URL(source.url).protocol, 'https:')
      products.add(source.product)
    }
    for (const platform of item.platforms ?? PLATFORMS) assert(PLATFORMS.includes(platform))
    if (item.knownGap) {
      assert(item.knownGap.reason.length > 20)
      assert(item.knownGap.platforms.length > 0)
      for (const platform of item.knownGap.platforms) {
        assert((item.platforms ?? PLATFORMS).includes(platform))
        const code = typeof item.knownGap.code === 'object' ? item.knownGap.code[platform] : item.knownGap.code
        assert(typeof code === 'string' && code.length > 0, 'A gap cannot exempt arbitrary failure modes')
      }
    }
  }
  assert.deepEqual([...products].sort(), ['Antigravity CLI', 'Claude Code', 'Codex', 'OpenCode'])
  assert(contracts.unverified.length > 0, 'Unit coverage must not imply native/attachment verification')
})

test('CLI-KB-02: actual host routing and terminal encoding introduce no unreviewed incompatibilities', async t => {
  const rows = await audit
  for (const row of rows.filter(row => row.status !== 'PASS')) t.diagnostic(`${row.status} ${row.platform}/${row.id}: ${row.failure}`)
  const invalid = rows.filter(row => !['PASS', 'KNOWN_GAP'].includes(row.status))
  assert.deepEqual(invalid.map(({ id, platform, failure, status }) => ({ id, platform, failure, status })), [],
    'New defects fail; repaired known gaps require removing their stale baseline entries')
  t.diagnostic(`Transport baseline: ${rows.filter(row => row.status === 'PASS').length} passed, ${rows.filter(row => row.status === 'KNOWN_GAP').length} known gaps; NOT full CLI compatibility`)
})

test('CLI-KB-03: mutation checks reject lost, changed, duplicated, or wrongly owned input', () => {
  const base = { hex: '0d', data: ['\r'], actions: [], promptEvents: [], routes: [] }
  const enter = { expect: { hex: '0d' } }
  assert.equal(compareDelivery(enter, base), null)
  assert.equal(compareDelivery(enter, { ...base, hex: '' }), 'no-delivery')
  assert.equal(compareDelivery(enter, { ...base, hex: '0a' }), 'wrong-bytes')
  assert.equal(compareDelivery(enter, { ...base, hex: '0d0d' }), 'wrong-bytes')
  assert.equal(compareDelivery(enter, { ...base, actions: [{ type: 'focusPromptEditor' }] }), 'unexpected-host-action')
  const modified = historicalContracts.cases.find(item => item.id === 'newline-shift-enter')
  assert.equal(compareDelivery(modified, base, { Enter: '0d' }), 'aliases:Enter')
  assert.equal(baselineVerdict(modified, 'win32', 'aliases:Enter'), 'KNOWN_GAP')
  assert.equal(baselineVerdict(modified, 'win32', 'aliases:Enter', true), 'FAIL_KNOWN_GAP')
  assert.equal(baselineVerdict(modified, 'win32', 'no-delivery'), 'REGRESSION', 'A known alias cannot excuse newly lost input')
  assert.equal(baselineVerdict(modified, 'win32', null), 'BASELINE_STALE', 'A repair must retire its exception')
  assert.equal(baselineVerdict(enter, 'win32', 'wrong-bytes'), 'REGRESSION')
  const paste = { entry: 'context', expect: { textFixture: 'plain' } }
  const text = clipboards.plain.text
  assert.equal(compareDelivery(paste, { ...base, hex: Buffer.from(text).toString('hex'), data: [text.slice(0, 3), text.slice(3)] }), 'duplicate-paste')
})

test('CLI-KB-04: default host bindings preserve ordinary CLI controls and independent target streams', async () => {
  for (const platform of PLATFORMS) {
    const first = createHarness(platform)
    const second = createHarness(platform)
    try {
      assert(Object.values(first.shortcuts).every(value => value === null), 'New default host chords need compatibility review')
      assert.equal(first.settings.leader, null)
      let expected = ''
      for (let round = 0; round < 5; round++) for (const letter of 'ABCDEFGHIJKLMNOPQRSTUWXYZ') {
        await first.press(`Control+${letter}`)
        expected += String.fromCharCode(letter.charCodeAt(0) - 64)
      }
      assert.equal(first.result().hex, Buffer.from(expected).toString('hex'))
      assert.equal(first.result().actions.length, 0)
      assert.equal(second.result().hex, '', 'Input cannot leak into another terminal')
      await second.press('Control+J')
      assert.equal(second.result().hex, '0a')
      assert.equal(first.result().hex, Buffer.from(expected).toString('hex'))
    } finally { first.dispose(); second.dispose() }
  }
})

test('CLI-KB-05: repeated leader cancellation and passthrough do not retain timers or consume later CLI input', async () => {
  for (const platform of PLATFORMS) {
    const harness = createHarness(platform, { hostLeader: 'Control+X' })
    try {
      for (let trial = 0; trial < 5; trial++) {
        for (let sequence = 0; sequence < 20; sequence++) {
          await harness.press('Control+X')
          await harness.press('Escape')
          await harness.press('Control+P')
          await harness.press('Control+X')
          await harness.press('Control+X')
        }
        // The input adapter owns one bounded diagnostic batch timer; no Leader
        // timer may survive cancellation, and the diagnostic timer must drain.
        assert.deepEqual([...harness.timers.keys()], [harness.inputAdapter.timer])
        assert.equal(harness.controller.state, null)
        harness.advance(1000)
        assert.equal(harness.timers.size, 0)
      }
      assert.equal(harness.result().hex, '1018'.repeat(100))
      await harness.press('Control+X')
      harness.advance(2000)
      await harness.press('Control+P')
      assert(harness.result().hex.endsWith('101810'))
      assert.deepEqual([...harness.timers.keys()], [harness.inputAdapter.timer])
      assert.equal(harness.controller.state, null)
      harness.advance(1000)
      assert.equal(harness.timers.size, 0)
    } finally { harness.dispose() }
  }
})

test('CLI-KB-06: selection-copy is conditional, empty text is inert, and clipboard paths remain single-delivery', async () => {
  for (const platform of PLATFORMS) {
    const selection = createHarness(platform, { selection: true })
    try {
      await selection.press('Control+C')
      if (platform === 'darwin') { assert.equal(selection.result().hex, '03'); assert.equal(selection.result().copied.length, 0) }
      else {
        assert.equal(selection.result().hex, '')
        assert.deepEqual(selection.result().copied, [clipboards.plain.text])
        await selection.press('Control+C')
        assert.equal(selection.result().hex, '03', 'Copy must clear selection and release subsequent interrupt')
      }
    } finally { selection.dispose() }
    const empty = await observe({ entry: 'context', clipboard: 'empty' }, platform)
    assert.equal(empty.hex, '')
    for (const entry of ['context', 'nativePaste']) for (let trial = 0; trial < 5; trial++) {
      const item = { entry, clipboard: 'multiline', bracketed: true, expect: { textFixture: 'multiline', bracketed: true } }
      assert.equal(compareDelivery(item, await observe(item, platform)), null)
    }
  }
})

test('CLI-KB-07: strict mode rejects every known gap and never presents the baseline as compatibility success', async t => {
  const rows = await audit
  const gaps = rows.filter(row => row.failure)
  const report = { authority: contracts.authority, reviewedAt: contracts.reviewedAt, strict: STRICT,
    scope: 'Unit transport seams with simulated platforms; no native menu or real CLI attachment certification',
    counts: { scenarios: rows.length, passed: rows.filter(row => row.status === 'PASS').length,
      knownGaps: rows.filter(row => row.status === 'KNOWN_GAP').length,
      regressions: rows.filter(row => row.status === 'REGRESSION').length,
      staleBaseline: rows.filter(row => row.status === 'BASELINE_STALE').length },
    profileScope: repairs.scope, unverified: contracts.unverified, sources: contracts.sources, rows }
  if (REPORT) {
    const directory = path.join(ROOT, 'traces/test-logs/cli-shortcut-compatibility')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, STRICT ? 'strict.json' : 'baseline.json'), JSON.stringify(report, null, 2))
  }
  t.diagnostic(`Known incompatibilities: ${gaps.length}; unverified categories: ${contracts.unverified.length}; strict=${STRICT}`)
  if (STRICT) assert.deepEqual(gaps.map(row => `${row.platform}/${row.id}: ${row.failure}`), [], 'Strict compatibility is RED until the input defects are repaired')
  else for (const row of rows.filter(row => row.status === 'KNOWN_GAP')) {
    const contract = contracts.cases.find(item => item.id === row.id)
    assert.equal(baselineVerdict(contract, row.platform, row.failure, true), 'FAIL_KNOWN_GAP')
  }
})

test('CLI-KB-08: unnegotiated legacy encoding and native Option composition are explicitly preserved', async () => {
  for (const item of historicalContracts.cases.filter(item => item.knownGap && (repairs.cases[item.id]?.keyboardFlags || item.id === 'option-word'))) {
    for (const platform of item.knownGap.platforms) {
      const references = {}
      for (const stroke of item.expect.distinctFrom ?? []) references[stroke] = (await observe({ strokes: [stroke] }, platform)).hex
      const failure = compareDelivery(item, await observe(item, platform), references)
      assert.equal(baselineVerdict(item, platform, failure), 'KNOWN_GAP', `${platform}/${item.id}: legacy mode changed`)
    }
  }
})
