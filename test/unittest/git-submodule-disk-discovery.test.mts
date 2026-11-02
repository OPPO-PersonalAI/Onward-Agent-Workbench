/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-submodule-disk-discovery.test.mts
 *
 * Pins the pure, filesystem-only submodule discovery that replaced the
 * fork-heavy `git submodule status --recursive` on the Git-Diff hot path.
 * This locks the structural math (which submodules exist, initialized vs
 * deinit-ed, depth / parentRoot nesting) without spawning git or building
 * Electron — its autotest counterpart (run-git-diff-submodules /
 * run-git-diff-recursive-submodules) proves the end-to-end wiring against a
 * real git repo.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  collectSubmoduleSnapshotsFromDisk,
  isGitWorktreeRoot,
  parseGitlinkPathsFromLsFilesZ,
  readGitmodulesSubmodulePaths
} from '../../electron/main/git-submodule-disk-discovery.ts'

/** Forward-slash normalize, matching the discovery's cross-platform output contract. */
const norm = (p: string): string => p.replace(/\\/g, '/')

function gitmodules(...entries: Array<{ name: string; path: string }>): string {
  return entries
    .map((e) => `[submodule "${e.name}"]\n\tpath = ${e.path}\n\turl = https://example.invalid/${e.name}.git\n`)
    .join('')
}

/**
 * Build a fixture repo tree on disk:
 *   root/.gitmodules               -> declares sub-a, sub-b
 *   root/sub-a/.git (gitfile)      -> initialized submodule
 *   root/sub-a/.gitmodules         -> declares nested
 *   root/sub-a/nested/.git (dir)   -> initialized nested submodule
 *   root/sub-b/                    -> declared but NOT initialized (deinit shape)
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'onward-submodule-disc-'))
  writeFileSync(join(root, '.gitmodules'), gitmodules(
    { name: 'sub-a', path: 'sub-a' },
    { name: 'sub-b', path: 'sub-b' }
  ))

  // sub-a: initialized via a gitfile (the standard submodule layout).
  mkdirSync(join(root, 'sub-a'), { recursive: true })
  writeFileSync(join(root, 'sub-a', '.git'), 'gitdir: ../.git/modules/sub-a\n')
  writeFileSync(join(root, 'sub-a', '.gitmodules'), gitmodules(
    { name: 'nested', path: 'nested' }
  ))

  // sub-a/nested: initialized via a real .git directory (legacy layout).
  mkdirSync(join(root, 'sub-a', 'nested', '.git'), { recursive: true })

  // sub-b: declared in .gitmodules but the working tree is empty (deinit).
  mkdirSync(join(root, 'sub-b'), { recursive: true })

  return root
}

// ---------------------------------------------------------------------------
// readGitmodulesSubmodulePaths
// ---------------------------------------------------------------------------

test('readGitmodulesSubmodulePaths parses paths, skips comments, normalizes separators', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitmodules-'))
  try {
    writeFileSync(join(root, '.gitmodules'),
      '# a comment\n; another\n[submodule "x"]\n\tpath = vendor\\x\n\turl = u\n[submodule "y"]\n\tpath = y\n')
    const paths = await readGitmodulesSubmodulePaths(root)
    assert.deepEqual(paths, ['vendor/x', 'y'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readGitmodulesSubmodulePaths returns [] when .gitmodules is absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitmodules-none-'))
  try {
    assert.deepEqual(await readGitmodulesSubmodulePaths(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// isGitWorktreeRoot
// ---------------------------------------------------------------------------

test('isGitWorktreeRoot: true for .git directory, true for gitfile, false otherwise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-worktree-'))
  try {
    const dirCase = join(root, 'dir-case')
    mkdirSync(join(dirCase, '.git'), { recursive: true })
    assert.equal(await isGitWorktreeRoot(dirCase), true)

    const fileCase = join(root, 'file-case')
    mkdirSync(fileCase, { recursive: true })
    writeFileSync(join(fileCase, '.git'), 'gitdir: ../.git/modules/file-case\n')
    assert.equal(await isGitWorktreeRoot(fileCase), true)

    const plainFile = join(root, 'plain-case')
    mkdirSync(plainFile, { recursive: true })
    writeFileSync(join(plainFile, '.git'), 'this is not a gitfile\n')
    assert.equal(await isGitWorktreeRoot(plainFile), false)

    const emptyCase = join(root, 'empty-case')
    mkdirSync(emptyCase, { recursive: true })
    assert.equal(await isGitWorktreeRoot(emptyCase), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// collectSubmoduleSnapshotsFromDisk
// ---------------------------------------------------------------------------

test('collectSubmoduleSnapshotsFromDisk discovers direct + nested, flags deinit, computes depth/parent', async () => {
  const root = makeFixture()
  try {
    const snaps = await collectSubmoduleSnapshotsFromDisk(root)
    const byPath = new Map(snaps.map((s) => [s.path, s]))

    // Three submodules discovered, sorted lexicographically.
    assert.deepEqual(snaps.map((s) => s.path), ['sub-a', 'sub-a/nested', 'sub-b'])

    const subA = byPath.get('sub-a')!
    assert.equal(subA.initialized, true)
    assert.equal(subA.isValidRepo, true)
    assert.equal(subA.depth, 0)
    // Output paths are forward-slash normalized on every platform.
    assert.equal(subA.parentRoot, norm(resolve(root)))
    assert.equal(subA.absolutePath, norm(resolve(root, 'sub-a')))
    assert.ok(!subA.absolutePath.includes('\\'), 'absolutePath must not contain a backslash')
    assert.equal(subA.declaredInGitmodules, true)

    const nested = byPath.get('sub-a/nested')!
    assert.equal(nested.initialized, true)
    assert.equal(nested.isValidRepo, true)
    assert.equal(nested.depth, 1)
    assert.equal(nested.parentRoot, norm(resolve(root, 'sub-a')))
    assert.equal(nested.absolutePath, norm(resolve(root, 'sub-a', 'nested')))

    // Deinit-ed submodule: declared, but empty working tree → not valid.
    const subB = byPath.get('sub-b')!
    assert.equal(subB.initialized, false)
    assert.equal(subB.isValidRepo, false)
    assert.equal(subB.depth, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectSubmoduleSnapshotsFromDisk returns [] for a repo with no .gitmodules', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-no-subs-'))
  try {
    assert.deepEqual(await collectSubmoduleSnapshotsFromDisk(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectSubmoduleSnapshotsFromDisk does not recurse into a deinit-ed submodule', async () => {
  // Even if a deinit-ed path somehow carries a .gitmodules, it has no .git so
  // we must not descend into it (it is not a checked-out repo).
  const root = mkdtempSync(join(tmpdir(), 'onward-no-recurse-'))
  try {
    writeFileSync(join(root, '.gitmodules'), gitmodules({ name: 'ghost', path: 'ghost' }))
    mkdirSync(join(root, 'ghost'), { recursive: true })
    // .gitmodules present but NO .git → not initialized.
    writeFileSync(join(root, 'ghost', '.gitmodules'), gitmodules({ name: 'inner', path: 'inner' }))
    const snaps = await collectSubmoduleSnapshotsFromDisk(root)
    assert.deepEqual(snaps.map((s) => s.path), ['ghost'])
    assert.equal(snaps[0].initialized, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// parseGitlinkPathsFromLsFilesZ — pure parse of `git ls-files -s -z` output.
// A gitlink is mode 160000; everything else (blobs/exec/symlink) is ignored.
// `-z` makes records NUL-separated; each record is `<mode> <sha> <stage>\t<path>`.
// ---------------------------------------------------------------------------

const SHA = '471bf8f966ccc0deb85bf6cfbcea27a4cdc7209d'
/** Build a NUL-separated `ls-files -s -z` blob; trailingNul mirrors real git. */
function lsFilesZ(entries: Array<{ mode: string; path: string }>, trailingNul = true): string {
  const body = entries.map((e) => `${e.mode} ${SHA} 0\t${e.path}`).join('\0')
  return trailingNul && entries.length > 0 ? `${body}\0` : body
}

test('parseGitlinkPathsFromLsFilesZ: empty input → []', () => {
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(''), [])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ('\0'), [])
})

test('parseGitlinkPathsFromLsFilesZ: no gitlinks among plain blobs → []', () => {
  const out = lsFilesZ([
    { mode: '100644', path: 'README.md' },
    { mode: '100755', path: 'scripts/build.sh' },
    { mode: '120000', path: 'link' }
  ])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), [])
})

test('parseGitlinkPathsFromLsFilesZ: single gitlink', () => {
  const out = lsFilesZ([{ mode: '160000', path: 'application' }])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['application'])
})

test('parseGitlinkPathsFromLsFilesZ: many gitlinks interleaved with blobs, order preserved', () => {
  const out = lsFilesZ([
    { mode: '100644', path: 'CLAUDE.md' },
    { mode: '160000', path: 'application' },
    { mode: '100644', path: 'README.md' },
    { mode: '160000', path: 'buildtools' },
    { mode: '160000', path: 'toolchains' }
  ])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['application', 'buildtools', 'toolchains'])
})

test('parseGitlinkPathsFromLsFilesZ: path with spaces is kept whole (TAB delimits, not space)', () => {
  const out = lsFilesZ([{ mode: '160000', path: 'vendor/my sub module' }])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['vendor/my sub module'])
})

test('parseGitlinkPathsFromLsFilesZ: deep nested gitlink path is preserved', () => {
  const out = lsFilesZ([{ mode: '160000', path: 'a/b/c/deep' }])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['a/b/c/deep'])
})

test('parseGitlinkPathsFromLsFilesZ: backslashes normalized to forward slash', () => {
  // -z never emits backslashes, but normalize defensively for cross-platform parity.
  const out = lsFilesZ([{ mode: '160000', path: 'vendor\\win\\sub' }])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['vendor/win/sub'])
})

test('parseGitlinkPathsFromLsFilesZ: a path that merely contains "160000" is not a false mode', () => {
  // The mode anchor is the record PREFIX; "160000" living after the TAB must
  // not be mistaken for a gitlink mode.
  const out = lsFilesZ([
    { mode: '100644', path: 'data/160000.bin' },
    { mode: '160000', path: 'real-sub' }
  ])
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['real-sub'])
})

test('parseGitlinkPathsFromLsFilesZ: tolerates missing trailing NUL', () => {
  const out = lsFilesZ([{ mode: '160000', path: 'application' }], /* trailingNul */ false)
  assert.deepEqual(parseGitlinkPathsFromLsFilesZ(out), ['application'])
})

// ---------------------------------------------------------------------------
// collectSubmoduleSnapshotsFromDisk — extraGitlinkPaths (no-.gitmodules gitlinks)
// ---------------------------------------------------------------------------

/** Create `root/<rel>` with a real `.git` directory → a valid nested repo. */
function makeNestedRepo(root: string, rel: string): void {
  mkdirSync(join(root, rel, '.git'), { recursive: true })
}

test('extraGitlinkPaths: gitlinks with NO .gitmodules become valid repos', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-only-'))
  try {
    makeNestedRepo(root, 'application')
    makeNestedRepo(root, 'buildtools')
    makeNestedRepo(root, 'toolchains')
    const snaps = await collectSubmoduleSnapshotsFromDisk(root, {
      extraGitlinkPaths: ['application', 'buildtools', 'toolchains']
    })
    assert.deepEqual(snaps.map((s) => s.path), ['application', 'buildtools', 'toolchains'])
    for (const s of snaps) {
      assert.equal(s.declaredInGitmodules, false, `${s.path} is a gitlink, not .gitmodules-declared`)
      assert.equal(s.initialized, true)
      assert.equal(s.isValidRepo, true)
      assert.equal(s.depth, 0)
      assert.equal(s.parentRoot, norm(resolve(root)))
      assert.ok(!s.absolutePath.includes('\\'), 'absolutePath must be forward-slash')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraGitlinkPaths: a path also declared in .gitmodules is NOT duplicated (declared wins)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-overlap-'))
  try {
    writeFileSync(join(root, '.gitmodules'), gitmodules({ name: 'sub-a', path: 'sub-a' }))
    mkdirSync(join(root, 'sub-a'), { recursive: true })
    writeFileSync(join(root, 'sub-a', '.git'), 'gitdir: ../.git/modules/sub-a\n')
    // The index lists sub-a (every submodule is also a gitlink) PLUS an
    // undeclared gitlink `vendor-x`.
    makeNestedRepo(root, 'vendor-x')
    const snaps = await collectSubmoduleSnapshotsFromDisk(root, {
      extraGitlinkPaths: ['sub-a', 'vendor-x']
    })
    assert.deepEqual(snaps.map((s) => s.path), ['sub-a', 'vendor-x'])
    const byPath = new Map(snaps.map((s) => [s.path, s]))
    // sub-a stayed the declared entry — no second gitlink-only copy.
    assert.equal(byPath.get('sub-a')!.declaredInGitmodules, true)
    assert.equal(byPath.get('vendor-x')!.declaredInGitmodules, false)
    assert.equal(byPath.get('vendor-x')!.isValidRepo, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraGitlinkPaths: a gitlink whose working tree is not checked out is initialized=false', async () => {
  // Parent index records mode 160000 but the path on disk has no .git (the
  // submodule was never `git submodule update`-d). It must surface but be
  // flagged invalid so isValidRepo consumers (Diff/History) skip it.
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-uninit-'))
  try {
    mkdirSync(join(root, 'uninit'), { recursive: true }) // empty dir, no .git
    const snaps = await collectSubmoduleSnapshotsFromDisk(root, {
      extraGitlinkPaths: ['uninit']
    })
    assert.deepEqual(snaps.map((s) => s.path), ['uninit'])
    assert.equal(snaps[0].declaredInGitmodules, false)
    assert.equal(snaps[0].initialized, false)
    assert.equal(snaps[0].isValidRepo, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraGitlinkPaths: mixed declared + gitlink-only, sorted and flagged independently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-mixed-'))
  try {
    writeFileSync(join(root, '.gitmodules'), gitmodules({ name: 'declared', path: 'declared' }))
    mkdirSync(join(root, 'declared', '.git'), { recursive: true })
    makeNestedRepo(root, 'zeta-gitlink')
    makeNestedRepo(root, 'alpha-gitlink')
    const snaps = await collectSubmoduleSnapshotsFromDisk(root, {
      extraGitlinkPaths: ['zeta-gitlink', 'alpha-gitlink']
    })
    // Lexicographic order across both classes.
    assert.deepEqual(snaps.map((s) => s.path), ['alpha-gitlink', 'declared', 'zeta-gitlink'])
    const byPath = new Map(snaps.map((s) => [s.path, s]))
    assert.equal(byPath.get('declared')!.declaredInGitmodules, true)
    assert.equal(byPath.get('alpha-gitlink')!.declaredInGitmodules, false)
    assert.equal(byPath.get('zeta-gitlink')!.declaredInGitmodules, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraGitlinkPaths: undefined / empty options preserves existing behavior (regression)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-none-'))
  try {
    makeNestedRepo(root, 'should-not-appear') // a nested repo but NOT passed as a gitlink
    assert.deepEqual(await collectSubmoduleSnapshotsFromDisk(root), [])
    assert.deepEqual(await collectSubmoduleSnapshotsFromDisk(root, {}), [])
    assert.deepEqual(await collectSubmoduleSnapshotsFromDisk(root, { extraGitlinkPaths: [] }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraGitlinkPaths: trailing slashes and backslashes are normalized, dedup-safe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-norm-'))
  try {
    makeNestedRepo(root, 'sub')
    const snaps = await collectSubmoduleSnapshotsFromDisk(root, {
      // Same logical path three ways — must collapse to one normalized entry.
      extraGitlinkPaths: ['sub/', 'sub', 'sub\\']
    })
    assert.deepEqual(snaps.map((s) => s.path), ['sub'])
    assert.equal(snaps[0].isValidRepo, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraGitlinkPaths: deep gitlink path nested under a declared submodule gets correct depth/parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onward-gitlink-deep-'))
  try {
    // declared submodule `outer` (initialized), with an undeclared gitlink at
    // outer/inner that the parent index lists as a deep 160000 path.
    writeFileSync(join(root, '.gitmodules'), gitmodules({ name: 'outer', path: 'outer' }))
    mkdirSync(join(root, 'outer', '.git'), { recursive: true })
    makeNestedRepo(root, 'outer/inner')
    const snaps = await collectSubmoduleSnapshotsFromDisk(root, {
      extraGitlinkPaths: ['outer/inner']
    })
    assert.deepEqual(snaps.map((s) => s.path), ['outer', 'outer/inner'])
    const inner = snaps.find((s) => s.path === 'outer/inner')!
    assert.equal(inner.declaredInGitmodules, false)
    assert.equal(inner.depth, 1)
    assert.equal(inner.parentRoot, norm(resolve(root, 'outer')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
