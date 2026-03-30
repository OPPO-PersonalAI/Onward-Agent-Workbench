/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const GENERATED_PATH_SEGMENTS = [
  'node_modules/',
  'out/',
  'release/',
  '.git/',
  'coverage/'
]

const PREFERRED_MARKDOWN_PATHS = [
  'docs/api-reference.md',
  'docs/architecture.md',
  'test/README.md',
  'test/dl_math_foundations.md',
  'README.md'
]

function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_SEGMENTS.some(segment => path.includes(segment))
}

function selectMarkdownFile(paths: string[]): string | null {
  for (const preferredPath of PREFERRED_MARKDOWN_PATHS) {
    if (paths.includes(preferredPath)) {
      return preferredPath
    }
  }

  const ranked = [...paths].sort((a, b) => {
    const score = (value: string) => {
      let total = value.startsWith('docs/') || value.startsWith('test/') ? 1000 : 0
      total += value.split('/').length * -10
      total += value.length
      return total
    }
    return score(b) - score(a)
  })
  return ranked[0] ?? null
}

export async function testPreviewPositionRestore(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, assert, cancelled } = ctx
  const results: TestResult[] = []

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const api = window.__onwardProjectEditorDebug
  if (!api) {
    record('PPR-00-api-available', false, { error: 'debug api not found' })
    return results
  }

  const fileIndex = await ctx.buildFileIndex()
  const eligibleFiles = fileIndex.filter(file => !isGeneratedPath(file))
  const markdownFiles = eligibleFiles.filter(file => file.endsWith('.md'))
  const nonMarkdownFiles = eligibleFiles.filter(file => !file.endsWith('.md') && !file.startsWith('.'))

  if (markdownFiles.length === 0) {
    record('PPR-00-files-found', false, { error: 'No markdown files found in the test directory' })
    return results
  }

  const markdownFile = selectMarkdownFile(markdownFiles)
  if (!markdownFile) {
    record('PPR-00-files-found', false, { error: 'No eligible markdown files found for restore test' })
    return results
  }
  const alternateMarkdownFile = markdownFiles.find(file => file !== markdownFile) ?? null
  const switchFile = nonMarkdownFiles[0] ?? alternateMarkdownFile
  if (!switchFile) {
    record('PPR-00-switch-file', false, { error: 'Need at least two files for switching' })
    return results
  }

  log('PPR:files', { markdownFile, switchFile })
  record('PPR-00-files-found', true, { markdownFile, switchFile })
  if (cancelled()) return results

  const waitForPreviewSettled = async (
    label: string,
    options?: { expectNotNearTopWhenVisible?: boolean }
  ) => {
    const startedAt = Date.now()
    let sawTransition = false
    let sawVisibleBeforeIdle = false
    let sawTopWhileVisible = false
    let lastPhase: string | null = null
    let lastScrollTop = 0

    while (Date.now() - startedAt < 10000) {
      const phase = api.getPreviewRestorePhase?.() ?? 'idle'
      const pending = api.isMarkdownRenderPending()
      const htmlLength = api.getMarkdownRenderedHtml().length
      const contentVisible = api.isPreviewContentVisible?.() ?? true
      const scrollTop = api.getPreviewScrollTop?.() ?? 0

      lastPhase = phase
      lastScrollTop = scrollTop

      if (phase !== 'idle') {
        sawTransition = true
        if (contentVisible) {
          sawVisibleBeforeIdle = true
        }
      }

      if (options?.expectNotNearTopWhenVisible && contentVisible && scrollTop < 100) {
        sawTopWhileVisible = true
      }

      if (!pending && htmlLength > 0 && phase === 'idle') {
        log(`${label}:settled`, {
          phase,
          scrollTop: Math.round(scrollTop),
          sawTransition,
          sawVisibleBeforeIdle,
          sawTopWhileVisible
        })
        return {
          ready: true,
          sawTransition,
          sawVisibleBeforeIdle,
          sawTopWhileVisible,
          finalPhase: phase,
          finalScrollTop: scrollTop
        }
      }

      await sleep(50)
    }

    log(`${label}:timeout`, {
      lastPhase,
      lastScrollTop: Math.round(lastScrollTop),
      sawTransition,
      sawVisibleBeforeIdle,
      sawTopWhileVisible
    })

    return {
      ready: false,
      sawTransition,
      sawVisibleBeforeIdle,
      sawTopWhileVisible,
      finalPhase: lastPhase,
      finalScrollTop: lastScrollTop
    }
  }

  await api.openFileByPath(markdownFile)
  const initialSettle = await waitForPreviewSettled('PPR-01')
  record('PPR-01-render-complete', initialSettle.ready, { phase: initialSettle.finalPhase })
  record('PPR-01-hidden-until-settled', !initialSettle.sawVisibleBeforeIdle, {
    sawVisibleBeforeIdle: initialSettle.sawVisibleBeforeIdle
  })
  if (!initialSettle.ready || cancelled()) return results
  await sleep(300)

  api.scrollPreviewToFraction?.(0.5)
  await sleep(300)
  const savedPosition = api.getPreviewScrollTop?.() ?? 0
  const scrollHeight1 = api.getPreviewScrollHeight?.() ?? 0
  const nearestHeading = api.debugScanPreviewHeadings?.().nearest ?? null
  record('PPR-02-position-saved', savedPosition > 100, {
    savedPosition: Math.round(savedPosition),
    scrollHeight: scrollHeight1,
    nearestHeading
  })
  if (cancelled()) return results

  await api.openFileByPath(switchFile)
  await sleep(1500)
  record('PPR-03-switched', api.getActiveFilePath() === switchFile, {
    expected: switchFile,
    actual: api.getActiveFilePath()
  })
  if (cancelled()) return results

  await api.openFileByPath(markdownFile)
  const restoreSettle = await waitForPreviewSettled('PPR-04', { expectNotNearTopWhenVisible: true })
  record('PPR-04-render-complete', restoreSettle.ready, { phase: restoreSettle.finalPhase })
  record('PPR-04-transition-observed', restoreSettle.sawTransition, {
    sawTransition: restoreSettle.sawTransition
  })
  record('PPR-04-hidden-until-settled', !restoreSettle.sawVisibleBeforeIdle, {
    sawVisibleBeforeIdle: restoreSettle.sawVisibleBeforeIdle
  })
  record('PPR-04-no-top-flash', !restoreSettle.sawTopWhileVisible, {
    sawTopWhileVisible: restoreSettle.sawTopWhileVisible
  })
  if (!restoreSettle.ready || cancelled()) return results
  await sleep(300)

  const restoredPosition = api.getPreviewScrollTop?.() ?? 0
  const scrollHeight2 = api.getPreviewScrollHeight?.() ?? 0
  const positionDiff = Math.abs(restoredPosition - savedPosition)
  const tolerance = 50

  record('PPR-05-position-restored', positionDiff <= tolerance, {
    savedPosition: Math.round(savedPosition),
    restoredPosition: Math.round(restoredPosition),
    diff: Math.round(positionDiff),
    tolerance,
    scrollHeight1,
    scrollHeight2
  })

  record('PPR-06-not-at-top', restoredPosition > 100, {
    restoredPosition: Math.round(restoredPosition)
  })

  return results
}
