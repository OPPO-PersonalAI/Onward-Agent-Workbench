/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Phase 5: Regression testing (migrating existing T1-T6 + ESC testing + Markdown preview)
 */
import type { AutotestContext, TestResult } from './types'

const SCROLL_TOLERANCE = 200

export async function testRegression(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath, reopenProjectEditor } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase5:start', { suite: 'Regression' })

  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const getProjectEditorApi = () => window.__onwardProjectEditorDebug

  const waitForGitDiffOpen = async (label: string) => {
    return await waitFor(`gitdiff-open:${label}`, () => {
      const api = getGitDiffApi()
      return Boolean(api?.isOpen && api.isOpen())
    }, 8000)
  }

  const waitForGitDiffLoaded = async (label: string) => {
    return await waitFor(`gitdiff-loaded:${label}`, () => {
      const api = getGitDiffApi()
      return Boolean(api?.getFileList && api.getFileList().length > 0)
    }, 8000)
  }

  const waitForGitDiffSelectedReady = async (label: string) => {
    return await waitFor(`gitdiff-selected:${label}`, () => {
      const api = getGitDiffApi()
      return Boolean(api?.isSelectedReady && api.isSelectedReady())
    }, 8000)
  }

  const waitForGitDiffSelectedFile = async (label: string, path: string) => {
    return await waitFor(`gitdiff-selected-file:${label}`, () => {
      const api = getGitDiffApi()
      const selected = api?.getSelectedFile?.()
      return Boolean(selected && (selected.filename === path || selected.originalFilename === path))
    }, 8000)
  }

  const waitForProjectEditorFile = async (label: string, path: string) => {
    return await waitFor(`project-editor-file:${label}`, () => {
      const api = getProjectEditorApi()
      return Boolean(api?.isOpen?.() && api.getActiveFilePath?.() === path)
    }, 8000)
  }

  const openGitDiff = async (label: string) => {
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
    const opened = await waitForGitDiffOpen(label)
    if (!opened) {
      log('gitdiff-open-failed', { label })
      return false
    }
    const loaded = await waitForGitDiffLoaded(label)
    if (!loaded) {
      log('gitdiff-load-timeout', { label })
    }
    return true
  }

  const closeGitDiff = async (label: string) => {
    window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId } }))
    await sleep(800)
    log('gitdiff-closed', { label })
  }

  const dispatchEscape = () => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true
    }))
  }

  // Create temporary files for regression testing
  const tempBaseContent = '# AutoTest Temporary File\n\n- Initial content\n'
  let tempPath = 'onward-autotest-regression.md'
  let createResult = await window.electronAPI.project.createFile(rootPath, tempPath, tempBaseContent)
  if (!createResult.success) {
    tempPath = `onward-autotest-regression-${Date.now()}.md`
    createResult = await window.electronAPI.project.createFile(rootPath, tempPath, tempBaseContent)
  }

  if (!createResult.success) {
    log('regression:temp-create-failed', { path: tempPath, error: createResult.error })
    results.push({ name: 'RG-00-setup', ok: false, detail: { reason: 'cannot create temp file' } })
    return results
  }
  log('regression:temp-created', { path: tempPath })

  // Create dual files for saving target regressions
  const saveTargetSuffix = Date.now()
  const saveTargetAPath = `onward-autotest-save-target-a-${saveTargetSuffix}.txt`
  const saveTargetBPath = `onward-autotest-save-target-b-${saveTargetSuffix}.txt`
  const saveTargetAContent = 'AUTOTEST_SAVE_TARGET_A_ORIGINAL\n'
  const saveTargetBContent = 'AUTOTEST_SAVE_TARGET_B_ORIGINAL\nSECOND_LINE\n'
  const createSaveTargetA = await window.electronAPI.project.createFile(rootPath, saveTargetAPath, saveTargetAContent)
  const createSaveTargetB = await window.electronAPI.project.createFile(rootPath, saveTargetBPath, saveTargetBContent)
  const saveTargetReady = createSaveTargetA.success && createSaveTargetB.success
  if (!saveTargetReady) {
    log('regression:save-target-setup-failed', {
      saveTargetAPath,
      saveTargetBPath,
      createSaveTargetA,
      createSaveTargetB
    })
  }

  // Add content to diff (make files appear in git diff)
  const longLines = Array.from({ length: 120 }, (_, idx) => `- Line ${idx + 1}`).join('\n')
  const payload = `\n\n## AutoTest Regression\n\n- Regression verification\n${longLines}\n`
  const fullContent = tempBaseContent + payload
  await window.electronAPI.project.saveFile(rootPath, tempPath, fullContent)
  await sleep(300)

  if (terminalId) {
    await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
    await sleep(600)
  }

  let tempDeleted = false
  let tempInDiff = false
  let saveTargetADeleted = false
  let saveTargetBDeleted = false

  try {
    // Open Git Diff baseline
    const baselineOpened = await openGitDiff('regression-baseline')
    if (baselineOpened) {
      const api = getGitDiffApi()!
      const files = api.getFileList()
      tempInDiff = files.some(f => f.filename === tempPath || f.originalFilename === tempPath)
      if (tempInDiff) {
        api.selectFileByPath(tempPath)
        await waitForGitDiffSelectedFile('regression-baseline', tempPath)
        await waitForGitDiffSelectedReady('regression-baseline')
      } else if (files.length > 0) {
        api.selectFileByIndex(0)
        await waitForGitDiffSelectedReady('regression-baseline')
      }
    }

    if (baselineOpened && tempInDiff) {
      // RG-01: Git Diff rolling capture (T1)
      if (!cancelled()) {
        const api = getGitDiffApi()!
        api.scrollToFraction(0.7)
        await sleep(400)
        const scrollAfterFraction = api.getScrollTop()
        const lineAfterFraction = api.getFirstVisibleLine()
        _assert('RG-01-scroll-capture', scrollAfterFraction > 50, {
          scrollTop: scrollAfterFraction,
          line: lineAfterFraction
        })

        // RG-02: Close → Reopen → Position recovery (T2)
        if (!cancelled()) {
          await closeGitDiff('rg02-close')
          await reopenProjectEditor('rg02-reopen')
          const t2Opened = await openGitDiff('rg02-restore')
          if (t2Opened) {
            await waitForGitDiffSelectedReady('rg02-restore')
            await sleep(400)
            const api2 = getGitDiffApi()!
            const restoredScrollTop = api2.getScrollTop()
            const restoredLine = api2.getFirstVisibleLine()
            const scrollDelta = Math.abs(restoredScrollTop - scrollAfterFraction)
            const lineDelta = Math.abs(restoredLine - lineAfterFraction)
            _assert('RG-02-reopen-restore-scroll', scrollDelta < SCROLL_TOLERANCE, {
              expected: scrollAfterFraction,
              actual: restoredScrollTop,
              delta: scrollDelta
            })
            _assert('RG-02-reopen-restore-line', lineDelta <= 5, {
              expected: lineAfterFraction,
              actual: restoredLine,
              delta: lineDelta
            })
            const notice = api2.getRestoreNotice()
            _assert('RG-02-no-notice', notice === null, { notice })

            // RG-03: File switching memory (T3)
            if (!cancelled()) {
              const fileList = api2.getFileList()
              if (fileList.length >= 2) {
                api2.scrollToFraction(0.3)
                await sleep(400)
                const fileAScrollTop = api2.getScrollTop()
                const fileALine = api2.getFirstVisibleLine()

                const otherFile = fileList.find(f => f.filename !== tempPath) || fileList[0]
                api2.selectFileByPath(otherFile.filename)
                await waitForGitDiffSelectedReady('rg03-switch-B')
                await sleep(400)

                const api3 = getGitDiffApi()!
                api3.scrollToFraction(0.9)
                await sleep(400)
                const fileBScrollTop = api3.getScrollTop()
                const fileBLine = api3.getFirstVisibleLine()

                api3.selectFileByPath(tempPath)
                await waitForGitDiffSelectedFile('rg03-back-A', tempPath)
                await waitForGitDiffSelectedReady('rg03-back-A')
                await sleep(400)
                const api4 = getGitDiffApi()!
                const fileARestoredScroll = api4.getScrollTop()
                const fileARestoredLine = api4.getFirstVisibleLine()
                _assert('RG-03-file-switch-A-scroll', Math.abs(fileARestoredScroll - fileAScrollTop) < SCROLL_TOLERANCE, {
                  expected: fileAScrollTop, actual: fileARestoredScroll,
                  delta: Math.abs(fileARestoredScroll - fileAScrollTop)
                })
                _assert('RG-03-file-switch-A-line', Math.abs(fileARestoredLine - fileALine) <= 5, {
                  expected: fileALine, actual: fileARestoredLine,
                  delta: Math.abs(fileARestoredLine - fileALine)
                })

                api4.selectFileByPath(otherFile.filename)
                await waitForGitDiffSelectedReady('rg03-back-B')
                await sleep(400)
                const api5 = getGitDiffApi()!
                const fileBRestoredScroll = api5.getScrollTop()
                const fileBRestoredLine = api5.getFirstVisibleLine()
                _assert('RG-03-file-switch-B-scroll', Math.abs(fileBRestoredScroll - fileBScrollTop) < SCROLL_TOLERANCE, {
                  expected: fileBScrollTop, actual: fileBRestoredScroll,
                  delta: Math.abs(fileBRestoredScroll - fileBScrollTop)
                })
                _assert('RG-03-file-switch-B-line', Math.abs(fileBRestoredLine - fileBLine) <= 5, {
                  expected: fileBLine, actual: fileBRestoredLine,
                  delta: Math.abs(fileBRestoredLine - fileBLine)
                })
              } else {
                log('rg03-skip', { reason: 'need-2-files', count: fileList.length })
              }
            }

            // RG-04: ScrollToFirstChange/Top（T4）
            if (!cancelled()) {
              const api4 = getGitDiffApi()!
              api4.selectFileByPath(tempPath)
              await waitForGitDiffSelectedReady('rg04-actions')
              await sleep(300)
              const api4b = getGitDiffApi()!
              api4b.scrollToFraction(0)
              await sleep(200)
              const topScroll = api4b.getScrollTop()
              api4b.scrollToFraction(0.5)
              await sleep(200)
              const midScroll = api4b.getScrollTop()
              _assert('RG-04-scroll-midpoint', midScroll > topScroll + 10, {
                top: topScroll, mid: midScroll
              })
            }
          }
        }
      }

      await closeGitDiff('rg04-close')
      await reopenProjectEditor('rg05-changed')

      // RG-05: Content change prompt (T5)
      if (!cancelled() && tempInDiff) {
        const changedContent = '# AutoTest Updated Content\n\n- Keep only three lines\n- Line 2\n- Line 3\n'
        await window.electronAPI.project.saveFile(rootPath, tempPath, changedContent)
        if (terminalId) {
          await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
        }
        const changedOpened = await openGitDiff('rg05-changed')
        if (changedOpened) {
          await waitForGitDiffSelectedReady('rg05-changed')
          await sleep(400)
          const api5 = getGitDiffApi()!
          const notice = api5.getRestoreNotice()
          _assert('RG-05-changed-notice', notice?.type === 'changed', { notice })
        }
        await closeGitDiff('rg05-changed')
        await reopenProjectEditor('rg06-missing')
      }

      // RG-06: File missing prompt (T6)
      if (!cancelled()) {
        const deleteResult = await window.electronAPI.project.deletePath(rootPath, tempPath)
        tempDeleted = deleteResult.success
        if (terminalId) {
          await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
        }
        await sleep(600)
        if (tempInDiff) {
          const missingOpened = await openGitDiff('rg06-missing')
          if (missingOpened) {
            // Wait for restoreNotice to appear
            const noticeAppeared = await waitFor('rg06-notice', () => {
              const a = getGitDiffApi()
              const n = a?.getRestoreNotice()
              return n?.type === 'missing'
            }, 6000)
            const notice = getGitDiffApi()?.getRestoreNotice() ?? null
            _assert('RG-06-missing-notice', noticeAppeared && notice?.type === 'missing', { notice })
          }
          await closeGitDiff('rg06-missing')
          await reopenProjectEditor('rg06-cleanup')
        }
      }
    } else {
      log('regression:skip-git-diff', { reason: baselineOpened ? 'temp-not-in-diff' : 'open-failed' })
      await closeGitDiff('regression-skip-cleanup')
      await reopenProjectEditor('regression-skip-cleanup')
    }

    // RG-09: Select A first and then B. The editor shortcut must hit B to save (A cannot be contaminated)
    if (!cancelled()) {
      if (!saveTargetReady) {
        _assert('RG-09-editor-shortcut-save-target', false, { reason: 'save target setup failed' })
      } else {
        const projectEditorApi = getProjectEditorApi()
        if (!projectEditorApi) {
          _assert('RG-09-editor-shortcut-save-target', false, { reason: 'project editor debug api missing' })
        } else {
          await projectEditorApi.openFileByPath(saveTargetAPath)
          await waitForProjectEditorFile('rg09-open-a', saveTargetAPath)
          await projectEditorApi.openFileByPath(saveTargetBPath)
          const openedB = await waitForProjectEditorFile('rg09-open-b', saveTargetBPath)
          const triggered = openedB ? projectEditorApi.triggerEditorSaveCommand() : false
          await sleep(350)
          const [readA, readB] = await Promise.all([
            window.electronAPI.project.readFile(rootPath, saveTargetAPath),
            window.electronAPI.project.readFile(rootPath, saveTargetBPath)
          ])
          const aUnchanged = readA.success && !readA.isBinary && !readA.isImage && readA.content === saveTargetAContent
          const bUnchanged = readB.success && !readB.isBinary && !readB.isImage && readB.content === saveTargetBContent
          _assert('RG-09-editor-shortcut-save-target', openedB && triggered && aUnchanged && bUnchanged, {
            openedB,
            triggered,
            aUnchanged,
            bUnchanged,
            activeFile: projectEditorApi.getActiveFilePath?.()
          })
        }
      }
    }

    // RG-10: Select A first and then select B. You must also hit B when saving in the toolbar.
    if (!cancelled()) {
      if (!saveTargetReady) {
        _assert('RG-10-toolbar-save-target', false, { reason: 'save target setup failed' })
      } else {
        await window.electronAPI.project.saveFile(rootPath, saveTargetAPath, saveTargetAContent)
        await window.electronAPI.project.saveFile(rootPath, saveTargetBPath, saveTargetBContent)
        await sleep(120)
        const projectEditorApi = getProjectEditorApi()
        if (!projectEditorApi) {
          _assert('RG-10-toolbar-save-target', false, { reason: 'project editor debug api missing' })
        } else {
          await projectEditorApi.openFileByPath(saveTargetAPath)
          await waitForProjectEditorFile('rg10-open-a', saveTargetAPath)
          await projectEditorApi.openFileByPath(saveTargetBPath)
          const openedB = await waitForProjectEditorFile('rg10-open-b', saveTargetBPath)
          const triggered = openedB ? await projectEditorApi.triggerToolbarSave() : false
          await sleep(250)
          const [readA, readB] = await Promise.all([
            window.electronAPI.project.readFile(rootPath, saveTargetAPath),
            window.electronAPI.project.readFile(rootPath, saveTargetBPath)
          ])
          const aUnchanged = readA.success && !readA.isBinary && !readA.isImage && readA.content === saveTargetAContent
          const bUnchanged = readB.success && !readB.isBinary && !readB.isImage && readB.content === saveTargetBContent
          _assert('RG-10-toolbar-save-target', openedB && triggered && aUnchanged && bUnchanged, {
            openedB,
            triggered,
            aUnchanged,
            bUnchanged,
            activeFile: projectEditorApi.getActiveFilePath?.()
          })
        }
      }
    }

    // RG-07: ESC closes Git Diff
    if (!cancelled()) {
      const diffOpened = await openGitDiff('rg07-esc')
      if (diffOpened) {
        dispatchEscape()
        const closed = await waitFor('rg07-esc-close', () => {
          const api = getGitDiffApi()
          return !api || !api.isOpen()
        }, 4000)
        _assert('RG-07-esc-close-gitdiff', closed, { closed })
        await sleep(300)
        await reopenProjectEditor('rg07-cleanup')
      } else {
        results.push({ name: 'RG-07-esc-close-gitdiff', ok: false, detail: { reason: 'git diff did not open' } })
      }
    }

    // RG-08: ESC closes ProjectEditor
    if (!cancelled()) {
      const peOpen = await reopenProjectEditor('rg08-esc')
      if (peOpen) {
        dispatchEscape()
        const closed = await waitFor('rg08-esc-close', () => !ctx.isOpenRef.current, 4000)
        _assert('RG-08-esc-close-project-editor', closed, { closed })
        await sleep(300)
      } else {
        results.push({ name: 'RG-08-esc-close-project-editor', ok: false, detail: { reason: 'project editor did not open' } })
      }
    }

  } finally {
    if (!tempDeleted) {
      const cleanup = await window.electronAPI.project.deletePath(rootPath, tempPath)
      log('regression:temp-clean', { ok: cleanup.success, error: cleanup.error })
      if (terminalId) {
        await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
      }
    }
    if (saveTargetReady && !saveTargetADeleted) {
      const cleanupA = await window.electronAPI.project.deletePath(rootPath, saveTargetAPath)
      saveTargetADeleted = cleanupA.success
      log('regression:save-target-a-clean', { ok: cleanupA.success, error: cleanupA.error })
    }
    if (saveTargetReady && !saveTargetBDeleted) {
      const cleanupB = await window.electronAPI.project.deletePath(rootPath, saveTargetBPath)
      saveTargetBDeleted = cleanupB.success
      log('regression:save-target-b-clean', { ok: cleanupB.success, error: cleanupB.error })
    }
    if (terminalId) {
      await window.electronAPI.git.notifyTerminalGitUpdate(terminalId)
    }
  }

  log('phase5:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
