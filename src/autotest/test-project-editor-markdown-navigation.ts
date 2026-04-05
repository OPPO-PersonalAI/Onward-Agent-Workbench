/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const SAMPLE_MARKDOWN_PATH = 'test/dl_math_foundations.md'
const HIGHLIGHT_FIXTURE_PATH = 'docs/api-reference.md'
const IMAGE_FIXTURE_PATH = 'test/markdown-image-preview.md'
const SVG_DATA_URL_PREFIX = 'data:image/svg+xml;base64,'
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

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

  const highlightFixture = await window.electronAPI.project.readFile(ctx.rootPath, HIGHLIGHT_FIXTURE_PATH)
  record('PMN-04-highlight-fixture-exists', highlightFixture.success, {
    path: HIGHLIGHT_FIXTURE_PATH,
    error: highlightFixture.success ? null : highlightFixture.error
  })
  if (!highlightFixture.success || cancelled()) return results

  await getApi()?.openFileByPath?.(HIGHLIGHT_FIXTURE_PATH)
  const highlightRendered = await waitFor(
    'pmn-highlight-rendered',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== HIGHLIGHT_FIXTURE_PATH) return false
      if (!current?.isMarkdownPreviewVisible?.()) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      return html.includes('API Reference') && html.includes('class="hljs') && /hljs-[^"']+/.test(html)
    },
    15000,
    120
  )
  record('PMN-05-markdown-code-highlight-rendered', highlightRendered, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0,
    hasHljsRoot: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes('class="hljs'),
    hasHljsToken: /hljs-[^"']+/.test(getApi()?.getMarkdownRenderedHtml?.() ?? '')
  })
  if (!highlightRendered || cancelled()) return results

  const imageFixture = await window.electronAPI.project.readFile(ctx.rootPath, IMAGE_FIXTURE_PATH)
  record('PMN-06-image-fixture-exists', imageFixture.success, {
    path: IMAGE_FIXTURE_PATH,
    error: imageFixture.success ? null : imageFixture.error
  })
  if (!imageFixture.success || cancelled()) return results

  await getApi()?.openFileByPath?.(IMAGE_FIXTURE_PATH)
  const imageRendered = await waitFor(
    'pmn-image-rendered',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== IMAGE_FIXTURE_PATH) return false
      if (!current?.isMarkdownPreviewVisible?.()) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      const imageState = current?.getMarkdownPreviewImageState?.()
      return (
        html.includes('AUTOTEST_IMAGE_ORIGINAL') &&
        html.includes('<img') &&
        html.includes(`src="${SVG_DATA_URL_PREFIX}`) &&
        html.includes(`src="${PNG_DATA_URL_PREFIX}`) &&
        (imageState?.count ?? 0) >= 2 &&
        (imageState?.loadedCount ?? 0) > 0 &&
        (imageState?.brokenCount ?? 0) === 0 &&
        (imageState?.sources ?? []).some((source) => source.startsWith(SVG_DATA_URL_PREFIX)) &&
        (imageState?.sources ?? []).some((source) => source.startsWith(PNG_DATA_URL_PREFIX))
      )
    },
    15000,
    120
  )
  record('PMN-07-markdown-image-rendered-as-data-url', imageRendered, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0,
    hasImageTag: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes('<img'),
    hasSvgDataImage: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes(`src="${SVG_DATA_URL_PREFIX}`),
    hasPngDataImage: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes(`src="${PNG_DATA_URL_PREFIX}`),
    imageState: getApi()?.getMarkdownPreviewImageState?.() ?? null
  })
  if (!imageRendered || cancelled()) return results

  const canEditMarkdown = Boolean(getApi()?.setEditorContent)
  record('PMN-08-markdown-editor-content-api-available', canEditMarkdown)
  if (!canEditMarkdown || cancelled()) return results

  const editedImageContent = `${getApi()?.getEditorContent?.() ?? ''}\n\nAUTOTEST_IMAGE_EDITED\n`
  getApi()?.setEditorContent?.(editedImageContent)
  const imageStillRenderedAfterEdit = await waitFor(
    'pmn-image-rendered-after-edit',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== IMAGE_FIXTURE_PATH) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      const imageState = current?.getMarkdownPreviewImageState?.()
      return (
        html.includes('AUTOTEST_IMAGE_EDITED') &&
        html.includes('<img') &&
        html.includes(`src="${SVG_DATA_URL_PREFIX}`) &&
        html.includes(`src="${PNG_DATA_URL_PREFIX}`) &&
        (imageState?.count ?? 0) >= 2 &&
        (imageState?.loadedCount ?? 0) > 0 &&
        (imageState?.brokenCount ?? 0) === 0 &&
        (imageState?.sources ?? []).some((source) => source.startsWith(SVG_DATA_URL_PREFIX)) &&
        (imageState?.sources ?? []).some((source) => source.startsWith(PNG_DATA_URL_PREFIX))
      )
    },
    15000,
    120
  )
  record('PMN-09-markdown-image-persists-after-edit', imageStillRenderedAfterEdit, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0,
    hasEditedMarker: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes('AUTOTEST_IMAGE_EDITED'),
    hasImageTag: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes('<img'),
    hasSvgDataImage: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes(`src="${SVG_DATA_URL_PREFIX}`),
    hasPngDataImage: (getApi()?.getMarkdownRenderedHtml?.() ?? '').includes(`src="${PNG_DATA_URL_PREFIX}`),
    imageState: getApi()?.getMarkdownPreviewImageState?.() ?? null
  })
  if (!imageStillRenderedAfterEdit || cancelled()) return results

  await getApi()?.openFileByPath?.(SAMPLE_MARKDOWN_PATH)
  const sampleRestored = await waitFor(
    'pmn-sample-restored',
    () => {
      const current = getApi()
      if (!current?.isOpen?.()) return false
      if (current?.getActiveFilePath?.() !== SAMPLE_MARKDOWN_PATH) return false
      if (!current?.isMarkdownPreviewVisible?.()) return false
      if (current?.isMarkdownRenderPending?.()) return false
      const html = current?.getMarkdownRenderedHtml?.() ?? ''
      return html.includes('Deep Learning Math Foundations')
    },
    15000,
    120
  )
  record('PMN-10-sample-markdown-restored', sampleRestored, {
    activeFilePath: getApi()?.getActiveFilePath?.() ?? null,
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!sampleRestored || cancelled()) return results

  const api = getApi()
  const canToggleEditor = Boolean(api?.setMarkdownEditorVisible && api?.isMarkdownEditorVisible)
  record('PMN-11-editor-visibility-api-available', canToggleEditor)
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
  record('PMN-12-markdown-read-mode-keeps-preview-open', editorHidden, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.(),
    previewVisible: getApi()?.isMarkdownPreviewVisible?.()
  })
  if (!editorHidden || cancelled()) return results

  const canOpenPreviewSearch = Boolean(api?.setPreviewSearchOpen && api?.isPreviewSearchOpen)
  record('PMN-13-preview-search-api-available', canOpenPreviewSearch)
  if (canOpenPreviewSearch) {
    api?.setPreviewSearchOpen?.(true)
    const searchOpened = await waitFor(
      'pmn-preview-search-opened',
      () => getApi()?.isPreviewSearchOpen?.() === true,
      3000,
      60
    )
    record('PMN-14-preview-search-opened', searchOpened, {
      previewSearchOpen: getApi()?.isPreviewSearchOpen?.()
    })
  }

  const canUsePreviewOutline = Boolean(api?.setOutlineTarget && api?.getOutlineTarget && api?.scrollPreviewToFraction && api?.getPreviewActiveSlug)
  record('PMN-15-preview-outline-api-available', canUsePreviewOutline)
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
    record('PMN-16-preview-scroll-updates-active-heading', previewTracked, {
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
  record('PMN-17-markdown-editor-restored', editorRestored, {
    editorVisible: getApi()?.isMarkdownEditorVisible?.()
  })

  return results
}
