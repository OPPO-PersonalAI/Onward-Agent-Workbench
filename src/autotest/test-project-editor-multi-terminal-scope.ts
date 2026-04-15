/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 0.7: ProjectEditor multi-terminal isolation recovery test in the same directory
 */
import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand, type TerminalShellKind } from '../utils/terminal-command'

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
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

async function resolveTerminalShellKind(terminalId: string): Promise<TerminalShellKind | undefined> {
  try {
    return (await window.electronAPI.terminal.getInputCapabilities(terminalId)).shellKind
  } catch {
    return undefined
  }
}

async function waitForTerminalCwd(
  terminalId: string,
  expectedCwd: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 10000
): Promise<string | null> {
  const startedAt = performance.now()
  const normalizedExpected = normalizePath(expectedCwd)
  while (performance.now() - startedAt < timeoutMs) {
    const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
    if (cwd && normalizePath(cwd) === normalizedExpected) {
      return cwd
    }
    await sleep(150)
  }
  return null
}

async function waitForPersistedState(
  stateKey: string,
  expectedFilePath: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 10000
) {
  const startedAt = performance.now()
  while (performance.now() - startedAt < timeoutMs) {
    const appState = await window.electronAPI.appState.load()
    const entry = appState.projectEditorStates?.[stateKey] ?? null
    if (entry?.activeFilePath === expectedFilePath) {
      return entry
    }
    await sleep(160)
  }
  return null
}

export async function testProjectEditorMultiTerminalScope(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath, openFileInEditor } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug
  const waitForEditorClosedOrReset = async (label: string) => {
    return await waitFor(
      label,
      () => {
        const api = getApi()
        if (!api?.isOpen) return true
        if (!api.isOpen()) return true
        return (api.getActiveFilePath?.() ?? null) === null
      },
      8000
    )
  }
  const tempPathA = `onward-autotest-multi-terminal-a-${Date.now()}.md`
  const tempPathB = `onward-autotest-multi-terminal-b-${Date.now()}.md`
  const contentA = Array.from({ length: 40 }, (_, idx) => `terminal-a-line-${idx + 1}`).join('\n')
  const contentB = Array.from({ length: 40 }, (_, idx) => `terminal-b-line-${idx + 1}`).join('\n')

  log('phase0.7:start', { suite: 'ProjectEditorMultiTerminalScope', rootPath, tempPathA, tempPathB })

  const layoutButton = document.querySelector<HTMLButtonElement>('button[title="Two terminals"]')
  layoutButton?.click()
  const hasTwoTerminals = await waitFor(
    'phase0.7-layout-two-terminals',
    () => getVisibleTerminalIds().length >= 2,
    10000
  )
  _assert('PEMS-01-layout-two-terminals', hasTwoTerminals, {
    visibleTerminalIds: getVisibleTerminalIds()
  })
  if (!hasTwoTerminals || cancelled()) return results

  const terminalIds = getVisibleTerminalIds()
  const terminalA = terminalIds[0] ?? null
  const terminalB = terminalIds[1] ?? null
  const terminalPairValid = Boolean(terminalA && terminalB && terminalA !== terminalB)
  _assert('PEMS-02-terminal-pair-valid', terminalPairValid, { terminalA, terminalB, terminalIds })
  if (!terminalPairValid || !terminalA || !terminalB || cancelled()) return results

  const createA = await window.electronAPI.project.createFile(rootPath, tempPathA, contentA)
  _assert('PEMS-03-create-file-a', createA.success, { error: createA.error, tempPathA })
  if (!createA.success || cancelled()) return results
  const createB = await window.electronAPI.project.createFile(rootPath, tempPathB, contentB)
  _assert('PEMS-04-create-file-b', createB.success, { error: createB.error, tempPathB })
  if (!createB.success || cancelled()) return results

  const platform = window.electronAPI.platform
  const shellKindA = await resolveTerminalShellKind(terminalA)
  const shellKindB = await resolveTerminalShellKind(terminalB)
  const cdCommandA = buildChangeDirectoryCommand(platform, rootPath, shellKindA)
  const cdCommandB = buildChangeDirectoryCommand(platform, rootPath, shellKindB)

  await window.electronAPI.terminal.write(terminalA, cdCommandA)
  await window.electronAPI.terminal.write(terminalB, cdCommandB)
  await window.electronAPI.git.notifyTerminalActivity(terminalA)
  await window.electronAPI.git.notifyTerminalActivity(terminalB)

  const cwdA = await waitForTerminalCwd(terminalA, rootPath, sleep)
  _assert('PEMS-05-terminal-a-cwd-ready', Boolean(cwdA), {
    terminalId: terminalA,
    expected: normalizePath(rootPath),
    actual: cwdA ? normalizePath(cwdA) : null
  })
  if (!cwdA || cancelled()) return results

  const cwdB = await waitForTerminalCwd(terminalB, rootPath, sleep)
  _assert('PEMS-06-terminal-b-cwd-ready', Boolean(cwdB), {
    terminalId: terminalB,
    expected: normalizePath(rootPath),
    actual: cwdB ? normalizePath(cwdB) : null
  })
  if (!cwdB || cancelled()) return results

  try {
    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
    const openedA = await waitFor(
      'phase0.7-open-editor-a',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-07-open-editor-a', openedA, { terminalId: terminalA })
    if (!openedA || cancelled()) return results

    await openFileInEditor(tempPathA)
    const openedFileA = await waitFor(
      'phase0.7-open-file-a',
      () => getApi()?.getActiveFilePath?.() === tempPathA,
      8000
    )
    _assert('PEMS-08-open-file-a', openedFileA, {
      expected: tempPathA,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openedFileA || cancelled()) return results

    await sleep(240)
    dispatchEscape()
    const closedA = await waitForEditorClosedOrReset('phase0.7-close-editor-a')
    _assert('PEMS-09-close-editor-a', closedA, { closedA })
    if (!closedA || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalB } }))
    const openedB = await waitFor(
      'phase0.7-open-editor-b',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-10-open-editor-b', openedB, { terminalId: terminalB })
    if (!openedB || cancelled()) return results

    await openFileInEditor(tempPathB)
    const openedFileB = await waitFor(
      'phase0.7-open-file-b',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('PEMS-11-open-file-b', openedFileB, {
      expected: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!openedFileB || cancelled()) return results

    await sleep(240)
    dispatchEscape()
    const closedB = await waitForEditorClosedOrReset('phase0.7-close-editor-b')
    _assert('PEMS-12-close-editor-b', closedB, { closedB })
    if (!closedB || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalA } }))
    const reopenedA = await waitFor(
      'phase0.7-reopen-editor-a',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-13-reopen-editor-a', reopenedA, { terminalId: terminalA })
    if (!reopenedA || cancelled()) return results

    const restoredA = await waitFor(
      'phase0.7-restore-a-file',
      () => getApi()?.getActiveFilePath?.() === tempPathA,
      8000
    )
    _assert('PEMS-14-restore-a-file', restoredA, {
      expected: tempPathA,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!restoredA || cancelled()) return results

    const notCrossRestored = getApi()?.getActiveFilePath?.() !== tempPathB
    _assert('PEMS-15-no-cross-restore-a-to-b', Boolean(notCrossRestored), {
      disallowed: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })

    await sleep(240)
    dispatchEscape()
    const closedAfterAReopen = await waitForEditorClosedOrReset('phase0.7-close-editor-after-a-reopen')
    _assert('PEMS-16-close-editor-after-a-reopen', closedAfterAReopen, { closedAfterAReopen })
    if (!closedAfterAReopen || cancelled()) return results

    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: terminalB } }))
    const reopenedB = await waitFor(
      'phase0.7-reopen-editor-b',
      () => Boolean(getApi()?.isOpen?.()),
      8000
    )
    _assert('PEMS-17-reopen-editor-b', reopenedB, { terminalId: terminalB })
    if (!reopenedB || cancelled()) return results

    const restoredB = await waitFor(
      'phase0.7-restore-b-file',
      () => getApi()?.getActiveFilePath?.() === tempPathB,
      8000
    )
    _assert('PEMS-18-restore-b-file', restoredB, {
      expected: tempPathB,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })

    const normalizedRoot = normalizePath(rootPath)
    const stateKeyA = JSON.stringify([terminalA, normalizedRoot])
    const stateKeyB = JSON.stringify([terminalB, normalizedRoot])
    const stateA = await waitForPersistedState(stateKeyA, tempPathA, sleep)
    const stateB = await waitForPersistedState(stateKeyB, tempPathB, sleep)
    _assert('PEMS-19-state-key-a-persisted', Boolean(stateA), {
      stateKeyA,
      activeFilePath: stateA?.activeFilePath ?? null
    })
    _assert('PEMS-20-state-key-b-persisted', Boolean(stateB), {
      stateKeyB,
      activeFilePath: stateB?.activeFilePath ?? null
    })
  } finally {
    dispatchEscape()
    await sleep(200)
    await window.electronAPI.project.deletePath(rootPath, tempPathA)
    await window.electronAPI.project.deletePath(rootPath, tempPathB)
    const singleLayoutButton = document.querySelector<HTMLButtonElement>('button[title="Single terminal"]')
    singleLayoutButton?.click()
    log('phase0.7:cleanup', { tempPathA, tempPathB, resetLayout: true })
  }

  return results
}
