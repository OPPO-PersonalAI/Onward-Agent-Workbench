/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const TEST_IMAGE_FILENAME = '__autotest_image_diff_test.png'

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

  const termExec = async (command: string, label: string, waitMs = 900) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`, { command })
  }

  log('image-diff:start', { suite: 'ImageDiff' })

  if (!cancelled()) {
    const createCommand = platform === 'win32'
      ? `powershell -Command "[Convert]::FromBase64String('${TINY_PNG_BASE64}') | Set-Content -Path '${TEST_IMAGE_FILENAME}' -Encoding Byte"`
      : `printf '%s' '${TINY_PNG_BASE64}' | base64 -d > '${TEST_IMAGE_FILENAME}'`
    await termExec(createCommand, 'create-image', 1500)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    await sleep(700)
    record('ID-01-test-image-created', true)
  }

  let gitDiffOpened = false
  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    gitDiffOpened = await waitForGitDiffOpen('open')
    record('ID-02-git-diff-opened', gitDiffOpened)
  }

  let foundIndex = -1
  if (!cancelled() && gitDiffOpened) {
    const loaded = await waitForGitDiffLoaded('loaded')
    const api = getGitDiffApi()
    const fileList = api?.getFileList?.() || []
    foundIndex = fileList.findIndex((file) => file.filename === TEST_IMAGE_FILENAME || file.filename.endsWith(`/${TEST_IMAGE_FILENAME}`) || file.filename.endsWith(`\\${TEST_IMAGE_FILENAME}`))
    record('ID-03-files-loaded', loaded, { fileCount: fileList.length })
    record('ID-03-test-image-found', foundIndex >= 0, { fileCount: fileList.length })
  }

  if (!cancelled() && gitDiffOpened && foundIndex >= 0) {
    const api = getGitDiffApi()
    const selected = api?.selectFileByIndex(foundIndex) === true
    record('ID-04-selected', selected)
    const previewLoaded = selected ? await waitForImagePreview('preview') : false
    record('ID-04-image-preview-loaded', previewLoaded)
    if (previewLoaded) {
      const state = api?.getImagePreviewState?.()
      record('ID-04-is-image', state?.isImage === true, state || undefined)
      record('ID-04-has-modified-url', state?.hasModifiedUrl === true, state || undefined)
      record('ID-04-no-original-url', state?.hasOriginalUrl === false, state || undefined)
    }
  }

  if (!cancelled() && gitDiffOpened) {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await sleep(500)
    record('ID-05-closed', true)
  }

  if (!cancelled()) {
    const cleanupCommand = platform === 'win32'
      ? `del /f "${TEST_IMAGE_FILENAME}" 2>nul`
      : `rm -f "${TEST_IMAGE_FILENAME}"`
    await termExec(cleanupCommand, 'cleanup-image', 800)
    record('ID-06-cleanup', true)
  }

  log('image-diff:done', { totalTests: results.length, passed: results.filter((result) => result.ok).length })
  return results
}
