// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// This is the receiver, not an echo-based oracle. Every stdin byte, including
// Ctrl+C, is appended unchanged. A separate file channel owns snapshots/stop.
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const directory = path.resolve(process.argv[2] ?? '')
assert(process.argv[2], 'Pass the suite-owned receiver directory')
assert(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function', 'Receiver requires a real PTY')
const bytesPath = path.join(directory, 'stdin.bin')
const commandPath = path.join(directory, 'command.json')
const statusPath = path.join(directory, 'status.json')
let length = 0
let commandId = 0
let bracketedPaste = true
let stopped = false

function status(extra = {}) {
  const temporary = `${statusPath}.next`
  writeFileSync(temporary, JSON.stringify({ pid: process.pid, ready: true, commandId, length, bracketedPaste, stopped, ...extra }))
  renameSync(temporary, statusPath)
}

function setBracketedPaste(enabled) {
  bracketedPaste = enabled
  process.stdout.write(enabled ? '\x1b[?2004h' : '\x1b[?2004l')
}

function stop(reason, code = 0) {
  if (stopped) return
  stopped = true
  clearInterval(commands)
  clearTimeout(deadline)
  setBracketedPaste(false)
  process.stdin.setRawMode(false)
  process.stdin.pause()
  status({ reason })
  process.exitCode = code
}

writeFileSync(bytesPath, Buffer.alloc(0))
process.stdin.setRawMode(true)
process.stdin.on('data', chunk => {
  assert(Buffer.isBuffer(chunk), 'No text decoder may normalize receiver bytes')
  appendFileSync(bytesPath, chunk)
  length += chunk.length
})
process.stdin.resume()
setBracketedPaste(true)
status()

const commands = setInterval(() => {
  if (!existsSync(commandPath)) return
  const command = JSON.parse(readFileSync(commandPath, 'utf8'))
  if (command.id <= commandId) return
  commandId = command.id
  if (command.operation === 'stop') stop('control-file')
  else if (command.operation === 'bracketed-paste') {
    setBracketedPaste(command.enabled === true)
    status()
  } else if (command.operation === 'snapshot') status()
  else throw new Error(`Unknown receiver command: ${command.operation}`)
}, 15)
// A leaked receiver cannot live beyond the regression runner's hard ceiling.
const deadline = setTimeout(() => stop('receiver-deadline', 1), 180000)
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))
