/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRespawnGitStateMirrorWorker } from '../../electron/main/git-state-mirror-teardown.ts'

test('GSM-R01 respawn requires an active app, no live worker, and remaining retry budget', () => {
  for (const disposed of [false, true]) {
    for (const hasLiveWorker of [false, true]) {
      for (const respawnAttempt of [0, 4, 5, 6]) {
        const actual = shouldRespawnGitStateMirrorWorker({ disposed, hasLiveWorker, respawnAttempt, maxAttempts: 5 })
        assert.equal(actual, !disposed && !hasLiveWorker && respawnAttempt < 5)
      }
    }
  }
})
