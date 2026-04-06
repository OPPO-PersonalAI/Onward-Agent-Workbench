#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  })
}

function initRepo(repoRoot, files, commitMessage) {
  mkdirSync(repoRoot, { recursive: true })
  git(repoRoot, ['init'])
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(repoRoot, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }
  git(repoRoot, ['add', '.'])
  git(repoRoot, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit',
    '-m',
    commitMessage
  ])
}

function addSubmodule(repoRoot, sourceRepoRoot, targetPath) {
  git(repoRoot, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    pathToFileURL(sourceRepoRoot).href,
    targetPath
  ])
}

function commitAll(repoRoot, commitMessage) {
  git(repoRoot, ['add', '.'])
  git(repoRoot, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit',
    '-m',
    commitMessage
  ])
}

function appendLine(filePath, line) {
  appendFileSync(filePath, `${line}\n`, 'utf8')
}

const tempRoot = mkdtempSync(join(tmpdir(), 'onward-git-recursive-submodules-'))
const sourcesRoot = join(tempRoot, 'sources')
const workspaceRoot = join(tempRoot, 'workspace')

const betaRepo = join(sourcesRoot, 'beta')
const alphaRepo = join(sourcesRoot, 'alpha')
const gammaRepo = join(sourcesRoot, 'gamma')
const rootRepo = join(workspaceRoot, 'root')

initRepo(betaRepo, {
  'BETA.md': '# Beta\n\nBase fixture file.\n'
}, 'init beta')

initRepo(alphaRepo, {
  'ALPHA.md': '# Alpha\n\nBase fixture file.\n'
}, 'init alpha')
addSubmodule(alphaRepo, betaRepo, 'deps/beta')
commitAll(alphaRepo, 'add beta submodule')

initRepo(gammaRepo, {
  'GAMMA.md': '# Gamma\n\nBase fixture file.\n'
}, 'init gamma')

initRepo(rootRepo, {
  'README.md': '# Recursive Submodule Fixture\n'
}, 'init root')
addSubmodule(rootRepo, alphaRepo, 'modules/alpha')
addSubmodule(rootRepo, gammaRepo, 'modules/gamma')
commitAll(rootRepo, 'add nested submodules')
git(rootRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

appendLine(join(rootRepo, 'README.md'), 'root dirty change')
appendLine(join(rootRepo, 'modules', 'alpha', 'ALPHA.md'), 'alpha dirty change')
appendLine(join(rootRepo, 'modules', 'alpha', 'deps', 'beta', 'BETA.md'), 'beta nested dirty change')
appendLine(join(rootRepo, 'modules', 'gamma', 'GAMMA.md'), 'gamma dirty change')

process.stdout.write(JSON.stringify({
  tempRoot,
  repoRoot: rootRepo
}))
