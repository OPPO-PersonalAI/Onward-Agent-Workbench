/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitStateMirror symlink suite (GSY-*).
 *
 * Reproduces + locks the "repo entered through a symlink shows no git status"
 * bug (2026-07-16). Mechanism under test: the shell reports the LOGICAL
 * (symlink-preserving) cwd via OSC, the mirror keys every snapshot by the
 * REAL path (realpathSync in the router), and the only bridge between the two
 * is the renderer's `mirrorSnapshotAliases` map. Before the fix that alias was
 * created ONLY when `subscribeMirror` returned a warm snapshot — a cold repo
 * returned null and skipped alias creation, so the Task badge never rendered.
 *
 *   GSY-01  cold entry through the symlink renders the branch badge. This is
 *           the repro assertion: RED before the fix (alias never created on a
 *           cold subscribe), GREEN after.
 *   GSY-02  a dirty flip propagates through the alias: an external write into
 *           the REAL repo must flip the badge colour while the Task's cwd is
 *           the SYMLINK path. Proves the realpath-keyed watcher stream reaches
 *           a symlink-cwd subscriber.
 *   GSY-03  sanity guard: pushing the REAL path also renders (the fix must not
 *           regress the normal non-symlink path). Green before AND after.
 *   GSY-04  no subscribe storm after the symlink entry (2026-10-30 renderer
 *           OOM): the raw OSC cwd vs realpath lastCwd flip-flop must not
 *           drive an unsubscribe/resubscribe loop. RED before the fix
 *           (~2.4k GIT_TERMINAL_INFO pushes/s), GREEN after.
 *   GSY-05  same storm guard for a renderer/main cwd desync without a
 *           symlink (stale renderer OSC value vs main's terminal cwd).
 *
 * Windows note: the fixture uses an NTFS junction (no admin required);
 * realpathSync resolves junctions exactly like POSIX symlinks, so the same
 * assertions gate the same class on win32.
 */
import type { AutotestContext, TestResult } from './types'
import { pushOscCwd } from './probe-utils'

interface Manifest {
  tempRoot: string
  realRepo: string
  linkToRepo: string
  neutralCwd: string
  branch: string
}

// Badge convergence budget. Generous hang-detector per the EDR readiness
// lessons — the wait short-circuits the moment the badge renders, so a healthy
// host pays only the real convergence latency.
const BADGE_TIMEOUT_MS = 30_000

const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

async function loadManifest(extraPath: string | null): Promise<Manifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as Manifest
  } catch {
    return null
  }
}

type BadgeColour = 'clean' | 'added' | 'modified' | 'deleted' | 'mixed' | 'unknown' | null

interface BadgeProbe {
  present: boolean
  branch: string | null
  colour: BadgeColour
  cwdLabel: string | null
}

function probeBadge(terminalId: string): BadgeProbe {
  const cell = document.querySelector(`.terminal-grid-cell[data-terminal-id="${terminalId}"]`)
  if (!cell) return { present: false, branch: null, colour: null, cwdLabel: null }
  const chip = cell.querySelector('.terminal-grid-branch')
  const cwdEl = cell.querySelector('.terminal-grid-adaptive-cwd') as HTMLElement | null
  let colour: BadgeColour = null
  if (chip) {
    if (chip.classList.contains('terminal-grid-branch--modified')) colour = 'modified'
    else if (chip.classList.contains('terminal-grid-branch--added')) colour = 'added'
    else if (chip.classList.contains('terminal-grid-branch--deleted')) colour = 'deleted'
    else if (chip.classList.contains('terminal-grid-branch--mixed')) colour = 'mixed'
    else if (chip.classList.contains('terminal-grid-branch--unknown')) colour = 'unknown'
    else colour = 'clean'
  }
  return {
    present: true,
    branch: chip?.textContent?.trim() || null,
    colour,
    cwdLabel: cwdEl?.getAttribute('title') ?? cwdEl?.textContent?.trim() ?? null
  }
}

// Storm probe budget: after a settle window, count GIT_TERMINAL_INFO pushes
// for the terminal over a fixed window. A converged terminal emits ~0; the
// pre-fix flip-flop loop produced thousands per second.
const STORM_SETTLE_MS = 1500
const STORM_WINDOW_MS = 3000
const STORM_MAX_EVENTS = 6

async function measureInfoStorm(
  terminalId: string,
  extra: Record<string, unknown>
): Promise<[boolean, Record<string, unknown>]> {
  await new Promise(resolve => setTimeout(resolve, STORM_SETTLE_MS))
  let infoEvents = 0
  const off = window.electronAPI.git.onTerminalInfo((id) => {
    if (id === terminalId) infoEvents += 1
  })
  await new Promise(resolve => setTimeout(resolve, STORM_WINDOW_MS))
  off()
  return [infoEvents <= STORM_MAX_EVENTS, {
    infoEvents,
    windowMs: STORM_WINDOW_MS,
    ratePerSec: +(infoEvents / (STORM_WINDOW_MS / 1000)).toFixed(1),
    maxAllowed: STORM_MAX_EVENTS,
    ...extra
  }]
}

export async function testGitStateMirrorSymlink(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, waitFor, cancelled, log, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('gsy:start', {})
  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    record('GSY-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }
  record('GSY-00-fixture-loaded', true, {
    realRepo: manifest.realRepo,
    linkToRepo: manifest.linkToRepo
  })

  // ── GSY-01: COLD entry through the symlink must render the branch badge. ──
  // The fixture repo has never been subscribed in this app session (the app's
  // terminal cwd is the neutral dir), so `subscribeMirror(linkToRepo)` resolves
  // against a cold router cache — exactly the alias-gap window.
  await pushOscCwd(terminalId, manifest.linkToRepo)
  const badgeShown = await waitFor(
    'GSY-01-badge-through-symlink',
    () => probeBadge(terminalId).branch === manifest.branch,
    BADGE_TIMEOUT_MS,
    200
  )
  record('GSY-01-badge-renders-through-symlink-cwd', badgeShown, {
    probe: probeBadge(terminalId) as unknown as Record<string, unknown>,
    expectedBranch: manifest.branch,
    note: 'RED before fix: cold subscribeMirror returns null and the raw→canonical alias is never created'
  })
  if (cancelled()) return results

  // ── GSY-04: no subscribe storm after entering through the symlink. ──
  // 2026-10-30 field crash (renderer OOM, exitCode 5): TerminalGrid persisted
  // the RAW OSC cwd (symlink path) on every `terminals` change, while
  // applyTerminalInfoUpdate persists the bridge's REALPATH cwd. The two
  // writes flipped `lastCwd` forever → `visibleTerminals` got a new identity →
  // the subscribe effect unsubscribed + resubscribed every visible terminal →
  // the main bridge re-emitted GIT_TERMINAL_INFO (fresh entry, null
  // fingerprint) → loop (~2.4k events/s measured before the fix).
  record('GSY-04-no-subscribe-storm-after-symlink-entry', ...await measureInfoStorm(terminalId, {
    note: 'RED = lastCwd flip-flop (raw OSC symlink vs realpath) drives an unsubscribe/resubscribe loop'
  }))
  if (cancelled()) return results

  // ── GSY-02: dirty flip propagates through the alias. ──
  // Write into the REAL repo (the watcher observes the realpath); the Task
  // whose cwd is the SYMLINK path must see its badge flip off clean.
  if (badgeShown) {
    await window.electronAPI.debug.writeExternalFile({
      root: manifest.realRepo,
      relPath: 'gsy-untracked.txt',
      content: 'dirty flip through the alias\n'
    })
    const flipped = await waitFor(
      'GSY-02-dirty-flip',
      () => {
        const probe = probeBadge(terminalId)
        return probe.branch === manifest.branch && probe.colour !== null && probe.colour !== 'clean'
      },
      BADGE_TIMEOUT_MS,
      200
    )
    record('GSY-02-dirty-flip-through-symlink-cwd', flipped, {
      probe: probeBadge(terminalId) as unknown as Record<string, unknown>
    })
  } else {
    record('GSY-02-dirty-flip-through-symlink-cwd', false, {
      skippedBecause: 'GSY-01 badge never rendered'
    })
  }
  if (cancelled()) return results

  // ── GSY-03: sanity guard — the REAL path still renders (no regression). ──
  await pushOscCwd(terminalId, manifest.realRepo)
  const realShown = await waitFor(
    'GSY-03-badge-real-path',
    () => probeBadge(terminalId).branch === manifest.branch,
    BADGE_TIMEOUT_MS,
    200
  )
  record('GSY-03-badge-renders-through-real-cwd', realShown, {
    probe: probeBadge(terminalId) as unknown as Record<string, unknown>
  })

  if (cancelled()) return results

  // ── GSY-05: renderer/main cwd desync (no symlink) must not storm either. ──
  // Field variant of GSY-04: the renderer's OSC map holds a cwd that differs
  // from main's terminal cwd for a reason other than a symlink (stale OSC
  // value, main-probe cwd). Simulate by dispatching the renderer-local OSC
  // event ONLY (main keeps the real repo from GSY-03).
  window.dispatchEvent(new CustomEvent('onward:terminal-cwd-detected', {
    detail: { terminalId, cwd: manifest.neutralCwd }
  }))
  record('GSY-05-no-subscribe-storm-on-renderer-main-cwd-desync', ...await measureInfoStorm(terminalId, {
    rendererCwd: manifest.neutralCwd,
    mainCwd: manifest.realRepo,
    note: 'RED = renderer OSC cwd vs main cwd desync drives the same lastCwd flip-flop loop'
  }))

  window.electronAPI.git.unsubscribeMirror(manifest.linkToRepo)
  window.electronAPI.git.unsubscribeMirror(manifest.realRepo)
  return results
}
