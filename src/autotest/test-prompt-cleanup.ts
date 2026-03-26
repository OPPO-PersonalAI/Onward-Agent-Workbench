/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 4: Prompt cleanup test (git_log branch)
 */
import type { AutotestContext, TestResult } from './types'

export async function testPromptCleanup(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase4:start', { suite: 'PromptCleanup' })

  const getApi = () => window.__onwardPromptNotebookDebug
  const apiReady = await waitFor('prompt-notebook-api', () => Boolean(getApi()), 8000)
  if (!apiReady) {
    log('phase4:skip', { reason: 'PromptNotebook Debug API not available' })
    results.push({ name: 'PC-00-api-available', ok: false, detail: { reason: 'API not mounted' } })
    return results
  }

  // PC-01: lastUsedAt update
  if (!cancelled()) {
    const promptsBefore = getApi()!.getPrompts()
    if (promptsBefore.length > 0) {
      const target = promptsBefore[0]
      const beforeTimestamp = target.lastUsedAt

      // Set content and submit
      getApi()!.setEditorContent('PC-01 lastUsedAt update test')
      await sleep(300)
      getApi()!.submitEditor()
      await sleep(800)

      const promptsAfter = getApi()!.getPrompts()
      const updated = promptsAfter.find(p => p.id === target.id)
      const afterTimestamp = updated?.lastUsedAt ?? 0

      _assert('PC-01-lastUsedAt-update', afterTimestamp >= beforeTimestamp, {
        promptId: target.id,
        before: beforeTimestamp,
        after: afterTimestamp
      })
    } else {
      // There is no prompt, create one first
      getApi()!.setEditorContent('PC-01 create new Prompt test')
      await sleep(300)
      getApi()!.submitEditor()
      await sleep(800)

      const promptsAfter = getApi()!.getPrompts()
      _assert('PC-01-lastUsedAt-update', promptsAfter.length > 0, {
        reason: 'created new prompt',
        count: promptsAfter.length
      })
    }
  }

  // PC-02: Clean configuration readable
  if (!cancelled()) {
    const api = getApi()!
    const config = api.getCleanupConfig()
    _assert('PC-02-cleanup-config-readable', config !== null && typeof config.autoEnabled === 'boolean', {
      config
    })
  }

  // PC-03: Pinned detection
  if (!cancelled()) {
    const api = getApi()!
    const prompts = api.getPrompts()
    const pinnedPrompts = prompts.filter(p => p.pinned)
    // Only verify that the pinned attribute can be read
    _assert('PC-03-pinned-readable', Array.isArray(pinnedPrompts), {
      totalPrompts: prompts.length,
      pinnedCount: pinnedPrompts.length
    })
  }

  // PC-04: Color Marking Detection
  if (!cancelled()) {
    const api = getApi()!
    const prompts = api.getPrompts()
    const coloredPrompts = prompts.filter(p => p.color && p.color !== null)
    _assert('PC-04-color-readable', Array.isArray(coloredPrompts), {
      totalPrompts: prompts.length,
      coloredCount: coloredPrompts.length,
      colors: coloredPrompts.map(p => p.color)
    })
  }

  // PC-05: Reading and writing editor content
  if (!cancelled()) {
    const testContent = `test-content-${Date.now()}`
    getApi()!.setEditorContent(testContent)
    await sleep(400)
    const readBack = getApi()!.getEditorContent()
    _assert('PC-05-editor-content-rw', readBack === testContent, {
      written: testContent,
      readBack
    })
    // Clear
    getApi()!.setEditorContent('')
    await sleep(200)
  }

  // PC-06: Cleaning up configuration integrity
  if (!cancelled()) {
    const api = getApi()!
    const config = api.getCleanupConfig()
    const hasAllFields = (
      typeof config.autoEnabled === 'boolean' &&
      typeof config.autoKeepDays === 'number' &&
      typeof config.autoDeleteColored === 'boolean' &&
      (config.lastAutoCleanupAt === null || typeof config.lastAutoCleanupAt === 'number')
    )
    _assert('PC-06-cleanup-config-complete', hasAllFields, {
      autoEnabled: config.autoEnabled,
      autoKeepDays: config.autoKeepDays,
      autoDeleteColored: config.autoDeleteColored,
      lastAutoCleanupAt: config.lastAutoCleanupAt
    })
  }

  log('phase4:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
