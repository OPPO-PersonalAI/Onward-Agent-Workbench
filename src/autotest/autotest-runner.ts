/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automated test master orchestrator
 *
 * Called from ProjectEditor's autotest useEffect, all test suites are executed sequentially by stage.
 */
import type { AutotestContext, TestResult, TestSuiteResult } from './types'
import { testPromptSender } from './test-prompt-sender'
import { testPerAgentFont } from './test-per-agent-font'
import { testGitHistory } from './test-git-history'
import { testPromptCleanup } from './test-prompt-cleanup'
import { testSchedule } from './test-schedule'
import { testRegression } from './test-regression'
import { testStress } from './test-stress'
import { testProjectEditorRestore } from './test-project-editor-restore'
import { testProjectEditorRestoreUnit } from './test-project-editor-restore-unit'
import { testProjectEditorOpenPosition } from './test-project-editor-open-position'
import { testGitDiffSubdir } from './test-git-diff-subdir'
import { testGitCrossPlatform } from './test-git-cross-platform'
import { testProjectEditorMultiTerminalScope } from './test-project-editor-multi-terminal-scope'
import { testMarkdownLatexPreview } from './test-markdown-latex-preview'
import { testProjectEditorSqlite } from './test-project-editor-sqlite'
import { testTerminalPerf } from './test-terminal-perf'
import { testTerminalFocusActivation } from './test-terminal-focus-activation'
import { testTerminalStress } from './test-terminal-stress'
import { testImageDiff } from './test-image-diff'
import { testProjectEditorMarkdownNavigation } from './test-project-editor-markdown-navigation'
import { testGlobalSearch } from './test-global-search'

export async function runAllTests(ctx: AutotestContext): Promise<void> {
  const { log, sleep } = ctx
  const suiteFilter = (window.electronAPI.debug.autotestSuite || '').trim().toLowerCase()
  const runSingleSuite = suiteFilter.length > 0 && suiteFilter !== 'all'
  const shouldRun = (suiteId: string) => !runSingleSuite || suiteFilter === suiteId

  log('=== Autotest Start ===')
  log('autotest-config', {
    suiteFilter: runSingleSuite ? suiteFilter : 'all'
  })
  const startTime = performance.now()
  const allResults: TestSuiteResult[] = []
  const allTestResults: TestResult[] = []

  const collectSuiteResults = (suite: string, results: TestResult[]) => {
    const passed = results.filter(r => r.ok).length
    const failed = results.filter(r => !r.ok).length
    const skipped = 0
    allResults.push({ suite, results, passed, failed, skipped })
    allTestResults.push(...results)
    log(`suite-done:${suite}`, { passed, failed, total: results.length })
  }

  try {
    // Phase 0: Initialization
    log('phase0:init', { rootPath: ctx.rootPath, terminalId: ctx.terminalId })
    if (ctx.terminalId) {
      const platform = window.electronAPI.platform
      const cdCommand = platform === 'win32'
        ? `cd /d "${ctx.rootPath}"\r`
        : `cd "${ctx.rootPath}"\r`
      await window.electronAPI.terminal.write(ctx.terminalId, cdCommand)
      await sleep(600)
      await window.electronAPI.git.notifyTerminalActivity(ctx.terminalId)
      await sleep(600)
    }

    // Phase 0.4: ProjectEditor resumes logical unit testing
    if (!ctx.cancelled() && shouldRun('project-editor-restore-unit')) {
      log('phase0.4:begin')
      const results = await testProjectEditorRestoreUnit(ctx)
      collectSuiteResults('ProjectEditorRestoreUnit', results)
      await sleep(300)
    }

    // Phase 0.5: ProjectEditor memory recovery interactive test
    if (!ctx.cancelled() && shouldRun('project-editor-restore')) {
      log('phase0.5:begin')
      const results = await testProjectEditorRestore(ctx)
      collectSuiteResults('ProjectEditorRestore', results)
      await sleep(500)
    }

    // Phase 0.6: ProjectEditor open file location special test
    if (!ctx.cancelled() && shouldRun('project-editor-open-position')) {
      log('phase0.6:begin')
      const results = await testProjectEditorOpenPosition(ctx)
      collectSuiteResults('ProjectEditorOpenPosition', results)
      await sleep(500)
    }

    // Phase 0.7: ProjectEditor multi-terminal isolation recovery test in the same directory
    if (!ctx.cancelled() && shouldRun('project-editor-multi-terminal-scope')) {
      log('phase0.7:begin')
      const results = await testProjectEditorMultiTerminalScope(ctx)
      collectSuiteResults('ProjectEditorMultiTerminalScope', results)
      await sleep(500)
    }

    // Phase 0.8: ProjectEditor Markdown LaTeX preview special test
    if (!ctx.cancelled() && shouldRun('markdown-latex-preview')) {
      log('phase0.8:begin')
      const results = await testMarkdownLatexPreview(ctx)
      collectSuiteResults('MarkdownLatexPreview', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('project-editor-markdown-navigation')) {
      log('phase0.85:begin')
      const results = await testProjectEditorMarkdownNavigation(ctx)
      collectSuiteResults('ProjectEditorMarkdownNavigation', results)
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('global-search')) {
      log('phase0.875:begin')
      const results = await testGlobalSearch(ctx)
      collectSuiteResults('GlobalSearch', results)
      await sleep(500)
    }

    // Phase 0.9: ProjectEditor SQLite preview and special test of adding, deleting, modifying and checking
    if (!ctx.cancelled() && shouldRun('project-editor-sqlite')) {
      log('phase0.9:begin')
      const results = await testProjectEditorSqlite(ctx)
      collectSuiteResults('ProjectEditorSqlite', results)
      await sleep(500)
    }

    // Phase 1: PromptSender UI testing
    if (!ctx.cancelled() && shouldRun('prompt-sender')) {
      log('phase1:begin')
      const results = await testPromptSender(ctx)
      collectSuiteResults('PromptSender', results)
      await sleep(500)
    }

    // Phase 2: Per-Agent font testing
    if (!ctx.cancelled() && shouldRun('per-agent-font')) {
      log('phase2:begin')
      await ctx.reopenProjectEditor('phase2-setup')
      await sleep(300)
      const results = await testPerAgentFont(ctx)
      collectSuiteResults('PerAgentFont', results)
      await ctx.reopenProjectEditor('phase2-cleanup')
      await sleep(500)
    }

    // Phase 3: Git History Test
    if (!ctx.cancelled() && shouldRun('git-history')) {
      log('phase3:begin')
      await ctx.reopenProjectEditor('phase3-setup')
      await sleep(300)
      const results = await testGitHistory(ctx)
      collectSuiteResults('GitHistory', results)
      await ctx.reopenProjectEditor('phase3-cleanup')
      await sleep(500)
    }

    // Phase 4: Prompt cleanup test
    if (!ctx.cancelled() && shouldRun('prompt-cleanup')) {
      log('phase4:begin')
      const results = await testPromptCleanup(ctx)
      collectSuiteResults('PromptCleanup', results)
      await sleep(500)
    }

    // Phase 4.5: Scheduled task function test
    if (!ctx.cancelled() && shouldRun('schedule')) {
      log('phase4.5:begin')
      const results = await testSchedule(ctx)
      collectSuiteResults('Schedule', results)
      await sleep(500)
    }

    // Phase 5: Regression testing
    if (!ctx.cancelled() && shouldRun('regression')) {
      log('phase5:begin')
      await ctx.reopenProjectEditor('phase5-setup')
      await sleep(300)
      const results = await testRegression(ctx)
      collectSuiteResults('Regression', results)
      await ctx.reopenProjectEditor('phase5-cleanup')
      await sleep(500)
    }

    // Phase 5.4: Git cross-platform test
    if (!ctx.cancelled() && shouldRun('git-cross-platform')) {
      log('phase5.4:begin')
      await ctx.reopenProjectEditor('phase5.4-setup')
      await sleep(300)
      const results = await testGitCrossPlatform(ctx)
      collectSuiteResults('GitCrossPlatform', results)
      await ctx.reopenProjectEditor('phase5.4-cleanup')
      await sleep(500)
    }

    // Phase 5.5: Git Diff subdirectory special test
    if (!ctx.cancelled() && shouldRun('git-diff-subdir')) {
      log('phase5.5:begin')
      await ctx.reopenProjectEditor('phase5.5-setup')
      await sleep(300)
      const results = await testGitDiffSubdir(ctx)
      collectSuiteResults('GitDiffSubdir', results)
      await ctx.reopenProjectEditor('phase5.5-cleanup')
      await sleep(500)
    }

    if (!ctx.cancelled() && shouldRun('image-diff')) {
      log('phase5.55:begin')
      await ctx.reopenProjectEditor('phase5.55-setup')
      await sleep(300)
      const results = await testImageDiff(ctx)
      collectSuiteResults('ImageDiff', results)
      await ctx.reopenProjectEditor('phase5.55-cleanup')
      await sleep(500)
    }

    // Phase 5.6: Terminal performance test
    if (!ctx.cancelled() && shouldRun('terminal-perf')) {
      log('phase5.6:begin')
      const results = await testTerminalPerf(ctx)
      collectSuiteResults('TerminalPerf', results)
      await sleep(500)
    }

    // Phase 5.7: Terminal focus activation regression test
    if (!ctx.cancelled() && shouldRun('terminal-focus-activation')) {
      log('phase5.7:begin')
      const results = await testTerminalFocusActivation(ctx)
      collectSuiteResults('TerminalFocusActivation', results)
      await sleep(500)
    }

    // Phase 5.8: Terminal stress test (extended multi-terminal pressure)
    if (!ctx.cancelled() && shouldRun('terminal-stress')) {
      log('phase5.8:begin')
      const results = await testTerminalStress(ctx)
      collectSuiteResults('TerminalStress', results)
      await sleep(500)
    }

    // Phase 6: Stress Test
    if (!ctx.cancelled() && shouldRun('stress')) {
      log('phase6:begin')
      await ctx.reopenProjectEditor('phase6-setup')
      await sleep(300)
      const results = await testStress(ctx)
      collectSuiteResults('Stress', results)
      await ctx.reopenProjectEditor('phase6-cleanup')
      await sleep(500)
    }

    // Phase 7: Summary Report
    const elapsedMs = Math.round(performance.now() - startTime)
    const totalPassed = allTestResults.filter(r => r.ok).length
    const totalFailed = allTestResults.filter(r => !r.ok).length
    const totalTests = allTestResults.length

    log('=== Test Summary ===', {
      totalTests,
      totalPassed,
      totalFailed,
      elapsedMs,
      suites: allResults.map(s => ({
        suite: s.suite,
        passed: s.passed,
        failed: s.failed,
        total: s.results.length
      }))
    })

    // Output each failed test
    const failedTests = allTestResults.filter(r => !r.ok)
    if (failedTests.length > 0) {
      log('=== Failed Cases ===', {
        count: failedTests.length,
        tests: failedTests.map(r => ({
          name: r.name,
          detail: r.detail
        }))
      })
    }

    // Output a list of all test results
    log('=== Result List ===', {
      results: allTestResults.map(r => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`)
    })

    log('=== Autotest Completed ===', {
      elapsed: `${(elapsedMs / 1000).toFixed(1)}s`,
      passed: totalPassed,
      failed: totalFailed,
      total: totalTests
    })

  } catch (error) {
    log('autotest-error', { error: String(error) })
  }
}
