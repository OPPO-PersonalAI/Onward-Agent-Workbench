/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const SAMPLE_MARKDOWN_PATH = 'test/dl_math_foundations.md'

export async function testProjectEditorMarkdownNavigation(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, openFileInEditor, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const fixture = await window.electronAPI.project.readFile(ctx.rootPath, SAMPLE_MARKDOWN_PATH)
  record('PMN-00-fixture-exists', fixture.success, {
    path: SAMPLE_MARKDOWN_PATH,
    error: fixture.success ? null : fixture.error
  })
  if (!fixture.success || cancelled()) return results

  await openFileInEditor(SAMPLE_MARKDOWN_PATH)
  const opened = await waitFor(
    'pmn-open-markdown',
    () => getApi()?.getActiveFilePath?.() === SAMPLE_MARKDOWN_PATH,
    10000
  )
  record('PMN-01-open-markdown-file', opened, {
    actual: getApi()?.getActiveFilePath?.() ?? null
  })
  if (!opened || cancelled()) return results

  const rendered = await waitFor(
    'pmn-markdown-rendered',
    () => {
      const api = getApi()
      if (!api?.isOpen?.()) return false
      if (!api?.isMarkdownPreviewVisible?.()) return false
      if (api?.isMarkdownRenderPending?.()) return false
      const html = api?.getMarkdownRenderedHtml?.() ?? ''
      return html.includes('Deep Learning Math Foundations') && html.length > 1000
    },
    15000,
    120
  )
  record('PMN-02-markdown-preview-rendered', rendered, {
    renderPending: getApi()?.isMarkdownRenderPending?.(),
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!rendered || cancelled()) return results

  const outlineReady = await waitFor(
    'pmn-outline-ready',
    () => {
      const api = getApi()
      return Boolean(api?.isOutlineVisible?.() && (api?.getOutlineSymbolCount?.() ?? 0) >= 3)
    },
    8000,
    100
  )
  record('PMN-03-outline-symbols-loaded', outlineReady, {
    outlineVisible: getApi()?.isOutlineVisible?.() ?? false,
    symbolCount: getApi()?.getOutlineSymbolCount?.() ?? 0
  })
  if (!outlineReady || cancelled()) return results

  const api = getApi()
  const canToggleEditor = Boolean(api?.setMarkdownEditorVisible && api?.isMarkdownEditorVisible)
  record('PMN-04-editor-visibility-api-available', canToggleEditor)
  if (!canToggleEditor || cancelled()) return results

  api?.setMarkdownEditorVisible?.(false)
  const editorHidden = await waitFor(
    'pmn-editor-hidden',
    () => {
      const current = getApi()
      return current?.isMarkdownEditorVisible?.() === false && current?.isMarkdownPreviewVisible?.() === true
    },
    4000,
    80
  )
  record('PMN-05-markdown-read-mode-keeps-preview-open', editorHidden, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.(),
    previewVisible: getApi()?.isMarkdownPreviewVisible?.()
  })
  if (!editorHidden || cancelled()) return results

  const canOpenPreviewSearch = Boolean(api?.setPreviewSearchOpen && api?.isPreviewSearchOpen)
  record('PMN-06-preview-search-api-available', canOpenPreviewSearch)
  if (canOpenPreviewSearch) {
    api?.setPreviewSearchOpen?.(true)
    const searchOpened = await waitFor(
      'pmn-preview-search-opened',
      () => getApi()?.isPreviewSearchOpen?.() === true,
      3000,
      60
    )
    record('PMN-07-preview-search-opened', searchOpened, {
      previewSearchOpen: getApi()?.isPreviewSearchOpen?.()
    })
  }

  const canUsePreviewOutline = Boolean(api?.setOutlineTarget && api?.getOutlineTarget && api?.scrollPreviewToFraction && api?.getPreviewActiveSlug)
  record('PMN-08-preview-outline-api-available', canUsePreviewOutline)
  if (canUsePreviewOutline) {
    const beforeSlug = getApi()?.getPreviewActiveSlug?.() ?? null
    api?.setOutlineTarget?.('preview')
    api?.scrollPreviewToFraction?.(0.7)
    const previewTracked = await waitFor(
      'pmn-preview-outline-tracked',
      () => {
        const current = getApi()
        const slug = current?.getPreviewActiveSlug?.() ?? null
        return current?.getOutlineTarget?.() === 'preview' && typeof slug === 'string' && slug.length > 0
      },
      4000,
      80
    )
    const afterSlug = getApi()?.getPreviewActiveSlug?.() ?? null
    record('PMN-09-preview-scroll-updates-active-heading', previewTracked, {
      beforeSlug,
      afterSlug,
      outlineTarget: getApi()?.getOutlineTarget?.()
    })
  }

  api?.setPreviewSearchOpen?.(false)
  api?.setOutlineTarget?.('editor')
  api?.setMarkdownEditorVisible?.(true)
  await sleep(120)

  const editorRestored = await waitFor(
    'pmn-editor-restored',
    () => getApi()?.isMarkdownEditorVisible?.() === true,
    3000,
    60
  )
  record('PMN-10-markdown-editor-restored', editorRestored, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.()
  })

  return results
}
