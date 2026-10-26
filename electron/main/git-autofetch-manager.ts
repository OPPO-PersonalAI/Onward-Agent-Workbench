/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git auto-fetch manager (impure side of the background-fetch feature).
 *
 * Owns the timer + the hardened `git fetch` child spawns that keep the Task
 * badge's ↓behind count fresh. The WHEN decision is delegated to the pure
 * {@link GitAutofetchScheduler}; this module only:
 *   1. every tick, hands the scheduler the current set of in-use repo roots
 *      (from the mirror router) and spawns a hardened fetch for each due repo,
 *      capped at {@link MAX_CONCURRENT_FETCHES};
 *   2. hardens the fetch so it can NEVER hang or prompt (see
 *      {@link buildHardenedFetchEnv} in git-fetch-policy.ts): no credential
 *      prompts, SSH BatchMode + keepalives, and transport-level stall detection
 *      (curl low-speed abort). A wedged transport is cut by the transport; a
 *      slow-but-alive one is allowed to finish. Only a long wall-clock ceiling
 *      ({@link GIT_FETCH_CEILING_MS}) remains as a last resort — the old fixed
 *      20 s kill made a binary-heavy repo un-syncable (2026-10-26 field bundle);
 *   3. on success, asks the mirror to revalidate that repo so the recompute
 *      re-reads `# branch.ab` and the badge's behind count refreshes;
 *   4. runs at most ONE fetch per repo: a manual click or forced run that
 *      arrives while one is in flight joins it ({@link InFlightRegistry}), and
 *      the in-flight state is published to the renderer so the sync button
 *      spins for background fetches too.
 *
 * The fetch is spawned DIRECTLY (not through the shared git runtime queue) so a
 * slow network fetch never occupies a concurrency slot meant for the fast local
 * `git status` path — fetch stays fully off the status lane by construction.
 *
 * Default OFF-switch: `ONWARD_DISABLE_GIT_AUTOFETCH=1` parks the whole feature.
 * Period override: `ONWARD_GIT_AUTOFETCH_INTERVAL_MS` (>= 60 000 in normal
 * builds; any positive value under `ONWARD_AUTOTEST=1` so a test can drive it
 * fast). See docs/debug-env-variables.md and
 * docs/html/git-ahead-behind-fetch-strategy.html.
 */

import { execFile } from 'child_process'
import { readdir, stat } from 'fs/promises'
import { join, resolve as resolvePath } from 'path'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { getExecEnv, resolveGitExecutable } from './git-utils'
import { gitStateMirrorRouter } from './git-state-mirror-router'
import {
  classifyFetchFailure,
  classifyRemoteScheme,
  sanitizeGitStderr,
  type FetchFailureReason,
  type RemoteScheme
} from './git-fetch-failure-classify'
import {
  GitAutofetchScheduler,
  GIT_AUTOFETCH_DEFAULT_INTERVAL_MS,
  GIT_AUTOFETCH_MAX_BACKOFF_MS,
  GIT_AUTOFETCH_MIN_INTERVAL_MS,
  computeAutofetchBackoffMs,
  type PriorityRetryRefusal
} from './git-autofetch-scheduler'
import { InFlightRegistry } from './git-fetch-inflight'
import { buildHardenedFetchEnv, resolveFetchCeilingMs, GIT_FETCH_CEILING_MS } from './git-fetch-policy'

/** Never run more than this many fetches at once (many-repo cost guard). */
const MAX_CONCURRENT_FETCHES = 3
/** Tick cadence floor / ceiling; derived from the interval so a small (test) interval still ticks promptly. */
const TICK_FLOOR_MS = 1_000
const TICK_CEIL_MS = 30_000

/**
 * How often the paused-while-hidden diagnostic may repeat when nothing changed.
 * The event used to fire on EVERY 30 s tick with an empty payload: a 4-day
 * bundle carried 935 identical `{}` records (BUG-0005 § 2.2). Now it fires on a
 * change of the owed-work signature, or at most once per this interval.
 */
const HIDDEN_SKIP_MIN_REPEAT_MS = 600_000
/** Own timeout for the (cached, failure-only) remote-URL lookup. */
const REMOTE_URL_TIMEOUT_MS = 5_000
/** Own timeout for the (failure-only) pack-directory lookup. */
const PACK_DIR_TIMEOUT_MS = 5_000
/**
 * Priority-retry refusals that are ordinary steady state rather than a signal,
 * and so are NOT traced. Both fire on every Task focus: `not-backed-off` for any
 * healthy repo, `unknown-repo` for any repo the scheduler has not synced yet or
 * deliberately excludes (no upstream). See handleRepoFocused.
 */
const STEADY_STATE_REFUSALS: ReadonlySet<PriorityRetryRefusal> = new Set<PriorityRetryRefusal>([
  'not-backed-off',
  'unknown-repo'
])

/** Who started a fetch run. Carried on every lifecycle event. */
export type FetchSource = 'autofetch' | 'manual' | 'autofetch-forced'

export interface AutofetchResult {
  ok: boolean
  reason?: FetchFailureReason
  durationMs: number
  /**
   * Monotonic id of the spawned fetch. Callers that joined an in-flight run see
   * the SAME id, which is how a test proves only one process was spawned.
   */
  fetchId?: number
  /** Failure only: git's exit code, or null when the process was killed. */
  exitCode?: number | null
  /** Failure only: true when the wall-clock ceiling killed the process. */
  killedByTimeout?: boolean
  /**
   * Failure only: {@link classifyFetchFailure} applied to stderr **even when the
   * process was killed by the ceiling**. `reason` stays `'timeout'` because that
   * is what happened to the process; a killed fetch still usually printed
   * something first ("Permission denied (publickey)", "Could not resolve host"),
   * and discarding it made auth-wall, unreachable-remote and slow-transport
   * indistinguishable in a user-attached trace.
   */
  classified?: FetchFailureReason
  /** Failure only: redacted tail of stderr. See {@link sanitizeGitStderr}. */
  stderrTail?: string
}

function readIntervalMsFromEnv(): number {
  const raw = process.env.ONWARD_GIT_AUTOFETCH_INTERVAL_MS
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n >= GIT_AUTOFETCH_MIN_INTERVAL_MS) return n
    // Autotest may drive the loop far faster than the 60 s production floor.
    if (Number.isFinite(n) && n > 0 && process.env.ONWARD_AUTOTEST === '1') return n
  }
  return GIT_AUTOFETCH_DEFAULT_INTERVAL_MS
}

function buildFetchEnv(): NodeJS.ProcessEnv {
  return buildHardenedFetchEnv(getExecEnv(), process.env.GIT_SSH_COMMAND) as NodeJS.ProcessEnv
}

/**
 * Map a failed result onto the single failure class the UI shows for a manual
 * fetch. A ceiling kill is a timeout regardless of what stderr said.
 */
export function resolveFetchFailureKind(result: AutofetchResult): FetchFailureReason | undefined {
  if (result.ok) return undefined
  if (result.killedByTimeout) return 'timeout'
  return result.classified ?? result.reason ?? 'other'
}

class GitAutofetchManager {
  private scheduler = new GitAutofetchScheduler()
  private tickTimer: NodeJS.Timeout | null = null
  private activeFetches = 0
  private started = false
  private disposed = false
  private enabled = false
  private intervalMs = GIT_AUTOFETCH_DEFAULT_INTERVAL_MS
  private gitPathPromise: Promise<string | null> | null = null
  /** Owed-work signature of the last emitted skipped-hidden event. */
  private hiddenSkipSignature: string | null = null
  private hiddenSkipEmittedAt = 0
  /** repoRoot → transport class of its `origin`. Resolved lazily, on failure only. */
  private readonly remoteSchemeCache = new Map<string, RemoteScheme>()
  /** One fetch per repo; later requests join the running one. */
  private readonly inflight = new InFlightRegistry<AutofetchResult>()
  private nextFetchId = 1
  /** Wall-clock ceiling for one fetch (autotest may shorten it). */
  private ceilingMs = GIT_FETCH_CEILING_MS

  /**
   * Start the background loop. No-op if already started, or if the kill switch
   * `ONWARD_DISABLE_GIT_AUTOFETCH=1` is set (logged once so the trace shows the
   * feature was deliberately parked, not silently broken).
   */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    // Resolved BEFORE the kill-switch check: manual (`fetchNow`) and forced
    // fetches still run when the background loop is parked, and they must obey
    // the same ceiling.
    this.ceilingMs = resolveFetchCeilingMs(process.env)
    if (this.ceilingMs !== GIT_FETCH_CEILING_MS) {
      console.log(`[GitAutofetch] fetch ceiling overridden to ${this.ceilingMs}ms (ONWARD_GIT_FETCH_CEILING_MS, autotest)`)
    }

    if (process.env.ONWARD_DISABLE_GIT_AUTOFETCH === '1') {
      this.enabled = false
      console.log('[GitAutofetch] disabled via ONWARD_DISABLE_GIT_AUTOFETCH=1')
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_LIFECYCLE, { phase: 'start', enabled: false })
      return
    }

    this.enabled = true
    this.intervalMs = readIntervalMsFromEnv()
    this.scheduler = new GitAutofetchScheduler({
      intervalMs: this.intervalMs,
      maxBackoffMs: GIT_AUTOFETCH_MAX_BACKOFF_MS
    })

    const tickMs = Math.min(TICK_CEIL_MS, Math.max(TICK_FLOOR_MS, Math.floor(this.intervalMs / 2)))
    console.log(`[GitAutofetch] enabled; interval=${this.intervalMs}ms tick=${tickMs}ms ceiling=${this.ceilingMs}ms`)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_LIFECYCLE, {
      phase: 'start',
      enabled: true,
      intervalMs: this.intervalMs,
      tickMs,
      ceilingMs: this.ceilingMs
    })
    this.tickTimer = setInterval(() => this.runTick(), tickMs)
    this.tickTimer.unref?.()
    // BUG-0005 R1-A: the mirror router owns the "which repo is the user looking
    // at" signal. Inverted as a listener (router → manager) because the manager
    // already imports the router; the reverse would be a cycle.
    gitStateMirrorRouter.setRepoFocusListener((repoRoot) => this.handleRepoFocused(repoRoot))
  }

  /**
   * App window visibility gate — hidden/minimized pauses fetching.
   *
   * A hidden → visible edge also halves every repo's failure streak inside the
   * scheduler (BUG-0005 R1-B); the count comes back so the transition is visible
   * in a trace rather than being a silent state mutation.
   */
  setAppVisible(visible: boolean): void {
    const halvedRepoCount = this.scheduler.setAppVisible(visible)
    if (halvedRepoCount > 0) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_STREAK_HALVED, { halvedRepoCount })
    }
    // Re-arm the hidden diagnostic so the NEXT hidden stretch reports itself even
    // if its owed-work signature happens to match the previous one.
    if (visible) this.hiddenSkipSignature = null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.started = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    gitStateMirrorRouter.setRepoFocusListener(null)
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_LIFECYCLE, { phase: 'dispose' })
  }

  /** Diagnostics / autotest introspection. */
  inspect() {
    return { ...this.scheduler.inspect(), intervalMs: this.intervalMs, activeFetches: this.activeFetches }
  }

  private runTick(): void {
    if (this.disposed || !this.enabled) return
    const snap = this.scheduler.inspect()
    if (!snap.appVisible) {
      this.recordHiddenSkip()
      return
    }
    this.scheduler.syncRepos(gitStateMirrorRouter.getAutofetchRepoRoots())
    const due = this.scheduler.tick(Date.now())
    for (const repoRoot of due) {
      if (this.activeFetches >= MAX_CONCURRENT_FETCHES) break
      void this.runScheduledFetch(repoRoot)
    }
  }

  /**
   * Emit the paused-while-hidden diagnostic, but only when it carries new
   * information: the owed-work signature changed, or {@link HIDDEN_SKIP_MIN_REPEAT_MS}
   * elapsed. Previously this fired on every 30 s tick with an empty payload —
   * 935 identical `{}` records across a 4-day field bundle.
   *
   * The repo set is deliberately NOT re-synced here: syncing would run router
   * work on a path whose entire purpose is to do nothing while the user is away.
   * The numbers therefore describe the set as of the last visible tick, which is
   * exactly the question being asked ("how much was owed when we went quiet").
   */
  private recordHiddenSkip(): void {
    const now = Date.now()
    const owed = this.scheduler.overdueSnapshot(now)
    const signature = `${owed.repoCount}:${owed.overdueCount}:${owed.neverFetchedCount}`
    if (
      signature === this.hiddenSkipSignature &&
      now - this.hiddenSkipEmittedAt < HIDDEN_SKIP_MIN_REPEAT_MS
    ) {
      return
    }
    this.hiddenSkipSignature = signature
    this.hiddenSkipEmittedAt = now
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SKIPPED_HIDDEN, {
      repoCount: owed.repoCount,
      overdueCount: owed.overdueCount,
      neverFetchedCount: owed.neverFetchedCount,
      maxOverdueMs: Math.round(owed.maxOverdueMs)
    })
  }

  /**
   * The user focused a Task whose repo is `repoRoot`. Ask the scheduler for one
   * backoff-bypassing fetch, and if granted, run a tick immediately rather than
   * waiting up to a full tick period.
   */
  private handleRepoFocused(repoRoot: string): void {
    if (this.disposed || !this.enabled || !repoRoot) return
    const decision = this.scheduler.requestPriorityRetry(repoRoot, Date.now())
    // Rate control. Only two outcomes are newsworthy: a GRANT, and a refusal
    // that means "the hatch was reached but rate-limited" (cooldown /
    // attempted-recently / already-pending / in-flight). The other two refusals
    // are steady state and fire on EVERY Task focus — `not-backed-off` for every
    // healthy repo, and `unknown-repo` for every repo the scheduler has not
    // synced yet (no visible tick since launch) or deliberately excludes (no
    // upstream). Tracing them swamps the very signal this event exists to carry:
    // a 30 s slice of a test run produced 36 `unknown-repo` records and zero
    // useful ones.
    if (!decision.granted && decision.reason && STEADY_STATE_REFUSALS.has(decision.reason)) return
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_PRIORITY_RETRY, {
      repoRoot,
      granted: decision.granted,
      reason: decision.reason ?? null
    })
    if (decision.granted) this.runTick()
  }

  private async runScheduledFetch(repoRoot: string): Promise<void> {
    // The tick only offers repos the scheduler considers idle, but a manual or
    // forced run may own the repo without the scheduler having seen it yet
    // (e.g. a repo the scheduler has not synced) — join instead of doubling up.
    // Recorded BEFORE the spawn so `scheduled` precedes `started` in the trace.
    if (!this.inflight.has(repoRoot)) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SCHEDULED, { repoRoot })
    }
    await this.inflight.runOrJoin(repoRoot, () => this.startFetch(repoRoot, 'autofetch')).promise
  }

  /**
   * One complete fetch lifecycle. Every path (scheduled, manual, forced) goes
   * through here exactly once per spawned process, so the scheduler's
   * start/done hooks, the in-flight publish and the outcome events stay paired.
   */
  private async startFetch(repoRoot: string, source: FetchSource): Promise<AutofetchResult> {
    const fetchId = this.nextFetchId++
    // The autotest force path deliberately leaves the scheduler alone (start AND
    // done): it drives one fetch deterministically, it does not model the loop.
    const tracksScheduler = source !== 'autofetch-forced'
    if (tracksScheduler) this.scheduler.onFetchStart(repoRoot)
    this.activeFetches += 1
    // Publish BEFORE spawning so the button starts spinning for background
    // fetches too (user decision 2026-10-26) — the dropped-click report came
    // from a user who could not see that a fetch was already running.
    const inFlightFanoutCount = gitStateMirrorRouter.setFetchFreshness(repoRoot, { fetchInFlight: true })
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_STARTED, {
      repoRoot,
      source,
      fetchId,
      inFlightFanoutCount,
      ...(source === 'autofetch-forced' ? { forced: true } : {})
    })
    let result: AutofetchResult
    try {
      result = { ...(await this.executeFetch(repoRoot)), fetchId }
    } catch (error) {
      // executeFetch never rejects by contract; this keeps the in-flight flag
      // and the scheduler's streak honest if that contract is ever broken.
      result = { ok: false, reason: 'other', classified: 'other', durationMs: 0, fetchId, stderrTail: sanitizeGitStderr(String(error)) }
    } finally {
      this.activeFetches -= 1
    }
    if (tracksScheduler) this.scheduler.onFetchDone(repoRoot, Date.now(), result.ok)
    this.reportResult(repoRoot, result, source)
    return result
  }

  /**
   * User-initiated fetch for one repo — the recovery path behind the Task
   * badge's sync button (BUG-0005 follow-up).
   *
   * Deliberately bypasses the due-timer and the failure backoff: the backoff
   * exists to stop an UNATTENDED dead repo from burning resources, and a user
   * who just clicked is by definition attending. A success RESETS the failure
   * streak, so the manual fetch fixing the repo also un-sticks the loop.
   *
   * When a fetch for this repo is already running the click JOINS it and
   * resolves with that run's outcome (user decision 2026-10-26, VS Code's
   * `@throttle` semantics). It used to return `null` here, which the renderer
   * ignored — the click was dropped with one frame of spinner.
   */
  async fetchNow(repoRoot: string): Promise<(AutofetchResult & { joined: boolean }) | null> {
    if (this.disposed || !repoRoot) return null
    // Recorded BEFORE runOrJoin (which spawns synchronously on a miss) so
    // `user-requested` precedes the `started` it causes in the trace.
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_FETCH_USER_REQUESTED, {
      repoRoot,
      joined: this.inflight.has(repoRoot)
    })
    const run = this.inflight.runOrJoin(repoRoot, () => this.startFetch(repoRoot, 'manual'))
    const result = await run.promise
    return { ...result, joined: run.joined }
  }

  /**
   * Autotest-only deterministic driver: fetch one repo NOW (bypassing due
   * timing), revalidate on success, and return the result. Shares the in-flight
   * registry so a test can model "background fetch running, then a click".
   * Gated by the caller (`ONWARD_AUTOTEST=1`), never wired in production.
   */
  async forceFetchForAutotest(repoRoot: string): Promise<AutofetchResult & { joined: boolean }> {
    const run = this.inflight.runOrJoin(repoRoot, () => this.startFetch(repoRoot, 'autofetch-forced'))
    const result = await run.promise
    return { ...result, joined: run.joined }
  }

  private reportResult(repoRoot: string, result: AutofetchResult, source: FetchSource): void {
    // Publish fetch freshness to the badge regardless of outcome, so a ↓behind
    // whose backing fetch has been failing can be RENDERED as stale instead of
    // silently presenting a days-old number as current (BUG-0005 R3).
    const settledAt = Date.now()
    // Only ONE failure class reaches the BADGE tooltip: the remote could not be
    // reached. A MANUAL fetch additionally reports its failure class through
    // the fetchNow IPC result (user decision 2026-10-26); background failures
    // stay silent. Note a ceiling kill with no stderr classifies as 'other',
    // not 'network' — we genuinely do not know why it hung, so we do not claim to.
    const remoteUnreachable = !result.ok && result.classified === 'network'
    // freshnessFanoutCount closes a diagnostic gap: without it, "published to
    // nobody because no cwd matched" and "published, but the renderer never
    // applied it" look identical in a bundle. Folded into the outcome events
    // below rather than getting an event of its own. `fetchInFlight: false`
    // rides the same delta so the spinner stops in the same render.
    const freshnessFanoutCount = gitStateMirrorRouter.setFetchFreshness(repoRoot, {
      lastFetchAttemptAt: settledAt,
      remoteUnreachable,
      fetchInFlight: false,
      ...(result.ok ? { lastFetchOkAt: settledAt } : {})
    })
    if (result.ok) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_SUCCEEDED, {
        repoRoot,
        source,
        fetchId: result.fetchId ?? null,
        durationMs: result.durationMs,
        freshnessFanoutCount
      })
      // A successful fetch advanced the remote-tracking ref → re-read behind.
      gitStateMirrorRouter.revalidateRepoRoot(repoRoot, source)
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_TRIGGERED_RECOMPUTE, { repoRoot })
      return
    }
    void this.recordFailure(repoRoot, result, freshnessFanoutCount, source)
  }

  /**
   * Failure path. Enriches the diagnostic with the repo's transport class before
   * emitting, because "SSH timed out" and "HTTPS timed out" have entirely
   * different triage paths and the bundle previously carried neither.
   *
   * Async only for the cached remote-URL lookup; it runs at most once per repo
   * per process, and only after a failure (so a healthy repo never pays for it).
   */
  private async recordFailure(
    repoRoot: string,
    result: AutofetchResult,
    freshnessFanoutCount: number,
    source: FetchSource
  ): Promise<void> {
    const remoteScheme = await this.resolveRemoteScheme(repoRoot)
    // A killed fetch leaves its partial pack behind (git neither resumes nor
    // reuses it; gc prunes it later). Its size is the only evidence that the
    // transfer was progressing rather than wedged — the field bundle could only
    // prove this by inspecting the user's disk. Ceiling kills only, so a healthy
    // repo never pays for the directory read.
    const leftovers = result.killedByTimeout ? await this.probeTmpPacks(repoRoot) : null
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_FAILED, {
      repoRoot,
      source,
      fetchId: result.fetchId ?? null,
      ...(leftovers ? { tmpPackCount: leftovers.count, tmpPackBytes: leftovers.bytes } : {}),
      reason: result.reason ?? 'other',
      durationMs: result.durationMs,
      freshnessFanoutCount,
      killedByTimeout: result.killedByTimeout ?? false,
      classified: result.classified ?? null,
      exitCode: result.exitCode ?? null,
      remoteScheme,
      stderrTail: result.stderrTail ?? ''
    })
    const nextGapMs = computeAutofetchBackoffMs(
      this.intervalMs,
      this.scheduler.inspect().repos.find((r) => r.repoKey === repoRoot)?.failureStreak ?? 1,
      GIT_AUTOFETCH_MAX_BACKOFF_MS
    )
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_GIT_AUTOFETCH_BACKOFF, { repoRoot, nextGapMs })
  }

  /**
   * Transport class of `repoRoot`'s `origin`, cached forever per repo. Only the
   * CLASS is retained — the URL, host and user never leave this function.
   */
  private async resolveRemoteScheme(repoRoot: string): Promise<RemoteScheme> {
    const cached = this.remoteSchemeCache.get(repoRoot)
    if (cached) return cached
    if (!this.gitPathPromise) this.gitPathPromise = resolveGitExecutable()
    const gitPath = await this.gitPathPromise
    if (!gitPath) return 'other'
    const scheme = await new Promise<RemoteScheme>((resolve) => {
      execFile(
        gitPath,
        ['-C', repoRoot, 'config', '--get', 'remote.origin.url'],
        {
          env: getExecEnv(),
          timeout: REMOTE_URL_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024
        },
        (error, stdout) => resolve(error ? 'none' : classifyRemoteScheme(String(stdout ?? '')))
      )
    })
    this.remoteSchemeCache.set(repoRoot, scheme)
    return scheme
  }

  /**
   * Count leftover `tmp_pack_*` files in the repo's pack directory. Resolved via
   * `git rev-parse --git-path` so linked worktrees and `GIT_COMMON_DIR` layouts
   * point at the shared object store. Returns null on any error — this is
   * diagnostic enrichment, never a reason to fail the failure event.
   */
  private async probeTmpPacks(repoRoot: string): Promise<{ count: number; bytes: number } | null> {
    if (!this.gitPathPromise) this.gitPathPromise = resolveGitExecutable()
    const gitPath = await this.gitPathPromise
    if (!gitPath) return null
    const packDir = await new Promise<string | null>((resolve) => {
      execFile(
        gitPath,
        // No `--path-format=absolute` (git >= 2.31 only): the output may be
        // relative to repoRoot, so resolve it ourselves on every git version.
        ['-C', repoRoot, 'rev-parse', '--git-path', 'objects/pack'],
        { env: getExecEnv(), timeout: PACK_DIR_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          const out = error ? '' : String(stdout ?? '').trim()
          resolve(out ? resolvePath(repoRoot, out) : null)
        }
      )
    })
    if (!packDir) return null
    try {
      const names = (await readdir(packDir)).filter((name) => name.startsWith('tmp_pack_'))
      let bytes = 0
      for (const name of names) {
        try {
          bytes += (await stat(join(packDir, name))).size
        } catch {
          // Raced with gc / another fetch — skip it.
        }
      }
      return { count: names.length, bytes }
    } catch {
      return null
    }
  }

  private async executeFetch(repoRoot: string): Promise<AutofetchResult> {
    if (!this.gitPathPromise) this.gitPathPromise = resolveGitExecutable()
    const gitPath = await this.gitPathPromise
    if (!gitPath) {
      return { ok: false, reason: 'other', durationMs: 0 }
    }
    return runFetchProcess(gitPath, repoRoot, this.ceilingMs)
  }
}

/**
 * Spawn one hardened `git fetch` and resolve with its outcome. Never rejects —
 * a failed background fetch is safe to swallow (it touches only remote-tracking
 * refs + FETCH_HEAD, never the working tree) and the caller backs it off.
 */
export function runFetchProcess(
  gitPath: string,
  repoRoot: string,
  ceilingMs: number = GIT_FETCH_CEILING_MS
): Promise<AutofetchResult> {
  return new Promise((resolve) => {
    const startMs = Date.now()
    execFile(
      gitPath,
      ['-C', repoRoot, 'fetch', '--quiet'],
      { env: buildFetchEnv(), timeout: ceilingMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        const durationMs = Date.now() - startMs
        if (!error) {
          resolve({ ok: true, durationMs })
          return
        }
        const killedByTimeout = (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
        const stderrText = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        const evidence = stderrText || error.message || ''
        // Classify ALWAYS, including on the ceiling-kill path. `reason` still
        // reports what happened to the PROCESS; `classified` reports what
        // git was complaining about while it hung. The timeout branch used to
        // short-circuit past classifyFetchFailure and drop stderr entirely,
        // which is why 6 of 9 field failures were undiagnosable.
        const classified = classifyFetchFailure(evidence)
        const reason: FetchFailureReason = killedByTimeout ? 'timeout' : classified
        const exitCode = (error as NodeJS.ErrnoException & { code?: number | string }).code
        resolve({
          ok: false,
          reason,
          durationMs,
          killedByTimeout,
          classified,
          exitCode: typeof exitCode === 'number' ? exitCode : null,
          stderrTail: sanitizeGitStderr(evidence)
        })
      }
    )
  })
}

export const gitAutofetchManager = new GitAutofetchManager()
