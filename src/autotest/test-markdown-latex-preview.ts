/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 0.7: ProjectEditor Markdown LaTeX preview special test
 */
import type { AutotestContext, TestResult } from './types'

const SAMPLE_MARKDOWN_PATH = 'test/dl_math_foundations.md'

function countClassName(html: string, className: string): number {
  const regex = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"`, 'g')
  return (html.match(regex) || []).length
}

export async function testMarkdownLatexPreview(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, waitFor, assert, cancelled, rootPath, openFileInEditor, sleep } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const waitForMarkdownRendered = async (label: string, minHtmlLength: number, expectedMarker?: string) => {
    return await waitFor(
      `markdown-rendered:${label}`,
      () => {
        const api = getApi()
        if (!api?.isOpen?.()) return false
        if (!api?.isMarkdownPreviewVisible?.()) return false
        if (api?.isMarkdownRenderPending?.()) return false
        const html = api?.getMarkdownRenderedHtml?.() ?? ''
        if (expectedMarker && !html.includes(expectedMarker)) return false
        return html.length >= minHtmlLength
      },
      15000,
      120
    )
  }

  log('phase0.7:start', { suite: 'MarkdownLatexPreview' })

  const fixtureResult = await window.electronAPI.project.readFile(rootPath, SAMPLE_MARKDOWN_PATH)
  _assert('MLP-00-fixture-exists', fixtureResult.success, {
    path: SAMPLE_MARKDOWN_PATH,
    error: fixtureResult.success ? null : fixtureResult.error
  })
  if (!fixtureResult.success || cancelled()) return results

  await openFileInEditor(SAMPLE_MARKDOWN_PATH)
  const fixtureOpened = await waitFor(
    'markdown-open-fixture',
    () => getApi()?.getActiveFilePath?.() === SAMPLE_MARKDOWN_PATH,
    10000
  )
  _assert('MLP-01-open-fixture-file', fixtureOpened, {
    expected: SAMPLE_MARKDOWN_PATH,
    actual: getApi()?.getActiveFilePath?.() ?? null
  })
  if (!fixtureOpened || cancelled()) return results

  const fixtureRendered = await waitForMarkdownRendered('fixture', 1000, 'Deep Learning Math Foundations')
  _assert('MLP-02-fixture-render-finished', fixtureRendered, {
    renderPending: getApi()?.isMarkdownRenderPending?.(),
    htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
  })
  if (!fixtureRendered || cancelled()) return results

  const fixtureHtml = getApi()?.getMarkdownRenderedHtml?.() ?? ''
  const fixtureKatexCount = countClassName(fixtureHtml, 'katex')
  const fixtureDisplayCount = countClassName(fixtureHtml, 'katex-display')
  const fixtureMathMlCount = countClassName(fixtureHtml, 'katex-mathml')

  _assert('MLP-03-fixture-inline-math-rendered', fixtureKatexCount >= 30, {
    katexCount: fixtureKatexCount
  })
  _assert('MLP-04-fixture-display-math-rendered', fixtureDisplayCount >= 10, {
    displayCount: fixtureDisplayCount
  })
  _assert('MLP-05-fixture-mathml-preserved', fixtureMathMlCount >= 10, {
    mathMlCount: fixtureMathMlCount
  })

  if (cancelled()) return results

  const tempPath = `onward-autotest-markdown-latex-${Date.now()}.md`
  const tempContent = [
    '# AutoTest Markdown LaTeX',
    '',
    'AUTOTEST_LATEX_TEMP_MARKER',
    '',
    'Inline dollar: $a^2 + b^2 = c^2$',
    '',
    'Inline parentheses: \\(e^{i\\pi} + 1 = 0\\)',
    '',
    'Display dollar:',
    '$$',
    '\\int_0^1 x^2 dx = \\frac{1}{3}',
    '$$',
    '',
    'Display brackets:',
    '\\[',
    '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}',
    '\\]',
    '',
    'Bare environment:',
    '',
    '\\begin{aligned}',
    'f(x) &= x^2 + 1 \\\\',
    'g(x) &= \\frac{1}{1 + e^{-x}}',
    '\\end{aligned}',
    ''
  ].join('\n')

  const createResult = await window.electronAPI.project.createFile(rootPath, tempPath, tempContent)
  _assert('MLP-06-create-temp-file', createResult.success, {
    tempPath,
    error: createResult.success ? null : createResult.error
  })
  if (!createResult.success || cancelled()) return results

  try {
    await openFileInEditor(tempPath)
    const tempOpened = await waitFor(
      'markdown-open-temp',
      () => getApi()?.getActiveFilePath?.() === tempPath,
      10000
    )
    _assert('MLP-07-open-temp-file', tempOpened, {
      expected: tempPath,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!tempOpened || cancelled()) return results

    const tempRendered = await waitForMarkdownRendered('temp', 300, 'AUTOTEST_LATEX_TEMP_MARKER')
    _assert('MLP-08-temp-render-finished', tempRendered, {
      renderPending: getApi()?.isMarkdownRenderPending?.(),
      htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
    })
    if (!tempRendered || cancelled()) return results

    const tempHtml = getApi()?.getMarkdownRenderedHtml?.() ?? ''
    const tempKatexCount = countClassName(tempHtml, 'katex')
    const tempDisplayCount = countClassName(tempHtml, 'katex-display')
    const tempMathMlCount = countClassName(tempHtml, 'katex-mathml')

    _assert('MLP-09-support-inline-and-display-delimiters', tempKatexCount >= 4 && tempDisplayCount >= 2, {
      katexCount: tempKatexCount,
      displayCount: tempDisplayCount
    })
    _assert('MLP-10-support-mathml-output', tempMathMlCount >= 4, {
      mathMlCount: tempMathMlCount
    })
    _assert(
      'MLP-11-no-raw-bracket-delimiters',
      !tempHtml.includes('\\(') &&
      !tempHtml.includes('\\['),
      {
      hasInlineParenthesesDelimiter: tempHtml.includes('\\('),
      hasBlockBracketDelimiter: tempHtml.includes('\\[')
    }
    )
    if (cancelled()) return results

    const updatedContent = `${tempContent}\nAUTOTEST_LATEX_UPDATED_MARKER\nUpdated formula check: $\\alpha + \\beta$`
    const saveResult = await window.electronAPI.project.saveFile(rootPath, tempPath, updatedContent)
    _assert('MLP-12-update-temp-file', saveResult.success, {
      error: saveResult.success ? null : saveResult.error
    })
    if (!saveResult.success || cancelled()) return results

    await openFileInEditor(SAMPLE_MARKDOWN_PATH)
    await waitFor(
      'markdown-switch-to-fixture',
      () => getApi()?.getActiveFilePath?.() === SAMPLE_MARKDOWN_PATH,
      10000
    )
    await sleep(220)

    await openFileInEditor(tempPath)
    const tempReopened = await waitFor(
      'markdown-reopen-temp',
      () => getApi()?.getActiveFilePath?.() === tempPath,
      10000
    )
    _assert('MLP-13-reopen-temp-file-after-save', tempReopened, {
      expected: tempPath,
      actual: getApi()?.getActiveFilePath?.() ?? null
    })
    if (!tempReopened || cancelled()) return results

    const updatedRendered = await waitForMarkdownRendered('temp-updated', 360, 'AUTOTEST_LATEX_UPDATED_MARKER')
    _assert('MLP-14-rerender-after-file-update', updatedRendered, {
      renderPending: getApi()?.isMarkdownRenderPending?.(),
      htmlLength: getApi()?.getMarkdownRenderedHtml?.().length ?? 0
    })
    if (!updatedRendered || cancelled()) return results

    const updatedHtml = getApi()?.getMarkdownRenderedHtml?.() ?? ''
    const hasUpdatedMarker = updatedHtml.includes('AUTOTEST_LATEX_UPDATED_MARKER')
    const hasRawUpdatedFormula = updatedHtml.includes('$\\alpha + \\beta$')
    _assert('MLP-15-updated-formula-visible', hasUpdatedMarker && !hasRawUpdatedFormula, {
      hasUpdatedMarker,
      hasRawUpdatedFormula
    })
  } finally {
    const cleanup = await window.electronAPI.project.deletePath(rootPath, tempPath)
    log('phase0.7:cleanup', {
      tempPath,
      ok: cleanup.success,
      error: cleanup.success ? null : cleanup.error
    })
  }

  return results
}
