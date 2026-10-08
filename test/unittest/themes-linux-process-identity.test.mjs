/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {
  isEligibleLinuxMainProcess,
  parseLinuxCommandLine,
  parseLinuxProcessStat,
  readLinuxProcessIdentity,
  signalVerifiedLinuxMainProcesses
} from '../autotest/themes-linux-process-identity.mjs'

// Opaque Linux process identities: no real filesystem or process is accessed.
const EXECUTABLE = '/work/white-theme/release/linux-unpacked/Under Development 2.0.1-white-theme'
const SELF_PID = 900
const main = overrides => ({
  pid: 42, state: 'S', startTime: '12345678901234567890', executable: EXECUTABLE,
  argv: [EXECUTABLE, '--remote-debugging-port=34567'], ...overrides
})
const eligible = (initial, current = initial) => isEligibleLinuxMainProcess(EXECUTABLE, SELF_PID, initial, current)
const stat = (startTime = '12345678901234567890', comm = 'Under Developme', state = 'S') =>
  `42 (${comm}) ${state} 1 42 42 0 -1 4194304 123 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 4096 512\n`

test('exact executable main process qualifies despite a long name and scheduler-state change', () => {
  assert(EXECUTABLE.split('/').at(-1).length > 15)
  assert.equal(eligible(main(), main({ state: 'R' })), true)
  // argv[0] alone is not the executable identity authority.
  assert.equal(eligible(main({ argv: ['renamed-main-title'] })), true)
})

test('helpers sharing the exact executable never qualify, for joined or split subtype switches', () => {
  for (const subtype of ['renderer', 'gpu-process', 'utility', 'zygote', 'broker', 'crashpad-handler']) {
    for (const args of [[`--type=${subtype}`], ['--type', subtype]]) {
      assert.equal(eligible(main({ argv: [EXECUTABLE, ...args] })), false, args.join(' '))
    }
  }
  for (const args of [['--type='], ['--type'], ['-type=renderer'], ['--TYPE=renderer'], ['--utility-sub-type=network.mojom.NetworkService']]) {
    assert.equal(eligible(main({ argv: [EXECUTABLE, ...args] })), false)
  }
})

test('other branches, same basename elsewhere, separate helper executables, and deleted binaries are rejected', () => {
  for (const executable of [
    EXECUTABLE.replace('2.0.1-white-theme', '2.0.1-other-branch'),
    EXECUTABLE.replace('/work/white-theme/', '/work/other-checkout/'),
    `${EXECUTABLE} Helper`, `${EXECUTABLE} (deleted)`, 'Under Developme'
  ]) assert.equal(eligible(main({ executable })), false, executable)
})

test('exited, unreadable, malformed, self, init, and process-group identities fail closed', () => {
  for (const value of [null, undefined, {}, main({ argv: [] }), main({ argv: null }), main({ argv: [''] }),
    main({ argv: [EXECUTABLE, 123] }), main({ argv: [EXECUTABLE, 'broken\0argument'] }),
    main({ startTime: '' }), main({ startTime: 123 }), main({ state: 'Z' }), main({ state: 'X' }),
    ...[SELF_PID, 1, 0, -42, 42.5, NaN, Number.MAX_SAFE_INTEGER + 1].map(pid => main({ pid }))]) {
    assert.equal(eligible(value), false)
  }
})

test('revalidation rejects PID reuse, exec, helper conversion, argument changes, and exit', () => {
  const initial = main()
  for (const current of [
    null, main({ pid: 43 }), main({ startTime: '12345678901234567891' }),
    main({ executable: '/usr/bin/node' }), main({ argv: [EXECUTABLE, '--type=renderer'] }),
    main({ argv: [EXECUTABLE, '--remote-debugging-port=45678'] }), main({ state: 'Z' })
  ]) assert.equal(eligible(initial, current), false)
})

test('proc stat parser ignores comm delimiters and keeps start ticks lossless', () => {
  assert.deepEqual(parseLinuxProcessStat(stat()), { pid: 42, state: 'S', startTime: '12345678901234567890' })
  assert.deepEqual(parseLinuxProcessStat(stat('456', 'name ) with (parentheses)\nand newline')), { pid: 42, state: 'S', startTime: '456' })
  for (const text of ['', '42 (truncated) S 1 2', stat('not-a-number'), stat('1', 'zombie', 'Z')]) {
    assert.equal(parseLinuxProcessStat(text), null)
  }
})

test('proc cmdline parser preserves NUL boundaries and rejects absent or incomplete evidence', () => {
  assert.deepEqual(parseLinuxCommandLine(`${EXECUTABLE}\0--type\0renderer\0`), [EXECUTABLE, '--type', 'renderer'])
  assert.deepEqual(parseLinuxCommandLine(`${EXECUTABLE}\0\0`), [EXECUTABLE, ''])
  for (const text of ['', '\0', EXECUTABLE, undefined]) assert.equal(parseLinuxCommandLine(text), null)
})

test('proc reader requires stable stat identity around exe/cmdline reads', () => {
  const run = (secondStat, cmdline = `${EXECUTABLE}\0`) => {
    let statReads = 0
    return readLinuxProcessIdentity(42, {
      procRoot: path.join('mock-proc'),
      resolvePath: filename => {
        assert.equal(path.basename(filename), 'exe')
        return EXECUTABLE
      },
      readText: filename => path.basename(filename) === 'cmdline' ? cmdline : (++statReads === 1 ? stat() : secondStat)
    })
  }
  assert.equal(run(stat()).executable, EXECUTABLE)
  assert.equal(run(stat('98765')), null, 'PID reused while reading cmdline')
  assert.equal(run(stat().replace(/^42 /, '43 ')), null, 'PID does not match requested directory')
  assert.equal(run(stat(), ''), null, 'Exited process has empty cmdline')
})

test('unreadable or vanished proc entries never trigger a guessed identity', () => {
  for (const code of ['ENOENT', 'ESRCH', 'EACCES', 'EPERM']) {
    assert.equal(readLinuxProcessIdentity(42, { readText: () => { throw Object.assign(new Error(code), { code }) } }), null)
  }
  assert.throws(() => readLinuxProcessIdentity(42, { readText: () => { throw Object.assign(new Error('I/O failure'), { code: 'EIO' }) } }), /I\/O failure/)
})

function signalsFor(snapshots, signalError) {
  const calls = []
  const reads = []
  const result = signalVerifiedLinuxMainProcesses({
    expectedExecutable: EXECUTABLE, selfPid: SELF_PID, pids: [0, 1, -42, SELF_PID, 42, 42],
    readIdentity: pid => { reads.push(pid); return snapshots.shift() ?? null },
    signal: (pid, signal) => {
      calls.push({ pid, signal })
      if (signalError) throw Object.assign(new Error(signalError), { code: signalError })
    }
  })
  return { calls, reads, result }
}

test('signaling coordinator signals only the twice-verified positive PID once', () => {
  const { calls, reads, result } = signalsFor([main(), main()])
  assert.deepEqual(reads, [42, 42])
  assert.deepEqual(calls, [{ pid: 42, signal: 'SIGTERM' }])
  assert.deepEqual(result.signaledPids, [42])
})

test('signaling coordinator never signals helpers, changed identities, or processes that vanished at recheck', () => {
  for (const snapshots of [
    [main({ argv: [EXECUTABLE, '--type=renderer'] })],
    [main({ executable: '/other/branch/app' })],
    [null], [main(), null], [main(), main({ startTime: '12345678901234567891' })],
    [main(), main({ argv: [EXECUTABLE, '--type=utility'] })]
  ]) assert.deepEqual(signalsFor(snapshots).calls, [])
})

test('exit at signal time is benign; permission errors abort instead of escalating', () => {
  const { result, calls } = signalsFor([main(), main()], 'ESRCH')
  assert.deepEqual(result.exitedPids, [42])
  assert.deepEqual(result.signaledPids, [])
  assert.equal(calls.length, 1)
  assert.throws(() => signalsFor([main(), main()], 'EPERM'), /EPERM/)
})
