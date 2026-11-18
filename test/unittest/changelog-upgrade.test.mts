/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateChangelogUpgrade, acknowledgeReleaseNotes, parseReleaseNotesState, normalizeReleaseVersion, LAST_SEEN_RELEASE_TAG_STORAGE_KEY } from '../../src/utils/changelog-upgrade.ts'
import { ReleaseNotesStore } from '../../electron/main/changelog-state.ts'

const oldVersion = '2.1.0-daily.20261102.1'
const version = '2.1.0-daily.20261117.1'
const tag = `v${version}`
const pending = () => ({ schemaVersion: 1 as const, lastRunVersion: version, pendingVersion: version })

test('CLU-U-01 legacy storage key remains readable', () => {
  assert.equal(LAST_SEEN_RELEASE_TAG_STORAGE_KEY, 'onward.lastSeenReleaseTag')
})
test('CLU-U-02 prior session identifies upgrade without a legacy marker', () => {
  const decision = evaluateChangelogUpgrade({ currentTag: tag, previousSessionVersion: oldVersion })
  assert.equal(decision.reason, 'upgrade')
  assert.deepEqual(decision.state, pending())
  assert.equal(decision.source, 'session-ledger')
})
test('CLU-U-03 fresh install records baseline without pending content', () => {
  assert.deepEqual(evaluateChangelogUpgrade({ currentTag: tag }).state, { ...pending(), pendingVersion: null })
})
test('CLU-U-04 same version retains unacknowledged pending content', () => {
  assert.deepEqual(evaluateChangelogUpgrade({ currentTag: tag, state: pending() }).state, pending())
})
test('CLU-U-05 acknowledgement is version checked and idempotent', () => {
  const state = pending()
  assert.equal(acknowledgeReleaseNotes(state, tag, `v${oldVersion}`), state)
  const done = acknowledgeReleaseNotes(state, tag, tag)
  assert.equal(done.pendingVersion, null)
  assert.equal(acknowledgeReleaseNotes(done, tag, tag), done)
  assert.equal(evaluateChangelogUpgrade({ currentTag: tag, state: done }).reason, 'same-version')
})
test('CLU-U-06 downgrade clears pending; subsequent upgrade creates it again', () => {
  const down = evaluateChangelogUpgrade({ currentTag: `v${oldVersion}`, state: pending() })
  assert.equal(down.reason, 'downgrade')
  assert.equal(down.state?.pendingVersion, null)
  assert.deepEqual(evaluateChangelogUpgrade({ currentTag: tag, state: down.state }).state, pending())
})
test('CLU-U-07 full semantic versions order daily build numbers, dates, patch and stable releases', () => {
  for (const [before, after] of [
    [oldVersion, version], ['2.1.0-daily.20261117.2', '2.1.0-daily.20261117.10'],
    ['2.1.0', '2.1.1'], ['2.0.0', '3.0.0'], [version, '2.1.0']
  ]) assert.equal(evaluateChangelogUpgrade({ currentTag: `v${after}`, previousSessionVersion: before }).reason, 'upgrade')
})
test('CLU-U-08 migration priority is state, session, legacy storage', () => {
  const done = { ...pending(), pendingVersion: null }
  assert.equal(evaluateChangelogUpgrade({ currentTag: tag, state: done, previousSessionVersion: oldVersion }).reason, 'same-version')
  assert.equal(evaluateChangelogUpgrade({ currentTag: tag, previousSessionVersion: oldVersion, storedLastSeenTag: tag }).source, 'session-ledger')
  assert.equal(evaluateChangelogUpgrade({ currentTag: tag, previousSessionVersion: 'broken', storedLastSeenTag: `v${oldVersion}` }).source, 'legacy-storage')
})
test('CLU-U-09 unavailable or unorderable identities do not fabricate upgrades', () => {
  for (const value of [null, '', 'broken', 'v2026.11.17.1', '2026.11.17']) assert.equal(normalizeReleaseVersion(value), null)
  assert.equal(evaluateChangelogUpgrade({ currentTag: null, state: pending() }).state?.pendingVersion, version)
  assert.equal(evaluateChangelogUpgrade({ currentTag: tag, previousSessionVersion: 'corrupt' }).reason, 'fresh-install')
})
test('CLU-U-10 persisted schema rejects mismatched or malformed pending state', () => {
  assert.deepEqual(parseReleaseNotesState(pending()), pending())
  for (const value of [null, {}, { ...pending(), schemaVersion: 2 }, { ...pending(), pendingVersion: oldVersion }, { ...pending(), lastRunVersion: 3 }]) {
    assert.equal(parseReleaseNotesState(value), null)
  }
})
test('CLU-U-11 disk state survives pre-display exit, acknowledgement and another upgrade', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-notes-unit-')))
  const path = join(root, 'release-notes-state.json')
  try {
    const first = new ReleaseNotesStore(path, tag, oldVersion, () => {})
    assert.equal(first.snapshot().pendingTag, tag)
    const retry = new ReleaseNotesStore(path, tag, version, () => {})
    assert.equal(retry.prepare().pendingTag, tag)
    assert.equal(retry.markShown('stale').success, false)
    assert.equal(retry.markShown(tag).success, true)
    const restart = new ReleaseNotesStore(path, tag, version, () => {})
    assert.equal(restart.prepare().pendingTag, null)
    const nextTag = 'v2.1.0-daily.20261118.1'
    assert.equal(new ReleaseNotesStore(path, nextTag, version, () => {}).prepare().pendingTag, nextTag)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pendingVersion, nextTag.slice(1))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('CLU-U-12 legacy import happens once and write failure preserves disk retry intent', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-notes-unit-')))
  const path = join(root, 'release-notes-state.json')
  const actions: string[] = []
  try {
    const store = new ReleaseNotesStore(path, tag, null, detail => actions.push(String(detail.action)))
    assert.equal(store.prepare(`v${oldVersion}`).pendingTag, tag)
    mkdirSync(`${path}.pending`)
    assert.equal(store.markShown(tag).success, false)
    assert.equal(store.prepare(`v${oldVersion}`).pendingTag, null)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pendingVersion, version)
    assert.ok(actions.includes('write-failed'))
    rmSync(`${path}.pending`, { recursive: true })
    assert.equal(new ReleaseNotesStore(path, tag, version, () => {}).prepare().pendingTag, tag)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
