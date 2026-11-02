/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/git-gitignore-watch-globs.test.mts
 *
 * Locks the .gitignore -> parcel-watcher ignore-glob converter that suppresses
 * gitignored-directory watcher storms.
 * The safety contract: directory patterns convert (negation-immune); file /
 * extension patterns and negations do NOT (could over-ignore real changes).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { gitignoreToWatchIgnoreGlobs } from '../../electron/main/git-gitignore-watch-globs.ts'

test('bare directory pattern -> root + any-depth globs', () => {
  const globs = gitignoreToWatchIgnoreGlobs('build/\n')
  assert.deepEqual(globs, ['build/**', '**/build/**'])
})

test('root-anchored directory (/build/) -> root-only glob', () => {
  const globs = gitignoreToWatchIgnoreGlobs('/build/\n')
  assert.deepEqual(globs, ['build/**'])
})

test('mid-path directory (tools/tests/output/) -> anchored glob, no **/ prefix', () => {
  const globs = gitignoreToWatchIgnoreGlobs('tools/tests/compare/output/\n')
  assert.deepEqual(globs, ['tools/tests/compare/output/**'])
})

test('file / extension patterns are NOT converted (negation-hazard avoidance)', () => {
  const globs = gitignoreToWatchIgnoreGlobs('*.raw\nserial_output.txt\nbuild_log.txt\n')
  assert.deepEqual(globs, [], 'no directory patterns -> no globs')
})

test('negation lines are skipped entirely (never produce an ignore)', () => {
  const globs = gitignoreToWatchIgnoreGlobs('build/\n!build/keep/\n')
  // The negated line must not add an ignore; the plain build/ still converts.
  assert.deepEqual(globs, ['build/**', '**/build/**'])
})

test('comments and blank lines are ignored', () => {
  const globs = gitignoreToWatchIgnoreGlobs('# QEMU output\n\n   \nbuild/\n# trailing comment\n')
  assert.deepEqual(globs, ['build/**', '**/build/**'])
})

test('char-class patterns are skipped for safety', () => {
  const globs = gitignoreToWatchIgnoreGlobs('build[0-9]/\n')
  assert.deepEqual(globs, [])
})

test('wildcard directory names are allowed (build_*/)', () => {
  const globs = gitignoreToWatchIgnoreGlobs('build_*/\n')
  assert.deepEqual(globs, ['build_*/**', '**/build_*/**'])
})

test('duplicates are de-duplicated', () => {
  const globs = gitignoreToWatchIgnoreGlobs('build/\nbuild/\n')
  assert.deepEqual(globs, ['build/**', '**/build/**'])
})

test('maxGlobs caps a pathological .gitignore', () => {
  const many = Array.from({ length: 500 }, (_, i) => `dir${i}/`).join('\n')
  const globs = gitignoreToWatchIgnoreGlobs(many, { maxGlobs: 10 })
  assert.ok(globs.length <= 10, `expected <=10, got ${globs.length}`)
})

test('realistic .gitignore excerpt: build dirs convert, file patterns do not', () => {
  const content = [
    'build/',
    'build_*/',
    'build-ut/',
    '*.raw',
    '# comment',
    'serial*.txt',
    'framebuffer.raw',
    'output/',
    'cmake_build/'
  ].join('\n')
  const globs = gitignoreToWatchIgnoreGlobs(content)
  // Directory patterns present:
  for (const dir of ['build', 'build_*', 'build-ut', 'output', 'cmake_build']) {
    assert.ok(globs.includes(`${dir}/**`), `missing ${dir}/**`)
    assert.ok(globs.includes(`**/${dir}/**`), `missing **/${dir}/**`)
  }
  // File patterns absent:
  assert.ok(!globs.some((g) => g.includes('.raw')), 'must not convert *.raw / framebuffer.raw')
  assert.ok(!globs.some((g) => g.includes('serial')), 'must not convert serial*.txt')
})
