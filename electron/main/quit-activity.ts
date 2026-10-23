/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure activity classification behind the activity-aware quit confirmation.
 *
 * Industry-standard mechanism (verified against peer sources, 2026-07-25):
 * descendant-process enumeration from each terminal's shell pid plus an
 * ignore-list of harmless helpers — the approach iTerm2 (PROMPT_EX_JOBS),
 * VS Code (confirmOnExit: hasChildProcesses) and WezTerm
 * (skip_close_confirmation_for_processes_named) all converge on. The
 * foreground-process-group technique (pgid==tpgid) is deliberately NOT used
 * as the quit criterion: backgrounded jobs (`cmd &`) leave the foreground
 * group but still die with the window, so a foreground-only test under-warns.
 * An idle shell has no non-ignored descendants, so it never false-positives.
 *
 * This module is pure (no electron/fs imports) so the decision table is
 * locked by test/unittest/quit-activity.test.mts in plain Node.
 */

export interface ProcessTableRow {
  pid: number
  ppid: number
  /** Executable name as reported by the platform process table. */
  name: string
}

export interface TerminalShellRef {
  terminalId: string
  shellPid: number
  /** Optional user-facing terminal label (tab/task name) for the dialog. */
  label?: string
}

export interface TerminalActivity {
  terminalId: string
  shellPid: number
  label?: string
  active: boolean
  /** Non-ignored descendant process names, deduped, insertion-ordered. */
  jobs: string[]
}

export interface QuitActivitySummary {
  terminalCount: number
  activeCount: number
  /** Deduped job names across all active terminals, capped by caller. */
  jobNames: string[]
  /** Labels (or terminalIds) of the active terminals, capped by caller. */
  activeTerminalLabels: string[]
}

/**
 * Helpers that never count as "work you would lose": login scaffolding and
 * prompt decorators (VS Code ships starship/oh-my-posh for the same reason),
 * plus shells themselves — Git Bash style shells re-spawn themselves as a
 * child, which would otherwise make every idle prompt look active.
 */
export const DEFAULT_IGNORED_JOB_NAMES: ReadonlySet<string> = new Set([
  'login',
  'starship',
  'oh-my-posh',
  'bash',
  'zsh',
  'sh',
  'fish',
  'nu',
  'cmd',
  'pwsh',
  'powershell',
  'conhost'
])

/**
 * Normalize a raw process-table name for ignore-list comparison: strip any
 * path prefix, the login-shell `-` prefix convention (`-zsh`), a trailing
 * `.exe`, and case.
 */
export function normalizeJobName(raw: string): string {
  const base = raw.trim().replace(/^.*[\\/]/, '')
  const noDash = base.startsWith('-') ? base.slice(1) : base
  return noDash.replace(/\.exe$/i, '').toLowerCase()
}

export function buildChildrenIndex(table: ProcessTableRow[]): Map<number, ProcessTableRow[]> {
  const index = new Map<number, ProcessTableRow[]>()
  for (const row of table) {
    const list = index.get(row.ppid)
    if (list) list.push(row)
    else index.set(row.ppid, [row])
  }
  return index
}

/**
 * Collect the names of every descendant of `rootPid` that is not on the
 * ignore list. The root (the shell itself) is never counted. Cycle-guarded
 * so a corrupt process table (pid reuse mid-snapshot) cannot loop forever.
 */
export function collectDescendantJobs(
  childrenIndex: Map<number, ProcessTableRow[]>,
  rootPid: number,
  ignoredNames: ReadonlySet<string> = DEFAULT_IGNORED_JOB_NAMES
): string[] {
  const jobs: string[] = []
  const seenPids = new Set<number>([rootPid])
  const seenNames = new Set<string>()
  const queue: number[] = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of childrenIndex.get(pid) ?? []) {
      if (seenPids.has(child.pid)) continue
      seenPids.add(child.pid)
      queue.push(child.pid)
      const name = normalizeJobName(child.name)
      if (!name || ignoredNames.has(name)) continue
      if (!seenNames.has(name)) {
        seenNames.add(name)
        jobs.push(name)
      }
    }
  }
  return jobs
}

export function classifyTerminalActivity(
  shells: TerminalShellRef[],
  table: ProcessTableRow[],
  ignoredNames: ReadonlySet<string> = DEFAULT_IGNORED_JOB_NAMES
): TerminalActivity[] {
  const index = buildChildrenIndex(table)
  return shells.map((shell) => {
    const jobs = collectDescendantJobs(index, shell.shellPid, ignoredNames)
    return {
      terminalId: shell.terminalId,
      shellPid: shell.shellPid,
      label: shell.label,
      active: jobs.length > 0,
      jobs
    }
  })
}

export function summarizeQuitActivity(
  activities: TerminalActivity[],
  maxNames: number = 3
): QuitActivitySummary {
  const active = activities.filter((a) => a.active)
  const jobNames: string[] = []
  const seen = new Set<string>()
  for (const a of active) {
    for (const job of a.jobs) {
      if (seen.has(job)) continue
      seen.add(job)
      jobNames.push(job)
    }
  }
  return {
    terminalCount: activities.length,
    activeCount: active.length,
    jobNames: jobNames.slice(0, Math.max(0, maxNames)),
    activeTerminalLabels: active
      .map((a) => (a.label && a.label.trim() ? a.label.trim() : a.terminalId))
      .slice(0, Math.max(0, maxNames))
  }
}

/**
 * Collect every descendant PID across `rootPids` from a process-table snapshot.
 * Used during PTY shutdown BEFORE killing the root shells (once a root shell exits,
 * POSIX reparents surviving job-control process groups to PID 1, severing the ppid link).
 */
export function collectAllDescendantPids(
  table: ProcessTableRow[],
  rootPids: Iterable<number>
): number[] {
  const childrenIndex = buildChildrenIndex(table)
  const roots = new Set<number>()
  for (const pid of rootPids) {
    if (typeof pid === 'number' && pid > 0) roots.add(pid)
  }
  const seenPids = new Set<number>(roots)
  const descendants: number[] = []
  const queue: number[] = Array.from(roots)
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of childrenIndex.get(pid) ?? []) {
      if (seenPids.has(child.pid) || child.pid <= 1) continue
      seenPids.add(child.pid)
      descendants.push(child.pid)
      queue.push(child.pid)
    }
  }
  return descendants
}

/** Process-table row with the job-control identity needed for safe escalation. */
export interface DetailedProcessRow extends ProcessTableRow {
  pgid: number
  /** Foreground process group of the row's controlling terminal (<= 0 when none). */
  tpgid: number
  /** Opaque, locale-pinned start time. Equality only — never parsed. */
  startedAt: string
}

export interface HangupEscalationTarget {
  pid: number
  pgid: number
  startedAt: string
}

/**
 * Pick which terminal descendants may be force-killed after the hangup grace.
 *
 * Only members of their terminal's FOREGROUND process group (pgid === tpgid)
 * qualify. Those are exactly the processes a terminal hangup is addressed to,
 * so one still alive after the grace caught SIGHUP and refused to exit.
 * Background jobs that the user detached with `nohup cmd &`, `disown`, or
 * `setsid` are deliberately excluded: the shell's own hangup forwarding
 * already applies the user's intent to them, and overriding it would kill
 * work the user explicitly asked to keep. (The activity dialog still counts
 * background jobs; this is a different question — warning vs. force-killing.)
 */
export function selectHangupEscalationTargets(
  table: DetailedProcessRow[],
  shellPids: Iterable<number>
): HangupEscalationTarget[] {
  const byPid = new Map<number, DetailedProcessRow>()
  for (const row of table) byPid.set(row.pid, row)
  const targets: HangupEscalationTarget[] = []
  for (const pid of collectAllDescendantPids(table, shellPids)) {
    const row = byPid.get(pid)
    if (!row || row.pgid <= 1 || row.tpgid <= 1 || row.pgid !== row.tpgid) continue
    targets.push({ pid: row.pid, pgid: row.pgid, startedAt: row.startedAt })
  }
  return targets
}

/**
 * Re-verify escalation targets against a FRESH process table taken right
 * before SIGKILL. A pid qualifies only if the same pid still exists with the
 * same process group and start time, so a pid recycled by an unrelated
 * process can never be killed. ppid is intentionally not compared: once the
 * shell exits, survivors are reparented to PID 1.
 */
export function verifyEscalationTargets(
  targets: HangupEscalationTarget[],
  freshTable: DetailedProcessRow[]
): number[] {
  const byPid = new Map<number, DetailedProcessRow>()
  for (const row of freshTable) byPid.set(row.pid, row)
  return targets
    .filter((target) => {
      const row = byPid.get(target.pid)
      return Boolean(row && row.pgid === target.pgid && row.startedAt === target.startedAt)
    })
    .map((target) => target.pid)
}

