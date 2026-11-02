/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nested gitlink (NO .gitmodules) discovery — end-to-end suite.
 *
 * A parent repo tracks nested repos as bare gitlinks (mode 160000) it NEVER
 * declared in `.gitmodules`. Before the fix, the snapshot service discovered
 * submodules from `.gitmodules` only, so these nested repos were invisible —
 * Git Diff and Git History showed nothing for them. The fix reads the index's
 * gitlink set (`git ls-files -s`) so they surface as submodule repos.
 *
 * Why a SEPARATE, focused suite rather than amending the (large) Git Diff
 * staleness suite: this owns a distinct fixture (a gitlink-without-.gitmodules
 * parent, which no other suite builds) and must stay fast — it drives the main
 * process directly via `git.getDiff` / `git.getHistory` IPC (no UI round-trip),
 * so even on an EDR-throttled host the whole session is a handful of git
 * spawns, well under the per-runner budget.
 *
 * The pure discovery math (parse `ls-files -s`, fold gitlinks into the snapshot)
 * is unit-pinned in `test/unittest/git-submodule-disk-discovery.test.mts`; this
 * suite proves the wiring all the way to a Diff / History result.
 */
import type { AutotestContext, TestResult } from './types'

interface NestedGitlinkManifest {
  tempRoot: string
  parentRoot: string
  nestedChangedRel: string
  nestedChangedFile: string
  nestedCleanRel: string
}

interface DiffRepo {
  root: string
  isSubmodule?: boolean
}
interface DiffFile {
  filename: string
  repoRoot?: string
}
interface DiffResult {
  success: boolean
  files: DiffFile[]
  repos?: DiffRepo[]
}
interface HistoryResult {
  success: boolean
  repos?: DiffRepo[]
}

/** Forward-slash + trailing-slash normalize for cross-platform path equality. */
function clampPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}
const dirOf = (p: string): string => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
const baseOf = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

async function loadManifest(extraPath: string | null): Promise<NestedGitlinkManifest | null> {
  if (!extraPath) return null
  const result = await window.electronAPI.project.readFile(dirOf(extraPath), baseOf(extraPath))
  if (!result.success || typeof result.content !== 'string') return null
  try {
    return JSON.parse(result.content) as NestedGitlinkManifest
  } catch {
    return null
  }
}

export async function testGitDiffNestedGitlink(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, assert, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('nested-gitlink:start', { suite: 'GitDiffNestedGitlink' })

  const manifest = await loadManifest(window.electronAPI.debug.autotestFixtureExtra)
  if (!manifest) {
    _assert('NGL-00-fixture-loaded', false, { extraPath: window.electronAPI.debug.autotestFixtureExtra })
    return results
  }
  _assert('NGL-00-fixture-loaded', true, { parentRoot: manifest.parentRoot })

  const parentRoot = manifest.parentRoot
  const changedRel = manifest.nestedChangedRel
  const changedFile = manifest.nestedChangedFile
  const cleanRel = manifest.nestedCleanRel

  // One Diff capture drives NGL-01 + NGL-02.
  if (!cancelled()) {
    const diff = (await window.electronAPI.git.getDiff(parentRoot, { scope: 'full', force: true })) as DiffResult
    const repoRoots = (diff.repos ?? []).map((r) => clampPath(r.root))

    // NGL-01: the changed gitlink surfaces as a submodule repo AND its
    // uncommitted modification loads as a file owned by that repo.
    const changedSection = (diff.repos ?? []).find((r) => clampPath(r.root).endsWith(`/${changedRel}`))
    const changedFileLoaded = diff.files.some((f) =>
      f.repoRoot && clampPath(f.repoRoot).endsWith(`/${changedRel}`) && f.filename === changedFile)
    _assert('NGL-01-diff-gitlink-no-gitmodules-surfaces', (
      diff.success &&
      Boolean(changedSection) &&
      Boolean(changedSection?.isSubmodule) &&
      changedFileLoaded
    ), {
      changedRepoInOutline: Boolean(changedSection),
      isSubmodule: Boolean(changedSection?.isSubmodule),
      changedFileLoaded,
      repoRoots,
      filenames: diff.files.map((f) => clampPath(f.filename))
    })

    // NGL-02: a second undeclared gitlink is discovered too, proving we read
    // the full gitlink set rather than only the first entry.
    const cleanSection = (diff.repos ?? []).find((r) => clampPath(r.root).endsWith(`/${cleanRel}`))
    _assert('NGL-02-multiple-gitlinks-all-discovered', (
      diff.success && Boolean(changedSection) && Boolean(cleanSection)
    ), {
      cleanRepoInOutline: Boolean(cleanSection),
      repoRoots
    })
  }

  // NGL-03: History goes through the SAME snapshot discovery, so the nested
  // gitlinks must also appear in the History repos outline (the second half of
  // the user's "diff AND history can't see it" report).
  if (!cancelled()) {
    const history = (await window.electronAPI.git.getHistory(parentRoot, { limit: 20 })) as HistoryResult
    const historyRoots = (history.repos ?? []).map((r) => clampPath(r.root))
    const changedInHistory = historyRoots.some((root) => root.endsWith(`/${changedRel}`))
    const cleanInHistory = historyRoots.some((root) => root.endsWith(`/${cleanRel}`))
    _assert('NGL-03-history-gitlink-no-gitmodules-surfaces', (
      history.success && changedInHistory && cleanInHistory
    ), {
      changedInHistory,
      cleanInHistory,
      historyRoots
    })
  }

  log('nested-gitlink:done', {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length
  })
  return results
}
