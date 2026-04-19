#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'child_process'
import { rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-nested-submodules')
const runtimeRoot = join(fixtureRoot, 'runtime')
const sourcesRoot = join(runtimeRoot, 'sources')
const workspaceRoot = join(runtimeRoot, 'workspace')
const rootRepo = join(workspaceRoot, 'root')

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

function write(repoRoot, relativePath, content) {
  const filePath = join(repoRoot, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function append(repoRoot, relativePath, content) {
  appendFileSync(join(repoRoot, relativePath), content, 'utf8')
}

function commitAll(repoRoot, message) {
  git(repoRoot, ['add', '.'])
  git(repoRoot, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit',
    '-m',
    message
  ])
}

function initRepo(repoRoot, level) {
  mkdirSync(repoRoot, { recursive: true })
  git(repoRoot, ['init'])
  write(repoRoot, `level-${level}.txt`, `level ${level} base\n`)
  commitAll(repoRoot, `level-${level}: initial commit`)
  append(repoRoot, `level-${level}.txt`, `level ${level} committed update\n`)
  commitAll(repoRoot, `level-${level}: committed update`)
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

function ensureFixture() {
  mkdirSync(fixtureRoot, { recursive: true })
  rmSync(runtimeRoot, { recursive: true, force: true })
  mkdirSync(sourcesRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })

  const levelRoots = new Map()
  for (let level = 5; level >= 1; level -= 1) {
    const repoRoot = join(sourcesRoot, `level-${level}`)
    initRepo(repoRoot, level)
    const childRoot = levelRoots.get(level + 1)
    if (childRoot) {
      addSubmodule(repoRoot, childRoot, `deps/level-${level + 1}`)
      commitAll(repoRoot, `level-${level}: add level-${level + 1} submodule`)
      git(repoRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])
    }
    levelRoots.set(level, repoRoot)
  }

  mkdirSync(rootRepo, { recursive: true })
  git(rootRepo, ['init'])
  write(rootRepo, 'root-owned.txt', 'root base\n')
  commitAll(rootRepo, 'root: initial commit')
  append(rootRepo, 'root-owned.txt', 'root committed update\n')
  commitAll(rootRepo, 'root: committed update')
  addSubmodule(rootRepo, levelRoots.get(1), 'modules/level-1')
  commitAll(rootRepo, 'root: add level-1 submodule')
  git(rootRepo, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive'])

  append(rootRepo, 'root-owned.txt', 'root dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'level-1.txt'), 'level 1 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'level-2.txt'), 'level 2 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'level-3.txt'), 'level 3 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'deps', 'level-4', 'level-4.txt'), 'level 4 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'deps', 'level-4', 'deps', 'level-5', 'level-5.txt'), 'level 5 dirty worktree change\n')

  write(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'level-2-untracked.txt'), 'level 2 untracked file\n')
  write(rootRepo, 'root-untracked.txt', 'root untracked file\n')
}

ensureFixture()

const levelPaths = {}
let nestedPath = join(rootRepo, 'modules', 'level-1')
for (let level = 1; level <= 5; level += 1) {
  levelPaths[`level${level}`] = nestedPath
  nestedPath = join(nestedPath, 'deps', `level-${level + 1}`)
}

if (!existsSync(rootRepo)) {
  throw new Error(`Fixture root was not created: ${rootRepo}`)
}

process.stdout.write(JSON.stringify({
  fixtureRoot,
  runtimeRoot,
  repoRoot: rootRepo,
  levelPaths
}))
