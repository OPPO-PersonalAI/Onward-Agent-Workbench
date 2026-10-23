/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
const fs = require('node:fs')
const { spawn } = require('node:child_process')

try { process.on('SIGHUP', () => {}) } catch {}
for (const stream of [process.stdout, process.stderr]) {
  if (stream && typeof stream.on === 'function') {
    stream.on('error', () => {})
  }
}

if (process.argv[2] === '--child') {
  process.stdout.write('READY\n')
  setInterval(() => {}, 1000)
} else {
  const pidFile = process.argv[2]
  const child = spawn(process.execPath, [__filename, '--child'], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  let recorded = false
  child.stdout.on('data', () => {
    if (recorded) return
    recorded = true
    if (pidFile) {
      fs.writeFileSync(`${pidFile}.tmp`, `${process.pid}\n${child.pid}\n`)
      fs.renameSync(`${pidFile}.tmp`, pidFile)
    }
  })
  const line = 'sighup-trap-pressure '.repeat(64) + '\n'
  setInterval(() => {
    try { process.stdout.write(line) } catch {}
  }, 10)
}
