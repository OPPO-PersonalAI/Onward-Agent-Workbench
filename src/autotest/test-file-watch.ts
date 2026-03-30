/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

export async function testFileWatch(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, rootPath, openFileInEditor } = ctx
  const results: TestResult[] = []

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  const tempFile = `onward-autotest-file-watch-${Date.now()}.md`
  const tempFile2 = `onward-autotest-file-watch-switch-${Date.now()}.md`
  const initialContent = '# Initial content\n\nline-1\nline-2\nline-3\n'
  const externalContent = '# External change\n\nline-1\nline-2\nline-3\nline-4-external\n'
  const rapidContent1 = '# Rapid write 1\n'
  const rapidContent2 = '# Rapid write 2\n'
  const rapidContentFinal = '# Rapid final write\n'
  const file2Content = '# Second file\n\nswitch-line-1\n'
  const file2ExternalContent = '# Second file changed externally\n\nswitch-line-1\nswitch-line-2\n'

  log('file-watch:start', { tempFile, tempFile2 })

  const createFirst = await window.electronAPI.project.createFile(rootPath, tempFile, initialContent)
  if (!createFirst.success) {
    record('FW-00-setup', false, { error: createFirst.error })
    return results
  }

  const createSecond = await window.electronAPI.project.createFile(rootPath, tempFile2, file2Content)
  if (!createSecond.success) {
    await window.electronAPI.project.deletePath(rootPath, tempFile)
    record('FW-00-setup-file2', false, { error: createSecond.error })
    return results
  }

  try {
    await openFileInEditor(tempFile)
    await sleep(800)

    const api = getApi()
    if (!api) {
      record('FW-01-api-ready', false, { reason: 'debug api not available' })
      return results
    }

    record('FW-01a-initial-content', api.getEditorContent() === initialContent, {
      expected: initialContent.slice(0, 50),
      actual: api.getEditorContent().slice(0, 50)
    })

    await window.electronAPI.git.saveFileContent(rootPath, tempFile, externalContent)
    const refreshed = await waitFor('FW-01-refresh', () => {
      return getApi()?.getEditorContent() === externalContent
    }, 3000, 100)
    record('FW-01b-auto-refresh', refreshed, {
      contentAfter: getApi()?.getEditorContent()?.slice(0, 50) ?? null
    })

    const contentBeforeSave = api.getEditorContent()
    const saveOk = await api.triggerToolbarSave()
    record('FW-02a-save-success', saveOk)
    await sleep(1500)
    record('FW-02b-no-spurious-refresh', getApi()?.getEditorContent() === contentBeforeSave, {
      before: contentBeforeSave.slice(0, 50),
      after: getApi()?.getEditorContent()?.slice(0, 50) ?? null
    })

    await window.electronAPI.git.saveFileContent(rootPath, tempFile, rapidContent1)
    await sleep(100)
    await window.electronAPI.git.saveFileContent(rootPath, tempFile, rapidContent2)
    await sleep(100)
    await window.electronAPI.git.saveFileContent(rootPath, tempFile, rapidContentFinal)
    const debounced = await waitFor('FW-03-debounce', () => {
      return getApi()?.getEditorContent() === rapidContentFinal
    }, 3000, 100)
    record('FW-03a-debounce-final-content', debounced, {
      content: getApi()?.getEditorContent()?.slice(0, 50) ?? null
    })

    const multiLineContent = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join('\n') + '\n'
    await window.electronAPI.git.saveFileContent(rootPath, tempFile, multiLineContent)
    await waitFor('FW-04-load-multiline', () => {
      return (getApi()?.getEditorLineCount() ?? 0) >= 30
    }, 3000, 100)
    api.setCursorPosition(15, 3)
    await sleep(200)

    const appendedContent = `${multiLineContent}appended-line-31\nappended-line-32\n`
    await window.electronAPI.git.saveFileContent(rootPath, tempFile, appendedContent)
    const cursorPreserved = await waitFor('FW-04-refresh-done', () => {
      return getApi()?.getEditorContent() === appendedContent
    }, 3000, 100)

    if (cursorPreserved) {
      const cursor = api.getCursorPosition()
      record('FW-04a-cursor-line-preserved', cursor?.lineNumber === 15, {
        expected: 15,
        actual: cursor?.lineNumber
      })
    } else {
      record('FW-04a-cursor-line-preserved', false, { reason: 'refresh did not complete' })
    }

    await openFileInEditor(tempFile2)
    await sleep(800)
    record('FW-05a-file2-loaded', api.getEditorContent() === file2Content, {
      expected: file2Content.slice(0, 50),
      actual: api.getEditorContent().slice(0, 50)
    })

    await window.electronAPI.git.saveFileContent(rootPath, tempFile2, file2ExternalContent)
    const file2Refreshed = await waitFor('FW-05-file2-refresh', () => {
      return getApi()?.getEditorContent() === file2ExternalContent
    }, 3000, 100)
    record('FW-05b-file2-auto-refresh', file2Refreshed, {
      content: getApi()?.getEditorContent()?.slice(0, 50) ?? null
    })

    await window.electronAPI.git.saveFileContent(rootPath, tempFile, '# Inactive file should not refresh the current editor\n')
    await sleep(1500)
    record('FW-05c-old-file-no-effect', getApi()?.getEditorContent() === file2ExternalContent, {
      expected: file2ExternalContent.slice(0, 50),
      actual: getApi()?.getEditorContent()?.slice(0, 50) ?? null
    })
  } finally {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
    await sleep(300)
    await window.electronAPI.project.deletePath(rootPath, tempFile)
    await window.electronAPI.project.deletePath(rootPath, tempFile2)
  }

  return results
}
