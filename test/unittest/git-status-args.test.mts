/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-status-args.test.mts
 *
 * Locks the pure `git status --porcelain=2` argument builder shared by the Git
 * Diff path and the GitStateMirror worker. Both heavy status callers MUST emit
 * `--ignore-submodules=dirty` so the superproject status no longer recursively
 * walks submodule working trees, WITHOUT losing the commit-pointer signal.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildGitStatusPorcelainArgs } from '../../electron/main/git-status-args.ts'

test('diff-path status args: -z + find-renames + untracked=all + ignore-submodules=dirty', () => {
  const args = buildGitStatusPorcelainArgs({ z: true, findRenames: 50, untracked: 'all', ignoreSubmodules: 'dirty' })
  assert.deepEqual(args, [
    '-c', 'core.quotepath=false', 'status', '--porcelain=2',
    '-z', '--find-renames=50', '--untracked-files=all', '--ignore-submodules=dirty'
  ])
})

test('mirror status args: branch + -z + untracked=all + ignore-submodules=dirty', () => {
  const args = buildGitStatusPorcelainArgs({ branch: true, z: true, untracked: 'all', ignoreSubmodules: 'dirty' })
  assert.deepEqual(args, [
    '-c', 'core.quotepath=false', 'status', '--porcelain=2',
    '--branch', '-z', '--untracked-files=all', '--ignore-submodules=dirty'
  ])
})

test('ignore-submodules is OMITTED when not requested (no behavior change for other callers)', () => {
  const args = buildGitStatusPorcelainArgs({ branch: true, untracked: 'all' })
  assert.ok(!args.some((a) => a.startsWith('--ignore-submodules')), 'must not append ignore-submodules by default')
  assert.deepEqual(args, ['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--branch', '--untracked-files=all'])
})

test('untracked defaults to all; find-renames omitted when not a number', () => {
  const args = buildGitStatusPorcelainArgs({})
  assert.deepEqual(args, ['-c', 'core.quotepath=false', 'status', '--porcelain=2', '--untracked-files=all'])
  assert.ok(!args.some((a) => a.startsWith('--find-renames')))
})

test('untracked=no is honored (e.g. cheap branch-only status)', () => {
  const args = buildGitStatusPorcelainArgs({ branch: true, untracked: 'no' })
  assert.ok(args.includes('--untracked-files=no'))
})

test('each ignore-submodules level renders verbatim', () => {
  for (const level of ['none', 'untracked', 'dirty', 'all'] as const) {
    const args = buildGitStatusPorcelainArgs({ ignoreSubmodules: level })
    assert.ok(args.includes(`--ignore-submodules=${level}`), `level ${level}`)
  }
})
