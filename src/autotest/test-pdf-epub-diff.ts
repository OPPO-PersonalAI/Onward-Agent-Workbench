/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Exercises Git Diff + Git History compare views for PDF and EPUB files.
 *
 * User-facing flow being validated:
 *   1. User edits a PDF / EPUB in a git repo.
 *   2. User opens Git Diff (terminal → subpage).
 *   3. User clicks the PDF file in the diff list. They see a side-by-side
 *      PDF viewer comparing the base and modified versions.
 *   4. User clicks the EPUB file. They see a chapter list with badges for
 *      unchanged / modified / added chapters. Clicking a modified chapter
 *      shows line-level additions / deletions highlighted in the panes.
 *   5. User commits the changes and opens Git History. The same compare
 *      views should render for the two selected commits.
 *
 * Each assertion in this suite corresponds to something the user would
 * actually perceive: the component being visible, a status badge having the
 * expected color/text, diff lines showing up, etc.
 */

import type { AutotestContext, TestResult } from './types'

const PDF_BASE64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDMwIDEwMCBUZCAoT253YXJkIEF1dG90ZXN0IFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNDcgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MTcKJSVFT0YK'

const PDF_ALT_BASE64 =
  'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MyA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDMwIDEwMCBUZCAoT253YXJkIEF1dG90ZXN0IFBERiB2MikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNTAgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjAKJSVFT0YK'

const EPUB_BASE64 =
  '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'

const EPUB_ALT_BASE64 =
  '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'

const REPO_DIR = '__autotest_pdf_epub_diff_repo'
const PDF_NAME = 'book.pdf'
const EPUB_NAME = 'book.epub'

function joinPath(base: string, child: string): string {
  const trimmed = base.replace(/[\\/]+$/, '')
  return `${trimmed}/${child}`
}

function windowsPath(p: string): string {
  return p.replace(/\//g, '\\')
}

function buildRepoSetupCommand(platform: string, repoPath: string): string {
  if (platform === 'win32') {
    const repo = windowsPath(repoPath)
    return `powershell -Command "$repo='${repo}'; if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }; New-Item -ItemType Directory -Path $repo | Out-Null; git -C $repo init | Out-Null; git -C $repo config user.name 'Onward Autotest'; git -C $repo config user.email 'autotest@example.com'; [IO.File]::WriteAllBytes((Join-Path $repo '${PDF_NAME}'), [Convert]::FromBase64String('${PDF_BASE64}')); [IO.File]::WriteAllBytes((Join-Path $repo '${EPUB_NAME}'), [Convert]::FromBase64String('${EPUB_BASE64}')); git -C $repo add '${PDF_NAME}' '${EPUB_NAME}'; git -C $repo commit -m 'base PDF/EPUB' | Out-Null; [IO.File]::WriteAllBytes((Join-Path $repo '${PDF_NAME}'), [Convert]::FromBase64String('${PDF_ALT_BASE64}')); [IO.File]::WriteAllBytes((Join-Path $repo '${EPUB_NAME}'), [Convert]::FromBase64String('${EPUB_ALT_BASE64}'))"`
  }
  return `rm -rf '${repoPath}' && mkdir -p '${repoPath}' && git -C '${repoPath}' init >/dev/null && git -C '${repoPath}' config user.name 'Onward Autotest' && git -C '${repoPath}' config user.email 'autotest@example.com' && printf '%s' '${PDF_BASE64}' | base64 -d > '${repoPath}/${PDF_NAME}' && printf '%s' '${EPUB_BASE64}' | base64 -d > '${repoPath}/${EPUB_NAME}' && git -C '${repoPath}' add '${PDF_NAME}' '${EPUB_NAME}' && git -C '${repoPath}' commit -m 'base PDF/EPUB' >/dev/null && printf '%s' '${PDF_ALT_BASE64}' | base64 -d > '${repoPath}/${PDF_NAME}' && printf '%s' '${EPUB_ALT_BASE64}' | base64 -d > '${repoPath}/${EPUB_NAME}'`
}

function buildRepoCommitCommand(platform: string, repoPath: string, message: string): string {
  if (platform === 'win32') {
    const repo = windowsPath(repoPath)
    return `powershell -Command "git -C '${repo}' add -A; git -C '${repo}' commit -m '${message}' | Out-Null"`
  }
  return `git -C '${repoPath}' add -A && git -C '${repoPath}' commit -m '${message}' >/dev/null`
}

function buildCdCommand(platform: string, repoPath: string): string {
  if (platform === 'win32') return `cd /d '${windowsPath(repoPath)}'`
  return `cd '${repoPath}'`
}

function buildCleanupCommand(platform: string, repoPath: string): string {
  if (platform === 'win32') {
    return `powershell -Command "if (Test-Path '${windowsPath(repoPath)}') { Remove-Item -Recurse -Force '${windowsPath(repoPath)}' }"`
  }
  return `rm -rf '${repoPath}'`
}

export async function testPdfEpubDiff(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId, rootPath } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const platform = window.electronAPI.platform
  const repoPath = joinPath(rootPath, REPO_DIR)
  const getGitDiffApi = () => window.__onwardGitDiffDebug
  const getGitHistoryApi = () => window.__onwardGitHistoryDebug

  const termExec = async (command: string, label: string, waitMs = 1200) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`exec:${label}`)
  }

  // ---------- Setup: temp repo with a base commit + unstaged modifications ----------

  log('pdf-epub-diff:start', { repoPath })
  await termExec(buildRepoSetupCommand(platform, repoPath), 'setup-repo', 3000)

  // Switch the terminal into the repo so Git Diff / Git History see it.
  await termExec(buildCdCommand(platform, repoPath), 'cd-repo', 1200)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(600)

  // ---------- Git Diff: click the PDF ----------

  window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId, source: 'debug' } }))
  const diffOpened = await waitFor(
    'git-diff-open',
    () => Boolean(getGitDiffApi()?.isOpen?.()),
    10000
  )
  record('git-diff-opened', diffOpened)
  if (!diffOpened || cancelled()) return results

  const filesLoaded = await waitFor(
    'git-diff-files-loaded',
    () => {
      const list = getGitDiffApi()?.getFileList?.() || []
      return list.some(f => f.filename.endsWith(PDF_NAME)) &&
        list.some(f => f.filename.endsWith(EPUB_NAME))
    },
    12000
  )
  record('git-diff-files-loaded', filesLoaded, {
    fileList: getGitDiffApi()?.getFileList?.().map(f => f.filename) ?? []
  })
  if (!filesLoaded) return results

  const fileList = getGitDiffApi()?.getFileList?.() ?? []
  const pdfIndex = fileList.findIndex(f => f.filename.endsWith(PDF_NAME))
  const epubIndex = fileList.findIndex(f => f.filename.endsWith(EPUB_NAME))

  // Click the PDF: user action.
  getGitDiffApi()?.selectFileByIndex(pdfIndex)
  const pdfCompareVisible = await waitFor(
    'git-diff-pdf-compare',
    () => Boolean(getGitDiffApi()?.getPdfCompareState?.()?.visible),
    12000
  )
  record('git-diff-pdf-compare-visible', pdfCompareVisible, {
    state: getGitDiffApi()?.getPdfCompareState?.() ?? null
  })
  const pdfState = getGitDiffApi()?.getPdfCompareState?.() ?? null
  record('git-diff-pdf-status-modified', pdfState?.status === 'modified', { state: pdfState })
  record('git-diff-pdf-both-sides-populated',
    Boolean(pdfState?.originalSrc && pdfState?.modifiedSrc && !pdfState?.originalHasEmpty && !pdfState?.modifiedHasEmpty),
    { state: pdfState }
  )
  record('git-diff-pdf-sides-differ',
    Boolean(pdfState?.originalSrc && pdfState?.modifiedSrc && pdfState.originalSrc !== pdfState.modifiedSrc),
    { original: pdfState?.originalSrc?.slice(0, 80), modified: pdfState?.modifiedSrc?.slice(0, 80) }
  )

  // ---------- Git Diff: click the EPUB ----------

  getGitDiffApi()?.selectFileByIndex(epubIndex)
  const epubCompareVisible = await waitFor(
    'git-diff-epub-compare',
    () => Boolean(getGitDiffApi()?.getEpubCompareState?.()?.visible),
    20000
  )
  record('git-diff-epub-compare-visible', epubCompareVisible, {
    state: getGitDiffApi()?.getEpubCompareState?.() ?? null
  })

  const epubState = await (async () => {
    // The chapter list is populated after epubjs finishes opening both books.
    await waitFor(
      'git-diff-epub-chapters-listed',
      () => (getGitDiffApi()?.getEpubCompareState?.()?.chapterCount ?? 0) >= 2,
      20000,
      200
    )
    return getGitDiffApi()?.getEpubCompareState?.() ?? null
  })()
  record('git-diff-epub-chapters-populated', (epubState?.chapterCount ?? 0) >= 2, { state: epubState })
  record('git-diff-epub-status-modified', epubState?.status === 'modified', { state: epubState })
  record('git-diff-epub-has-modified-chapter',
    (epubState?.chapterBadges ?? []).some(c => c.kind === 'modified'),
    { badges: epubState?.chapterBadges }
  )
  record('git-diff-epub-has-unchanged-chapter',
    (epubState?.chapterBadges ?? []).some(c => c.kind === 'unchanged'),
    { badges: epubState?.chapterBadges }
  )

  // Click the modified chapter: user action. Verify diff lines highlight.
  const modifiedChapter = (epubState?.chapterBadges ?? []).find(c => c.kind === 'modified')
  if (modifiedChapter) {
    const btn = Array.from(
      document.querySelectorAll('.git-epub-compare-chapter-item')
    ).find(el => (el as HTMLElement).dataset?.href === modifiedChapter.href) as HTMLElement | undefined
    btn?.click()
    await sleep(400)
    const afterClick = getGitDiffApi()?.getEpubCompareState?.() ?? null
    record('git-diff-epub-modified-chapter-selected',
      afterClick?.selectedHref === modifiedChapter.href,
      { afterClick }
    )
    record('git-diff-epub-modified-chapter-has-add-lines',
      (afterClick?.diffCounts?.add ?? 0) > 0,
      { diffCounts: afterClick?.diffCounts }
    )
  } else {
    record('git-diff-epub-modified-chapter-selected', false, { reason: 'no-modified-chapter' })
  }

  // Close Git Diff with ESC (user action) so the next step starts clean.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor('git-diff-close', () => !getGitDiffApi()?.isOpen?.(), 5000)

  if (cancelled()) return results

  // ---------- Git History: commit the modification + open history ----------

  await termExec(buildRepoCommitCommand(platform, repoPath, 'updated PDF/EPUB'), 'commit-alt', 2500)
  await window.electronAPI.git.notifyTerminalActivity(terminalId)
  await sleep(500)

  window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
  const historyOpened = await waitFor(
    'git-history-open',
    () => Boolean(getGitHistoryApi()?.isOpen?.()),
    10000
  )
  record('git-history-opened', historyOpened)
  if (!historyOpened || cancelled()) return results

  getGitHistoryApi()?.switchRepo?.(repoPath)
  const repoSwitched = await waitFor(
    'git-history-switch-repo',
    () => {
      const active = getGitHistoryApi()?.getActiveCwd?.() ?? ''
      return active.replace(/\\/g, '/') === repoPath.replace(/\\/g, '/')
    },
    10000
  )
  record('git-history-repo-switched', repoSwitched, {
    activeCwd: getGitHistoryApi()?.getActiveCwd?.() ?? null
  })

  const commitsReady = await waitFor(
    'git-history-commits-ready',
    () => (getGitHistoryApi()?.getCommitCount?.() ?? 0) >= 2,
    10000
  )
  record('git-history-commits-ready', commitsReady, {
    commits: getGitHistoryApi()?.getCommitCount?.()
  })
  if (!commitsReady) return results

  // Select the latest commit (index 0): user action (click first row).
  getGitHistoryApi()?.selectCommitByIndex(0)
  const historyFilesLoaded = await waitFor(
    'git-history-files-loaded',
    () => {
      const files = getGitHistoryApi()?.getFiles?.() ?? []
      return files.some(f => f.filename.endsWith(PDF_NAME)) && files.some(f => f.filename.endsWith(EPUB_NAME))
    },
    10000
  )
  record('git-history-files-loaded', historyFilesLoaded)

  // Select PDF in history viewer.
  const historyFiles = getGitHistoryApi()?.getFiles?.() ?? []
  const hPdfIdx = historyFiles.findIndex(f => f.filename.endsWith(PDF_NAME))
  const hEpubIdx = historyFiles.findIndex(f => f.filename.endsWith(EPUB_NAME))
  getGitHistoryApi()?.selectFileByIndex?.(hPdfIdx)
  // First wait for the compare component to mount, THEN wait for its iframes
  // to get their src attribute (depends on pdfViewerUrl being resolved via IPC).
  const historyPdfVisible = await waitFor(
    'git-history-pdf-compare',
    () => Boolean(getGitHistoryApi()?.getPdfCompareState?.()?.visible),
    20000,
    200
  )
  record('git-history-pdf-compare-visible', historyPdfVisible, {
    state: getGitHistoryApi()?.getPdfCompareState?.() ?? null,
    selectedFileName: getGitHistoryApi()?.getSelectedFile?.()?.filename ?? null
  })
  await waitFor(
    'git-history-pdf-iframes-src',
    () => {
      const s = getGitHistoryApi()?.getPdfCompareState?.()
      return Boolean(s?.originalSrc && s?.modifiedSrc)
    },
    10000,
    200
  )
  const historyPdfState = getGitHistoryApi()?.getPdfCompareState?.() ?? null
  record('git-history-pdf-status-modified', historyPdfState?.status === 'modified', { state: historyPdfState })
  record('git-history-pdf-both-sides-populated',
    Boolean(historyPdfState?.originalSrc && historyPdfState?.modifiedSrc && !historyPdfState?.originalHasEmpty && !historyPdfState?.modifiedHasEmpty),
    { state: historyPdfState }
  )

  // Select EPUB in history viewer.
  getGitHistoryApi()?.selectFileByIndex?.(hEpubIdx)
  const historyEpubVisible = await waitFor(
    'git-history-epub-compare',
    () => Boolean(getGitHistoryApi()?.getEpubCompareState?.()?.visible),
    20000
  )
  record('git-history-epub-compare-visible', historyEpubVisible)
  await waitFor(
    'git-history-epub-chapters',
    () => (getGitHistoryApi()?.getEpubCompareState?.()?.chapterCount ?? 0) >= 2,
    20000,
    200
  )
  const historyEpubState = getGitHistoryApi()?.getEpubCompareState?.() ?? null
  record('git-history-epub-chapters-populated', (historyEpubState?.chapterCount ?? 0) >= 2, { state: historyEpubState })
  record('git-history-epub-has-modified-chapter',
    (historyEpubState?.chapterBadges ?? []).some(c => c.kind === 'modified'),
    { badges: historyEpubState?.chapterBadges }
  )

  // Close Git History.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await waitFor('git-history-close', () => !getGitHistoryApi()?.isOpen?.(), 5000)

  // ---------- Cleanup ----------
  // Step out of the test repo before nuking it so subsequent suites inherit a
  // sane working directory.
  await termExec(buildCdCommand(platform, rootPath), 'cd-back', 800)
  await termExec(buildCleanupCommand(platform, repoPath), 'cleanup-repo', 1500)

  log('pdf-epub-diff:done', {
    pass: results.filter(r => r.ok).length,
    fail: results.filter(r => !r.ok).length
  })
  return results
}
