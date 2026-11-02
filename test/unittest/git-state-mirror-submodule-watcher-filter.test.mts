/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-state-mirror-submodule-watcher-filter.test.mts
 *
 * Regression lock for the Windows Git-Diff invalidation-storm bug (2026-06-03)
 * AND gitignored-directory churn storms.
 *
 * # Why SYNTHETIC events (not the real @parcel/watcher)
 *
 * The bug this guards is a pure FILTER DECISION: the GitStateMirror worker
 * callback keeps a path iff `classifyEventPath(path, root).drop === false`
 * (kept paths drive a `git status` recompute → diff-cache invalidation), and a
 * repo's `.gitignore` directory patterns are converted to parcel ignore globs.
 * The original version of this test SUBSCRIBED the real @parcel/watcher to
 * prove the filter end-to-end. That native subscription is the only part that
 * is fragile to the HOST Node version: under Node 25 + @parcel/watcher 2.5.6 the
 * watcher delivers ZERO events on macOS (a bare-watcher probe confirms it), so
 * the sentinel never arrives and BOTH assertions fail with `delivered=[]` — a
 * false failure that has nothing to do with the product (the packaged app runs
 * on Electron's own runtime, where the watcher works; run-file-watch passes).
 *
 * So we drive the EXACT same filter decision with synthetic events (the shapes
 * @parcel/watcher would deliver) against the REAL `classifyEventPath` /
 * `MIRROR_WATCHER_IGNORE` / `gitignoreToWatchIgnoreGlobs`. This is a pure-logic
 * unit test: deterministic, instant, Node-version-robust, and it still locks the
 * regression (nested submodule `.git/` churn must not survive; a real worktree /
 * source edit must; gitignored `build/` directories convert to ignore globs
 * while `*.raw` file patterns do NOT).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyEventPath,
  MIRROR_WATCHER_IGNORE
} from '../../electron/main/git-state-mirror-worker-core.ts'
import { gitignoreToWatchIgnoreGlobs } from '../../electron/main/git-gitignore-watch-globs.ts'

/** Mirror the worker callback's decision: kept paths drive a recompute. */
function keptPaths(events: Array<{ path: string }>, root: string): string[] {
  return events.filter((e) => !classifyEventPath(e.path, root).drop).map((e) => e.path)
}

test('classifyEventPath: nested submodule .git churn does NOT survive the filter, a real worktree edit does', () => {
  const root = '/repo/root'
  const sub = `${root}/src/third_party/sublib`
  // The synthetic batch @parcel/watcher would deliver for: a submodule
  // `git status`/`git add` (index.lock churn), object gc noise, and a REAL
  // worktree edit (the sentinel that MUST survive).
  const events = [
    { path: `${sub}/.git/index.lock`, type: 'create' },
    { path: `${sub}/.git/index.lock`, type: 'delete' },
    { path: `${sub}/.git/objects/ab/deadbeef`, type: 'create' },
    { path: `${sub}/lib/widget.c`, type: 'update' }
  ]

  const kept = keptPaths(events, root).map((p) => p.replace(/\\/g, '/'))

  // The real worktree edit must survive the filter (recompute).
  assert.ok(
    kept.some((p) => p.endsWith('src/third_party/sublib/lib/widget.c')),
    `real submodule worktree edit must survive the filter. kept=${JSON.stringify(kept)}`
  )
  // CORE REGRESSION ASSERTION: NOTHING under any `.git/` (the submodule's git
  // dir) may survive — no recompute, no diff-cache invalidation. This is the
  // exact leak the 2026-06-03 bug had (only the TOP-LEVEL `.git/` was filtered).
  const leaked = kept.filter((p) => /(?:^|\/)\.git\//.test(p))
  assert.deepEqual(leaked, [], `submodule .git churn leaked past the filter: ${JSON.stringify(leaked)}`)
})

test('MIRROR_WATCHER_IGNORE does not over-suppress a real source edit (sanity)', () => {
  const root = '/repo/root'
  // A real tracked-source edit under src/ must never be classified as drop.
  const decision = classifyEventPath(`${root}/src/main.c`, root)
  assert.equal(decision.drop, false, `a real source edit must survive: ${JSON.stringify(decision)}`)
  // And the ignore list is the narrow, negation-immune set it is supposed to be.
  assert.deepEqual(
    [...MIRROR_WATCHER_IGNORE],
    ['.git/objects/**', 'node_modules/**', 'out/**', 'release/**', 'traces/**', '.parcel-cache/**']
  )
})

test('gitignoreToWatchIgnoreGlobs: directory patterns convert (negation-immune); file/extension patterns do NOT', () => {
  // `build/` (a gitignored dir whose contents churn) must convert to parcel
  // ignore globs so those writes produce NO watcher events; `*.raw` (a
  // file/extension pattern) must NOT be converted (a later `!keep.raw` negation
  // could make blanket suppression drop a real change).
  const globs = gitignoreToWatchIgnoreGlobs('build/\n*.raw\n')
  assert.ok(globs.includes('build/**'), `expected build/** in ${JSON.stringify(globs)}`)
  assert.ok(globs.includes('**/build/**'), `expected **/build/** in ${JSON.stringify(globs)}`)
  // file / extension pattern is intentionally NOT converted (negation hazard).
  assert.ok(!globs.some((g) => g.includes('raw')), `*.raw must NOT convert: ${JSON.stringify(globs)}`)
})
