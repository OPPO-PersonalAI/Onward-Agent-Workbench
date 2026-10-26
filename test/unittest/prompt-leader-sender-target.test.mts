/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { promptLeaderTargetFor } from '../../src/utils/prompt-input.ts'

const targets = [{ id: 'task-a' }, { id: 'task-b' }]
const view = (event: { tabId: string; active: boolean; targetId?: string }) => ({ event, targets })

test('PLT-U01: no cue, waiting, or choosing never highlights a sender card', () => {
  assert.equal(promptLeaderTargetFor(null, 'tab-a'), null)
  assert.equal(promptLeaderTargetFor(undefined, 'tab-a'), null)
  assert.equal(promptLeaderTargetFor(view({ tabId: 'tab-a', active: true }), 'tab-a'), null)
})

test('PLT-U02: picked target highlights only in the owning Tab', () => {
  const picked = view({ tabId: 'tab-a', active: true, targetId: 'task-b' })
  assert.equal(promptLeaderTargetFor(picked, 'tab-a'), 'task-b')
  assert.equal(promptLeaderTargetFor(picked, 'tab-b'), null)
})

test('PLT-U03: inactive or stale targets are ignored', () => {
  assert.equal(promptLeaderTargetFor(view({ tabId: 'tab-a', active: false, targetId: 'task-a' }), 'tab-a'), null)
  assert.equal(promptLeaderTargetFor(view({ tabId: 'tab-a', active: true, targetId: 'task-gone' }), 'tab-a'), null)
})
