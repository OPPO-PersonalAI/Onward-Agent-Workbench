/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const TEST_IMAGE_FILENAME = '__autotest_image_diff_test.png'
const TEST_SVG_FILENAME = '__autotest_image_diff_test.svg'
const TINY_SVG_CONTENT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>\n'

export async function testImageDiff(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const platform = window.electronAPI.platform

  const waitForGitDiffOpen = async (label: string, timeout = 10000) => {
    return waitFor(`gitdiff-open:${label}`, () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen && api.isOpen())
    }, timeout)
  }

  const waitForGitDiffLoaded = async (label: string, timeout = 15000) => {
    return waitFor(`gitdiff-loaded:${label}`, () => {
      const api = getGitDiffApi()
      const fileList = api?.getFileList?.() || []
      return Array.isArray(fileList) && fileList.length > 0
    }, timeout)
  }

  const waitForImagePreview = async (label: string, timeout = 10000) => {
    return waitFor(`image-preview:${label}`, () => {
      const state = getGitDiffApi()?.getImagePreviewState?.()
      return Boolean(state && !state.loading && state.isImage)
    }, timeout)
  }

  const matchesFileName = (actual: string | undefined, expected: string) => {
    if (!actual) return false
    return actual === expected || actual.endsWith(`/${expected}`) || actual.endsWith(`\\${expected}`)
  }

  const findFileIndex = (filename: string) => {
    const fileList = getGitDiffApi()?.getFileList?.() || []
    return fileList.findIndex((file) => matchesFileName(file.filename, filename))
  }

  const waitForFileChangeType = async (filename: string, changeType: 'staged' | 'untracked', timeout = 12000) => {
    return waitFor(`image-file-state:${filename}:${changeType}`, () => {
      const fileList = getGitDiffApi()?.getFileList?.() || []
      return fileList.some((file) => matchesFileName(file.filename, filename) && file.changeType === changeType)
    }, timeout, 120)
  }

  const exerciseImageFileActions = async (filename: string, idPrefix: string, verifyKeepDeny = true) => {
    const index = findFileIndex(filename)
    record(`${idPrefix}-file-found`, index >= 0, { filename, index })
    if (index < 0 || cancelled()) return

    const selected = getGitDiffApi()?.selectFileByIndex(index) === true
    record(`${idPrefix}-selected`, selected, { filename })
    if (!selected || cancelled()) return

    const previewLoaded = await waitForImagePreview(`${filename}-preview`)
    record(`${idPrefix}-image-preview-loaded`, previewLoaded, { filename })
    if (!previewLoaded || cancelled()) return

    const previewState = getGitDiffApi()?.getImagePreviewState?.()
    record(`${idPrefix}-image-preview-state`, Boolean(previewState?.isImage) && previewState?.hasModifiedUrl === true, {
      filename,
      state: previewState || null
    })

    const actionState = getGitDiffApi()?.getFileActionState?.()
    record(`${idPrefix}-file-actions-visible`, actionState?.fileActionsVisible === true, {
      filename,
      actionState: actionState || null
    })
    record(`${idPrefix}-line-actions-hidden`, actionState?.lineActionsVisible === false, {
      filename,
      actionState: actionState || null
    })
    if (!(actionState?.fileActionsVisible) || cancelled() || !verifyKeepDeny) return

    const keepTriggered = await getGitDiffApi()?.triggerFileAction?.('keep')
    record(`${idPrefix}-keep-triggered`, keepTriggered === true, { filename })
    if (keepTriggered !== true || cancelled()) return

    const staged = await waitForFileChangeType(filename, 'staged')
    record(`${idPrefix}-keep-staged`, staged, {
      filename,
      files: getGitDiffApi()?.getFileList?.().filter((file) => matchesFileName(file.filename, filename)) || []
    })
    if (!staged || cancelled()) return

    const denyTriggered = await getGitDiffApi()?.triggerFileAction?.('deny')
    record(`${idPrefix}-deny-triggered`, denyTriggered === true, { filename })
    if (denyTriggered !== true || cancelled()) return

    const backToUntracked = await waitForFileChangeType(filename, 'untracked')
    record(`${idPrefix}-deny-restored-untracked`, backToUntracked, {
      filename,
      files: getGitDiffApi()?.getFileList?.().filter((file) => matchesFileName(file.filename, filename)) || []
    })
  }

  const termExec = async (command: string, label: string, waitMs = 900) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`, { command })
  }

  log('image-diff:start', { suite: 'ImageDiff' })

  if (!cancelled()) {
    const createCommand = platform === 'win32'
      ? `powershell -Command "[IO.File]::WriteAllBytes('${TEST_IMAGE_FILENAME}', [Convert]::FromBase64String('${TINY_PNG_BASE64}')); [IO.File]::WriteAllText('${TEST_SVG_FILENAME}', '${TINY_SVG_CONTENT}', [Text.UTF8Encoding]::new(\$false))"`
      : `printf '%s' '${TINY_PNG_BASE64}' | base64 -d > '${TEST_IMAGE_FILENAME}'; printf '%s' '${TINY_SVG_CONTENT}' > '${TEST_SVG_FILENAME}'`
    await termExec(createCommand, 'create-image', 1500)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    await sleep(700)
    record('ID-01-test-images-created', true)
  }

  let gitDiffOpened = false
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    gitDiffOpened = await waitForGitDiffOpen('open')
    record('ID-02-git-diff-opened', gitDiffOpened)
  }

  if (!cancelled() && gitDiffOpened) {
    const loaded = await waitForGitDiffLoaded('loaded')
    const api = getGitDiffApi()
    const fileList = api?.getFileList?.() || []
    record('ID-03-files-loaded', loaded, { fileCount: fileList.length })
    record('ID-03-test-images-found', findFileIndex(TEST_IMAGE_FILENAME) >= 0 && findFileIndex(TEST_SVG_FILENAME) >= 0, {
      fileCount: fileList.length,
      files: fileList
    })
  }

  if (!cancelled() && gitDiffOpened) {
    await exerciseImageFileActions(TEST_IMAGE_FILENAME, 'ID-04')
  }

  if (!cancelled() && gitDiffOpened) {
    await exerciseImageFileActions(TEST_SVG_FILENAME, 'ID-12', false)
  }

  if (!cancelled() && gitDiffOpened) {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await sleep(500)
    record('ID-20-closed', true)
  }

  if (!cancelled()) {
    const cleanupCommand = platform === 'win32'
      ? `del /f "${TEST_IMAGE_FILENAME}" "${TEST_SVG_FILENAME}" 2>nul`
      : `rm -f "${TEST_IMAGE_FILENAME}" "${TEST_SVG_FILENAME}"`
    await termExec(cleanupCommand, 'cleanup-image', 800)
    record('ID-21-cleanup', true)
  }

  log('image-diff:done', { totalTests: results.length, passed: results.filter((result) => result.ok).length })
  return results
}
