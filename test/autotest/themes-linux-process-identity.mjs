/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'

const LIVE_STATES = new Set(['R', 'S', 'D', 'T', 't', 'I'])
const UNAVAILABLE_CODES = new Set(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])
const validPid = pid => Number.isSafeInteger(pid) && pid > 1

export function parseLinuxProcessStat(text) {
  if (typeof text !== 'string') return null
  const prefix = /^(\d+) \(/.exec(text)
  const closing = text.lastIndexOf(') ')
  if (!prefix || closing < prefix[0].length) return null
  const pid = Number(prefix[1])
  // comm can contain spaces, parentheses, and newlines. Fields following its
  // closing parenthesis begin at field 3; field 22 is the process start time.
  const fields = text.slice(closing + 2).trim().split(/\s+/)
  if (!validPid(pid) || !LIVE_STATES.has(fields[0]) || !/^\d+$/.test(fields[19] ?? '')) return null
  return { pid, state: fields[0], startTime: fields[19] }
}

export function parseLinuxCommandLine(text) {
  // An empty or incomplete cmdline cannot prove a live Electron main process.
  if (typeof text !== 'string' || !text.endsWith('\0')) return null
  const argv = text.slice(0, -1).split('\0')
  return argv[0] ? argv : null
}

export function isEligibleLinuxMainProcess(expectedExecutable, selfPid, initial, current) {
  if (typeof expectedExecutable !== 'string' || !expectedExecutable) return false
  const eligible = snapshot => snapshot && validPid(snapshot.pid) && snapshot.pid !== selfPid &&
    LIVE_STATES.has(snapshot.state) && typeof snapshot.startTime === 'string' && /^\d+$/.test(snapshot.startTime) &&
    snapshot.executable === expectedExecutable && Array.isArray(snapshot.argv) && snapshot.argv.length > 0 &&
    typeof snapshot.argv[0] === 'string' && snapshot.argv[0].length > 0 &&
    snapshot.argv.every(arg => typeof arg === 'string' && !arg.includes('\0') && !/^-{1,2}(?:type|utility-sub-type)(?:=|$)/i.test(arg))
  if (!eligible(initial) || !eligible(current)) return false
  return initial.pid === current.pid && initial.startTime === current.startTime &&
    initial.argv.length === current.argv.length && initial.argv.every((arg, index) => arg === current.argv[index])
}

export function readLinuxProcessIdentity(pid, {
  procRoot = '/proc',
  readText = filename => readFileSync(filename, 'utf8'),
  resolvePath = realpathSync
} = {}) {
  if (!validPid(pid)) return null
  const directory = path.join(procRoot, String(pid))
  try {
    const before = parseLinuxProcessStat(readText(path.join(directory, 'stat')))
    if (!before || before.pid !== pid) return null
    const executable = resolvePath(path.join(directory, 'exe'))
    const argv = parseLinuxCommandLine(readText(path.join(directory, 'cmdline')))
    const after = parseLinuxProcessStat(readText(path.join(directory, 'stat')))
    if (!argv || !after || after.pid !== pid || before.startTime !== after.startTime) return null
    return { ...after, executable, argv }
  } catch (error) {
    // Exit races and unreadable identities are ineligible, never grounds to
    // fall back to a truncated comm, command-line substring, or guessed PID.
    if (UNAVAILABLE_CODES.has(error.code)) return null
    throw error
  }
}

export function signalVerifiedLinuxMainProcesses({ expectedExecutable, selfPid, pids, readIdentity, signal }) {
  const result = { matchedPids: [], signaledPids: [], changedPids: [], exitedPids: [] }
  for (const pid of new Set(pids)) {
    if (!validPid(pid) || pid === selfPid) continue
    const initial = readIdentity(pid)
    if (initial?.pid !== pid || !isEligibleLinuxMainProcess(expectedExecutable, selfPid, initial, initial)) continue
    result.matchedPids.push(pid)
    const current = readIdentity(pid)
    if (!isEligibleLinuxMainProcess(expectedExecutable, selfPid, initial, current)) {
      result.changedPids.push(pid)
      continue
    }
    // No await/logging between the final proof and the exact positive-PID signal.
    // Revalidation detects observed PID reuse/exec/exit races. process.kill is
    // not pidfd-based, so it cannot make the final read-to-signal gap atomic.
    try {
      signal(pid, 'SIGTERM')
      result.signaledPids.push(pid)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      result.exitedPids.push(pid)
    }
  }
  return result
}

/** Linux-only test-runner cleanup; importing this module does not inspect or kill processes. */
export function stopLinuxMainProcessesByExecutable(appBin) {
  if (process.platform !== 'linux') throw new Error('Executable-identity cleanup requires Linux /proc')
  // Linux comm is capped at 15 characters, so pgrep -x cannot identify long
  // development product names. The exact canonical /proc/<pid>/exe path is
  // the authority instead. Electron helpers can share that executable: reject
  // every subtype argument and require a stable PID/start-time pair as well.
  // This is an exact-executable identity check, never a partial-name selector.
  const expectedExecutable = realpathSync(appBin)
  const pids = readdirSync('/proc').filter(name => /^[1-9]\d*$/.test(name)).map(Number)
  return signalVerifiedLinuxMainProcesses({
    expectedExecutable,
    selfPid: process.pid,
    pids,
    readIdentity: readLinuxProcessIdentity,
    signal: (pid, signal) => process.kill(pid, signal)
  })
}
