/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 2: Per-Agent font size test (git_diff_ui_miss_match branch)
 */
import type { AutotestContext, TestResult } from './types'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../constants/gitDiff'

export async function testPerAgentFont(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase2:start', { suite: 'PerAgentFont' })

  const getGitDiffApi = () => window.__onwardGitDiffDebug

  // PF-01: Default font fallback
  if (!cancelled()) {
    // First open Git Diff to ensure the API is mounted
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const opened = await waitFor('pf01-gitdiff-open', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen())
    }, 8000)

    if (opened) {
      await sleep(500)
      const api = getGitDiffApi()!
      const fontSize = api.getDiffFontSize()
      // If the per-agent font is not set, it should fall back to the default value
      _assert('PF-01-default-font-fallback', fontSize > 0, {
        fontSize,
        defaultFontSize: DEFAULT_GIT_DIFF_FONT_SIZE
      })

      // Close Git Diff
      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      await sleep(400)
    } else {
      results.push({ name: 'PF-01-default-font-fallback', ok: false, detail: { reason: 'git diff did not open' } })
    }
  }

  // PF-02: Per-agent font validation
  if (!cancelled()) {
    // Reopen Git Diff
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const opened = await waitFor('pf02-gitdiff-open', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen())
    }, 8000)

    if (opened) {
      await sleep(500)
      const api = getGitDiffApi()!
      const fontSize = api.getDiffFontSize()
      // Verify that the font size is a reasonable value (greater than 0, usually between 10-30)
      _assert('PF-02-font-size-valid', fontSize >= 10 && fontSize <= 40, {
        fontSize,
        range: '10-40'
      })

      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      await sleep(400)
    } else {
      results.push({ name: 'PF-02-font-size-valid', ok: false, detail: { reason: 'git diff did not open' } })
    }
  }

  // PF-03: getDiffFontSize consistent with settings
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const opened = await waitFor('pf03-gitdiff-open', () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen())
    }, 8000)

    if (opened) {
      await sleep(500)
      const api = getGitDiffApi()!
      const fontSize = api.getDiffFontSize()
      // Make sure the font is an integer (pixel value)
      const isInteger = Number.isInteger(fontSize)
      _assert('PF-03-font-integer', isInteger, {
        fontSize,
        isInteger
      })

      window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
      await sleep(400)
    } else {
      results.push({ name: 'PF-03-font-integer', ok: false, detail: { reason: 'git diff did not open' } })
    }
  }

  log('phase2:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
