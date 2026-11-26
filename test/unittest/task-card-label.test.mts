/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { getTaskCardLabel } from '../../src/utils/task-card-label.ts'

test('TCL-U01: a named Task keeps its position number and trimmed custom name', () => {
  assert.deepEqual(
    getTaskCardLabel({ title: 'Task 3: api-server', customName: '  api-server ' }, 2),
    { position: 3, name: 'api-server', title: 'Task 3: api-server' }
  )
})

test('TCL-U02: a Task without a usable custom name reports name null', () => {
  for (const customName of [null, undefined, '', '   ']) {
    const label = getTaskCardLabel({ title: 'Task 7', customName }, 6)
    assert.equal(label.position, 7)
    assert.equal(label.name, null, `customName ${JSON.stringify(customName)}`)
    assert.equal(label.title, 'Task 7')
  }
})

test('TCL-U03: a missing or blank title falls back to "Task N" for tooltips', () => {
  assert.equal(getTaskCardLabel({ title: '', customName: 'docs' }, 0).title, 'Task 1')
  assert.equal(getTaskCardLabel({ title: '  ', customName: null }, 4).title, 'Task 5')
  assert.equal(getTaskCardLabel({ customName: null }, 1).title, 'Task 2')
})

test('TCL-U04: non-Latin names pass through unchanged', () => {
  const label = getTaskCardLabel({ title: 'Task 6: 前端重构', customName: '前端重构' }, 5)
  assert.equal(label.name, '前端重构')
  assert.equal(label.position, 6)
})

test('TCL-U05: the position is always a 1-based integer', () => {
  assert.equal(getTaskCardLabel({ title: 'x' }, 0).position, 1)
  assert.equal(getTaskCardLabel({ title: 'x' }, 7.9).position, 8)
  assert.equal(getTaskCardLabel({ title: 'x' }, -3).position, 1)
})
