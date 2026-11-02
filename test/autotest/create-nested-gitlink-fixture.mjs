#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0

// Builds the "nested gitlink with NO .gitmodules" fixture under one tempRoot.
// The parent repo tracks nested repos as bare gitlinks (mode 160000) it NEVER
// declared in `.gitmodules`, produced by `git add`-ing a standalone nested repo
// directly (NOT `git submodule add`). `git submodule status` errors here ("no
// submodule mapping found in .gitmodules"); only `git ls-files -s` sees the
// 160000 entries. Layout:
//
//   gitlink-parent/                  parent repo, NO .gitmodules
//   ├── .git/
//   ├── README.md                    committed parent file
//   ├── nested-changed/              gitlink + history + UNCOMMITTED change
//   │   └── .git/                       → Diff must surface its internal change
//   └── nested-clean/                gitlink + history, working tree clean
//       └── .git/                       → still discovered (multiple gitlinks)
//
// Deliberately small (1 parent + 2 nested) so the suite's app session stays
// well under the per-runner budget even on an EDR-throttled host.
//
// Cross-platform: `core.autocrlf=false` + `core.safecrlf=false` are set in each
// repo's LOCAL config right after `git init` so a contributor's global
// autocrlf can't re-normalize the fixture and make a clean repo report phantom
// modifications (CLAUDE.md autotest cross-platform hard rule).

import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = resolve(__dirname, 'fixtures', 'git-diff-nested-gitlink')
const runtimeRoot = join(fixtureRoot, 'runtime')

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

function commit(repo, message) {
  git(repo, [
    '-c', 'user.name=Onward AutoTest',
    '-c', 'user.email=autotest@example.com',
    'commit', '-m', message
  ])
}

function init(repo, files, message) {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-b', 'main'])
  // Pin line-ending behavior so the fixture is byte-stable across platforms.
  git(repo, ['config', 'core.autocrlf', 'false'])
  git(repo, ['config', 'core.safecrlf', 'false'])
  for (const [rel, content] of Object.entries(files)) {
    const full = join(repo, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  git(repo, ['add', '.'])
  commit(repo, message)
}

// Wipe-and-recreate so runs don't inherit a half-baked previous state.
mkdirSync(fixtureRoot, { recursive: true })
rmSync(runtimeRoot, { recursive: true, force: true })
mkdirSync(runtimeRoot, { recursive: true })

const tempRoot = runtimeRoot
const parentRoot = join(tempRoot, 'gitlink-parent')

// Parent repo — NO .gitmodules is ever written.
init(parentRoot, {
  'README.md': '# Gitlink parent\n\nbaseline parent content\n'
}, 'parent baseline')

// nested-changed: standalone repo with history, `git add`-ed as a bare gitlink,
// then left with an uncommitted modification so Diff has content to surface.
const nestedChanged = join(parentRoot, 'nested-changed')
init(nestedChanged, {
  'inner.txt': 'nested-changed inner baseline\n'
}, 'nested-changed baseline')

// nested-clean: standalone repo with history, `git add`-ed as a bare gitlink,
// working tree left clean — exercises "multiple gitlinks discovered" without a
// diff to show.
const nestedClean = join(parentRoot, 'nested-clean')
init(nestedClean, {
  'inner.txt': 'nested-clean inner baseline\n'
}, 'nested-clean baseline')

// Record BOTH nested repos as bare gitlinks in the parent index WITHOUT writing
// .gitmodules. The "embedded git repository" warning git prints is non-fatal.
git(parentRoot, ['add', 'nested-changed', 'nested-clean'])
commit(parentRoot, 'add nested repos as gitlinks (no .gitmodules)')

// Now dirty nested-changed so the parent Diff has real submodule content.
writeFileSync(join(nestedChanged, 'inner.txt'),
  'nested-changed inner baseline\nNGL uncommitted modification\n', 'utf8')

const manifest = {
  tempRoot,
  parentRoot,
  nestedChangedRel: 'nested-changed',
  nestedChangedFile: 'inner.txt',
  nestedCleanRel: 'nested-clean'
}

const manifestPath = join(tempRoot, 'manifest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

process.stdout.write(JSON.stringify({ ...manifest, manifestPath }))
