// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  inventoryTraceFiles,
  selectNewTraceFiles,
  validateTraceFiles,
} from '../autotest/trace-self-check-files.mjs'

const fixtures = fileURLToPath(new URL('../autotest/fixtures/trace-self-check/', import.meta.url))
const helper = fileURLToPath(new URL('../autotest/trace-self-check-files.mjs', import.meta.url))

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onward-trace-selection-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const traceDir = path.join(root, 'trace directory with spaces')
  fs.mkdirSync(traceDir)
  const copy = (fixture, name) => {
    const destination = path.join(traceDir, name)
    fs.copyFileSync(path.join(fixtures, fixture), destination)
    return destination
  }
  return { root, traceDir, copy }
}

test('mixed old/new chunks validate only new files and preserve all old evidence', t => {
  const { traceDir, copy } = setup(t)
  copy('truncated.jsonl', 'perf-old-a.jsonl')
  copy('truncated.jsonl', 'perf-old-b.jsonl')
  copy('legacy.json', 'old.json')
  fs.writeFileSync(path.join(traceDir, 'latest.txt'), 'perf-old-a.jsonl\n')
  const before = inventoryTraceFiles(traceDir)
  const oldBytes = before.names.map(name => [name, fs.readFileSync(path.join(traceDir, name))])
  const main = copy('main.jsonl', 'perf-current-a.jsonl')
  const renderer = copy('renderer.jsonl', 'perf-current-b.jsonl')
  copy('legacy.json', 'current.json')
  copy('main.jsonl', 'unrelated.jsonl')
  fs.mkdirSync(path.join(traceDir, 'perf-directory.jsonl'))
  const selection = selectNewTraceFiles(traceDir, before)
  assert.deepEqual(selection, { format: 'ndjson', files: [main, renderer] })
  const result = validateTraceFiles(selection)
  assert.equal(result.events.length, 2)
  assert.equal(result.invalidLines, 0)
  for (const [name, bytes] of oldBytes) {
    assert.deepEqual(fs.readFileSync(path.join(traceDir, name)), bytes, name)
  }
})

test('old traces and a rewritten old filename cannot satisfy a run with no new trace', t => {
  const { traceDir, copy } = setup(t)
  copy('main.jsonl', 'perf-old.jsonl')
  copy('legacy.json', 'old.json')
  const before = inventoryTraceFiles(traceDir)
  copy('truncated.jsonl', 'perf-old.jsonl')
  assert.throws(() => selectNewTraceFiles(traceDir, before), /No newly created/)
})

test('legacy fallback selects only the newest newly created JSON despite old NDJSON', t => {
  const { traceDir, copy } = setup(t)
  copy('main.jsonl', 'perf-old.jsonl')
  const old = copy('legacy.json', 'old.json')
  fs.utimesSync(old, new Date('2030-01-01'), new Date('2030-01-01'))
  const before = inventoryTraceFiles(traceDir)
  const earlier = copy('legacy.json', 'earlier.json')
  fs.utimesSync(earlier, new Date('2020-01-01'), new Date('2020-01-01'))
  const current = copy('legacy-partial.txt', 'current.json')
  const selection = selectNewTraceFiles(traceDir, before)
  assert.deepEqual(selection, { format: 'legacy', files: [current] })
  assert.equal(validateTraceFiles(selection).events[0].name, 'main:trace-start')
})

test('an old main canary cannot rescue new renderer-only output or trigger legacy fallback', t => {
  const { traceDir, copy } = setup(t)
  copy('main.jsonl', 'perf-old.jsonl')
  const before = inventoryTraceFiles(traceDir)
  copy('renderer.jsonl', 'perf-current.jsonl')
  copy('legacy.json', 'current.json')
  const selection = selectNewTraceFiles(traceDir, before)
  assert.equal(selection.format, 'ndjson')
  assert.throws(() => validateTraceFiles(selection), /no main:\* event/)
})

test('NDJSON parser preserves the one-partial-line allowance across all selected chunks', t => {
  const { traceDir, copy } = setup(t)
  const before = inventoryTraceFiles(traceDir)
  copy('truncated.jsonl', 'perf-current-a.jsonl')
  const result = validateTraceFiles(selectNewTraceFiles(traceDir, before))
  assert.equal(result.events.length, 1)
  assert.equal(result.invalidLines, 1)
  copy('truncated.jsonl', 'perf-current-b.jsonl')
  assert.throws(() => validateTraceFiles(selectNewTraceFiles(traceDir, before)), /2 unparseable lines/)
})

test('empty NDJSON and malformed legacy output fail actual parser validation', t => {
  const { traceDir, copy } = setup(t)
  const before = inventoryTraceFiles(traceDir)
  const empty = path.join(traceDir, 'perf-empty.jsonl')
  fs.writeFileSync(empty, '')
  assert.throws(() => validateTraceFiles(selectNewTraceFiles(traceDir, before)), /no events parsed/)
  fs.unlinkSync(empty)
  copy('truncated.jsonl', 'malformed.json')
  assert.throws(() => validateTraceFiles(selectNewTraceFiles(traceDir, before)), SyntaxError)
})

test('inventory rejects validation against a different directory', t => {
  const { root, traceDir } = setup(t)
  const before = inventoryTraceFiles(traceDir)
  assert.throws(() => selectNewTraceFiles(root, before), /inventory directory changed/)
})

test('runner CLI round-trip seals only new parsed events and fails when no new output exists', t => {
  const { root, traceDir, copy } = setup(t)
  copy('main.jsonl', 'perf-old.jsonl')
  const inventory = path.join(root, 'before.json')
  const sealed = path.join(root, 'merged.json')
  const run = command => spawnSync(process.execPath, [helper, command, traceDir, inventory, sealed], {
    encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(run('inventory').status, 0)
  const missing = run('validate')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /No newly created/)
  assert.equal(fs.existsSync(sealed), false)
  copy('truncated.jsonl', 'perf-current.jsonl')
  const valid = run('validate')
  assert.equal(valid.status, 0, valid.stderr)
  assert.match(valid.stdout, /first main event found/)
  const envelope = JSON.parse(fs.readFileSync(sealed, 'utf8'))
  assert.equal(envelope.traceEvents.length, 1)
  assert.equal(envelope.traceEvents[0].name, 'main:trace-start')
})
