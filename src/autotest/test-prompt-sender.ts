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

  log('phase1:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
