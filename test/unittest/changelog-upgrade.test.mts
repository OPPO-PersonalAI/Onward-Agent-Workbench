/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for evaluateChangelogUpgrade(): the pure-logic decision table
 * behind the VS Code-style post-upgrade Release Note auto-open.
 * Pair with the autotest suite `run-change-log` which locks end-to-end DOM
 * rendering and upgrade auto-open across app launches.
 *
 * Usage: node --experimental-strip-types --test test/unittest/changelog-upgrade.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateChangelogUpgrade,
  LAST_SEEN_RELEASE_TAG_STORAGE_KEY
} from '../../src/utils/changelog-upgrade.ts'

test('CLU-U-01 storage key is stable', () => {
  assert.equal(LAST_SEEN_RELEASE_TAG_STORAGE_KEY, 'onward.lastSeenReleaseTag')
})

test('CLU-U-02 untagged build never auto-opens and does not overwrite storage', () => {
  const decision = evaluateChangelogUpgrade({
    currentTag: null,
    changelogAvailable: true,
    storedLastSeenTag: 'v2.1.0-daily.20261102.1'
  })
  assert.equal(decision.shouldAutoOpen, false)
  assert.equal(decision.reason, 'no-tag')
  assert.equal(decision.nextStoredTag, null)
})

test('CLU-U-03 missing changelog payload never auto-opens an empty modal', () => {
  const decision = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: false,
    storedLastSeenTag: 'v2.1.0-daily.20261102.1'
  })
  assert.equal(decision.shouldAutoOpen, false)
  assert.equal(decision.reason, 'changelog-unavailable')
  assert.equal(decision.nextStoredTag, null)
})

test('CLU-U-04 fresh install records current tag without auto-opening', () => {
  const decision = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: true,
    storedLastSeenTag: null
  })
  assert.equal(decision.shouldAutoOpen, false)
  assert.equal(decision.reason, 'fresh-install')
  assert.equal(decision.nextStoredTag, 'v2.1.0-daily.20261112.1')
})

test('CLU-U-05 same version launch stays closed and keeps tag', () => {
  const decision = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: true,
    storedLastSeenTag: 'v2.1.0-daily.20261112.1'
  })
  assert.equal(decision.shouldAutoOpen, false)
  assert.equal(decision.reason, 'same-version')
  assert.equal(decision.nextStoredTag, 'v2.1.0-daily.20261112.1')
})

test('CLU-U-06 single-version or multi-version skip upgrade auto-opens and advances stored tag', () => {
  const skipped = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: true,
    storedLastSeenTag: 'v2.0.0-daily.20260401.1'
  })
  assert.equal(skipped.shouldAutoOpen, true)
  assert.equal(skipped.reason, 'upgrade')
  assert.equal(skipped.nextStoredTag, 'v2.1.0-daily.20261112.1')
})

test('CLU-U-07 CLI simulated upgrade auto-opens even on fresh or same-version storage', () => {
  const sim = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: true,
    storedLastSeenTag: 'v2.1.0-daily.20261112.1',
    simulateUpgrade: true
  })
  assert.equal(sim.shouldAutoOpen, true)
  assert.equal(sim.reason, 'simulated-upgrade')
  assert.equal(sim.nextStoredTag, 'v2.1.0-daily.20261112.1')
})

test('CLU-U-08 unrelated autotests suppress auto-open while change-log suite allows it', () => {
  const suppressed = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: true,
    storedLastSeenTag: 'v2.1.0-daily.20261102.1',
    isAutotest: true,
    autotestAllowAutoOpen: false
  })
  assert.equal(suppressed.shouldAutoOpen, false)
  assert.equal(suppressed.reason, 'autotest-suppressed')

  const allowed = evaluateChangelogUpgrade({
    currentTag: 'v2.1.0-daily.20261112.1',
    changelogAvailable: true,
    storedLastSeenTag: 'v2.1.0-daily.20261102.1',
    isAutotest: true,
    autotestAllowAutoOpen: true
  })
  assert.equal(allowed.shouldAutoOpen, true)
  assert.equal(allowed.reason, 'upgrade')
})
