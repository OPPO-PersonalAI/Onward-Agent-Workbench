/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
const TINY_PNG_ALT_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='
const TEST_IMAGE_FILENAME = '__autotest_image_diff_test.png'
const TEST_SVG_FILENAME = '__autotest_image_diff_test.svg'
const TEST_EDITOR_PNG_PATH = 'resources/test-preview.png'
const TEST_EDITOR_SVG_PATH = 'test/fixtures/markdown-preview-dot.svg'
const HISTORY_REPO_DIR = '__autotest_history_repo'
const TINY_SVG_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJyZWQiLz48L3N2Zz4K'
const TINY_SVG_ALT_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMCAxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJibHVlIi8+PC9zdmc+Cg=='

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function joinPath(base: string, child: string): string {
  const trimmedBase = base.replace(/[\\/]+$/, '')
  return `${trimmedBase}/${child}`
}

export async function testImageDiff(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, openFileInEditor, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const getGitHistoryApi = () => window.__onwardGitHistoryDebug
  const getProjectEditorApi = () => window.__onwardProjectEditorDebug
  const platform = window.electronAPI.platform
  const historyRepoPath = joinPath(rootPath, HISTORY_REPO_DIR)

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

  const waitForGitHistoryOpen = async (label: string, timeout = 10000) => {
    return waitFor(`git-history-open:${label}`, () => {
      const api = getGitHistoryApi()
      return Boolean(api?.isOpen?.())
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

  const findHistoryFileIndex = (filename: string) => {
    const fileList = getGitHistoryApi()?.getFiles?.() || []
    return fileList.findIndex((file) => matchesFileName(file.filename, filename))
  }

  const closeGitHistory = async (label: string) => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
    return waitFor(`git-history-close:${label}`, () => {
      const api = getGitHistoryApi()
      return !api || !api.isOpen()
    }, 4000)
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

  const writeAndSyncTerminal = async (command: string, label: string, waitMs = 900) => {
    await termExec(command, label, waitMs)
    await window.electronAPI.git.notifyTerminalActivity(terminalId)
    await sleep(500)
  }

  log('image-diff:start', { suite: 'ImageDiff' })

  if (!cancelled()) {
    const createCommand = platform === 'win32'
      ? `powershell -Command "[IO.File]::WriteAllBytes('${TEST_IMAGE_FILENAME}', [Convert]::FromBase64String('${TINY_PNG_BASE64}')); [IO.File]::WriteAllBytes('${TEST_SVG_FILENAME}', [Convert]::FromBase64String('${TINY_SVG_BASE64}'))"`
      : `printf '%s' '${TINY_PNG_BASE64}' | base64 -d > '${TEST_IMAGE_FILENAME}' && printf '%s' '${TINY_SVG_BASE64}' | base64 -d > '${TEST_SVG_FILENAME}'`
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

  if (!cancelled()) {
    const historyRepoShellPath = platform === 'win32' ? historyRepoPath.replace(/\//g, '\\') : historyRepoPath
    const createHistoryRepoCommand = platform === 'win32'
      ? `powershell -Command "$repo='${historyRepoShellPath}'; if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }; New-Item -ItemType Directory -Path $repo | Out-Null; git -C $repo init | Out-Null; git -C $repo config user.name 'Onward Autotest'; git -C $repo config user.email 'autotest@example.com'; [IO.File]::WriteAllBytes((Join-Path $repo '${TEST_IMAGE_FILENAME}'), [Convert]::FromBase64String('${TINY_PNG_BASE64}')); [IO.File]::WriteAllBytes((Join-Path $repo '${TEST_SVG_FILENAME}'), [Convert]::FromBase64String('${TINY_SVG_BASE64}')); git -C $repo add '${TEST_IMAGE_FILENAME}' '${TEST_SVG_FILENAME}'; git -C $repo commit -m 'base images' | Out-Null; [IO.File]::WriteAllBytes((Join-Path $repo '${TEST_IMAGE_FILENAME}'), [Convert]::FromBase64String('${TINY_PNG_ALT_BASE64}')); [IO.File]::WriteAllBytes((Join-Path $repo '${TEST_SVG_FILENAME}'), [Convert]::FromBase64String('${TINY_SVG_ALT_BASE64}')); git -C $repo add '${TEST_IMAGE_FILENAME}' '${TEST_SVG_FILENAME}'; git -C $repo commit -m 'update images' | Out-Null"`
      : `rm -rf '${historyRepoPath}' && mkdir '${historyRepoPath}' && git -C '${historyRepoPath}' init >/dev/null && git -C '${historyRepoPath}' config user.name 'Onward Autotest' && git -C '${historyRepoPath}' config user.email 'autotest@example.com' && printf '%s' '${TINY_PNG_BASE64}' | base64 -d > '${historyRepoPath}/${TEST_IMAGE_FILENAME}' && printf '%s' '${TINY_SVG_BASE64}' | base64 -d > '${historyRepoPath}/${TEST_SVG_FILENAME}' && git -C '${historyRepoPath}' add '${TEST_IMAGE_FILENAME}' '${TEST_SVG_FILENAME}' && git -C '${historyRepoPath}' commit -m 'base images' >/dev/null && printf '%s' '${TINY_PNG_ALT_BASE64}' | base64 -d > '${historyRepoPath}/${TEST_IMAGE_FILENAME}' && printf '%s' '${TINY_SVG_ALT_BASE64}' | base64 -d > '${historyRepoPath}/${TEST_SVG_FILENAME}' && git -C '${historyRepoPath}' add '${TEST_IMAGE_FILENAME}' '${TEST_SVG_FILENAME}' && git -C '${historyRepoPath}' commit -m 'update images' >/dev/null`
    await writeAndSyncTerminal(createHistoryRepoCommand, 'create-history-repo', 2500)
    const historyRepoResult = await window.electronAPI.git.getHistory(historyRepoPath, {
      limit: 5,
      skip: 0
    })
    const historyRepoReady = Boolean(historyRepoResult.success && historyRepoResult.commits.length >= 2)
    record('ID-13-history-repo-ready', historyRepoReady, {
      repoPath: historyRepoPath,
      success: historyRepoResult.success,
      commitCount: historyRepoResult.commits.length,
      error: historyRepoResult.error ?? null
    })
  }

  if (!cancelled()) {
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
    const historyOpened = await waitForGitHistoryOpen('image-history-open')
    if (historyOpened) {
      getGitHistoryApi()?.switchRepo?.(historyRepoPath)
    }
    const repoSwitched = historyOpened && await waitFor('git-history-switch-repo', () => {
      const api = getGitHistoryApi()
      return normalizePath(api?.getActiveCwd?.() ?? '') === normalizePath(historyRepoPath)
    }, 10000, 120)
    record('ID-14-git-history-opened', Boolean(historyOpened && repoSwitched), {
      historyOpened,
      repoSwitched,
      activeCwd: getGitHistoryApi()?.getActiveCwd?.() ?? null
    })
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const loaded = await waitFor('git-history-files-loaded', () => {
      const api = getGitHistoryApi()
      return Boolean(api && api.getCommitCount() >= 2)
    }, 10000, 120)
    const selected = getGitHistoryApi()?.selectCommitByIndex(0) === true
    const filesLoaded = await waitFor('git-history-image-files', () => {
      const api = getGitHistoryApi()
      const files = api?.getFiles?.() || []
      return files.some((file) => matchesFileName(file.filename, TEST_IMAGE_FILENAME)) &&
        files.some((file) => matchesFileName(file.filename, TEST_SVG_FILENAME))
    }, 10000, 120)
    record('ID-15-git-history-files-loaded', loaded && selected && filesLoaded, {
      loaded,
      selected,
      files: getGitHistoryApi()?.getFiles?.() || []
    })
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const pngIndex = findHistoryFileIndex(TEST_IMAGE_FILENAME)
    const pngSelected = pngIndex >= 0 && getGitHistoryApi()?.selectFileByIndex?.(pngIndex) === true
    const pngPreviewLoaded = pngSelected && await waitFor('git-history-png-state', () => {
      const api = getGitHistoryApi()
      const selected = api?.getSelectedFile?.()
      const state = api?.getImagePreviewState?.()
      return matchesFileName(selected?.filename, TEST_IMAGE_FILENAME) &&
        Boolean(state && !state.loading && !state.isSvg && state.hasOriginalUrl && state.hasModifiedUrl)
    }, 12000, 120)
    const pngState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-16-git-history-png-preview', Boolean(pngPreviewLoaded && pngState?.hasOriginalUrl && pngState?.hasModifiedUrl), {
      pngIndex,
      state: pngState || null
    })
    getGitHistoryApi()?.setImageCompareMode?.('swipe')
    await sleep(200)
    const swipeState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-16-git-history-png-swipe', swipeState?.compareMode === 'swipe', { state: swipeState || null })
    getGitHistoryApi()?.setImageCompareMode?.('onion')
    await sleep(200)
    const onionState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-16-git-history-png-onion', onionState?.compareMode === 'onion', { state: onionState || null })
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const svgIndex = findHistoryFileIndex(TEST_SVG_FILENAME)
    const svgSelected = svgIndex >= 0 && getGitHistoryApi()?.selectFileByIndex?.(svgIndex) === true
    const svgPreviewLoaded = svgSelected && await waitFor('git-history-svg-state', () => {
      const api = getGitHistoryApi()
      const selected = api?.getSelectedFile?.()
      const state = api?.getImagePreviewState?.()
      return matchesFileName(selected?.filename, TEST_SVG_FILENAME) &&
        Boolean(state && !state.loading && state.isSvg && state.hasOriginalUrl && state.hasModifiedUrl)
    }, 12000, 120)
    const svgState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-17-git-history-svg-preview', Boolean(svgPreviewLoaded && svgState?.isSvg && svgState?.hasOriginalUrl && svgState?.hasModifiedUrl), {
      svgIndex,
      state: svgState || null
    })
    getGitHistoryApi()?.setSvgViewMode?.('text')
    await sleep(200)
    const svgTextState = getGitHistoryApi()?.getImagePreviewState?.()
    record('ID-17-git-history-svg-text-mode', svgTextState?.svgViewMode === 'text', { state: svgTextState || null })
    getGitHistoryApi()?.setSvgViewMode?.('visual')
    await sleep(200)
  }

  if (!cancelled() && getGitHistoryApi()?.isOpen?.()) {
    const historyClosed = await closeGitHistory('image-history-close')
    record('ID-18-git-history-closed', historyClosed)
  }

  if (!cancelled()) {
    await openFileInEditor(TEST_EDITOR_PNG_PATH)
    const pngEditorReady = await waitFor('editor-png-preview', () => {
      const api = getProjectEditorApi()
      const state = api?.getImageFilePreviewState?.()
      return api?.getActiveFilePath?.() === TEST_EDITOR_PNG_PATH && Boolean(state?.visible && state.loaded && !state.broken)
    }, 10000, 120)
    record('ID-19-editor-png-preview', pngEditorReady, {
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null,
      state: getProjectEditorApi()?.getImageFilePreviewState?.() ?? null
    })

    await openFileInEditor(TEST_EDITOR_SVG_PATH)
    const svgEditorReady = await waitFor('editor-svg-preview', () => {
      const api = getProjectEditorApi()
      const state = api?.getImageFilePreviewState?.()
      return api?.getActiveFilePath?.() === TEST_EDITOR_SVG_PATH && Boolean(state?.visible && state.loaded && !state.broken)
    }, 10000, 120)
    record('ID-19-editor-svg-preview', svgEditorReady, {
      activeFilePath: getProjectEditorApi()?.getActiveFilePath?.() ?? null,
      state: getProjectEditorApi()?.getImageFilePreviewState?.() ?? null
    })
  }

  if (!cancelled() && gitDiffOpened) {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await sleep(500)
    record('ID-20-closed', true)
  }

  if (!cancelled()) {
    const cleanupCommand = platform === 'win32'
      ? `powershell -Command "Remove-Item -Force '${TEST_IMAGE_FILENAME}','${TEST_SVG_FILENAME}' -ErrorAction SilentlyContinue; if (Test-Path '${HISTORY_REPO_DIR}') { Remove-Item -Recurse -Force '${HISTORY_REPO_DIR}' }"`
      : `rm -f "${TEST_IMAGE_FILENAME}" "${TEST_SVG_FILENAME}" && rm -rf "${HISTORY_REPO_DIR}"`
    await termExec(cleanupCommand, 'cleanup-image', 800)
    record('ID-21-cleanup', true)
  }

  log('image-diff:done', { totalTests: results.length, passed: results.filter((result) => result.ok).length })
  return results
}
