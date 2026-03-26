/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 6: Stress Test
 */
import type { AutotestContext, TestResult, CpuSummary } from './types'

export async function testStress(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, startCpuSampler, stopCpuSampler, reopenProjectEditor } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase6:start', { suite: 'Stress' })

  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const getHistoryApi = () => window.__onwardGitHistoryDebug
  const getPromptSenderApi = () => window.__onwardPromptSenderDebug

  // ST-01: Git Diff quick switch 10 times
  if (!cancelled()) {
    startCpuSampler()
    let allOk = true
    for (let i = 0; i < 10; i++) {
      if (cancelled()) break
      window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
      const opened = await waitFor(`st01-open-${i}`, () => {
        const api = getGitDiffApi()
        return Boolean(api?.isOpen())
      }, 6000)
      if (!opened) { allOk = false; break }
      await sleep(200)
      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      await waitFor(`st01-close-${i}`, () => {
        const api = getGitDiffApi()
        return !api || !api.isOpen()
      }, 4000)
      await sleep(100)
    }
    const cpu = stopCpuSampler()
    _assert('ST-01-gitdiff-rapid-toggle', allOk, {
      iterations: 10,
      allOk,
      cpuAvg: cpu.totalAvg,
      cpuMax: cpu.totalMax
    })
    await reopenProjectEditor('st01-cleanup')
    await sleep(300)
  }

  // ST-02: Git History quick switch 10 times
  if (!cancelled()) {
    startCpuSampler()
    let allOk = true
    for (let i = 0; i < 10; i++) {
      if (cancelled()) break
      window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
      const opened = await waitFor(`st02-open-${i}`, () => {
        const api = getHistoryApi()
        return Boolean(api?.isOpen())
      }, 6000)
      if (!opened) { allOk = false; break }
      await sleep(200)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      await waitFor(`st02-close-${i}`, () => {
        const api = getHistoryApi()
        return !api || !api.isOpen()
      }, 4000)
      await sleep(100)
    }
    const cpu = stopCpuSampler()
    _assert('ST-02-githistory-rapid-toggle', allOk, {
      iterations: 10,
      allOk,
      cpuAvg: cpu.totalAvg,
      cpuMax: cpu.totalMax
    })
    await sleep(300)
  }

  // ST-03: ProjectEditor↔GitDiff switch 10 times
  if (!cancelled()) {
    startCpuSampler()
    let allOk = true
    for (let i = 0; i < 10; i++) {
      if (cancelled()) break
      // Open GitDiff
      window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
      const diffOpened = await waitFor(`st03-diff-${i}`, () => {
        const api = getGitDiffApi()
        return Boolean(api?.isOpen())
      }, 6000)
      if (!diffOpened) { allOk = false; break }
      await sleep(150)

      // Close GitDiff → Return to ProjectEditor
      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      await sleep(150)
      const peOpened = await reopenProjectEditor(`st03-pe-${i}`)
      if (!peOpened) { allOk = false; break }
      await sleep(150)
    }
    const cpu = stopCpuSampler()
    _assert('ST-03-pe-diff-toggle', allOk, {
      iterations: 10,
      allOk,
      cpuAvg: cpu.totalAvg,
      cpuMax: cpu.totalMax
    })
    await sleep(300)
  }

  // ST-04: GitDiff→GitHistory→return 5 times
  if (!cancelled()) {
    startCpuSampler()
    let allOk = true
    for (let i = 0; i < 5; i++) {
      if (cancelled()) break
      // GitDiff
      window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
      const diffOpened = await waitFor(`st04-diff-${i}`, () => {
        const api = getGitDiffApi()
        return Boolean(api?.isOpen())
      }, 6000)
      if (!diffOpened) { allOk = false; break }
      await sleep(200)

      // GitHistory (GitDiff should be turned off)
      window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
      const histOpened = await waitFor(`st04-hist-${i}`, () => {
        const api = getHistoryApi()
        return Boolean(api?.isOpen())
      }, 6000)
      if (!histOpened) { allOk = false; break }
      await sleep(200)

      // Close History
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      await waitFor(`st04-hist-close-${i}`, () => {
        const api = getHistoryApi()
        return !api || !api.isOpen()
      }, 4000)
      await sleep(200)
    }
    const cpu = stopCpuSampler()
    _assert('ST-04-diff-history-cycle', allOk, {
      iterations: 5,
      allOk,
      cpuAvg: cpu.totalAvg,
      cpuMax: cpu.totalMax
    })
    await sleep(300)
  }

  // ST-05: PromptSender quickly operates 20 times
  if (!cancelled()) {
    const api = getPromptSenderApi()
    if (api) {
      startCpuSampler()
      let allOk = true
      const cards = api.getTerminalCards()
      if (cards.length > 0) {
        for (let i = 0; i < 20; i++) {
          if (cancelled()) break
          const targetId = cards[i % cards.length].id
          if (i % 2 === 0) {
            api.selectTerminal(targetId)
          } else {
            api.deselectTerminal(targetId)
          }
          await sleep(50)
        }
      } else {
        allOk = false
      }
      const cpu = stopCpuSampler()
      _assert('ST-05-prompt-sender-rapid', allOk, {
        iterations: 20,
        allOk,
        cardCount: cards.length,
        cpuAvg: cpu.totalAvg,
        cpuMax: cpu.totalMax
      })
    } else {
      results.push({ name: 'ST-05-prompt-sender-rapid', ok: false, detail: { reason: 'API not available' } })
    }
  }

  log('phase6:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
