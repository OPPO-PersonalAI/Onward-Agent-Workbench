/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
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

function dispatchEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true
  }))
}

async function writeAndSyncTerminal(
  terminalId: string,
  command: string,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  await window.electronAPI.terminal.write(terminalId, command)
  await sleep(450)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(450)
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 12000
): Promise<string | null> {
  const normalizedExpected = normalizePath(expectedCwd)
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === normalizedExpected) {
      return cwd
    }
    await sleep(180)
  }
  return null
}

function isVisibleElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.closest('[aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}

function getSubpageButton(target: 'diff' | 'editor' | 'history'): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(`[data-subpage-button="${target}"]`))
  return buttons.find((button) => isVisibleElement(button)) ?? null
}

function getVisibleSubpageShells(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-subpage-panel-shell="true"]'))
    .filter((shell) => isVisibleElement(shell))
}

function getVisibleShellButtons(): HTMLButtonElement[] {
  const shell = getVisibleSubpageShells()[0]
  if (!shell) return []
  return Array.from(shell.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => isVisibleElement(button))
}

function getButtonMetrics(button: HTMLButtonElement) {
  const style = window.getComputedStyle(button)
  return {
    text: button.textContent?.trim() || '',
    height: style.height,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily,
    borderRadius: style.borderRadius,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom
  }
}

function areVisibleShellButtonsUniform(): { ok: boolean; metrics: ReturnType<typeof getButtonMetrics>[] } {
  const buttons = getVisibleShellButtons()
  const metrics = buttons.map(getButtonMetrics)
  const first = metrics[0]
  if (!first) {
    return { ok: false, metrics }
  }
  return {
    ok: metrics.every((metric) =>
      metric.height === first.height
      && metric.fontSize === first.fontSize
      && metric.fontFamily === first.fontFamily
      && metric.borderRadius === first.borderRadius
      && metric.paddingTop === first.paddingTop
      && metric.paddingBottom === first.paddingBottom
    ),
    metrics
  }
}

function clickSubpageButton(target: 'diff' | 'editor' | 'history'): boolean {
  const button = getSubpageButton(target)
  if (!button || button.disabled) return false
  button.click()
  return true
}

function getGitDiffApi() {
  return window.__onwardGitDiffDebug
}

function getGitHistoryApi() {
  return window.__onwardGitHistoryDebug
}

function getProjectEditorApi() {
  return window.__onwardProjectEditorDebug
}

export async function testSubpageNavigation(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const fixtureRoot = joinPath(dirname(ctx.rootPath), `onward-autotest-subpage-navigation-${Date.now()}`)
  const fixtureShellPath = platform === 'win32' ? fixtureRoot.replace(/\//g, '\\') : fixtureRoot
  const repoSetupCommand = platform === 'win32'
    ? [
      `$fixtureRoot = "${fixtureShellPath}"`,
      'if (Test-Path $fixtureRoot) { Remove-Item -Recurse -Force $fixtureRoot }',
      'New-Item -ItemType Directory -Path $fixtureRoot | Out-Null',
      'Set-Location $fixtureRoot',
      'git init | Out-Null',
      'Set-Content -LiteralPath "existing.md" -Value "# existing`nline1`nline2"',
      'Set-Content -LiteralPath "history-deleted.md" -Value "# history deleted`n"',
      'Set-Content -LiteralPath "diff-deleted.md" -Value "# diff deleted`n"',
      'Set-Content -LiteralPath "editor-only.md" -Value "# editor only`n"',
      'git add existing.md history-deleted.md diff-deleted.md editor-only.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "base" | Out-Null',
      'Set-Content -LiteralPath "existing.md" -Value "# existing`nline1`nline2`ncommitted"',
      'git add existing.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "update existing" | Out-Null',
      'git rm --quiet history-deleted.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "delete history file" | Out-Null'
    ].join('; ') + '\r'
    : [
      `rm -rf "${fixtureShellPath}"`,
      `mkdir -p "${fixtureShellPath}"`,
      `cd "${fixtureShellPath}"`,
      'git init >/dev/null 2>&1',
      'printf "# existing\\nline1\\nline2\\n" > existing.md',
      'printf "# history deleted\\n" > history-deleted.md',
      'printf "# diff deleted\\n" > diff-deleted.md',
      'printf "# editor only\\n" > editor-only.md',
      'git add existing.md history-deleted.md diff-deleted.md editor-only.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "base" >/dev/null 2>&1',
      'printf "# existing\\nline1\\nline2\\ncommitted\\n" > existing.md',
      'git add existing.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "update existing" >/dev/null 2>&1',
      'git rm -q history-deleted.md',
      'git -c user.name="Onward AutoTest" -c user.email="autotest@example.com" commit -m "delete history file" >/dev/null 2>&1'
    ].join(' && ') + '\r'

  log('phase0.58:start', {
    suite: 'SubpageNavigation',
    fixtureRoot
  })

  await writeAndSyncTerminal(terminalId, repoSetupCommand, sleep)
  const fixtureCwd = await waitForTerminalCwd(terminalId, fixtureRoot, sleep)
  _assert('SN-00-fixture-root-ready', Boolean(fixtureCwd), {
    expected: normalizePath(fixtureRoot),
    actual: fixtureCwd ? normalizePath(fixtureCwd) : null
  })
  if (!fixtureCwd || cancelled()) return results

  const updatedWorkingTree = await window.electronAPI.project.saveFile(
    fixtureRoot,
    'existing.md',
    '# existing\nline1\nline2\ncommitted\nworking tree\n'
  )
  const deletedWorkingTree = await window.electronAPI.project.deletePath(fixtureRoot, 'diff-deleted.md')
  await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
  await sleep(600)
  _assert('SN-00-working-tree-prepared', updatedWorkingTree.success && deletedWorkingTree.success, {
    updatedWorkingTree,
    deletedWorkingTree
  })
  if ((!updatedWorkingTree.success || !deletedWorkingTree.success) && cancelled()) return results

  const openProjectEditor = async (label: string) => {
    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId } }))
    return await waitFor(`subpage-navigation-project-editor-open:${label}`, () => {
      const api = getProjectEditorApi()
      return Boolean(api?.isOpen() && normalizePath(api.getRootPath?.() ?? '') === normalizePath(fixtureRoot))
    }, 8000)
  }

  const waitForProjectEditorFile = async (label: string, expectedPath: string | null) => {
    return await waitFor(`subpage-navigation-editor-file:${label}`, () => {
      const api = getProjectEditorApi()
      if (!api?.isOpen()) return false
      return (api.getActiveFilePath?.() ?? null) === expectedPath
    }, 8000)
  }

  const waitForGitDiffOpen = async (label: string) => {
    return await waitFor(`subpage-navigation-diff-open:${label}`, () => Boolean(getGitDiffApi()?.isOpen()), 8000)
  }

  const waitForDiffFile = async (label: string, filePath: string) => {
    return await waitFor(`subpage-navigation-diff-file:${label}`, () => {
      const files = getGitDiffApi()?.getFileList?.() ?? []
      return files.some((file) => file.filename === filePath || file.originalFilename === filePath)
    }, 8000)
  }

  const waitForGitHistoryOpen = async (label: string) => {
    return await waitFor(`subpage-navigation-history-open:${label}`, () => Boolean(getGitHistoryApi()?.isOpen()), 8000)
  }

  const waitForHistoryFiles = async (label: string) => {
    return await waitFor(`subpage-navigation-history-files:${label}`, () => {
      const api = getGitHistoryApi()
      return Boolean(api && !api.isLoading() && api.getFiles().length > 0)
    }, 8000)
  }

  const selectHistoryFileByPath = async (label: string, filePath: string) => {
    return await waitFor(`subpage-navigation-history-select:${label}`, () => {
      const api = getGitHistoryApi()
      if (!api || api.isLoading()) return false
      const files = api.getFiles()
      const targetIndex = files.findIndex((file) => file.filename === filePath)
      if (targetIndex < 0) return false
      if (api.getSelectedFile?.()?.filename === filePath) return true
      const selected = api.selectFileByIndex(targetIndex) === true
      return selected && api.getSelectedFile?.()?.filename === filePath
    }, 8000)
  }

  const editorOpened = await openProjectEditor('setup')
  _assert('SN-01-open-project-editor', editorOpened, {
    rootPath: getProjectEditorApi()?.getRootPath?.() ?? null
  })
  if (!editorOpened || cancelled()) return results

  const initialShell = await waitFor('subpage-navigation-shell-editor-visible', () => {
    const shells = getVisibleSubpageShells()
    return shells.length === 1 ? shells[0] : false
  }, 8000)
  _assert('SN-01A-shared-shell-visible-on-editor', Boolean(initialShell), {
    visibleShells: getVisibleSubpageShells().length
  })
  if (!initialShell || cancelled()) return results

  const editorButton = getSubpageButton('editor')
  _assert('SN-02-editor-switcher-current', Boolean(editorButton && editorButton.disabled), {
    disabled: editorButton?.disabled ?? null
  })
  const editorButtonsUniform = areVisibleShellButtonsUniform()
  _assert('SN-02A-editor-header-buttons-uniform', editorButtonsUniform.ok, {
    metrics: editorButtonsUniform.metrics
  })

  await getProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: true })
  const editorOnlyOpened = await waitForProjectEditorFile('editor-only', 'editor-only.md')
  _assert('SN-03-editor-open-editor-only', editorOnlyOpened, {
    activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
  })
  if (cancelled()) return results

  const clickedDiffFromEditor = clickSubpageButton('diff')
  const diffOpened = clickedDiffFromEditor && await waitForGitDiffOpen('from-editor')
  const diffShell = await waitFor('subpage-navigation-shell-diff-visible', () => {
    const shells = getVisibleSubpageShells()
    return shells.length === 1 ? shells[0] : false
  }, 8000)
  _assert('SN-04-editor-switch-to-diff', diffOpened, {
    clickedDiffFromEditor,
    diffOpen: getGitDiffApi()?.isOpen?.() ?? false
  })
  _assert('SN-04A-shared-shell-reused-on-diff', Boolean(diffShell && diffShell === initialShell), {
    visibleShells: getVisibleSubpageShells().length,
    reusedShellNode: Boolean(diffShell && diffShell === initialShell)
  })
  if (!diffOpened || cancelled()) return results

  const diffButton = getSubpageButton('diff')
  _assert('SN-05-diff-switcher-current', Boolean(diffButton && diffButton.disabled), {
    disabled: diffButton?.disabled ?? null
  })
  const diffButtonsUniform = areVisibleShellButtonsUniform()
  _assert('SN-05A-diff-header-buttons-uniform', diffButtonsUniform.ok, {
    metrics: diffButtonsUniform.metrics
  })

  const diffApi = getGitDiffApi()
  const diffExistingReady = await waitForDiffFile('existing', 'existing.md')
  const selectedExistingInDiff = diffExistingReady && diffApi?.selectFileByPath('existing.md') === true
  await waitFor('subpage-navigation-diff-existing-selected', () => {
    const selected = getGitDiffApi()?.getSelectedFile?.()
    return Boolean(selected?.filename === 'existing.md')
  }, 8000)
  // Switching back to Editor via SubpageSwitcher should restore the
  // Editor's own previous state (editor-only.md), NOT open the Diff's
  // selected file.
  const clickedEditorFromDiff = clickSubpageButton('editor')
  const diffToEditorOpened = clickedEditorFromDiff && await waitForProjectEditorFile('diff-restores-editor-state', 'editor-only.md')
  _assert('SN-06-diff-to-editor-restores-editor-state', selectedExistingInDiff && diffToEditorOpened, {
    selectedExistingInDiff,
    clickedEditorFromDiff,
    expected: 'editor-only.md',
    activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
  })
  if (cancelled()) return results

  await getProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: true })
  const editorOnlyRestored = await waitForProjectEditorFile('editor-only-restored', 'editor-only.md')
  const clickedDiffAgain = clickSubpageButton('diff')
  const diffRestored = clickedDiffAgain && await waitForGitDiffOpen('restore-from-editor')
  const restoredDiffSelection = getGitDiffApi()?.getSelectedFile?.()?.filename ?? null
  _assert('SN-07-editor-to-diff-restores-diff-selection', editorOnlyRestored && diffRestored && restoredDiffSelection === 'existing.md', {
    editorOnlyRestored,
    clickedDiffAgain,
    restoredDiffSelection
  })
  if (!diffRestored || cancelled()) return results

  const clickedHistoryFromDiff = clickSubpageButton('history')
  const historyOpened = clickedHistoryFromDiff && await waitForGitHistoryOpen('from-diff')
  const historyShell = await waitFor('subpage-navigation-shell-history-visible', () => {
    const shells = getVisibleSubpageShells()
    return shells.length === 1 ? shells[0] : false
  }, 8000)
  _assert('SN-08-diff-switch-to-history', historyOpened, {
    clickedHistoryFromDiff,
    historyOpen: getGitHistoryApi()?.isOpen?.() ?? false
  })
  _assert('SN-08A-shared-shell-reused-on-history', Boolean(historyShell && historyShell === initialShell), {
    visibleShells: getVisibleSubpageShells().length,
    reusedShellNode: Boolean(historyShell && historyShell === initialShell)
  })
  if (!historyOpened || cancelled()) return results

  const historyButton = getSubpageButton('history')
  _assert('SN-09-history-switcher-current', Boolean(historyButton && historyButton.disabled), {
    disabled: historyButton?.disabled ?? null
  })
  const historyButtonsUniform = areVisibleShellButtonsUniform()
  _assert('SN-09A-history-header-buttons-uniform', historyButtonsUniform.ok, {
    metrics: historyButtonsUniform.metrics
  })

  const historyApi = getGitHistoryApi()
  const selectedUpdateCommit = historyApi?.selectCommitByIndex(1) === true
  const historyFilesLoaded = await waitFor('subpage-navigation-history-existing-file', () => {
    const api = getGitHistoryApi()
    return Boolean(api && !api.isLoading() && api.getFiles().some((file) => file.filename === 'existing.md'))
  }, 8000)
  const selectedExistingHistoryFile = await selectHistoryFileByPath('existing', 'existing.md')
  await sleep(500)
  const clickedDiffFromHistory = clickSubpageButton('diff')
  const diffOpenedFromHistory = clickedDiffFromHistory && await waitForGitDiffOpen('from-history')
  const clickedHistoryAgain = diffOpenedFromHistory && clickSubpageButton('history')
  const historyRestored = Boolean(clickedHistoryAgain) && await waitForGitHistoryOpen('restore-from-diff')
  const restoredHistoryFile = getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
  _assert('SN-10-diff-to-history-restores-history-selection', Boolean(selectedUpdateCommit && historyFilesLoaded && selectedExistingHistoryFile && historyRestored && restoredHistoryFile === 'existing.md'), {
    selectedUpdateCommit,
    historyFilesLoaded,
    selectedExistingHistoryFile,
    restoredHistoryFile
  })
  if (cancelled()) return results

  // Switching back to Editor via SubpageSwitcher should restore the
  // Editor's own previous state, NOT open History's selected file.
  const clickedEditorFromHistory = clickSubpageButton('editor')
  const historyToEditorOpened = clickedEditorFromHistory && await waitForProjectEditorFile('history-restores-editor-state', 'editor-only.md')
  _assert('SN-11-history-to-editor-restores-editor-state', historyToEditorOpened, {
    clickedEditorFromHistory,
    expected: 'editor-only.md',
    activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
  })
  if (cancelled()) return results

  await getProjectEditorApi()?.openFileByPathAsUser?.('editor-only.md', { trackRecent: true })
  const editorOnlyBeforeHistory = await waitForProjectEditorFile('editor-only-before-history', 'editor-only.md')
  const clickedHistoryFromEditor = clickSubpageButton('history')
  const historyOpenedFromEditor = clickedHistoryFromEditor && await waitForGitHistoryOpen('from-editor-restore')
  const restoredHistoryAfterEditor = getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
  _assert('SN-12-editor-to-history-restores-history-selection', Boolean(editorOnlyBeforeHistory && historyOpenedFromEditor && restoredHistoryAfterEditor === 'existing.md'), {
    editorOnlyBeforeHistory,
    clickedHistoryFromEditor,
    restoredHistoryAfterEditor
  })
  if (!historyOpenedFromEditor || cancelled()) return results

  // SN-13 / SN-14: SubpageSwitcher no longer passes the Diff/History
  // selected file to Editor.  Switching back should restore Editor's own
  // state regardless of what is selected in Diff/History.
  const selectedDeleteCommit = getGitHistoryApi()?.selectCommitByIndex(0) === true
  const deleteFilesLoaded = await waitFor('subpage-navigation-history-deleted-file', () => {
    const api = getGitHistoryApi()
    return Boolean(api && !api.isLoading() && api.getFiles().some((file) => file.filename === 'history-deleted.md'))
  }, 8000)
  const selectedDeletedHistoryFile = await selectHistoryFileByPath('deleted', 'history-deleted.md')
  await sleep(500)
  const clickedEditorMissingFromHistory = clickSubpageButton('editor')
  const historyDeletedRestored = clickedEditorMissingFromHistory && await waitForProjectEditorFile('history-deleted-restore', 'editor-only.md')
  _assert('SN-13-history-deleted-file-does-not-override-editor', Boolean(
    selectedDeleteCommit &&
    deleteFilesLoaded &&
    selectedDeletedHistoryFile &&
    historyDeletedRestored
  ), {
    selectedDeleteCommit,
    deleteFilesLoaded,
    selectedDeletedHistoryFile,
    expected: 'editor-only.md',
    activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
  })
  if (cancelled()) return results

  const clickedDiffForMissing = clickSubpageButton('diff')
  const diffOpenedForMissing = clickedDiffForMissing && await waitForGitDiffOpen('missing')
  const diffDeletedReady = await waitForDiffFile('deleted', 'diff-deleted.md')
  const selectedDeletedDiffFile = diffDeletedReady && getGitDiffApi()?.selectFileByPath('diff-deleted.md') === true
  await sleep(500)
  const clickedEditorMissingFromDiff = clickSubpageButton('editor')
  const diffDeletedRestored = clickedEditorMissingFromDiff && await waitForProjectEditorFile('diff-deleted-restore', 'editor-only.md')
  _assert('SN-14-diff-deleted-file-does-not-override-editor', Boolean(
    diffOpenedForMissing &&
    selectedDeletedDiffFile &&
    diffDeletedRestored
  ), {
    diffOpenedForMissing,
    selectedDeletedDiffFile,
    expected: 'editor-only.md',
    activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null
  })

  if (getGitHistoryApi()?.isOpen()) {
    dispatchEscape()
    await sleep(400)
  }
  if (getGitDiffApi()?.isOpen()) {
    dispatchEscape()
    await sleep(400)
  }

  return results
}
