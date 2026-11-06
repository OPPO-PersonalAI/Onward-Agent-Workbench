#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'child_process'
import { rmSync, mkdirSync, writeFileSync, appendFileSync, existsSync, realpathSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath, pathToFileURL } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-nested-submodules')
// Belt-and-braces for Windows MAX_PATH (260): the 5-deep recursive-submodule
// layout produces a ~277-char .git/modules/.../objects/pack/*.keep path when
// rooted under the deep repo tree, which makes git fail with "Filename too
// long" before any product code runs. Relocate the runtime root to a SHORT
// OS-temp base to cut ~95 chars off the prefix; cleanup-on-exit still applies.
//
// canonicalTempBase() resolves the OS-temp base to its REAL path so the emitted
// fixture paths match the git backend's realpath-resolved repo roots. The test does
// strict absolute-path equality between ctx.rootPath-derived expected paths and
// backend paths, so the two must agree on the canonical form. Per platform:
//   - macOS:   tmpdir() is the unresolved /var symlink (/var/folders/...) while git
//              reports /private/var/folders/...; realpath bridges the two. (the bug)
//   - Windows: tmpdir() may be an 8.3 short name (e.g. C:\Users\RUNNER~1\...); realpath
//              expands it to the long form git also reports. Still well under MAX_PATH
//              (260) after the ~95-char relocation above; path separators are reconciled
//              downstream by the test's normalizePath (\\ -> /). No .ps1 change needed —
//              both runners invoke THIS shared .mjs and read .repoRoot.
//   - Linux:   /tmp is normally not a symlink -> realpath is an effective no-op.
// The try/catch falls back to the raw temp base if realpath ever fails (locked-down /
// redirected TEMP, exotic FS), guaranteeing this is never WORSE than the pre-
// canonicalization behavior on any platform.
function canonicalTempBase() {
  const base = tmpdir()
  try {
    return realpathSync(base)
  } catch {
    return base
  }
}
const runtimeRoot = join(canonicalTempBase(), 'onward-gns')
const sourcesRoot = join(runtimeRoot, 'sources')
const workspaceRoot = join(runtimeRoot, 'workspace')
const rootRepo = join(workspaceRoot, 'root')

// Shared git args injected into EVERY spawn so the deep submodule chain never
// trips MAX_PATH and file:// submodule URLs are always permitted.
const GIT_SHARED_CONFIG = [
  '-c', 'user.name=Onward AutoTest',
  '-c', 'user.email=autotest@onward.local',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'core.longpaths=true',
  '-c', 'protocol.file.allow=always'
]

async function git(cwd, args) {
  await execFileAsync('git', [...GIT_SHARED_CONFIG, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0'
    }
  })
}

function pinRepoConfig(repoRoot) {
  const gitConfigPath = join(repoRoot, '.git', 'config')
  if (existsSync(gitConfigPath)) {
    appendFileSync(
      gitConfigPath,
      '\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n\tlongpaths = true\n',
      'utf8'
    )
  }
}

function write(repoRoot, relativePath, content) {
  const filePath = join(repoRoot, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf8')
}

function append(repoRoot, relativePath, content) {
  appendFileSync(join(repoRoot, relativePath), content, 'utf8')
}

async function commitAll(repoRoot, message) {
  await git(repoRoot, ['add', '.'])
  await git(repoRoot, ['commit', '-m', message])
}

async function commitTracked(repoRoot, message) {
  await git(repoRoot, ['commit', '-a', '-m', message])
}

async function initRepo(repoRoot, level) {
  mkdirSync(repoRoot, { recursive: true })
  await git(repoRoot, ['init'])
  pinRepoConfig(repoRoot)
  write(repoRoot, `level-${level}.txt`, `level ${level} base\n`)
  await commitAll(repoRoot, `level-${level}: initial commit`)
  append(repoRoot, `level-${level}.txt`, `level ${level} committed update\n`)
  await commitTracked(repoRoot, `level-${level}: committed update`)
}

async function initRootBase(repoRoot) {
  mkdirSync(repoRoot, { recursive: true })
  await git(repoRoot, ['init'])
  pinRepoConfig(repoRoot)
  write(repoRoot, 'root-owned.txt', 'root base\n')
  await commitAll(repoRoot, 'root: initial commit')
  append(repoRoot, 'root-owned.txt', 'root committed update\n')
  await commitTracked(repoRoot, 'root: committed update')
}

async function addSubmodule(repoRoot, sourceRepoRoot, targetPath) {
  await git(repoRoot, [
    'submodule',
    'add',
    pathToFileURL(sourceRepoRoot).href,
    targetPath
  ])
}

async function ensureFixture() {
  rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  mkdirSync(sourcesRoot, { recursive: true })
  mkdirSync(workspaceRoot, { recursive: true })

  const levelRoots = new Map()
  for (let level = 1; level <= 5; level += 1) {
    levelRoots.set(level, join(sourcesRoot, `level-${level}`))
  }

  // Initialize all 5 level repos and rootRepo's base commits concurrently.
  await Promise.all([
    ...[1, 2, 3, 4, 5].map((level) => initRepo(levelRoots.get(level), level)),
    initRootBase(rootRepo)
  ])

  // Chain the submodule links from level 4 up to level 1.
  // `git submodule add` already clones and checks out the direct child, so no
  // redundant `submodule update --init` is needed at intermediate levels.
  for (let level = 4; level >= 1; level -= 1) {
    const repoRoot = levelRoots.get(level)
    const childRoot = levelRoots.get(level + 1)
    await addSubmodule(repoRoot, childRoot, `deps/level-${level + 1}`)
    await commitAll(repoRoot, `level-${level}: add level-${level + 1} submodule`)
  }

  await addSubmodule(rootRepo, levelRoots.get(1), 'modules/level-1')
  await commitAll(rootRepo, 'root: add level-1 submodule')
  await git(rootRepo, ['submodule', 'update', '--init', '--recursive'])

  append(rootRepo, 'root-owned.txt', 'root dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'level-1.txt'), 'level 1 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'level-2.txt'), 'level 2 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'level-3.txt'), 'level 3 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'deps', 'level-4', 'level-4.txt'), 'level 4 dirty worktree change\n')
  append(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'deps', 'level-3', 'deps', 'level-4', 'deps', 'level-5', 'level-5.txt'), 'level 5 dirty worktree change\n')

  write(rootRepo, join('modules', 'level-1', 'deps', 'level-2', 'level-2-untracked.txt'), 'level 2 untracked file\n')
  write(rootRepo, 'root-untracked.txt', 'root untracked file\n')
}

await ensureFixture()

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
