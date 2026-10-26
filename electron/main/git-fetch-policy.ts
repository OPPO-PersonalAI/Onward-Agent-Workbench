/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * When a background / manual `git fetch` is allowed to keep running (pure).
 *
 * History: the fetch used to be killed by a fixed 20 s wall-clock timeout. The
 * 2026-10-26 field bundle showed what that does to a binary-heavy repo: the
 * pending payload was 87.9 MiB, the user's own terminal fetch took ~30 s, and
 * the app's fetch was killed at 20,007 ms while STILL RECEIVING data (a 28.7 MB
 * `tmp_pack_*` was left behind at the kill minute). git cannot resume a killed
 * fetch, so every retry restarted from zero against a growing payload and the
 * repo could never sync. See docs/html/git-fetch-timeout-strategy-options.html.
 *
 * User decision (2026-10-26, option S1): let the TRANSPORT decide "stalled" vs
 * "slow but alive", and keep only a long wall-clock ceiling as a last resort:
 *   - HTTP(S): `GIT_HTTP_LOW_SPEED_LIMIT` / `GIT_HTTP_LOW_SPEED_TIME` make curl
 *     abort only when the rate stays below the limit for the whole window; the
 *     timer resets whenever the rate recovers.
 *   - SSH: `ServerAliveInterval` / `ServerAliveCountMax` drop an unresponsive
 *     peer; the pre-existing `ConnectTimeout=10` still bounds the handshake.
 *   - Everything else (`file://`, `git://`, `ext::`) is bounded by the ceiling.
 * Manual and background fetches share one policy (option D1): a click joins
 * the in-flight run, so two policies could never both apply anyway.
 *
 * Pure so the decided values are pinned by `test/unittest/git-fetch-policy.test.mts`.
 */

/** curl aborts when the transfer rate stays below this many bytes/s ... */
export const GIT_FETCH_LOW_SPEED_LIMIT_BPS = 1000
/** ... for this many consecutive seconds. */
export const GIT_FETCH_LOW_SPEED_TIME_SEC = 60
/** SSH keepalive probe period (seconds). */
export const GIT_FETCH_SSH_ALIVE_INTERVAL_SEC = 15
/** Unanswered SSH keepalives before the peer is declared dead (~60 s total). */
export const GIT_FETCH_SSH_ALIVE_COUNT_MAX = 4
/** SSH handshake bound, unchanged from the original hardening. */
export const GIT_FETCH_SSH_CONNECT_TIMEOUT_SEC = 10
/** Last-resort wall-clock ceiling for one fetch process. */
export const GIT_FETCH_CEILING_MS = 600_000
/**
 * Lower bound for the autotest-only ceiling override, so a typo cannot turn
 * every fetch into an instant kill.
 */
export const GIT_FETCH_CEILING_AUTOTEST_MIN_MS = 1_000

export type FetchEnv = Record<string, string | undefined>

/**
 * Overlay the hardening variables onto `base` (the resolved exec env). Never
 * mutates `base`. An explicit user `GIT_SSH_COMMAND` is preserved and extended
 * rather than replaced, so a custom key / proxy command keeps working.
 */
export function buildHardenedFetchEnv(base: FetchEnv, fallbackSshCommand?: string): FetchEnv {
  const existingSsh = base.GIT_SSH_COMMAND || fallbackSshCommand || 'ssh'
  return {
    ...base,
    // Fetch only writes remote-tracking refs; disabling optional locks avoids
    // index.lock churn racing the user's own git commands.
    GIT_OPTIONAL_LOCKS: '0',
    // Never prompt: an https credential prompt or GCM UI would hang invisibly.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND:
      `${existingSsh} -o BatchMode=yes -o ConnectTimeout=${GIT_FETCH_SSH_CONNECT_TIMEOUT_SEC}` +
      ` -o ServerAliveInterval=${GIT_FETCH_SSH_ALIVE_INTERVAL_SEC}` +
      ` -o ServerAliveCountMax=${GIT_FETCH_SSH_ALIVE_COUNT_MAX}`,
    // Transport-level stall detection (option S1). Env vars rather than `-c`
    // so they reach git-remote-https without depending on argv propagation.
    GIT_HTTP_LOW_SPEED_LIMIT: String(GIT_FETCH_LOW_SPEED_LIMIT_BPS),
    GIT_HTTP_LOW_SPEED_TIME: String(GIT_FETCH_LOW_SPEED_TIME_SEC)
  }
}

/**
 * Resolve the wall-clock ceiling. `ONWARD_GIT_FETCH_CEILING_MS` is honoured
 * ONLY under `ONWARD_AUTOTEST=1`, so a runner can exercise the kill path in
 * seconds instead of ten minutes; production builds always get
 * {@link GIT_FETCH_CEILING_MS}.
 */
export function resolveFetchCeilingMs(env: FetchEnv): number {
  if (env.ONWARD_AUTOTEST !== '1') return GIT_FETCH_CEILING_MS
  const raw = env.ONWARD_GIT_FETCH_CEILING_MS
  if (!raw) return GIT_FETCH_CEILING_MS
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < GIT_FETCH_CEILING_AUTOTEST_MIN_MS) return GIT_FETCH_CEILING_MS
  return n
}
