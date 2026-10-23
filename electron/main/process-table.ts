/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-shot cross-platform process-table snapshot for the activity-aware
 * quit confirmation. Queried ONLY when the quit dialog is about to show —
 * no polling, no resident cost (VS Code polls because it feeds live UI;
 * our only consumer is the dialog).
 *
 * Per-platform sources (three independent branches, no shared fallback):
 *   - darwin / linux: `ps -axo pid=,ppid=,comm=` (VS Code uses the same)
 *   - win32: PowerShell CIM Win32_Process (VS Code uses a native module for
 *     the same data; a one-shot CIM query avoids the native dependency)
 */

import { execFile } from 'child_process'
import type { DetailedProcessRow, ProcessTableRow } from './quit-activity'

const QUERY_TIMEOUT_MS = 3000

/** Parse `ps -axo pid=,ppid=,comm=` output. Exported for unit coverage. */
export function parsePsTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] })
  }
  return rows
}

/** Parse the PowerShell CIM CSV (ProcessId,ParentProcessId,Name). Exported for unit coverage. */
export function parseCimCsv(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^"?(\d+)"?,"?(\d+)"?,"?(.+?)"?\s*$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] })
  }
  return rows
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * Parse `ps -axo pid=,ppid=,pgid=,tpgid=,lstart=` (run under LC_ALL=C).
 * Everything after the four integer columns is the start time, kept as an
 * opaque identity string. Exported for unit coverage.
 */
export function parsePsDetailedTable(stdout: string): DetailedProcessRow[] {
  const rows: DetailedProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S.*?)\s*$/)
    if (!m) continue
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      tpgid: Number(m[4]),
      startedAt: m[5].replace(/\s+/g, ' '),
      name: ''
    })
  }
  return rows
}

/**
 * POSIX-only snapshot with job-control identity, used by PTY shutdown to
 * decide (and re-verify) hangup escalation. Windows has no process groups or
 * SIGHUP; node-pty's ConPTY kill already terminates the console process list.
 */
export async function listProcessTableDetailed(): Promise<DetailedProcessRow[]> {
  if (process.platform === 'win32') {
    throw new Error('Detailed process table is POSIX-only')
  }
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,lstart='], { ...process.env, LC_ALL: 'C' })
  return parsePsDetailedTable(stdout)
}

/**
 * Snapshot the full process table. Rejects on timeout/spawn failure — the
 * caller (confirmQuit) treats any failure as "no activity information" and
 * falls back to the plain dialog; detection must never block quitting.
 */
export async function listProcessTable(): Promise<ProcessTableRow[]> {
  if (process.platform === 'win32') {
    const stdout = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation | Select-Object -Skip 1'
    ])
    return parseCimCsv(stdout)
  }
  // darwin and linux share the POSIX ps interface; keep the branch explicit.
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,comm='])
  return parsePsTable(stdout)
}
