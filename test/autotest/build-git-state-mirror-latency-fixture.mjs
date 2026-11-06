#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

/**
 * On-demand fixture builder for the git-state-mirror-latency autotest.
 *
 * Invoked automatically by `run-git-state-mirror-latency-autotest.{sh,ps1}`
 * when the fixture tarballs or `manifest.json` are missing, or manually via:
 *   node test/autotest/build-git-state-mirror-latency-fixture.mjs
 *
 * Produces 11 *.tar.gz tarballs + `manifest.json` under
 * `test/autotest/fixtures/git-state-mirror-latency/` (gitignored). The runner
 * extracts them at every autotest session start, so subsequent runs pay only
 * a few `tar xzf` calls (no git invocations, no fixture rebuild).
 *
 * Each repo embodies a distinct (branch, status) tuple so the latency suite
 * can verify both the branch text and the status colour transition at a single
 * cd boundary:
 *
 *   repo-A             clean       branch=feature-a
 *   repo-B             clean       branch=main
 *   repo-modified      M           branch=dirty-yellow
 *   repo-untracked     ??          branch=dirty-purple
 *   repo-mixed         M+A+??      branch=dirty-mixed   (add+modify mix → blue)
 *   non-git-dir        n/a         not a git repo
 *
 * Re-running this script wipes and rebuilds the local tarballs and manifest.
 */

import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-state-mirror-latency')
const stagingRoot = join(tmpdir(), `onward-gsm-fixture-${process.pid}`)

const GIT_COMMON_ARGS = [
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false'
]

async function git(cwd, args) {
  await execFileAsync('git', [...GIT_COMMON_ARGS, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Onward AutoTest',
      GIT_AUTHOR_EMAIL: 'autotest@example.com',
      GIT_COMMITTER_NAME: 'Onward AutoTest',
      GIT_COMMITTER_EMAIL: 'autotest@example.com'
    }
  })
}

async function initRepo(absPath, branch, files, commitMessage) {
  mkdirSync(absPath, { recursive: true })
  await git(absPath, ['init', '-b', branch])
  // Pin line-ending behaviour in the fixture's LOCAL config (travels inside the
  // tarball's .git/config, overrides the user's global setting on extract). On
  // Windows the default `core.autocrlf=true` would re-normalise our LF blobs and
  // make clean fixtures show spurious modifications — breaking the deterministic
  // porcelain the badge-state matrix asserts on. `-text` semantics for all repos.
  appendFileSync(
    join(absPath, '.git', 'config'),
    '\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n',
    'utf8'
  )
  for (const [rel, content] of Object.entries(files)) {
    const full = join(absPath, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  await git(absPath, ['add', '.'])
  await git(absPath, ['commit', '-m', commitMessage])
}

function writeFile(absRepo, rel, content) {
  const full = join(absRepo, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

function sanitizeTarGzArchive(tarPath, outPath = tarPath) {
  const compressed = readFileSync(tarPath)
  const tarBuf = zlib.gunzipSync(compressed)
  let offset = 0
  while (offset + 512 <= tarBuf.length) {
    const block = tarBuf.subarray(offset, offset + 512)
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (block[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) {
      offset += 512
      continue
    }
    const sizeRaw = block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = sizeRaw ? parseInt(sizeRaw, 8) : 0
    // Normalize uid (108..116) and gid (116..124) to 0, and clear uname (265..297) & gname (297..329)
    // so the host OS username / UID never leaks into committed .tar.gz fixtures.
    block.write('0000000\0', 108, 8, 'ascii')
    block.write('0000000\0', 116, 8, 'ascii')
    block.fill(0, 265, 329)
    // Recompute POSIX tar header checksum at 148..156
    block.fill(0x20, 148, 156)
    let chksum = 0
    for (let i = 0; i < 512; i++) {
      chksum += block[i]
    }
    const chksumStr = chksum.toString(8).padStart(6, '0') + '\0 '
    block.write(chksumStr, 148, 8, 'ascii')

    const dataBlocks = Number.isFinite(size) && size > 0 ? Math.ceil(size / 512) : 0
    offset += 512 * (1 + dataBlocks)
  }
  const recompressed = zlib.gzipSync(tarBuf, { mtime: 0 })
  writeFileSync(outPath, recompressed)
}

async function tarball(repoName) {
  // GNU tar / bsd tar / Windows tar accept -czf consistently. We tarball
  // the entire `repoName/` directory (including .git/) so extraction
  // restores the repo as-is. --sort=name keeps the tarball deterministic
  // when GNU tar is in use; bsd tar (macOS default) silently ignores it.
  //
  // COPYFILE_DISABLE=1 stops macOS bsd-tar from baking AppleDouble resource
  // forks (`._*`) into the archive. Without it, every `._<file>` extracts on
  // Windows/Linux as an UNTRACKED file, so a "clean" fixture reports `?? ._*`
  // and the badge classifies it `added` — silently breaking the whole 5-state
  // matrix off-macOS. (Same cross-platform class as the core.autocrlf pin above.)
  const tarPath = join(fixtureRoot, `${repoName}.tar.gz`)
  const stagedTarName = `${repoName}.tar.gz`
  const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' }
  try {
    await execFileAsync('tar', ['--format=ustar', '--sort=name', '-czf', stagedTarName, repoName], {
      cwd: stagingRoot,
      env: tarEnv
    })
  } catch {
    // Retry without --sort=name for bsd tar on Windows/macOS where --sort=name
    // is unsupported; --format=ustar avoids PAX SCHILY.fflags extended headers.
    await execFileAsync('tar', ['--format=ustar', '-czf', stagedTarName, repoName], {
      cwd: stagingRoot,
      env: tarEnv
    })
  }
  sanitizeTarGzArchive(join(stagingRoot, stagedTarName), tarPath)
  return tarPath
}

// --- Wipe staging + previous tarballs, recreate fixture root ---
rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })
mkdirSync(fixtureRoot, { recursive: true })
for (const old of ['repo-A.tar.gz', 'repo-B.tar.gz', 'repo-modified.tar.gz', 'repo-untracked.tar.gz', 'repo-mixed.tar.gz', 'repo-deleted.tar.gz', 'repo-mixed-ad.tar.gz', 'repo-mixed-dm.tar.gz', 'repo-mixed-adm.tar.gz', 'repo-two-sided.tar.gz', 'non-git-dir.tar.gz']) {
  const oldPath = join(fixtureRoot, old)
  if (existsSync(oldPath)) rmSync(oldPath)
}

await Promise.all([
  // --- repo-A: clean, branch feature-a ---
  (async () => {
    const repo = join(stagingRoot, 'repo-A')
    await initRepo(repo, 'feature-a', {
      'README.md': '# repo-A\n\nClean fixture, branch feature-a.\n',
      'src/main.ts': 'export const REPO = "A"\n'
    }, 'Initial commit on feature-a')
    await tarball('repo-A')
  })(),

  // --- repo-B: clean, branch main ---
  (async () => {
    const repo = join(stagingRoot, 'repo-B')
    await initRepo(repo, 'main', {
      'README.md': '# repo-B\n\nClean fixture, branch main.\n',
      'app.ts': 'export const REPO = "B"\n'
    }, 'Initial commit on main')
    await tarball('repo-B')
  })(),

  // --- repo-modified: M only, branch dirty-yellow ---
  (async () => {
    const repo = join(stagingRoot, 'repo-modified')
    await initRepo(repo, 'dirty-yellow', {
      'README.md': '# repo-modified\n\nFixture for the modified (yellow) status colour.\n',
      'src/main.ts': 'export const VERSION = "v0"\n'
    }, 'Initial commit on dirty-yellow')
    // Modify a tracked file without staging — produces porcelain " M" status.
    writeFile(repo, 'src/main.ts', 'export const VERSION = "v1-modified"\n')
    await tarball('repo-modified')
  })(),

  // --- repo-untracked: ?? only, branch dirty-purple ---
  (async () => {
    const repo = join(stagingRoot, 'repo-untracked')
    await initRepo(repo, 'dirty-purple', {
      'README.md': '# repo-untracked\n\nFixture for the added (purple) status colour via an untracked file.\n'
    }, 'Initial commit on dirty-purple')
    // Drop an untracked file — produces porcelain "??" status.
    writeFile(repo, 'untracked.txt', 'not yet tracked\n')
    await tarball('repo-untracked')
  })(),

  // --- repo-mixed: M + A staged + ??, branch dirty-mixed ---
  (async () => {
    const repo = join(stagingRoot, 'repo-mixed')
    await initRepo(repo, 'dirty-mixed', {
      'README.md': '# repo-mixed\n\nFixture for the mixed (blue) bucket: additions and modifications coexist.\n',
      'src/main.ts': 'export const VERSION = "v0"\n'
    }, 'Initial commit on dirty-mixed')
    writeFile(repo, 'src/main.ts', 'export const VERSION = "v1-modified"\n')
    writeFile(repo, 'src/added.ts', 'export const ADDED = true\n')
    await git(repo, ['add', 'src/added.ts'])
    writeFile(repo, 'untracked.txt', 'still untracked\n')
    await tarball('repo-mixed')
  })(),

  // --- repo-deleted: D only, branch dirty-red ---
  (async () => {
    const repo = join(stagingRoot, 'repo-deleted')
    await initRepo(repo, 'dirty-red', {
      'README.md': '# repo-deleted\n\nFixture for the deleted (red) bucket: deletions are the only change.\n',
      'src/gone.ts': 'export const GONE = true\n'
    }, 'Initial commit on dirty-red')
    rmSync(join(repo, 'src/gone.ts'), { force: true })
    await tarball('repo-deleted')
  })(),

  // --- repo-mixed-ad: A + D across files, branch dirty-ad ---
  (async () => {
    const repo = join(stagingRoot, 'repo-mixed-ad')
    await initRepo(repo, 'dirty-ad', {
      'README.md': '# repo-mixed-ad\n\nMixed (blue): a staged add coexists with a worktree delete.\n',
      'src/old.ts': 'export const OLD = true\n'
    }, 'Initial commit on dirty-ad')
    writeFile(repo, 'src/new.ts', 'export const NEW = true\n')
    await git(repo, ['add', 'src/new.ts'])
    rmSync(join(repo, 'src/old.ts'), { force: true })
    await tarball('repo-mixed-ad')
  })(),

  // --- repo-mixed-dm: D + M across files, branch dirty-dm ---
  (async () => {
    const repo = join(stagingRoot, 'repo-mixed-dm')
    await initRepo(repo, 'dirty-dm', {
      'README.md': '# repo-mixed-dm\n\nMixed (blue): a worktree delete coexists with a modify.\n',
      'src/keep.ts': 'export const KEEP = "v0"\n',
      'src/gone.ts': 'export const GONE = true\n'
    }, 'Initial commit on dirty-dm')
    writeFile(repo, 'src/keep.ts', 'export const KEEP = "v1"\n')
    rmSync(join(repo, 'src/gone.ts'), { force: true })
    await tarball('repo-mixed-dm')
  })(),

  // --- repo-mixed-adm: A + D + M (the full triple), branch dirty-adm ---
  (async () => {
    const repo = join(stagingRoot, 'repo-mixed-adm')
    await initRepo(repo, 'dirty-adm', {
      'README.md': '# repo-mixed-adm\n\nMixed (blue): add + delete + modify all coexist.\n',
      'src/keep.ts': 'export const KEEP = "v0"\n',
      'src/gone.ts': 'export const GONE = true\n'
    }, 'Initial commit on dirty-adm')
    writeFile(repo, 'src/keep.ts', 'export const KEEP = "v1"\n')
    rmSync(join(repo, 'src/gone.ts'), { force: true })
    writeFile(repo, 'src/new.ts', 'export const NEW = true\n')
    await git(repo, ['add', 'src/new.ts'])
    await tarball('repo-mixed-adm')
  })(),

  // --- repo-two-sided: ONE file staged-modified + worktree-deleted -> XY "MD", branch dirty-twosided ---
  (async () => {
    const repo = join(stagingRoot, 'repo-two-sided')
    await initRepo(repo, 'dirty-twosided', {
      'README.md': '# repo-two-sided\n\nMixed (blue): ONE file is staged-modified AND worktree-deleted (XY="MD").\n',
      'src/twosided.ts': 'export const V = "v0"\n'
    }, 'Initial commit on dirty-twosided')
    writeFile(repo, 'src/twosided.ts', 'export const V = "v1-staged"\n')
    await git(repo, ['add', 'src/twosided.ts'])
    rmSync(join(repo, 'src/twosided.ts'), { force: true })
    await tarball('repo-two-sided')
  })(),

  // --- non-git-dir: plain directory, no .git ---
  (async () => {
    const repo = join(stagingRoot, 'non-git-dir')
    mkdirSync(repo, { recursive: true })
    writeFile(repo, 'README.md', '# non-git-dir\n\nNot a git repository — fixture for the unknown / no-status code path.\n')
    writeFile(repo, 'note.txt', 'plain text file outside any repo\n')
    await tarball('non-git-dir')
  })()
])

// --- Manifest the runner reads at startup ---
const manifest = {
  repos: [
    { name: 'repo-A',          branch: 'feature-a',    expectedStatus: 'clean'    },
    { name: 'repo-B',          branch: 'main',         expectedStatus: 'clean'    },
    { name: 'repo-modified',   branch: 'dirty-yellow', expectedStatus: 'modified' },
    { name: 'repo-untracked',  branch: 'dirty-purple', expectedStatus: 'added'    },
    { name: 'repo-mixed',      branch: 'dirty-mixed',  expectedStatus: 'mixed'    },
    { name: 'repo-deleted',    branch: 'dirty-red',    expectedStatus: 'deleted'  },
    { name: 'repo-mixed-ad',   branch: 'dirty-ad',     expectedStatus: 'mixed'    },
    { name: 'repo-mixed-dm',   branch: 'dirty-dm',     expectedStatus: 'mixed'    },
    { name: 'repo-mixed-adm',  branch: 'dirty-adm',    expectedStatus: 'mixed'    },
    { name: 'repo-two-sided',  branch: 'dirty-twosided', expectedStatus: 'mixed'  },
    { name: 'non-git-dir',     branch: null,           expectedStatus: 'unknown'  }
  ]
}
writeFileSync(join(fixtureRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

// Cleanup the staging dir; tarballs remain in fixtureRoot (gitignored).
rmSync(stagingRoot, { recursive: true, force: true })

console.log('Built tarballs in:', fixtureRoot)
for (const repo of manifest.repos) {
  console.log(`  - ${repo.name}.tar.gz   (branch=${repo.branch ?? 'n/a'}, expectedStatus=${repo.expectedStatus})`)
}
console.log('  - manifest.json')
