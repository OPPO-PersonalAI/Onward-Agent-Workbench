/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPromptTaskHistorySummary, extractTaskNumber } from '../../src/components/PromptNotebook/promptTaskHistory.ts'
import type { Prompt, PromptSendRecord } from '../../src/types/electron.d.ts'

function record(task: number, inputResult?: PromptSendRecord['inputResult']): PromptSendRecord {
  return { taskId: `task-${task}`, taskName: `Task ${task}`, action: 'sendAndExecute', sentAt: 1, inputResult }
}
function prompt(sendHistory: PromptSendRecord[]): Prompt {
  return { id: 'draft', title: '', content: 'Snapshot', pinned: false, createdAt: 1, updatedAt: 1, lastUsedAt: 1, sendHistory }
}

test('PTH-01: badges describe actual text delivery, including suffix failures but excluding rejected recipients', () => {
  const item = prompt([
    record(1, { ok: true, phase: 'complete', contentDelivered: true }),
    record(2, { ok: false, phase: 'content', contentDelivered: false, reason: 'unsafe-multiline-send' }),
    record(3, { ok: false, phase: 'key', contentDelivered: true, reason: 'write-failed' }),
    record(4, { ok: true, phase: 'complete', contentDelivered: false }),
    record(5)
  ])
  const original = structuredClone(item)
  const result = buildPromptTaskHistorySummary([item], 5)
  assert.deepEqual(result.promptTaskNumbers.get('draft'), [1, 3, 5])
  assert.deepEqual(result.allTaskNumbers, [1, 2, 3, 4, 5])
  assert.deepEqual(item, original)
})

test('PTH-02: only visible valid slot numbers remain, deduplicated in numeric order', () => {
  const item = prompt([record(3), record(1), record(3), record(9), { ...record(2), taskName: 'Custom name' }])
  assert.deepEqual(buildPromptTaskHistorySummary([item], 3).promptTaskNumbers.get('draft'), [1, 3])
  for (const count of [0, -1, NaN]) assert.equal(buildPromptTaskHistorySummary([item], count).promptTaskNumbers.size, 0)
  for (const name of ['Task 0', 'Task -1', 'Task unknown', 'SubTask 2']) assert.equal(extractTaskNumber(name), null)
})
