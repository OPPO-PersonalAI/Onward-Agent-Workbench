// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict')
const native = require(process.argv[2])
const mode = process.argv[3]
const original = new Error('original native callback exception')
const timer = setTimeout(() => { throw new Error('Native callback never completed') }, 5000)
process.once('uncaughtException', error => {
  clearTimeout(timer)
  assert.equal(error, original, 'Native completion must preserve the original JavaScript exception')
  console.log(`PASS callback-${mode}`)
})
if (mode === 'process') {
  native.getProcessList(rows => {
    assert(rows.some(row => row.pid === process.pid))
    throw original
  }, 0)
} else if (mode === 'cpu') {
  native.getProcessCpuUsage([{ pid: process.pid }], rows => {
    assert.equal(rows[0].pid, process.pid)
    throw original
  })
} else throw new Error(`Unknown native callback mode: ${mode}`)
