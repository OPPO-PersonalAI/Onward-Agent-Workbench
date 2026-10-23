/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prompt, PromptSendRecord } from '../../src/types/electron.d.ts'
import {
  buildImportPlan, normalizePromptForExport, parsePromptExportPayload,
  PROMPT_EXPORT_SCHEMA_VERSION, validateExportPayload
} from '../../src/utils/prompt-io.ts'
import { PROMPT_TERMINAL_KEYS } from '../../src/utils/prompt-input.ts'

const timestamp = 1700000000000
const legacy: PromptSendRecord = { taskId: 'task-1', taskName: 'Build', sentAt: timestamp, action: 'sendAndExecute' }
const delivered: PromptSendRecord = {
  ...legacy, inputActionId: 'custom-queue', inputTerminalKey: 'Tab',
  inputResult: { ok: true, phase: 'complete', contentDelivered: true }
}

function prompt(id: string, sendHistory: PromptSendRecord[]): Prompt {
  return { id, title: id, content: `Content ${id}\r\n\u63d0\u793a \ud83e\uddea`, pinned: false,
    createdAt: timestamp, updatedAt: timestamp, lastUsedAt: timestamp, sendHistory }
}

function payloadWith(record: unknown, scope: 'global' | 'local') {
  const recordPrompt = { ...normalizePromptForExport(prompt(scope, []), timestamp), sendHistory: [record] }
  return {
    schemaVersion: PROMPT_EXPORT_SCHEMA_VERSION,
    globalPrompts: scope === 'global' ? [recordPrompt] : [],
    tabs: scope === 'local' ? [{ localPrompts: [recordPrompt] }] : []
  }
}

test('PIH-U01: schema-v1 legacy history imports without introducing action metadata', () => {
  const records: PromptSendRecord[] = [
    { ...legacy, action: 'send' }, { ...legacy, action: 'execute' }, legacy,
    { ...legacy, result: 'executed' }, { ...legacy, result: 'sent-only' }
  ]
  const payload = {
    schemaVersion: 1, globalPrompts: [normalizePromptForExport(prompt('global', records), timestamp)],
    tabs: [{ localPrompts: [normalizePromptForExport(prompt('local', records), timestamp)] }]
  }
  const parsed = parsePromptExportPayload(JSON.stringify(payload))
  assert(parsed.success)
  const plan = buildImportPlan(parsed.payload, [])
  assert.equal(plan.duplicateCount, 0)
  assert.equal(plan.globals[0].pinned, true)
  assert.equal(plan.locals[0].pinned, false)
  for (const imported of [...plan.globals, ...plan.locals]) {
    assert.deepEqual(imported.sendHistory, records)
    for (const record of imported.sendHistory!) {
      assert(!Object.hasOwn(record, 'inputActionId'))
      assert(!Object.hasOwn(record, 'inputTerminalKey'))
      assert(!Object.hasOwn(record, 'inputResult'))
    }
  }
})

test('PIH-U02: mixed outcomes and custom action identity survive JSON export/import/re-export', () => {
  const records: PromptSendRecord[] = [
    legacy, delivered,
    { ...delivered, taskId: 'task-2', taskName: '\u6d4b\u8bd5 \ud83e\uddea', inputTerminalKey: 'Enter', inputResult: { ok: false, phase: 'key', contentDelivered: true, reason: 'write-failed' } },
    { ...delivered, taskId: 'task-3', inputResult: { ok: false, phase: 'content', contentDelivered: false, reason: 'unsafe-multiline-send' } },
    { ...delivered, taskId: 'task-4', inputResult: { ok: false, phase: 'content', contentDelivered: false, reason: 'unavailable' } }
  ]
  const original = prompt('mixed', records)
  const exported = normalizePromptForExport(original, timestamp)
  const parsed = parsePromptExportPayload(JSON.stringify({ schemaVersion: 1, globalPrompts: [], tabs: [{ localPrompts: [exported] }] }))
  assert(parsed.success)
  const plan = buildImportPlan(parsed.payload, [])
  assert.equal(plan.locals.length, 1)
  const imported = plan.locals[0]
  assert.notEqual(imported.id, original.id)
  assert.equal(imported.content, original.content)
  assert.deepEqual(imported.sendHistory, records)
  const reexported = normalizePromptForExport(imported, timestamp + 1)
  assert.deepEqual(reexported.sendHistory, records)
  assert.equal(reexported.createdAt, timestamp)
  assert.equal(reexported.lastUsedAtIso, new Date(timestamp).toISOString())
  assert.deepEqual(original, prompt('mixed', records))
  assert.equal(buildImportPlan(parsed.payload, [imported]).duplicateCount, 1)
})

test('PIH-U03: every supported terminal suffix and independent optional metadata field validate', () => {
  for (const scope of ['global', 'local'] as const) {
    for (const inputTerminalKey of PROMPT_TERMINAL_KEYS) {
      assert.equal(validateExportPayload(payloadWith({ ...delivered, inputTerminalKey }, scope)).valid, true, inputTerminalKey)
    }
    for (const record of [legacy, { ...legacy, inputActionId: 'a'.repeat(128) },
      { ...legacy, inputTerminalKey: 'None' }, { ...legacy, inputResult: delivered.inputResult }]) {
      assert.equal(validateExportPayload(payloadWith(record, scope)).valid, true)
    }
    for (const reason of ['invalid-input', 'unavailable', 'unsafe-multiline-send', 'write-failed', undefined]) {
      const record = { ...delivered, inputResult: { ok: false, phase: 'content', contentDelivered: false, reason } }
      assert.equal(validateExportPayload(payloadWith(record, scope)).valid, true)
    }
  }
})

test('PIH-U04: malformed action identity and terminal suffix reject either import scope', () => {
  const patches = [
    ...[null, 42, {}, [], 'a'.repeat(129)].map(inputActionId => ({ inputActionId })),
    ...[null, 42, {}, ['Tab'], 'Q', 'Ctrl+C', '\t', '\x1b[201~', '__proto__'].map(inputTerminalKey => ({ inputTerminalKey }))
  ]
  for (const scope of ['global', 'local'] as const) {
    for (const patch of patches) {
      const parsed = parsePromptExportPayload(JSON.stringify(payloadWith({ ...delivered, ...patch }, scope)))
      assert.equal(parsed.success, false, `${scope}: ${JSON.stringify(patch)}`)
    }
  }
})

test('PIH-U05: result enums are strict strings, never coerced arrays or partial objects', () => {
  const invalid = [null, [], true, 'complete', {},
    { ok: 'true', phase: 'complete', contentDelivered: true },
    { ok: true, phase: 'complete', contentDelivered: 1 },
    { ok: true, phase: 'unknown', contentDelivered: true },
    { ok: true, phase: ['complete'], contentDelivered: true },
    { ok: true, phase: null, contentDelivered: true },
    { ok: true, phase: 'complete' },
    { phase: 'complete', contentDelivered: true },
    { ok: false, phase: 'key', contentDelivered: true, reason: 'new-unknown-reason' },
    { ok: false, phase: 'key', contentDelivered: true, reason: ['write-failed'] },
    { ok: false, phase: 'key', contentDelivered: true, reason: null },
    { ok: false, phase: 'key', contentDelivered: true, reason: 0 }
  ]
  for (const scope of ['global', 'local'] as const) {
    for (const inputResult of invalid) {
      const parsed = parsePromptExportPayload(JSON.stringify(payloadWith({ ...delivered, inputResult }, scope)))
      assert.equal(parsed.success, false, `${scope}: ${JSON.stringify(inputResult)}`)
    }
  }
})
