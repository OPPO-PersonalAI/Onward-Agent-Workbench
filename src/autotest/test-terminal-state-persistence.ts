/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import { buildChangeDirectoryCommand } from '../utils/terminal-command'

function joinPath(base: string, name: string): string {
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${name}`
}

function getActiveTabState(appState: Awaited<ReturnType<typeof window.electronAPI.appState.load>>) {
  return appState.tabs.find((tab) => tab.id === appState.activeTabId) ?? null
}

function openPromptPanel(): void {
  if (document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor')) {
    return
  }
  const buttons = Array.from(document.querySelectorAll('.sidebar .sidebar-btn')) as HTMLButtonElement[]
  buttons[0]?.click()
}

function switchToDoubleLayout(): void {
  const buttons = Array.from(document.querySelectorAll('.sidebar .sidebar-btn')) as HTMLButtonElement[]
  buttons[2]?.click()
}

function dragPromptEditorHeight(deltaY: number): boolean {
  const editor = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor') as HTMLElement | null
  const resizer = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor-resizer') as HTMLElement | null
  if (!editor || !resizer) return false

  const rect = editor.getBoundingClientRect()
  const startX = rect.left + 16
  const startY = rect.top + 4
  resizer.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    clientX: startX,
    clientY: startY
  }))
  document.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true,
    cancelable: true,
    clientX: startX,
    clientY: startY - deltaY
  }))
  document.dispatchEvent(new MouseEvent('mouseup', {
    bubbles: true,
    cancelable: true,
    clientX: startX,
    clientY: startY - deltaY
  }))
  return true
}

export async function testTerminalStatePersistence(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, rootPath } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }
  const waitForAppState = async (
    label: string,
    predicate: (tab: NonNullable<ReturnType<typeof getActiveTabState>>) => boolean,
    timeoutMs: number = 8000
  ): Promise<boolean> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const appState = await window.electronAPI.appState.load()
      const activeTab = getActiveTabState(appState)
      if (activeTab && predicate(activeTab)) {
        return true
      }
      await sleep(120)
    }
    log(`${label}:timeout`)
    return false
  }
  const waitForTerminalCwd = async (terminalId: string, expectedCwd: string, timeoutMs: number = 8000): Promise<boolean> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const cwd = await window.electronAPI.git.getTerminalCwd(terminalId)
      if (cwd === expectedCwd) {
        return true
      }
      await sleep(150)
    }
    return false
  }
  const getPromptDebug = () => window.__onwardPromptNotebookDebug

  log('phase1.1:start', { suite: 'TerminalStatePersistence' })

  openPromptPanel()
  const promptReady = await waitFor(
    'terminal-state:persist:prompt-visible',
    () => Boolean(document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor')),
    8000
  )
  _assert('TSP-01-prompt-visible', promptReady)
  if (!promptReady || cancelled()) return results

  const promptDebugReady = await waitFor(
    'terminal-state:persist:prompt-debug',
    () => Boolean(window.__onwardPromptNotebookDebug),
    8000
  )
  _assert('TSP-01b-prompt-debug-ready', promptDebugReady)
  if (!promptDebugReady || cancelled()) return results

  switchToDoubleLayout()
  const terminalDebugReady = await waitFor(
    'terminal-state:persist:terminal-debug',
    () => Boolean(window.__onwardTerminalDebug),
    8000
  )
  _assert('TSP-01c-terminal-debug-ready', terminalDebugReady)
  if (!terminalDebugReady || cancelled()) return results

  const terminalsReady = await waitFor(
    'terminal-state:persist:two-terminals',
    () => (window.__onwardTerminalDebug?.getTerminalIds()?.length ?? 0) >= 2,
    10000
  )
  const terminalIds = window.__onwardTerminalDebug?.getTerminalIds() ?? []
  _assert('TSP-02-two-terminals-ready', terminalsReady, {
    terminalIds
  })
  if (!terminalsReady || terminalIds.length < 2 || cancelled()) return results

  const [terminalA, terminalB] = terminalIds
  const cwdA = rootPath
  const cwdB = joinPath(rootPath, 'src')
  const platform = window.electronAPI.platform

  await window.electronAPI.terminal.write(terminalA, buildChangeDirectoryCommand(platform, cwdA))
  await window.electronAPI.terminal.write(terminalB, buildChangeDirectoryCommand(platform, cwdB))
  await sleep(700)
  await window.electronAPI.git.notifyTerminalActivity(terminalA)
  await window.electronAPI.git.notifyTerminalActivity(terminalB)

  const cwdReady = await Promise.all([
    waitForTerminalCwd(terminalA, cwdA),
    waitForTerminalCwd(terminalB, cwdB)
  ]).then((values) => values.every(Boolean))
  const cwdPersisted = await waitForAppState(
    'terminal-state:persist:cwd-app-state',
    (activeTab) => {
      const terminalStateA = activeTab.terminals.find((terminal) => terminal.id === terminalA)
      const terminalStateB = activeTab.terminals.find((terminal) => terminal.id === terminalB)
      return terminalStateA?.lastCwd === cwdA && terminalStateB?.lastCwd === cwdB
    }
  )

  const cwdActualA = await window.electronAPI.git.getTerminalCwd(terminalA)
  const cwdActualB = await window.electronAPI.git.getTerminalCwd(terminalB)
  const appStateAfterCwd = await window.electronAPI.appState.load()
  const activeTabAfterCwd = getActiveTabState(appStateAfterCwd)
  const persistedTerminalA = activeTabAfterCwd?.terminals.find((terminal) => terminal.id === terminalA) ?? null
  const persistedTerminalB = activeTabAfterCwd?.terminals.find((terminal) => terminal.id === terminalB) ?? null

  const cwdObserved = cwdActualA === cwdA && cwdActualB === cwdB
  _assert('TSP-03-terminal-cwd-observed', cwdReady && cwdObserved, {
    terminalA,
    terminalB,
    expectedA: cwdA,
    expectedB: cwdB,
    actualA: cwdActualA,
    actualB: cwdActualB
  })

  const cwdSaved = persistedTerminalA?.lastCwd === cwdA && persistedTerminalB?.lastCwd === cwdB
  _assert('TSP-04-terminal-cwd-persisted', cwdPersisted && cwdSaved, {
    terminalA: persistedTerminalA,
    terminalB: persistedTerminalB
  })

  const initialHeight = getPromptDebug()?.getPersistedEditorHeight() ?? null
  const dragApplied = dragPromptEditorHeight(120)
  _assert('TSP-05-editor-height-drag-applied', dragApplied, {
    initialHeight
  })
  if (!dragApplied || cancelled()) return results

  const heightPersisted = await waitFor(
    'terminal-state:persist:editor-height',
    () => {
      const nextHeight = getPromptDebug()?.getPersistedEditorHeight() ?? null
      return typeof initialHeight === 'number' && typeof nextHeight === 'number' && nextHeight >= initialHeight + 100
    },
    5000
  )

  const persistedHeight = getPromptDebug()?.getPersistedEditorHeight() ?? null
  const liveHeight = getPromptDebug()?.getEditorHeight() ?? null
  _assert('TSP-06-editor-height-persisted', heightPersisted, {
    initialHeight,
    persistedHeight,
    liveHeight
  })
  if (!heightPersisted || typeof persistedHeight !== 'number' || cancelled()) return results

  getPromptDebug()?.setEditorContent('temporary persistence draft')
  const draftReady = await waitForAppState(
    'terminal-state:persist:draft-ready',
    (activeTab) => Boolean(activeTab.editorDraft?.content)
  )
  _assert('TSP-07-editor-draft-created', draftReady, {
    content: 'temporary persistence draft'
  })
  if (!draftReady || cancelled()) return results

  await sleep(400)
  getPromptDebug()?.setEditorContent('')

  const draftCleared = await waitForAppState(
    'terminal-state:persist:draft-cleared',
    (activeTab) => !activeTab.editorDraft
  )

  const finalState = await window.electronAPI.appState.load()
  const finalTab = getActiveTabState(finalState)
  const hasDraft = Boolean(finalTab?.editorDraft)
  const finalPromptHeight = finalTab?.promptEditorHeight ?? null

  _assert('TSP-08-editor-draft-cleared', draftCleared && !hasDraft, {
    editorDraft: finalTab?.editorDraft ?? null
  })
  _assert('TSP-09-editor-height-survives-empty-draft', finalPromptHeight === persistedHeight, {
    expected: persistedHeight,
    actual: finalPromptHeight
  })

  log('phase1.1:done', {
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length
  })

  return results
}
