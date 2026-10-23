/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/quit-activity.test.mts
 *
 * Locks the pure activity-classification decision table behind the
 * activity-aware quit confirmation (electron/main/quit-activity.ts):
 * descendant enumeration + ignore-list (the iTerm2/VS Code/WezTerm-style
 * criterion), idle-shell zero-false-positive, multi-level descendants,
 * cycle guarding, and the dialog summary shaping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_IGNORED_JOB_NAMES,
  buildChildrenIndex,
  classifyTerminalActivity,
  collectAllDescendantPids,
  collectDescendantJobs,
  normalizeJobName,
  selectHangupEscalationTargets,
  summarizeQuitActivity,
  verifyEscalationTargets,
  type DetailedProcessRow,
  type ProcessTableRow
} from '../../electron/main/quit-activity.ts'

const row = (pid: number, ppid: number, name: string): ProcessTableRow => ({ pid, ppid, name })
const detailedRow = (
  pid: number,
  ppid: number,
  pgid: number,
  tpgid: number,
  startedAt: string
): DetailedProcessRow => ({ pid, ppid, pgid, tpgid, startedAt, name: '' })

test('QAC-U-01: idle shell (no descendants) is never active', () => {
  const table = [row(100, 1, 'zsh')]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, false)
  assert.deepEqual(a.jobs, [])
})

test('QAC-U-02: shell with only ignored helpers (login/starship/self-fork) stays idle', () => {
  const table = [
    row(100, 1, '-zsh'),
    row(101, 100, 'starship'),
    row(102, 100, '/usr/bin/login'),
    row(103, 100, 'zsh')
  ]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, false)
})

test('QAC-U-03: a real job (codex) marks the terminal active and is named', () => {
  const table = [row(100, 1, 'zsh'), row(200, 100, 'codex')]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, true)
  assert.deepEqual(a.jobs, ['codex'])
})

test('QAC-U-04: multi-level descendants are found (zsh -> npm -> node)', () => {
  const table = [row(100, 1, 'zsh'), row(200, 100, 'npm'), row(300, 200, 'node')]
  const index = buildChildrenIndex(table)
  assert.deepEqual(collectDescendantJobs(index, 100), ['npm', 'node'])
})

test('QAC-U-05: backgrounded job still counts (no foreground-group blindness)', () => {
  // A `sleep 999 &` child: not in the foreground group, but a descendant.
  const table = [row(100, 1, 'zsh'), row(200, 100, 'sleep')]
  const [a] = classifyTerminalActivity([{ terminalId: 't1', shellPid: 100 }], table)
  assert.equal(a.active, true)
})

test('QAC-U-06: name normalization strips path, login dash, .exe, case', () => {
  assert.equal(normalizeJobName('/usr/local/bin/Codex'), 'codex')
  assert.equal(normalizeJobName('-zsh'), 'zsh')
  assert.equal(normalizeJobName('C:\\Windows\\System32\\conhost.exe'), 'conhost')
  assert.equal(normalizeJobName('PWSH.EXE'), 'pwsh')
})

test('QAC-U-07: cycle in a torn process-table snapshot terminates', () => {
  const table = [row(100, 1, 'zsh'), row(200, 100, 'vim'), row(100, 200, 'zsh')]
  const index = buildChildrenIndex(table)
  assert.deepEqual(collectDescendantJobs(index, 100), ['vim'])
})

test('QAC-U-08: summary counts, dedupes and caps names; labels fall back to ids', () => {
  const table: ProcessTableRow[] = [
    row(100, 1, 'zsh'),
    row(110, 100, 'codex'),
    row(200, 1, 'zsh'),
    row(210, 200, 'codex'),
    row(220, 200, 'vim'),
    row(300, 1, 'zsh'),
    row(400, 1, 'zsh'),
    row(410, 400, 'make')
  ]
  const activities = classifyTerminalActivity(
    [
      { terminalId: 't1', shellPid: 100, label: 'api-server' },
      { terminalId: 't2', shellPid: 200, label: '  ' },
      { terminalId: 't3', shellPid: 300 },
      { terminalId: 't4', shellPid: 400, label: 'build' }
    ],
    table
  )
  const s = summarizeQuitActivity(activities, 2)
  assert.equal(s.terminalCount, 4)
  assert.equal(s.activeCount, 3)
  assert.deepEqual(s.jobNames, ['codex', 'vim'])
  assert.deepEqual(s.activeTerminalLabels, ['api-server', 't2'])
})

test('QAC-U-10: ps output parser handles padding and command paths with spaces', async () => {
  const { parsePsTable } = await import('../../electron/main/process-table.ts')
  const out = '  100     1 /bin/zsh\n  200   100 /Applications/My App/Contents/MacOS/codex cli\n bad line\n'
  assert.deepEqual(parsePsTable(out), [
    { pid: 100, ppid: 1, name: '/bin/zsh' },
    { pid: 200, ppid: 100, name: '/Applications/My App/Contents/MacOS/codex cli' }
  ])
})

test('QAC-U-11: PowerShell CIM CSV parser handles quoted rows and CRLF', async () => {
  const { parseCimCsv } = await import('../../electron/main/process-table.ts')
  const out = '"4","0","System"\r\n"1234","4","conhost.exe"\r\nnot,a,row-x\r\n'
  assert.deepEqual(parseCimCsv(out), [
    { pid: 4, ppid: 0, name: 'System' },
    { pid: 1234, ppid: 4, name: 'conhost.exe' }
  ])
})

test('QAC-U-09: default ignore list covers shells and prompt decorators', () => {
  for (const name of ['bash', 'zsh', 'fish', 'starship', 'oh-my-posh', 'pwsh', 'conhost']) {
    assert.ok(DEFAULT_IGNORED_JOB_NAMES.has(name), `${name} should be ignored`)
  }
  assert.ok(!DEFAULT_IGNORED_JOB_NAMES.has('codex'))
  assert.ok(!DEFAULT_IGNORED_JOB_NAMES.has('tmux'))
})

test('QAC-U-12: collectAllDescendantPids collects multi-level descendant PIDs across multiple shells with cycle guard', () => {
  const table: ProcessTableRow[] = [
    row(100, 1, '-zsh'),
    row(110, 100, 'node'),
    row(120, 110, 'node'),
    row(200, 1, '-zsh'),
    row(210, 200, 'sleep'),
    row(100, 120, 'cycle-back'),
    row(999, 1, 'unrelated')
  ]
  assert.deepEqual(collectAllDescendantPids(table, [100, 200]), [110, 210, 120])
})

test('QAC-U-13: parsePsDetailedTable parses pid, ppid, pgid, tpgid and normalizes lstart', async () => {
  const { parsePsDetailedTable } = await import('../../electron/main/process-table.ts')
  const out = [
    '  100     1   100   110 Fri Oct 16  02:20:47 2026',
    '  110   100   110   110 Fri Oct 16 02:20:48 2026',
    '  120   100   120    -1 Fri Oct 16 02:20:49 2026',
    'invalid line'
  ].join('\n')
  assert.deepEqual(parsePsDetailedTable(out), [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 110, startedAt: 'Fri Oct 16 02:20:47 2026', name: '' },
    { pid: 110, ppid: 100, pgid: 110, tpgid: 110, startedAt: 'Fri Oct 16 02:20:48 2026', name: '' },
    { pid: 120, ppid: 100, pgid: 120, tpgid: -1, startedAt: 'Fri Oct 16 02:20:49 2026', name: '' }
  ])
})

test('QAC-U-14: selectHangupEscalationTargets includes only foreground-group descendants and spares nohup/disown/setsid background jobs', () => {
  const table: DetailedProcessRow[] = [
    detailedRow(100, 1, 100, 110, 'Fri Oct 16 02:00:00 2026'), // shell (foreground group is 110)
    detailedRow(110, 100, 110, 110, 'Fri Oct 16 02:00:01 2026'), // foreground parent job (pgid===tpgid===110)
    detailedRow(111, 110, 110, 110, 'Fri Oct 16 02:00:02 2026'), // foreground child in same group (pgid===tpgid===110)
    detailedRow(120, 100, 120, 110, 'Fri Oct 16 02:00:03 2026'), // background `nohup train.py &` (pgid=120 !== tpgid=110)
    detailedRow(130, 100, 130, 0, 'Fri Oct 16 02:00:04 2026') // detached `setsid` daemon (tpgid=0)
  ]
  assert.deepEqual(selectHangupEscalationTargets(table, [100]), [
    { pid: 110, pgid: 110, startedAt: 'Fri Oct 16 02:00:01 2026' },
    { pid: 111, pgid: 110, startedAt: 'Fri Oct 16 02:00:02 2026' }
  ])
})

test('QAC-U-15: verifyEscalationTargets accepts reparented survivors and rejects recycled PIDs', () => {
  const targets = [
    { pid: 110, pgid: 110, startedAt: 'Fri Oct 16 02:00:01 2026' },
    { pid: 111, pgid: 110, startedAt: 'Fri Oct 16 02:00:02 2026' },
    { pid: 112, pgid: 110, startedAt: 'Fri Oct 16 02:00:02 2026' }
  ]
  const freshTable: DetailedProcessRow[] = [
    // 110 survived, reparented to PID 1, controlling tty revoked (tpgid=-1), same pgid + startedAt
    detailedRow(110, 1, 110, -1, 'Fri Oct 16 02:00:01 2026'),
    // 111 exited and its PID was recycled by an unrelated process with a newer start time
    detailedRow(111, 1, 111, 111, 'Fri Oct 16 02:00:09 2026'),
    // 112 exited and its PID was recycled in the same second but a different pgid
    detailedRow(112, 1, 999, -1, 'Fri Oct 16 02:00:02 2026')
  ]
  assert.deepEqual(verifyEscalationTargets(targets, freshTable), [110])
})


