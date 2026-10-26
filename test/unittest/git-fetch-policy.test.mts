/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-fetch-policy.test.mts
 *
 * Pins the user-decided fetch time policy (2026-10-26, option S1 in
 * docs/html/git-fetch-timeout-strategy-options.html): the transport decides
 * "stalled" vs "slow but alive", and only a long ceiling remains.
 *
 * Why it matters: a fixed 20 s kill made a binary-heavy repo un-syncable — the
 * field fetch was killed at 20,007 ms while still receiving data (28.7 MB of a
 * 87.9 MiB pack on disk), and git cannot resume, so every retry restarted from
 * zero. A future "just add a short timeout back" change must fail here.
 *
 * Paired with run-git-autofetch-ahead-behind AB-08 (ceiling kill, autotest
 * override) and AB-17 (a fetch slower than the old 20 s ceiling completes).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHardenedFetchEnv,
  resolveFetchCeilingMs,
  GIT_FETCH_CEILING_MS,
  GIT_FETCH_CEILING_AUTOTEST_MIN_MS,
  GIT_FETCH_LOW_SPEED_LIMIT_BPS,
  GIT_FETCH_LOW_SPEED_TIME_SEC,
  GIT_FETCH_SSH_ALIVE_INTERVAL_SEC,
  GIT_FETCH_SSH_ALIVE_COUNT_MAX
} from '../../electron/main/git-fetch-policy.ts'

test('decided values: 1000 B/s for 60 s, ssh 15 s × 4, 10 min ceiling', () => {
  assert.equal(GIT_FETCH_LOW_SPEED_LIMIT_BPS, 1000)
  assert.equal(GIT_FETCH_LOW_SPEED_TIME_SEC, 60)
  assert.equal(GIT_FETCH_SSH_ALIVE_INTERVAL_SEC, 15)
  assert.equal(GIT_FETCH_SSH_ALIVE_COUNT_MAX, 4)
  assert.equal(GIT_FETCH_CEILING_MS, 600_000)
})

test('the ceiling can never again sit below the field case (a ~30 s fetch must fit)', () => {
  assert.ok(GIT_FETCH_CEILING_MS >= 120_000, `ceiling ${GIT_FETCH_CEILING_MS} ms is a fixed short kill again`)
})

test('env: low-speed abort is set for the https transport', () => {
  const env = buildHardenedFetchEnv({ PATH: '/usr/bin' })
  assert.equal(env.GIT_HTTP_LOW_SPEED_LIMIT, '1000')
  assert.equal(env.GIT_HTTP_LOW_SPEED_TIME, '60')
})

test('env: the original anti-prompt hardening is preserved', () => {
  const env = buildHardenedFetchEnv({})
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
})

test('env: ssh gets BatchMode, ConnectTimeout and keepalives', () => {
  const ssh = buildHardenedFetchEnv({}).GIT_SSH_COMMAND ?? ''
  assert.match(ssh, /^ssh /)
  assert.match(ssh, /-o BatchMode=yes/)
  assert.match(ssh, /-o ConnectTimeout=10/)
  assert.match(ssh, /-o ServerAliveInterval=15/)
  assert.match(ssh, /-o ServerAliveCountMax=4/)
})

test('env: a user GIT_SSH_COMMAND is extended, not replaced', () => {
  const fromBase = buildHardenedFetchEnv({ GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work' }).GIT_SSH_COMMAND ?? ''
  assert.match(fromBase, /^ssh -i ~\/\.ssh\/work -o BatchMode=yes/)
  const fromFallback = buildHardenedFetchEnv({}, 'plink -batch').GIT_SSH_COMMAND ?? ''
  assert.match(fromFallback, /^plink -batch -o BatchMode=yes/)
})

test('env: the base env is not mutated and unrelated keys pass through', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/x' }
  const env = buildHardenedFetchEnv(base)
  assert.deepEqual(base, { PATH: '/usr/bin', HOME: '/home/x' })
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/x')
})

test('ceiling: production ignores the override entirely', () => {
  assert.equal(resolveFetchCeilingMs({}), GIT_FETCH_CEILING_MS)
  assert.equal(resolveFetchCeilingMs({ ONWARD_GIT_FETCH_CEILING_MS: '5000' }), GIT_FETCH_CEILING_MS)
  assert.equal(
    resolveFetchCeilingMs({ ONWARD_AUTOTEST: '0', ONWARD_GIT_FETCH_CEILING_MS: '5000' }),
    GIT_FETCH_CEILING_MS
  )
})

test('ceiling: autotest may shorten it', () => {
  assert.equal(resolveFetchCeilingMs({ ONWARD_AUTOTEST: '1', ONWARD_GIT_FETCH_CEILING_MS: '30000' }), 30_000)
})

test('ceiling: a garbage or too-small autotest override falls back to the default', () => {
  for (const raw of ['', 'abc', '-5', '0', String(GIT_FETCH_CEILING_AUTOTEST_MIN_MS - 1)]) {
    assert.equal(
      resolveFetchCeilingMs({ ONWARD_AUTOTEST: '1', ONWARD_GIT_FETCH_CEILING_MS: raw }),
      GIT_FETCH_CEILING_MS,
      JSON.stringify(raw)
    )
  }
  assert.equal(
    resolveFetchCeilingMs({ ONWARD_AUTOTEST: '1', ONWARD_GIT_FETCH_CEILING_MS: String(GIT_FETCH_CEILING_AUTOTEST_MIN_MS) }),
    GIT_FETCH_CEILING_AUTOTEST_MIN_MS
  )
})
