/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Automated test for the shared file-index cache used by the
 * ProjectEditor filename search (Cmd+P).
 *
 * Usage: node --experimental-strip-types --test test/file-index-cache.test.mts
 *
 * Covers the user-observed scenario:
 *   - Open the same project from multiple Tabs/Tasks → index must be
 *     built only ONCE per normalized cwd.
 *   - Repeatedly invoke global search → walker must not re-run while
 *     the cache entry is ready.
 *   - File-tree mutations (create/rename/delete) apply as incremental
 *     patches rather than nuking the entry.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addFile,
  applyFsEvent,
  disposeAll,
  dispose,
  ensureIndex,
  getIndexSnapshot,
  invalidate,
  removeFile,
  renameFile,
  setFileIndexWatcherAdapter,
  subscribe,
  __getInternalStateForTest
} from '../src/components/ProjectEditor/GlobalSearch/fileIndexCache.ts'

type WalkerCall = { cwd: string; at: number }

function makeWalker(files: string[], opts?: { delayMs?: number; track?: WalkerCall[] }) {
  const delay = opts?.delayMs ?? 0
  const track = opts?.track
  let calls = 0
  const walker = async (cwd: string): Promise<string[]> => {
    calls += 1
    if (track) track.push({ cwd, at: Date.now() })
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    return [...files]
  }
  return {
    walker,
    get calls() {
      return calls
    }
  }
}

function resetCache() {
  setFileIndexWatcherAdapter(null)
  disposeAll()
}

test('ensureIndex builds once and serves the cached result on subsequent calls', async () => {
  resetCache()
  const w = makeWalker(['a.ts', 'b.ts'])
  const first = await ensureIndex('/project/alpha', w.walker)
  assert.deepEqual(first, ['a.ts', 'b.ts'])
  assert.equal(w.calls, 1)

  const second = await ensureIndex('/project/alpha', w.walker)
  assert.deepEqual(second, ['a.ts', 'b.ts'])
  assert.equal(w.calls, 1, 'walker must not run for a second search on the same cwd')

  const third = await ensureIndex('/project/alpha', w.walker)
  assert.equal(w.calls, 1, 'walker must not run for a third search either')
  assert.deepEqual(third, ['a.ts', 'b.ts'])
})

test('multiple concurrent ensureIndex calls dedupe to ONE walker invocation', async () => {
  resetCache()
  const w = makeWalker(['only.ts'], { delayMs: 30 })
  // Simulates: two Tabs both pointing at the same cwd opening Cmd+P at the same moment.
  const [a, b, c] = await Promise.all([
    ensureIndex('/project/beta', w.walker),
    ensureIndex('/project/beta', w.walker),
    ensureIndex('/project/beta', w.walker)
  ])
  assert.deepEqual(a, ['only.ts'])
  assert.deepEqual(b, ['only.ts'])
  assert.deepEqual(c, ['only.ts'])
  assert.equal(w.calls, 1, 'concurrent callers must share a single in-flight build')
})

test('distinct cwds keep independent cache entries', async () => {
  resetCache()
  const wA = makeWalker(['a1.ts', 'a2.ts'])
  const wB = makeWalker(['b1.ts', 'b2.ts'])
  const a1 = await ensureIndex('/project/a', wA.walker)
  const b1 = await ensureIndex('/project/b', wB.walker)
  const a2 = await ensureIndex('/project/a', wA.walker)
  const b2 = await ensureIndex('/project/b', wB.walker)
  assert.equal(wA.calls, 1)
  assert.equal(wB.calls, 1)
  assert.deepEqual(a1, ['a1.ts', 'a2.ts'])
  assert.deepEqual(a2, ['a1.ts', 'a2.ts'])
  assert.deepEqual(b1, ['b1.ts', 'b2.ts'])
  assert.deepEqual(b2, ['b1.ts', 'b2.ts'])
})

test('Windows-style backslashes normalize to the same entry as POSIX-style', async () => {
  resetCache()
  const w = makeWalker(['f.ts'])
  await ensureIndex('C:\\project\\gamma', w.walker)
  await ensureIndex('C:/project/gamma', w.walker)
  assert.equal(w.calls, 1, 'normalized cwd must match across platforms')
})

test('invalidate clears the entry and the next ensureIndex rebuilds', async () => {
  resetCache()
  const w = makeWalker(['one.ts'])
  await ensureIndex('/p', w.walker)
  assert.equal(w.calls, 1)
  invalidate('/p')
  const after = await ensureIndex('/p', w.walker)
  assert.equal(w.calls, 2)
  assert.deepEqual(after, ['one.ts'])
})

test('invalidating one cwd does not affect a sibling cwd', async () => {
  resetCache()
  const wA = makeWalker(['a.ts'])
  const wB = makeWalker(['b.ts'])
  await ensureIndex('/p/a', wA.walker)
  await ensureIndex('/p/b', wB.walker)
  invalidate('/p/a')
  await ensureIndex('/p/b', wB.walker)
  assert.equal(wB.calls, 1, 'sibling cwd must still serve from cache')
  await ensureIndex('/p/a', wA.walker)
  assert.equal(wA.calls, 2, 'invalidated cwd rebuilds on next ensure')
})

test('addFile appends a new path without rebuilding', async () => {
  resetCache()
  const w = makeWalker(['x.ts'])
  await ensureIndex('/p', w.walker)
  addFile('/p', 'y.ts')
  const snap = getIndexSnapshot('/p')
  assert.equal(snap.status, 'ready')
  assert.deepEqual(snap.files.sort(), ['x.ts', 'y.ts'])
  assert.equal(w.calls, 1)
})

test('addFile is idempotent — duplicates are ignored', async () => {
  resetCache()
  const w = makeWalker(['x.ts'])
  await ensureIndex('/p', w.walker)
  addFile('/p', 'y.ts')
  addFile('/p', 'y.ts')
  addFile('/p', 'y.ts')
  assert.deepEqual(getIndexSnapshot('/p').files.sort(), ['x.ts', 'y.ts'])
})

test('removeFile deletes a file and cascades to nested paths on directory removal', async () => {
  resetCache()
  const w = makeWalker([
    'src/index.ts',
    'src/util/a.ts',
    'src/util/b.ts',
    'README.md'
  ])
  await ensureIndex('/p', w.walker)
  removeFile('/p', 'src/util')
  assert.deepEqual(getIndexSnapshot('/p').files.sort(), ['README.md', 'src/index.ts'])
  removeFile('/p', 'README.md')
  assert.deepEqual(getIndexSnapshot('/p').files, ['src/index.ts'])
})

test('renameFile rewrites file paths and cascades into directories', async () => {
  resetCache()
  const w = makeWalker([
    'src/index.ts',
    'src/util/a.ts',
    'src/util/b.ts',
    'other.md'
  ])
  await ensureIndex('/p', w.walker)
  renameFile('/p', 'src/util', 'src/helpers')
  const files = getIndexSnapshot('/p').files.sort()
  assert.deepEqual(files, [
    'other.md',
    'src/helpers/a.ts',
    'src/helpers/b.ts',
    'src/index.ts'
  ])
})

test('renameFile on a single file updates just that entry', async () => {
  resetCache()
  const w = makeWalker(['foo.ts', 'bar.ts'])
  await ensureIndex('/p', w.walker)
  renameFile('/p', 'foo.ts', 'renamed.ts')
  assert.deepEqual(getIndexSnapshot('/p').files.sort(), ['bar.ts', 'renamed.ts'])
})

test('applyFsEvent processes combined added+removed batches', async () => {
  resetCache()
  const w = makeWalker(['alpha.ts', 'beta.ts', 'old/nested.ts'])
  await ensureIndex('/p', w.walker)
  applyFsEvent('/p', { added: ['gamma.ts', 'delta.ts'], removed: ['old'] })
  assert.deepEqual(
    getIndexSnapshot('/p').files.sort(),
    ['alpha.ts', 'beta.ts', 'delta.ts', 'gamma.ts']
  )
})

test('mutation APIs no-op when the entry is not ready', async () => {
  resetCache()
  // Never built — status is idle.
  addFile('/never-built', 'ghost.ts')
  removeFile('/never-built', 'ghost.ts')
  renameFile('/never-built', 'a', 'b')
  applyFsEvent('/never-built', { added: ['x'], removed: ['y'] })
  assert.deepEqual(getIndexSnapshot('/never-built').files, [])
})

test('subscribe notifies on build, mutation, and invalidation', async () => {
  resetCache()
  let count = 0
  const unsubscribe = subscribe('/p', () => {
    count += 1
  })
  const w = makeWalker(['a.ts'])
  await ensureIndex('/p', w.walker)
  assert.equal(count, 1, 'initial build notifies')
  addFile('/p', 'b.ts')
  assert.equal(count, 2, 'addFile notifies')
  removeFile('/p', 'a.ts')
  assert.equal(count, 3, 'removeFile notifies')
  renameFile('/p', 'b.ts', 'c.ts')
  assert.equal(count, 4, 'renameFile notifies')
  applyFsEvent('/p', { added: ['d.ts'] })
  assert.equal(count, 5, 'applyFsEvent notifies')
  invalidate('/p')
  assert.equal(count, 6, 'invalidate notifies')
  unsubscribe()
})

test('subscribe listener does not fire after unsubscribe', async () => {
  resetCache()
  let count = 0
  const unsubscribe = subscribe('/p', () => {
    count += 1
  })
  unsubscribe()
  const w = makeWalker(['a.ts'])
  await ensureIndex('/p', w.walker)
  addFile('/p', 'b.ts')
  assert.equal(count, 0)
})

test('watcher adapter.start runs after the initial build, adapter.stop on dispose', async () => {
  resetCache()
  const started: string[] = []
  const stopped: string[] = []
  setFileIndexWatcherAdapter({
    start: (cwd) => {
      started.push(cwd)
    },
    stop: (cwd) => {
      stopped.push(cwd)
    }
  })
  const w = makeWalker(['a.ts'])
  await ensureIndex('/project/wat', w.walker)
  assert.deepEqual(started, ['/project/wat'])
  // Ensure a second ensureIndex does not re-start the watcher.
  await ensureIndex('/project/wat', w.walker)
  assert.deepEqual(started, ['/project/wat'])
  dispose('/project/wat')
  assert.deepEqual(stopped, ['/project/wat'])
})

test('LRU evicts oldest unsubscribed entries when >8 are tracked', async () => {
  resetCache()
  for (let i = 0; i < 10; i += 1) {
    const w = makeWalker([`f${i}.ts`])
    // Space starts so lastTouched times differ.
    await ensureIndex(`/p/${i}`, w.walker)
    await new Promise((r) => setTimeout(r, 2))
  }
  const state = __getInternalStateForTest()
  assert.equal(state.size, 8, 'cache size is capped at 8')
  // The two oldest (indices 0 and 1) must have been evicted.
  assert.equal(state.snapshot('/p/0').status, 'idle', '/p/0 should have been evicted')
  assert.equal(state.snapshot('/p/1').status, 'idle', '/p/1 should have been evicted')
  assert.equal(state.snapshot('/p/9').status, 'ready', '/p/9 (most recent) still cached')
})

test('LRU respects subscribers — entries with listeners are not evicted', async () => {
  resetCache()
  // Pin /p/0 with a listener.
  const unsub = subscribe('/p/0', () => {})
  const w0 = makeWalker(['z.ts'])
  await ensureIndex('/p/0', w0.walker)
  // Fill up past the cap.
  for (let i = 1; i < 12; i += 1) {
    const w = makeWalker([`f${i}.ts`])
    await ensureIndex(`/p/${i}`, w.walker)
    await new Promise((r) => setTimeout(r, 1))
  }
  const state = __getInternalStateForTest()
  assert.equal(state.snapshot('/p/0').status, 'ready', 'subscribed entry must survive LRU')
  unsub()
})

test(
  'multi-tab scenario: two simulated Tabs, both searching the same project repeatedly, share ONE build',
  async () => {
    resetCache()
    const track: WalkerCall[] = []
    const w = makeWalker(
      Array.from({ length: 1000 }, (_, i) => `src/file${i}.ts`),
      { delayMs: 20, track }
    )
    // Tab A mounts, opens Cmd+P.
    const tabA_firstOpen = ensureIndex('/repo', w.walker)
    // Tab B mounts for the same project and opens Cmd+P at the same moment.
    const tabB_firstOpen = ensureIndex('/repo', w.walker)
    const [aList, bList] = await Promise.all([tabA_firstOpen, tabB_firstOpen])
    assert.equal(aList.length, 1000)
    assert.equal(bList.length, 1000)
    assert.equal(track.length, 1, 'both Tabs must share the same initial walker call')

    // Simulate each Tab typing a query 10 times: each keystroke reads the snapshot.
    for (let i = 0; i < 10; i += 1) {
      const snapA = getIndexSnapshot('/repo')
      const snapB = getIndexSnapshot('/repo')
      assert.equal(snapA.files.length, 1000)
      assert.equal(snapB.files.length, 1000)
    }
    // And re-trigger ensureIndex as each Tab re-opens the search.
    for (let i = 0; i < 5; i += 1) {
      await ensureIndex('/repo', w.walker)
      await ensureIndex('/repo', w.walker)
    }
    assert.equal(track.length, 1, 'no additional walker runs across 20 repeat opens')
  }
)

test('multi-project scenario: switching between projects never reloads the same cache twice', async () => {
  resetCache()
  const walkers: Record<string, { walker: (cwd: string) => Promise<string[]>; calls: number }> = {}
  for (const id of ['one', 'two', 'three']) {
    const w = makeWalker([`${id}/a.ts`, `${id}/b.ts`])
    walkers[id] = {
      walker: w.walker,
      get calls() {
        return w.calls
      }
    } as any
  }
  // User switches tabs 6 times across 3 projects.
  const sequence = ['one', 'two', 'three', 'one', 'two', 'three', 'one']
  for (const id of sequence) {
    await ensureIndex(`/repo/${id}`, walkers[id].walker)
  }
  for (const id of ['one', 'two', 'three']) {
    assert.equal(walkers[id].calls, 1, `project ${id} built exactly once across repeat visits`)
  }
})

test('invalidation during in-flight build does not let a stale walker overwrite newer state', async () => {
  resetCache()
  let firstWalkResolve: (value: string[]) => void = () => {}
  const firstWalk = new Promise<string[]>((resolve) => {
    firstWalkResolve = resolve
  })
  const walkerSlow = async (): Promise<string[]> => firstWalk
  const walkerFast = async (): Promise<string[]> => ['fast.ts']

  const slowBuild = ensureIndex('/p', walkerSlow)
  invalidate('/p')
  const fastBuild = await ensureIndex('/p', walkerFast)
  assert.deepEqual(fastBuild, ['fast.ts'])
  assert.deepEqual(getIndexSnapshot('/p').files, ['fast.ts'])

  // Now resolve the stale walker — it must NOT overwrite the newer ready state.
  firstWalkResolve(['stale.ts'])
  await slowBuild.catch(() => {})
  assert.deepEqual(getIndexSnapshot('/p').files, ['fast.ts'])
})
