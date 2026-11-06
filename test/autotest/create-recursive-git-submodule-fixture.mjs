#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const GIT_SHARED_CONFIG = [
  '-c', 'user.name=Onward AutoTest',
  '-c', 'user.email=autotest@onward.local',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
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
    appendFileSync(gitConfigPath, '\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n', 'utf8')
  }
}

async function initRepo(repoRoot, files, commitMessage) {
  mkdirSync(repoRoot, { recursive: true })
  await git(repoRoot, ['init'])
  pinRepoConfig(repoRoot)
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = join(repoRoot, relativePath)
    mkdirSync(join(filePath, '..'), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }
  await git(repoRoot, ['add', '.'])
  await git(repoRoot, ['commit', '-m', commitMessage])
}

async function addSubmodule(repoRoot, sourceRepoRoot, targetPath) {
  await git(repoRoot, [
    'submodule',
    'add',
    pathToFileURL(sourceRepoRoot).href,
    targetPath
  ])
}

async function commitAll(repoRoot, commitMessage) {
  await git(repoRoot, ['add', '.'])
  await git(repoRoot, ['commit', '-m', commitMessage])
}

function appendLine(filePath, line) {
  appendFileSync(filePath, `${line}\n`, 'utf8')
}

// Fail-safe cleanup: if any step below throws, remove tempRoot before
// re-throwing so a standalone invocation (no wrapper script trap) does not
// leak. On the success path, stdout-printed tempRoot transfers ownership to
// the caller (typically a `.sh` / `.ps1` runner that traps cleanup itself).
const tempRoot = mkdtempSync(join(tmpdir(), 'onward-git-recursive-submodules-'))

async function main() {
  try {
    const sourcesRoot = join(tempRoot, 'sources')
    const workspaceRoot = join(tempRoot, 'workspace')

    const betaRepo = join(sourcesRoot, 'beta')
    const alphaRepo = join(sourcesRoot, 'alpha')
    const gammaRepo = join(sourcesRoot, 'gamma')
    const rootRepo = join(workspaceRoot, 'root')

    await Promise.all([
      initRepo(betaRepo, {
        'BETA.md': '# Beta\n\nBase fixture file.\n'
      }, 'init beta'),
      initRepo(alphaRepo, {
        'ALPHA.md': '# Alpha\n\nBase fixture file.\n'
      }, 'init alpha'),
      initRepo(gammaRepo, {
        'GAMMA.md': '# Gamma\n\nBase fixture file.\n'
      }, 'init gamma'),
      initRepo(rootRepo, {
        'README.md': '# Recursive Submodule Fixture\n'
      }, 'init root')
    ])

    await addSubmodule(alphaRepo, betaRepo, 'deps/beta')
    await commitAll(alphaRepo, 'add beta submodule')

    await addSubmodule(rootRepo, alphaRepo, 'modules/alpha')
    await addSubmodule(rootRepo, gammaRepo, 'modules/gamma')
    await commitAll(rootRepo, 'add nested submodules')
    await git(rootRepo, ['submodule', 'update', '--init', '--recursive'])

    appendLine(join(rootRepo, 'README.md'), 'root dirty change')
    appendLine(join(rootRepo, 'modules', 'alpha', 'ALPHA.md'), 'alpha dirty change')
    appendLine(join(rootRepo, 'modules', 'alpha', 'deps', 'beta', 'BETA.md'), 'beta nested dirty change')
    appendLine(join(rootRepo, 'modules', 'gamma', 'GAMMA.md'), 'gamma dirty change')

    process.stdout.write(JSON.stringify({
      tempRoot,
      repoRoot: rootRepo
    }))
  } catch (err) {
    if (process.env.ONWARD_AUTOTEST_KEEP_TMP === '1') {
      console.error(`[autotest] retained tmp for debugging: ${tempRoot}`)
    } else {
      try {
        rmSync(tempRoot, { recursive: true, force: true })
      } catch {
        // Best-effort: do not mask the original error with a cleanup error.
      }
    }
    throw err
  }
}

await main()
