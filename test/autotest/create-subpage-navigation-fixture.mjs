#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))

function parseOutputDir(argv) {
  const outputIndex = argv.indexOf('--output')
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : null
  if (!output?.trim()) {
    throw new Error('Usage: node create-subpage-navigation-fixture.mjs --output <directory>')
  }
  return resolve(output)
}

const outputDir = parseOutputDir(process.argv.slice(2))
const fixtureRepo = join(outputDir, 'repo')
const fixtureRepoB = join(outputDir, 'repo-b')
const fixtureNestedRepo = join(fixtureRepo, 'nested-repo')
const navigationFixtureDir = join(scriptDir, 'fixtures', 'subpage-navigation')
const richFixtureDir = join(scriptDir, 'fixtures', 'pdf-epub')
const COLD_RICH_TRIALS = 5

const GIT_SHARED_CONFIG = [
  '-c', 'user.name=Onward AutoTest',
  '-c', 'user.email=autotest@example.com',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false'
]

async function git(repo, args) {
  const { stdout } = await execFileAsync('git', [...GIT_SHARED_CONFIG, ...args], {
    cwd: repo,
    encoding: 'utf8'
  })
  return stdout.trim()
}

async function initializeRepo(repo) {
  mkdirSync(repo, { recursive: true })
  await git(repo, ['init', '--quiet'])
  appendFileSync(
    join(repo, '.git', 'config'),
    '\n[user]\n\tname = Onward AutoTest\n\temail = autotest@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n',
    'utf8'
  )
  writeFileSync(join(repo, '.gitattributes'), '* -text\n', 'utf8')
}

function copyFixture(sourceName, targetName, sourceDir = navigationFixtureDir, repo = fixtureRepo) {
  const targetPath = join(repo, targetName)
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(join(sourceDir, sourceName), targetPath)
}

function copyColdRichFixtures(variant) {
  const fixtures = variant === 'working'
    ? [
        ['html', 'navigate.working.html', navigationFixtureDir],
        ['pdf', 'onward-autotest.navigation.pdf', richFixtureDir],
        ['epub', 'onward-autotest.alt.epub', richFixtureDir]
      ]
    : [
        ['html', 'navigate.base.html', navigationFixtureDir],
        ['pdf', 'onward-autotest.pdf', richFixtureDir],
        ['epub', 'onward-autotest.epub', richFixtureDir]
      ]
  for (const source of ['diff', 'history']) {
    for (let trial = 1; trial <= COLD_RICH_TRIALS; trial += 1) {
      for (const [extension, sourceName, sourceDir] of fixtures) {
        copyFixture(sourceName, `cold-${source}-${trial}.${extension}`, sourceDir)
      }
    }
  }
}

async function commit(repo, message) {
  await git(repo, ['add', '--all'])
  await git(repo, ['commit', '--quiet', '-m', message])
  return await git(repo, ['rev-parse', 'HEAD'])
}

async function setupNestedRepo() {
  await initializeRepo(fixtureNestedRepo)
  copyFixture('nested-target.base.ts', 'nested-target.ts', navigationFixtureDir, fixtureNestedRepo)
  return await commit(fixtureNestedRepo, 'base nested navigation fixture')
}

async function setupPrimaryAndNestedRepos() {
  const [, nestedBaseCommit] = await Promise.all([
    (async () => {
      await initializeRepo(fixtureRepo)
      writeFileSync(join(fixtureRepo, 'existing.md'), '# existing\nline1\nline2\n', 'utf8')
      writeFileSync(join(fixtureRepo, 'history-deleted.md'), '# history deleted\n', 'utf8')
      writeFileSync(join(fixtureRepo, 'diff-deleted.md'), '# diff deleted\n', 'utf8')
      writeFileSync(join(fixtureRepo, 'editor-only.md'), '# editor only\n', 'utf8')
      writeFileSync(join(fixtureRepo, 'rename-original.txt'), 'NAVIGATION_RENAME_BASE\n', 'utf8')
      copyFixture('navigate.base.ts', 'navigate.ts')
      copyFixture('navigate.base.html', 'navigate.html')
      copyFixture('navigate.base.css', join('navigation-assets', 'navigation.css'))
      copyFixture('navigate.base.js', join('navigation-assets', 'navigation.js'))
      copyFixture('dual-state.base.ts', 'dual-state.ts')
      copyFixture('scroll-state.base.ts', 'scroll-state.ts')
      copyFixture('onward-autotest.pdf', 'navigate.pdf', richFixtureDir)
      copyFixture('onward-autotest.epub', 'navigate.epub', richFixtureDir)
      copyColdRichFixtures('base')
    })(),
    setupNestedRepo()
  ])

  await git(fixtureRepo, ['add', '--all'])
  await git(fixtureRepo, ['commit', '--quiet', '-m', 'base navigation fixture'])

  writeFileSync(join(fixtureRepo, 'existing.md'), '# existing\nline1\nline2\ncommitted\n', 'utf8')
  await git(fixtureRepo, ['commit', '-a', '--quiet', '-m', 'update existing file'])

  await git(fixtureRepo, ['rm', '--quiet', 'history-deleted.md'])
  await git(fixtureRepo, ['commit', '--quiet', '-m', 'delete history file'])

  const [deleteCommit, updateCommit, baseCommit] = (
    await git(fixtureRepo, ['log', '-n', '3', '--format=%H'])
  ).split(/\r?\n/)

  writeFileSync(join(fixtureRepo, 'existing.md'), '# existing\nline1\nline2\ncommitted\nworking tree\n', 'utf8')
  rmSync(join(fixtureRepo, 'diff-deleted.md'))
  copyFixture('navigate.working.ts', 'navigate.ts')
  copyFixture('navigate.working.html', 'navigate.html')
  copyFixture('navigate.working.css', join('navigation-assets', 'navigation.css'))
  copyFixture('navigate.working.js', join('navigation-assets', 'navigation.js'))
  copyFixture('onward-autotest.navigation.pdf', 'navigate.pdf', richFixtureDir)
  copyFixture('onward-autotest.alt.epub', 'navigate.epub', richFixtureDir)
  copyColdRichFixtures('working')
  writeFileSync(join(fixtureRepo, 'added-navigation.txt'), 'NAVIGATION_ADDED_FILE\n', 'utf8')
  writeFileSync(join(fixtureRepo, 'untracked-navigation.txt'), 'NAVIGATION_UNTRACKED_FILE\n', 'utf8')
  writeFileSync(join(fixtureRepo, 'staged-missing.ts'), 'STAGED_FILE_REMOVED_FROM_WORKTREE\n', 'utf8')
  copyFixture('dual-state.staged.ts', 'dual-state.ts')
  await git(fixtureRepo, ['add', 'added-navigation.txt', 'staged-missing.ts', 'dual-state.ts'])
  rmSync(join(fixtureRepo, 'staged-missing.ts'))
  await git(fixtureRepo, ['mv', 'rename-original.txt', 'rename-current.txt'])
  copyFixture('dual-state.working.ts', 'dual-state.ts')
  copyFixture('scroll-state.working.ts', 'scroll-state.ts')
  copyFixture('nested-target.working.ts', 'nested-target.ts', navigationFixtureDir, fixtureNestedRepo)

  return { baseCommit, updateCommit, deleteCommit, nestedBaseCommit }
}

async function setupRepoB() {
  await initializeRepo(fixtureRepoB)
  copyFixture('cross-root-old.ts', 'cross-root-old.ts', navigationFixtureDir, fixtureRepoB)
  copyFixture('cross-root-target.base.ts', 'cross-root-target.ts', navigationFixtureDir, fixtureRepoB)
  const repoBBaseCommit = await commit(fixtureRepoB, 'base cross-root navigation fixture')
  copyFixture('cross-root-target.working.ts', 'cross-root-target.ts', navigationFixtureDir, fixtureRepoB)
  return repoBBaseCommit
}

rmSync(fixtureRepo, { recursive: true, force: true })
rmSync(fixtureRepoB, { recursive: true, force: true })

const [{ baseCommit, updateCommit, deleteCommit, nestedBaseCommit }, repoBBaseCommit] = await Promise.all([
  setupPrimaryAndNestedRepos(),
  setupRepoB()
])

const manifest = {
  fixtureRepo,
  fixtureRepoB,
  commits: {
    base: baseCommit,
    update: updateCommit,
    delete: deleteCommit,
    repoBBase: repoBBaseCommit,
    nestedBase: nestedBaseCommit
  },
  files: {
    code: 'navigate.ts',
    html: 'navigate.html',
    pdf: 'navigate.pdf',
    epub: 'navigate.epub',
    dualState: 'dual-state.ts',
    stagedMissing: 'staged-missing.ts'
  },
  coldRichTrials: COLD_RICH_TRIALS,
  crossRoot: {
    repoB: fixtureRepoB,
    oldPath: 'cross-root-old.ts',
    targetPath: 'cross-root-target.ts'
  },
  nested: {
    repo: fixtureNestedRepo,
    targetPath: 'nested-target.ts'
  }
}

writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(manifest)}\n`)
