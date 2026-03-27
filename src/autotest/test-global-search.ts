/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

export async function testGlobalSearch(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = () => window.__onwardProjectEditorDebug
  const timestamp = Date.now()
  const uniqueMarker = `ONWARD_GS_MARKER_${timestamp}`
  const testTsFile = `onward-gs-test-${timestamp}.ts`
  const testMdFile = `onward-gs-test-${timestamp}.md`

  const tsContent = [
    `// ${uniqueMarker} TypeScript fixture`,
    'export function greet(name: string): string {',
    `  return \`Hello, \${name}! ${uniqueMarker}\``,
    '}'
  ].join('\n')

  const mdContent = [
    `# ${uniqueMarker} Markdown Fixture`,
    '',
    `Body content for ${uniqueMarker}.`,
    '',
    '## Section Two'
  ].join('\n')

  const cleanup = async () => {
    await window.electronAPI.project.deletePath(rootPath, testTsFile).catch(() => {})
    await window.electronAPI.project.deletePath(rootPath, testMdFile).catch(() => {})
  }

  try {
    log('global-search:start', { rootPath })

    const createTs = await window.electronAPI.project.createFile(rootPath, testTsFile, tsContent)
    const createMd = await window.electronAPI.project.createFile(rootPath, testMdFile, mdContent)
    record('GS-00-setup-ts', createTs.success, { error: createTs.error })
    record('GS-00-setup-md', createMd.success, { error: createMd.error })
    if (!createTs.success || !createMd.success) {
      return results
    }

    await sleep(300)
    if (cancelled()) return results

    const receivedMatches: Array<{ file: string; line: number; lineContent: string }> = []
    let searchDone = false
    let searchId = ''

    const unsubscribeResult = window.electronAPI.project.onSearchResult((id, matches) => {
      if (id !== searchId) return
      receivedMatches.push(...matches.map((match) => ({
        file: match.file,
        line: match.line,
        lineContent: match.lineContent
      })))
    })

    const unsubscribeDone = window.electronAPI.project.onSearchDone((stats) => {
      if (stats.searchId === searchId) {
        searchDone = true
      }
    })

    const startResult = await window.electronAPI.project.searchStart({
      rootPath,
      query: uniqueMarker,
      isRegex: false,
      isCaseSensitive: true,
      isWholeWord: false
    })
    searchId = startResult.searchId
    record('GS-01-search-start', typeof searchId === 'string' && searchId.length > 0, { searchId })

    const searchCompleted = await waitFor('GS-02-search-done', () => searchDone, 10000)
    unsubscribeResult()
    unsubscribeDone()
    record('GS-02-search-done', searchCompleted)

    const matchedFiles = new Set(receivedMatches.map((match) => match.file))
    record('GS-03-found-ts', matchedFiles.has(testTsFile), { matchedFiles: [...matchedFiles] })
    record('GS-04-found-md', matchedFiles.has(testMdFile), { matchedFiles: [...matchedFiles] })
    record('GS-05-ts-line-1', receivedMatches.some((match) => match.file === testTsFile && match.line === 1))
    record('GS-06-md-line-1', receivedMatches.some((match) => match.file === testMdFile && match.line === 1))

    const api = debugApi()
    if (!api) {
      record('GS-07-debug-api', false, { error: 'Project Editor debug API is unavailable.' })
      return results
    }

    await api.openFileByPath(testMdFile)
    await sleep(1200)
    record('GS-07-active-file', api.getActiveFilePath() === testMdFile, {
      activeFile: api.getActiveFilePath()
    })
    record('GS-08-preview-visible', api.isMarkdownPreviewVisible(), {
      previewVisible: api.isMarkdownPreviewVisible()
    })

    const renderReady = await waitFor('GS-09-render-ready', () => !api.isMarkdownRenderPending(), 5000)
    record('GS-09-render-ready', renderReady)
    record('GS-10-rendered-marker', api.getMarkdownRenderedHtml().includes(uniqueMarker), {
      htmlLength: api.getMarkdownRenderedHtml().length
    })

    const cancelResult = await window.electronAPI.project.searchCancel()
    record('GS-11-search-cancel', cancelResult.success)
  } finally {
    await cleanup()
  }

  return results
}
