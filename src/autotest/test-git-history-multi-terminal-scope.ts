/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git History multi-terminal scope regression test
 */
import type { AutotestContext, TestResult } from './types'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

function dirname(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '')
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized
}

function getVisibleTerminalIds(): string[] {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-id]'))
  const ids = nodes
    .map((node) => node.dataset.terminalId ?? '')
    .filter(Boolean)
  return Array.from(new Set(ids))
}

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 12000
): Promise<string | null> {
  const startedAt = performance.now()
  const normalizedExpected = normalizePath(expectedCwd)
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === normalizedExpected) {
      return cwd
    }
    await sleep(180)
  }
  return null
}

async function writeAndSyncTerminal(
  terminalId: string,
  command: string,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  await window.electronAPI.terminal.write(terminalId, command)
  await sleep(400)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(400)
}

export async function testGitHistoryMultiTerminalScope(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getHistoryApi = () => window.__onwardGitHistoryDebug
  const fixtureRoot = joinPath(dirname(rootPath), `onward-autotest-git-history-scope-${Date.now()}`)
  const staleRepoRoot = joinPath(dirname(rootPath), `onward-autotest-stale-repo-${Date.now()}`)
  const layoutButton = document.querySelector<HTMLButtonElement>('button[title="Two terminals"]')

  log('phase3.5:start', {
    suite: 'GitHistoryMultiTerminalScope',
    rootPath,
    fixtureRoot,
    staleRepoRoot
  })

  layoutButton?.click()
  const hasTwoTerminals = await waitFor(
    'phase3.5-layout-two-terminals',
    () => getVisibleTerminalIds().length >= 2,
    10000
  )
  _assert('GHMS-01-layout-two-terminals', hasTwoTerminals, {
    visibleTerminalIds: getVisibleTerminalIds()
  })
  if (!hasTwoTerminals || cancelled()) return results

  const terminalIds = getVisibleTerminalIds()
  const terminalA = terminalIds[0] ?? null
  const terminalB = terminalIds[1] ?? null
  const terminalPairValid = Boolean(terminalA && terminalB && terminalA !== terminalB)
  _assert('GHMS-02-terminal-pair-valid', terminalPairValid, { terminalA, terminalB, terminalIds })
  if (!terminalPairValid || !terminalA || !terminalB || cancelled()) return results

  const platform = window.electronAPI.platform
  const fixtureShellPath = platform === 'win32' ? fixtureRoot.replace(/\//g, '\\') : fixtureRoot
  const rootShellPath = platform === 'win32' ? rootPath.replace(/\//g, '\\') : rootPath
  const fixtureCommand = platform === 'win32'
    ? [
      `$fixtureRoot = "${fixtureShellPath}"`,
      'if (Test-Path $fixtureRoot) { Remove-Item -Recurse -Force $fixtureRoot }',
      'New-Item -ItemType Directory -Path $fixtureRoot | Out-Null',
      'Set-Location $fixtureRoot',
      'git init | Out-Null',
      'Set-Content -LiteralPath "README.md" -Value "fixture"',
      'git add README.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "fixture" | Out-Null'
    ].join('; ') + "\r"
    : [
      `rm -rf "${fixtureShellPath}"`,
      `mkdir -p "${fixtureShellPath}"`,
      `cd "${fixtureShellPath}"`,
      'git init >/dev/null 2>&1',
      'printf "fixture\\n" > README.md',
      'git add README.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "fixture" >/dev/null 2>&1'
    ].join(' && ') + "\r"
  const rootCommand = platform === 'win32'
    ? `cd /d "${rootShellPath}"\r`
    : `cd "${rootShellPath}"\r`

  await writeAndSyncTerminal(terminalA, rootCommand, sleep)
  await writeAndSyncTerminal(terminalB, fixtureCommand, sleep)

  const cwdA = await waitForTerminalCwd(terminalA, rootPath, sleep)
  _assert('GHMS-03-terminal-a-root-ready', Boolean(cwdA), {
    terminalId: terminalA,
    expected: normalizePath(rootPath),
    actual: cwdA ? normalizePath(cwdA) : null
  })
  if (!cwdA || cancelled()) return results

  const cwdB = await waitForTerminalCwd(terminalB, fixtureRoot, sleep)
  _assert('GHMS-04-terminal-b-fixture-ready', Boolean(cwdB), {
    terminalId: terminalB,
    expected: normalizePath(fixtureRoot),
    actual: cwdB ? normalizePath(cwdB) : null
  })
  if (!cwdB || cancelled()) return results

  window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId: terminalA } }))
  const openedOnA = await waitFor(
    'phase3.5-history-open-a',
    () => Boolean(getHistoryApi()?.isOpen()),
    8000
  )
  _assert('GHMS-05-open-history-on-terminal-a', openedOnA, { terminalId: terminalA })
  if (!openedOnA || cancelled()) return results

  const loadedOnA = await waitFor(
    'phase3.5-history-loaded-a',
    () => {
      const api = getHistoryApi()
      return Boolean(api && api.getCommitCount() > 0 && !api.isLoading())
    },
    12000
  )
  _assert('GHMS-06-load-history-on-terminal-a', loadedOnA, {
    commitCount: getHistoryApi()?.getCommitCount() ?? 0,
    activeCwd: getHistoryApi()?.getActiveCwd?.() ?? null
  })
  if (!loadedOnA || cancelled()) return results

  const injected = getHistoryApi()?.injectRepoState({
    selectedRepoRoot: staleRepoRoot,
    cachedParentCwd: rootPath,
    repoSearch: 'stale repo',
    cachedRepos: [{ root: staleRepoRoot, label: 'Stale Repo' }]
  }) ?? false
  await sleep(200)
  const staleState = getHistoryApi()?.getRepoState?.() ?? null
  _assert('GHMS-07-inject-stale-repo-state', injected && staleState?.selectedRepoRoot === staleRepoRoot, {
    injected,
    staleState,
    activeCwd: getHistoryApi()?.getActiveCwd?.() ?? null
  })
  if ((!injected || staleState?.selectedRepoRoot !== staleRepoRoot) || cancelled()) return results

  window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId: terminalB } }))
  const switchedToB = await waitFor(
    'phase3.5-history-switch-b',
    () => {
      const api = getHistoryApi()
      if (!api?.isOpen()) return false
      return normalizePath(api.getActiveCwd?.() ?? '') === normalizePath(fixtureRoot)
    },
    12000
  )
  _assert('GHMS-08-switch-history-to-terminal-b', switchedToB, {
    expected: normalizePath(fixtureRoot),
    actual: normalizePath(getHistoryApi()?.getActiveCwd?.() ?? '')
  })
  if (!switchedToB || cancelled()) return results

  const reloadedOnB = await waitFor(
    'phase3.5-history-loaded-b',
    () => {
      const api = getHistoryApi()
      return Boolean(api && api.getCommitCount() > 0 && !api.isLoading())
    },
    12000
  )
  const finalState = getHistoryApi()?.getRepoState?.() ?? null
  _assert('GHMS-09-reload-current-repo-on-terminal-b', reloadedOnB, {
    commitCount: getHistoryApi()?.getCommitCount() ?? 0,
    activeCwd: getHistoryApi()?.getActiveCwd?.() ?? null,
    finalState
  })

  const clearedStaleState = Boolean(
    finalState &&
    finalState.selectedRepoRoot === null &&
    finalState.repoSearch === '' &&
    normalizePath(finalState.cachedParentCwd ?? '') !== normalizePath(staleRepoRoot)
  )
  _assert('GHMS-10-clear-stale-repo-state', clearedStaleState, {
    staleRepoRoot,
    finalState
  })

  dispatchEscape()
  const closed = await waitFor(
    'phase3.5-history-close',
    () => !getHistoryApi() || !getHistoryApi()!.isOpen(),
    4000
  )
  _assert('GHMS-11-esc-close-history', closed, { closed })
  await sleep(300)

  log('phase3.5:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
