/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 1: PromptSender UI test (agent_selector branch)
 */
import type { AutotestContext, TestResult } from './types'

export async function testPromptSender(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase1:start', { suite: 'PromptSender' })

  const getApi = () => window.__onwardPromptSenderDebug
  const getPromptNotebookApi = () => window.__onwardPromptNotebookDebug
  const getTerminalDebugApi = () => window.__onwardTerminalDebug
  const apiReady = await waitFor('prompt-sender-api', () => Boolean(getApi()), 8000)
  if (!apiReady) {
    log('phase1:skip', { reason: 'PromptSender Debug API not available' })
    results.push({ name: 'PS-00-api-available', ok: false, detail: { reason: 'API not mounted' } })
    return results
  }

  // PS-01: Terminal card rendering
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    _assert('PS-01-terminal-cards', cards.length > 0, {
      count: cards.length,
      sample: cards.slice(0, 3).map(c => ({ id: c.id, title: c.title }))
    })
  }

  // PS-02: 2-column Grid layout
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const expectedRows = Math.max(1, Math.ceil(layout.totalCards / 2))
    const gridElement = document.querySelector('.prompt-sender-terminals') as HTMLElement | null
    const gridAutoFlow = gridElement ? window.getComputedStyle(gridElement).gridAutoFlow : null
    const isRowFlow = typeof gridAutoFlow === 'string' && gridAutoFlow.startsWith('row')
    _assert('PS-02-grid-layout', layout.columns === 2 && layout.rows === expectedRows && isRowFlow, {
      columns: layout.columns,
      rows: layout.rows,
      totalCards: layout.totalCards,
      expectedRows,
      gridAutoFlow
    })
  }

  // PS-03: Click to select the terminal
  if (!cancelled()) {
    const cards = getApi()!.getTerminalCards()
    if (cards.length > 0) {
      getApi()!.deselectAllTerminals()
      await sleep(200)
      const targetId = cards[0].id
      const selected = getApi()!.selectTerminal(targetId)
      await sleep(200)
      const selectedIds = getApi()!.getSelectedTerminalIds()
      _assert('PS-03-select-terminal', selected && selectedIds.includes(targetId), {
        targetId,
        selected,
        selectedIds
      })
    } else {
      results.push({ name: 'PS-03-select-terminal', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-04: Click to uncheck
  if (!cancelled()) {
    const cards = getApi()!.getTerminalCards()
    if (cards.length > 0) {
      const targetId = cards[0].id
      getApi()!.selectTerminal(targetId)
      await sleep(200)
      getApi()!.deselectTerminal(targetId)
      await sleep(200)
      const selectedIds = getApi()!.getSelectedTerminalIds()
      _assert('PS-04-deselect-terminal', !selectedIds.includes(targetId), {
        targetId,
        selectedIds
      })
    } else {
      results.push({ name: 'PS-04-deselect-terminal', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-05: 4 operation buttons
  if (!cancelled()) {
    const api = getApi()!
    const buttons = api.getActionButtons()
    const expectedLabels = ['Send and execute', 'Execute', 'Send', 'Send all and execute']
    const labelsMatch = buttons.length === 4 &&
      buttons.every((btn, i) => btn.label.includes(expectedLabels[i].substring(0, 2)))
    _assert('PS-05-action-buttons', buttons.length === 4 && labelsMatch, {
      count: buttons.length,
      labels: buttons.map(b => b.label),
      expected: expectedLabels
    })
  }

  // PS-06: Button disabled when unselected
  if (!cancelled()) {
    const api = getApi()!
    api.deselectAllTerminals()
    await sleep(100)
    const buttons = api.getActionButtons()
    // The first 3 buttons (Send and Execute, Execute, Send) should be disabled
    const first3Disabled = buttons.slice(0, 3).every(b => b.disabled)
    _assert('PS-06-buttons-disabled', first3Disabled, {
      buttonStates: buttons.map(b => ({ label: b.label, disabled: b.disabled }))
    })
  }

  // PS-07: Quickly select/cancel 20 times
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    if (cards.length > 0) {
      const targetId = cards[0].id
      api.deselectAllTerminals()
      let lastState = false
      for (let i = 0; i < 20; i++) {
        if (cancelled()) break
        if (i % 2 === 0) {
          api.selectTerminal(targetId)
          lastState = true
        } else {
          api.deselectTerminal(targetId)
          lastState = false
        }
        await sleep(50)
      }
      const finalIds = api.getSelectedTerminalIds()
      const expected = lastState
      const actual = finalIds.includes(targetId)
      _assert('PS-07-rapid-toggle', actual === expected, {
        iterations: 20,
        expected,
        actual,
        finalIds
      })
    } else {
      results.push({ name: 'PS-07-rapid-toggle', ok: false, detail: { reason: 'no terminals' } })
    }
  }

  // PS-08: Multi-terminal layout detection (depends on the current number of terminals)
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    const layout = api.getGridLayout()
    _assert('PS-08-layout-consistency', layout.totalCards === cards.length, {
      totalCards: layout.totalCards,
      actualCards: cards.length,
      columns: layout.columns,
      rows: layout.rows
    })
  }

  // PS-09: Single-line send-and-execute still runs end to end
  if (!cancelled()) {
    const notebookApi = getPromptNotebookApi()
    const terminalApi = getTerminalDebugApi()
    const cards = getApi()?.getTerminalCards() ?? []
    if (getApi() && notebookApi && terminalApi && cards.length > 0) {
      const platform = window.electronAPI.platform
      const targetId = cards[0].id
      const marker = `PS09-${Date.now()}`
      const command = platform === 'win32'
        ? `Write-Output '${marker}'`
        : `printf '${marker}\\n'`

      getApi()!.deselectAllTerminals()
      await sleep(100)
      getApi()!.selectTerminal(targetId)
      await sleep(100)
      notebookApi.setEditorContent(command)
      const editorSynced = await waitFor('ps09-editor-sync', () => {
        return getPromptNotebookApi()?.getEditorContent() === command
      }, 3000, 80)
      const senderPromptReady = await waitFor('ps09-sender-ready', () => {
        const buttons = getApi()?.getActionButtons() ?? []
        return buttons[3]?.disabled === false
      }, 3000, 80)

      const clicked = await getApi()!.clickAction('sendAndExecute')
      const idle = await waitFor('ps09-send-and-execute-idle', () => {
        return Boolean(getApi() && !getApi()!.isSubmitting())
      }, platform === 'win32' ? 10000 : 6000, 100)
      const executed = await waitFor('ps09-send-and-execute', () => {
        const tail = terminalApi.getTailText(targetId, 40) ?? ''
        return tail.includes(marker)
      }, platform === 'win32' ? 8000 : 5000, 100)

      _assert('PS-09-send-and-execute-single-line', editorSynced && senderPromptReady && clicked && idle && executed, {
        targetId,
        marker,
        editorSynced,
        senderPromptReady,
        clicked,
        idle,
        platform,
        selectedIds: getApi()?.getSelectedTerminalIds() ?? [],
        notice: getApi()?.getNotice() ?? null,
        buttonStates: getApi()?.getActionButtons() ?? [],
        editorContent: getPromptNotebookApi()?.getEditorContent() ?? null,
        tail: terminalApi.getTailText(targetId, 40)
      })

      notebookApi.setEditorContent('')
      await sleep(100)
    } else {
      results.push({
        name: 'PS-09-send-and-execute-single-line',
        ok: false,
        detail: { reason: 'debug api unavailable or no terminals' }
      })
    }
  }

  log('phase1:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
