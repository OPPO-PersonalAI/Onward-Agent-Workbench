/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git ahead/behind + background auto-fetch suite (AB-*).
 *
 * Locks the new "local ahead / remote behind" Task-badge feature end-to-end
 * against REAL git repos (a local bare remote + clones, no network):
 *
 *   AB-01 up-to-date   → snapshot ahead 0, behind 0
 *   AB-02 ahead-only   → ahead 2, behind 0   (unpushed local commits)
 *   AB-03 behind-only  → ahead 0, behind 1
 *   AB-04 diverged     → ahead 1, behind 1
 *   AB-05 no-upstream  → ahead/behind undefined (local-only branch)
 *   AB-06 fetch flip   → a clone whose origin ref is stale reads behind 0; after
 *                        a background fetch (the autotest-only force hook) the
 *                        mirror re-reads # branch.ab and behind flips to 1.
 *
 * BUG-0005 additions — a fetch that never succeeds must be both DIAGNOSABLE and
 * VISIBLE, because the field bundle had a repo go 98.8 h with zero successful
 * fetches while the badge kept presenting its behind count as current:
 *
 *   AB-07 fail payload  → a fast failure (origin points nowhere) carries
 *                         classified / exitCode / stderrTail, not just `reason`
 *   AB-08 timeout payload → a fetch killed by the wall-clock ceiling ALSO
 *                         carries classified + stderrTail. This is the exact
 *                         branch that used to short-circuit past
 *                         classifyFetchFailure and discard stderr, and it is why
 *                         6 of 9 field failures were undiagnosable. The ceiling
 *                         is shortened for the test (ONWARD_GIT_FETCH_CEILING_MS,
 *                         autotest-only); production uses 10 min since 2026-10-26
 *   AB-09 fresh success → a successful fetch stamps lastFetchOkAt onto the
 *                         renderer-visible snapshot (the badge's staleness input)
 *   AB-10 fresh failure → a failed fetch stamps lastFetchAttemptAt but leaves
 *                         lastFetchOkAt unset — the precise state the pure
 *                         resolveGitSyncFreshness table calls 'never-succeeded'
 *
 * Recovery + failure-surfacing (2026-08-07, after peer research):
 *
 *   AB-11 manual fetch  → the PRODUCTION `git.fetchNow` IPC that the badge click
 *                         uses. AB-06 only proved the autotest-only force hook;
 *                         until this landed the app had no manual fetch at all
 *   AB-12 quiet failure → a missing-remote failure must NOT be reported to the
 *                         UI as unreachable
 *   AB-13 loud failure  → a refused connection classifies as `network` and DOES
 *                         reach the badge. AB-12 + AB-13 pin the mapping in both
 *                         directions: a false positive cries wolf, a false
 *                         negative hides a real outage
 *
 * Click / ceiling fixes (2026-10-26 field bundle — a click during a running
 * fetch was dropped, and a binary-heavy repo's ~30 s fetch was killed at 20 s
 * every time):
 *
 *   AB-14 join          → a click while a fetch is in flight JOINS it: same
 *                         fetchId, `joined: true`, one spawn. N=5, all must pass
 *   AB-15 in-flight     → `fetchInFlight` reaches the snapshot while the fetch
 *                         runs and clears when it settles (drives the spinner for
 *                         background fetches). N=5, all must pass
 *   AB-16 manual failure → `git.fetchNow` reports the failure class the button
 *                         shows: `no-remote` for a missing remote, `network` for
 *                         a refused connection
 *   AB-17 slow success  → a fetch slower than the OLD fixed 20 s kill completes
 *                         and flips behind 0 → 1
 *
 * The RENDERING itself (tooltip wording, age bucketing, which kind shows what)
 * is a pure function of these snapshot fields and is locked by git-sync-display's
 * unit test; these cases lock the plumbing that supplies them.
 *
 * AB-01..05 prove the parse → worker → IPC → renderer-snapshot pipeline (the
 * `# branch.ab` values reach the snapshot the badge renders from). The
 * snapshot → DOM mapping (green dot + ↑N/↓M arrows) is locked by the pure
 * `git-sync-display` unit test. AB-06 is the Phase-2 proof: the hardened
 * `git fetch` spawn + revalidate wiring actually refreshes behind.
 *
 * Reads the mirror via the real IPC surface (`subscribeMirror` / `getMirror`),
 * with generous convergence polling (no wall-clock budgets — EDR-robust per
 * test/README.md § timing).
 */
import type { AutotestContext, TestResult } from './types'

interface Manifest {
  tempRoot: string
  remote: string
  upToDate: string
  ahead: string
  behind: string
  diverged: string
  fetchBehind: string
  failFetch: string
  timeoutFetch: string
  slowFailFetch: string
  slowOkFetch: string
  slowOkDelaySec: number
  fetchCeilingMs: number | null
  unreachable: string
  noUpstream: string
  neutralCwd: string
}

interface MirrorSnapshot {
  repoRoot?: string | null
  status?: string | null
  ahead?: number
  behind?: number
  lastFetchOkAt?: number
  lastFetchAttemptAt?: number
  remoteUnreachable?: boolean
  fetchInFlight?: boolean
}

/** Timing-sensitive cases repeat inside the test and assert on all trials. */
const JOIN_TRIALS = 5
/** The pre-2026-10-26 fixed kill; AB-17 must outlast it. */
const OLD_FIXED_CEILING_MS = 20_000

const CONVERGE_TIMEOUT_MS = 20_000
const CONVERGE_INTERVAL_MS = 400

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

async function getSnapshot(cwd: string): Promise<MirrorSnapshot | null> {
  try {
    return (await window.electronAPI.git.getMirror(cwd)) as MirrorSnapshot | null
  } catch {
    return null
  }
}

async function pollSnapshot(
  sleep: (ms: number) => Promise<void>,
  cwd: string,
  predicate: (s: MirrorSnapshot | null) => boolean
): Promise<{ ok: boolean; last: MirrorSnapshot | null }> {
  const deadline = Date.now() + CONVERGE_TIMEOUT_MS
  let last: MirrorSnapshot | null = null
  while (Date.now() < deadline) {
    last = await getSnapshot(cwd)
    if (predicate(last)) return { ok: true, last }
    await sleep(CONVERGE_INTERVAL_MS)
  }
  return { ok: false, last }
}

/** Subscribe and wait for a classified snapshot (repoRoot resolved). */
async function subscribeClassified(
  sleep: (ms: number) => Promise<void>,
  cwd: string
): Promise<MirrorSnapshot | null> {
  await window.electronAPI.git.subscribeMirror(cwd)
  const res = await pollSnapshot(sleep, cwd, (s) => Boolean(s?.repoRoot) && s?.status != null)
  return res.last
}

export async function testGitAutofetchAheadBehind(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, sleep, cancelled, log } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('ab:start', {})
  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    _assert('AB-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }
  _assert('AB-00-fixture-loaded', true, { tempRoot: manifest.tempRoot })

  const subscribed: string[] = []
  const track = (cwd: string) => { subscribed.push(cwd) }

  // ── AB-01..04: static ahead/behind states reach the snapshot. ──
  const cases: Array<{ id: string; cwd: string; ahead: number; behind: number; desc: string }> = [
    { id: 'AB-01-up-to-date', cwd: manifest.upToDate, ahead: 0, behind: 0, desc: 'HEAD == origin/main → 0/0' },
    { id: 'AB-02-ahead-only', cwd: manifest.ahead, ahead: 2, behind: 0, desc: 'two unpushed commits → ahead 2' },
    { id: 'AB-03-behind-only', cwd: manifest.behind, ahead: 0, behind: 1, desc: 'HEAD one behind origin → behind 1' },
    { id: 'AB-04-diverged', cwd: manifest.diverged, ahead: 1, behind: 1, desc: 'one local + one origin-only → 1/1' }
  ]
  for (const c of cases) {
    if (cancelled()) return results
    track(c.cwd)
    await window.electronAPI.git.subscribeMirror(c.cwd)
    const res = await pollSnapshot(
      sleep,
      c.cwd,
      (s) => Boolean(s?.repoRoot) && s?.ahead === c.ahead && s?.behind === c.behind
    )
    _assert(c.id, res.ok, {
      description: c.desc,
      expectedAhead: c.ahead,
      expectedBehind: c.behind,
      observedAhead: res.last?.ahead ?? null,
      observedBehind: res.last?.behind ?? null
    })
  }

  // ── AB-05: a local-only branch has NO upstream → ahead/behind undefined. ──
  if (!cancelled()) {
    track(manifest.noUpstream)
    const snap = await subscribeClassified(sleep, manifest.noUpstream)
    const ok = Boolean(snap?.repoRoot) && snap?.ahead === undefined && snap?.behind === undefined
    _assert('AB-05-no-upstream-undefined', ok, {
      description: 'A branch with no upstream emits no # branch.ab → no arrows',
      observedAhead: snap?.ahead ?? null,
      observedBehind: snap?.behind ?? null
    })
  }

  // ── AB-06: background fetch flips a stale behind 0 → behind 1. ──
  if (!cancelled()) {
    track(manifest.fetchBehind)
    const before = await subscribeClassified(sleep, manifest.fetchBehind)
    // Stale origin ref → behind reads 0 before any fetch.
    const staleOk = before?.ahead === 0 && before?.behind === 0
    const repoRoot = before?.repoRoot ?? manifest.fetchBehind
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })
    // After the fetch advances origin/main + the triggered revalidate, behind → 1.
    const after = await pollSnapshot(sleep, manifest.fetchBehind, (s) => s?.behind === 1)
    _assert('AB-06-background-fetch-flips-behind', staleOk && fetchRes.ok && after.ok, {
      description: 'Auto-fetch advances the remote-tracking ref → mirror re-reads # branch.ab → behind 1',
      staleBehindWas: before?.behind ?? null,
      fetchOk: fetchRes.ok,
      fetchReason: fetchRes.reason ?? null,
      observedBehindAfter: after.last?.behind ?? null
    })
  }

  // ── AB-09: a SUCCESSFUL fetch stamps lastFetchOkAt onto the snapshot. ──
  // Runs right after AB-06 so it observes that same fetch. This is the R3
  // plumbing: freshness is published by main and rides the existing mirror-delta
  // channel, so a regression here (a worker recompute dropping the field, the
  // delta not fanning out) silently disarms the whole stale treatment.
  if (!cancelled()) {
    const res = await pollSnapshot(
      sleep,
      manifest.fetchBehind,
      (s) => typeof s?.lastFetchOkAt === 'number' && (s.lastFetchOkAt ?? 0) > 0
    )
    _assert('AB-09-success-stamps-last-fetch-ok', res.ok, {
      description: 'A successful background fetch publishes lastFetchOkAt to the renderer snapshot',
      observedLastFetchOkAt: res.last?.lastFetchOkAt ?? null,
      observedLastFetchAttemptAt: res.last?.lastFetchAttemptAt ?? null
    })
  }

  // ── AB-07 + AB-10: a FAST failure carries full evidence and marks freshness. ──
  if (!cancelled()) {
    track(manifest.failFetch)
    const before = await subscribeClassified(sleep, manifest.failFetch)
    const repoRoot = before?.repoRoot ?? manifest.failFetch
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })

    // AB-07: the enriched failure payload. `reason` alone was all the field
    // bundle ever had; these are the fields that make it actionable.
    const payloadOk =
      fetchRes.ok === false &&
      fetchRes.killedByTimeout === false &&
      typeof fetchRes.classified === 'string' &&
      fetchRes.classified.length > 0 &&
      typeof fetchRes.exitCode === 'number' &&
      typeof fetchRes.stderrTail === 'string' &&
      fetchRes.stderrTail.length > 0
    _assert('AB-07-fast-failure-carries-evidence', payloadOk, {
      description: 'A non-timeout fetch failure reports classified + exitCode + stderrTail',
      ok: fetchRes.ok,
      reason: fetchRes.reason ?? null,
      classified: fetchRes.classified ?? null,
      exitCode: fetchRes.exitCode ?? null,
      killedByTimeout: fetchRes.killedByTimeout ?? null,
      stderrTailLength: (fetchRes.stderrTail ?? '').length
    })

    // AB-10: attempted-but-never-succeeded is exactly the state the badge must
    // render as stale. Assert the SHAPE, not the rendering (that is unit-tested).
    const freshness = await pollSnapshot(
      sleep,
      manifest.failFetch,
      (s) => typeof s?.lastFetchAttemptAt === 'number' && (s.lastFetchAttemptAt ?? 0) > 0
    )
    const neverSynced = freshness.last?.lastFetchOkAt === undefined
    _assert('AB-10-failure-marks-attempt-without-success', freshness.ok && neverSynced, {
      description:
        'A failed fetch stamps lastFetchAttemptAt and leaves lastFetchOkAt unset → the stale input state',
      observedLastFetchAttemptAt: freshness.last?.lastFetchAttemptAt ?? null,
      observedLastFetchOkAt: freshness.last?.lastFetchOkAt ?? null
    })
  }

  // ── AB-14 + AB-15: a click during a running fetch JOINS it; in-flight is published. ──
  // The 2026-10-26 field bundle: 5 clicks during a background fetch produced 0
  // main-side requests and a one-frame spinner. Timing-sensitive (the click must
  // land inside the in-flight window), so it repeats N times and every trial
  // must pass — one miss means the join has a real hole.
  if (!cancelled()) {
    track(manifest.slowFailFetch)
    const before = await subscribeClassified(sleep, manifest.slowFailFetch)
    const repoRoot = before?.repoRoot ?? manifest.slowFailFetch
    const trials: Array<Record<string, unknown>> = []
    let joinOk = true
    let inFlightOk = true
    for (let i = 0; i < JOIN_TRIALS && !cancelled(); i++) {
      // The "background" fetch: the force hook shares the manager's in-flight
      // registry, so it models the scheduled loop without racing its timer.
      const backgroundRun = window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })
      const seenInFlight = await pollSnapshot(sleep, manifest.slowFailFetch, (s) => s?.fetchInFlight === true)
      const click = await window.electronAPI.git.fetchNow(repoRoot)
      const background = await backgroundRun
      const cleared = await pollSnapshot(sleep, manifest.slowFailFetch, (s) => s?.fetchInFlight === false)
      const trialJoinOk =
        background.joined === false &&
        click.joined === true &&
        typeof background.fetchId === 'number' &&
        click.fetchId === background.fetchId &&
        click.ok === false &&
        typeof click.failure === 'string'
      const trialInFlightOk = seenInFlight.ok && cleared.ok
      joinOk = joinOk && trialJoinOk
      inFlightOk = inFlightOk && trialInFlightOk
      trials.push({
        trial: i + 1,
        backgroundJoined: background.joined ?? null,
        clickJoined: click.joined ?? null,
        backgroundFetchId: background.fetchId ?? null,
        clickFetchId: click.fetchId ?? null,
        clickFailure: click.failure ?? null,
        sawInFlight: seenInFlight.ok,
        inFlightCleared: cleared.ok
      })
    }
    _assert('AB-14-click-joins-running-fetch', joinOk && trials.length === JOIN_TRIALS, {
      description: `A click during a running fetch joins it (same fetchId, joined:true), ${JOIN_TRIALS}/${JOIN_TRIALS} trials`,
      trials
    })
    _assert('AB-15-in-flight-published-and-cleared', inFlightOk && trials.length === JOIN_TRIALS, {
      description: 'fetchInFlight reaches the renderer snapshot while the fetch runs and clears when it settles',
      trials: trials.map((t) => ({ trial: t.trial, sawInFlight: t.sawInFlight, inFlightCleared: t.inFlightCleared }))
    })
  }

  // ── AB-11: the PRODUCTION user-initiated fetch IPC works end-to-end. ──
  // AB-06 proved the autotest-only force hook; this proves the path the badge
  // click actually uses. Before it existed the app had no manual fetch at all,
  // so the user's only recovery was typing `git fetch` in the terminal.
  if (!cancelled()) {
    const snap = await getSnapshot(manifest.fetchBehind)
    const repoRoot = snap?.repoRoot ?? manifest.fetchBehind
    const res = await window.electronAPI.git.fetchNow(repoRoot)
    _assert('AB-11-user-fetch-ipc-succeeds', res?.ok === true && res?.failure === undefined, {
      description: 'git.fetchNow reaches the manager and completes for a healthy repo',
      ok: res?.ok ?? null,
      joined: res?.joined ?? null,
      failure: res?.failure ?? null
    })
  }

  // ── AB-12 / AB-13: only UNREACHABLE surfaces; other failures stay quiet. ──
  // The mapping the UI depends on (2026-08-07 decision): auth / no-remote /
  // bare-timeout are not shown to the user, so remoteUnreachable must stay
  // false for them. Getting this wrong in either direction is a user-visible
  // bug — a false positive cries wolf, a false negative hides a real outage.
  if (!cancelled()) {
    const snap = await getSnapshot(manifest.failFetch)
    const repoRoot = snap?.repoRoot ?? manifest.failFetch
    const res = await window.electronAPI.git.fetchNow(repoRoot)
    const after = await pollSnapshot(
      sleep,
      manifest.failFetch,
      (x) => typeof x?.lastFetchAttemptAt === 'number'
    )
    _assert('AB-12-no-remote-does-not-claim-unreachable', after.last?.remoteUnreachable !== true, {
      description: 'A missing-remote failure must NOT be reported to the UI as unreachable',
      observedRemoteUnreachable: after.last?.remoteUnreachable ?? null
    })
    // AB-16a: the MANUAL path names the class the sync button then shows.
    _assert('AB-16a-manual-failure-reports-no-remote', res?.ok === false && res?.failure === 'no-remote' && res?.joined === false, {
      description: 'git.fetchNow on a missing remote returns failure:no-remote for the button tooltip',
      ok: res?.ok ?? null,
      failure: res?.failure ?? null,
      joined: res?.joined ?? null
    })
  }

  if (!cancelled()) {
    track(manifest.unreachable)
    const before = await subscribeClassified(sleep, manifest.unreachable)
    const repoRoot = before?.repoRoot ?? manifest.unreachable
    const res = await window.electronAPI.git.fetchNow(repoRoot)
    const after = await pollSnapshot(sleep, manifest.unreachable, (x) => x?.remoteUnreachable === true)
    _assert('AB-13-connection-refused-reports-unreachable', after.ok, {
      description: 'A refused connection classifies as network and DOES reach the badge',
      observedRemoteUnreachable: after.last?.remoteUnreachable ?? null
    })
    _assert('AB-16b-manual-failure-reports-network', res?.ok === false && res?.failure === 'network', {
      description: 'git.fetchNow on a refused connection returns failure:network for the button tooltip',
      ok: res?.ok ?? null,
      failure: res?.failure ?? null
    })
  }

  // ── AB-17: a fetch slower than the OLD fixed 20 s kill now completes. ──
  // The field case: a binary-heavy repo needed ~30 s to fetch and was killed at
  // 20,007 ms every time, so behind could never move. The origin here waits
  // past the old ceiling and then serves the real remote. Deterministic (fixed
  // delay, local transport) → one trial; slow by construction, so near the end.
  if (!cancelled()) {
    track(manifest.slowOkFetch)
    const before = await subscribeClassified(sleep, manifest.slowOkFetch)
    const repoRoot = before?.repoRoot ?? manifest.slowOkFetch
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })
    const after = await pollSnapshot(sleep, manifest.slowOkFetch, (s) => s?.behind === 1)
    const slowOk =
      before?.behind === 0 &&
      fetchRes.ok === true &&
      fetchRes.killedByTimeout !== true &&
      typeof fetchRes.durationMs === 'number' &&
      fetchRes.durationMs > OLD_FIXED_CEILING_MS &&
      after.ok
    _assert('AB-17-slow-fetch-beyond-old-ceiling-succeeds', slowOk, {
      description: `A fetch taking ~${manifest.slowOkDelaySec}s (> the old fixed 20 s kill) completes and flips behind 0 → 1`,
      behindBefore: before?.behind ?? null,
      ok: fetchRes.ok,
      durationMs: fetchRes.durationMs ?? null,
      killedByTimeout: fetchRes.killedByTimeout ?? null,
      reason: fetchRes.reason ?? null,
      behindAfter: after.last?.behind ?? null
    })
  }

  // ── AB-08: the CEILING-KILL branch also carries evidence. ──
  // Deliberately last: it costs the full (test-shortened) ceiling by
  // construction, and a hang is what we are asserting.
  if (!cancelled()) {
    track(manifest.timeoutFetch)
    const before = await subscribeClassified(sleep, manifest.timeoutFetch)
    const repoRoot = before?.repoRoot ?? manifest.timeoutFetch
    const fetchRes = await window.electronAPI.debug.gitAutofetchForAutotest({ repoRoot })
    const ceiling = manifest.fetchCeilingMs
    const durationMs = typeof fetchRes.durationMs === 'number' ? fetchRes.durationMs : -1
    // Killed AT the configured ceiling (not at some leftover fixed value).
    const atCeiling = ceiling !== null && durationMs >= ceiling - 500 && durationMs < ceiling + 10_000
    const timeoutOk =
      fetchRes.ok === false &&
      fetchRes.reason === 'timeout' &&
      fetchRes.killedByTimeout === true &&
      atCeiling &&
      // The regression guard: BOTH of these used to be absent on this branch.
      typeof fetchRes.classified === 'string' &&
      typeof fetchRes.stderrTail === 'string' &&
      fetchRes.stderrTail.length > 0
    _assert('AB-08-timeout-failure-carries-evidence', timeoutOk, {
      description:
        'A fetch killed by the wall-clock ceiling still classifies stderr instead of discarding it',
      ok: fetchRes.ok,
      reason: fetchRes.reason ?? null,
      killedByTimeout: fetchRes.killedByTimeout ?? null,
      classified: fetchRes.classified ?? null,
      durationMs: fetchRes.durationMs ?? null,
      configuredCeilingMs: ceiling,
      stderrTailLength: (fetchRes.stderrTail ?? '').length
    })
  }

  for (const cwd of subscribed) window.electronAPI.git.unsubscribeMirror(cwd)
  return results
}
