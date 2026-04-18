/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration test for ProjectTreeWatchManager.
 *
 * Usage: node --experimental-strip-types --test test/project-tree-watch-manager.test.mts
 *
 * Spawns the manager over a real temp directory, issues file-system
 * mutations, and asserts that the debounced IPC payload carries the
 * expected added/removed lists.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, mkdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProjectTreeWatchManager } from '../electron/main/project-tree-watch-manager.ts'

interface CapturedEvent {
  channel: string
  payload: { cwd: string; added: string[]; removed: string[]; resync?: boolean }
}

function makeFakeWindow() {
  const events: CapturedEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: { cwd: string; added: string[]; removed: string[]; resync?: boolean }) => {
        events.push({ channel, payload })
      }
    }
  }
  return { win, events }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForEvent(events: CapturedEvent[], predicate: (event: CapturedEvent) => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = events.find(predicate)
    if (match) return match
    await sleep(50)
  }
  return null
}

test('emits an added event for a newly created file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-watch-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  // Give the watcher a moment to attach.
  await sleep(30)

  writeFileSync(join(dir, 'hello.ts'), 'console.log(1)\n')
  const match = await waitForEvent(events, (e) => e.payload.added.includes('hello.ts'))
  assert.ok(match, 'expected added event for hello.ts')
  assert.equal(match!.channel, 'project:tree-watch:event')

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('emits a removed event for a deleted file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-watch-'))
  writeFileSync(join(dir, 'victim.ts'), '// doomed\n')
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(30)

  unlinkSync(join(dir, 'victim.ts'))
  const match = await waitForEvent(events, (e) => e.payload.removed.includes('victim.ts'))
  assert.ok(match, 'expected removed event for victim.ts')

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('tracks changes inside nested subdirectories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-watch-nested-'))
  mkdirSync(join(dir, 'src'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(40)

  writeFileSync(join(dir, 'src', 'inner.ts'), 'export {}\n')
  const match = await waitForEvent(events, (e) =>
    e.payload.added.some((relPath) => relPath === 'src/inner.ts')
  )
  assert.ok(match, 'expected nested added event for src/inner.ts')

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('debounces rapid successive writes into a single flush', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-watch-burst-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(30)

  for (let i = 0; i < 5; i += 1) {
    writeFileSync(join(dir, `burst-${i}.ts`), String(i))
  }
  await sleep(300)
  // All 5 files should be present in the union of added payloads, and
  // since writes happened inside one debounce window we expect a single
  // flush — tolerate up to 2 flushes because fs.watch on macOS can
  // split identical-timestamp writes.
  const addedUnion = new Set<string>()
  for (const event of events) {
    for (const name of event.payload.added) addedUnion.add(name)
  }
  for (let i = 0; i < 5; i += 1) {
    assert.ok(addedUnion.has(`burst-${i}.ts`), `expected burst-${i}.ts in added union`)
  }
  assert.ok(events.length <= 2, `expected at most 2 flushes, saw ${events.length}`)

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('stop() silences further events and double-start is a no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-watch-stop-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  manager.start(dir) // double start — should be ignored without throwing.
  await sleep(30)

  writeFileSync(join(dir, 'pre-stop.ts'), '1')
  await sleep(250)
  const beforeStop = events.length

  manager.stop(dir)
  writeFileSync(join(dir, 'post-stop.ts'), '2')
  await sleep(300)
  assert.equal(events.length, beforeStop, 'no events must arrive after stop')

  rmSync(dir, { recursive: true, force: true })
})

test('starting a non-existent cwd does not throw and does not emit', async () => {
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  assert.doesNotThrow(() => manager.start(join(tmpdir(), 'onward-never-exists-12345')))
  await sleep(200)
  assert.equal(events.length, 0)
  manager.dispose()
})

test('dispose tears down all active watchers', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'onward-tree-dispose-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'onward-tree-dispose-b-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dirA)
  manager.start(dirB)
  await sleep(30)

  manager.dispose()
  writeFileSync(join(dirA, 'late-a.ts'), '1')
  writeFileSync(join(dirB, 'late-b.ts'), '2')
  await sleep(300)
  assert.equal(events.length, 0, 'dispose must silence both watchers')

  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

test('creating a bare directory does NOT surface the directory path as a file addition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-dir-add-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(40)

  mkdirSync(join(dir, 'empty-dir'))
  await sleep(350)
  const addedUnion = new Set<string>()
  for (const event of events) {
    for (const name of event.payload.added) addedUnion.add(name)
  }
  assert.ok(!addedUnion.has('empty-dir'), `directory path must not appear as added (saw: ${[...addedUnion].join(',')})`)

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('creating a directory pre-populated with files emits only the file entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-dir-prefill-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(40)

  // Create the tree in a sibling temp dir then atomically rename it into the
  // watched cwd. This simulates an external `mv` that drops a fully-populated
  // directory into the project.
  const staging = mkdtempSync(join(tmpdir(), 'onward-tree-dir-staging-'))
  mkdirSync(join(staging, 'pkg'))
  writeFileSync(join(staging, 'pkg', 'one.ts'), 'export {}')
  writeFileSync(join(staging, 'pkg', 'two.ts'), 'export {}')
  mkdirSync(join(staging, 'pkg', 'nested'))
  writeFileSync(join(staging, 'pkg', 'nested', 'three.ts'), 'export {}')
  renameSync(join(staging, 'pkg'), join(dir, 'pkg'))
  rmSync(staging, { recursive: true, force: true })

  await sleep(500)
  const added = new Set<string>()
  for (const event of events) {
    for (const name of event.payload.added) added.add(name)
  }
  assert.ok(!added.has('pkg'), 'bare directory path must not leak as an added file')
  // The walker should at minimum have surfaced the three inner files (fs.watch
  // itself may or may not have fired child events, so we rely on the
  // directory-expansion walk).
  assert.ok(added.has('pkg/one.ts'), `expected pkg/one.ts, saw: ${[...added].join(',')}`)
  assert.ok(added.has('pkg/two.ts'), `expected pkg/two.ts, saw: ${[...added].join(',')}`)
  assert.ok(added.has('pkg/nested/three.ts'), `expected pkg/nested/three.ts, saw: ${[...added].join(',')}`)

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('removing a directory cascades via a single removed entry (cache handles the prefix)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-dir-remove-'))
  mkdirSync(join(dir, 'doomed'))
  writeFileSync(join(dir, 'doomed', 'a.ts'), '1')
  writeFileSync(join(dir, 'doomed', 'b.ts'), '2')
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(40)

  rmSync(join(dir, 'doomed'), { recursive: true, force: true })
  await sleep(500)
  const removed = new Set<string>()
  for (const event of events) {
    for (const name of event.payload.removed) removed.add(name)
  }
  assert.ok(
    removed.has('doomed') || removed.has('doomed/a.ts') || removed.has('doomed/b.ts'),
    `expected at least one removed entry under doomed/, saw: ${[...removed].join(',')}`
  )

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('a null-filename event surfaces as a resync signal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-null-'))
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(40)

  // Drive the watcher's internal raw-event path directly with a null filename
  // so the test is deterministic across platforms (fs.watch only occasionally
  // emits null on macOS in practice).
  const internal = manager as unknown as {
    entries: Map<string, { disposed: boolean }>
    handleRawEvent: (fullPath: string, entry: unknown, raw: string | null) => void
  }
  const normalized = Object.keys(Object.fromEntries(internal.entries))[0]
  assert.ok(normalized, 'watcher entry must exist')
  const entry = internal.entries.get(normalized)
  assert.ok(entry, 'watcher entry must be present')
  internal.handleRawEvent(normalized, entry, null)

  const match = await waitForEvent(events, (e) => e.payload.resync === true, 1500)
  assert.ok(match, 'expected a resync event from null-filename raw input')

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})

test('rename within the watched tree reports removed+added on the two endpoints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onward-tree-rename-'))
  writeFileSync(join(dir, 'before.ts'), 'x')
  const { win, events } = makeFakeWindow()
  const manager = new ProjectTreeWatchManager(win as any)
  manager.start(dir)
  await sleep(40)

  renameSync(join(dir, 'before.ts'), join(dir, 'after.ts'))
  await sleep(350)
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const event of events) {
    for (const name of event.payload.added) added.add(name)
    for (const name of event.payload.removed) removed.add(name)
  }
  assert.ok(removed.has('before.ts'), 'old name must appear as removed')
  assert.ok(added.has('after.ts'), 'new name must appear as added')

  manager.stop(dir)
  rmSync(dir, { recursive: true, force: true })
})
