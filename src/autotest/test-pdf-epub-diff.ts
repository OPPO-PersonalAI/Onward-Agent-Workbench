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

/**
 * Fixtures live on disk under `test/fixtures/pdf-epub/`. The setup command
 * copies the base and "alt" variants into a temp repo via `cp` / `Copy-Item`,
 * avoiding inlined base64 blobs. Regenerate with
 * `node test/fixtures/pdf-epub-fixture-builder.mjs --write`.
 */

const FIXTURE_REL_DIR = 'test/fixtures/pdf-epub'
const PDF_BASE_FIXTURE = 'onward-autotest.pdf'
const PDF_ALT_FIXTURE = 'onward-autotest.alt.pdf'
const EPUB_BASE_FIXTURE = 'onward-autotest.epub'
const EPUB_ALT_FIXTURE = 'onward-autotest.alt.epub'

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

function buildRepoSetupCommand(platform: string, repoPath: string, rootPath: string): string {
  if (platform === 'win32') {
    const repo = windowsPath(repoPath)
    const fixtures = windowsPath(`${rootPath}/${FIXTURE_REL_DIR}`)
    return `powershell -Command "$repo='${repo}'; if (Test-Path $repo) { Remove-Item -Recurse -Force $repo }; New-Item -ItemType Directory -Path $repo | Out-Null; git -C $repo init | Out-Null; git -C $repo config user.name 'Onward Autotest'; git -C $repo config user.email 'autotest@example.com'; Copy-Item -LiteralPath '${fixtures}\\${PDF_BASE_FIXTURE}' -Destination (Join-Path $repo '${PDF_NAME}') -Force; Copy-Item -LiteralPath '${fixtures}\\${EPUB_BASE_FIXTURE}' -Destination (Join-Path $repo '${EPUB_NAME}') -Force; git -C $repo add '${PDF_NAME}' '${EPUB_NAME}'; git -C $repo commit -m 'base PDF/EPUB' | Out-Null; Copy-Item -LiteralPath '${fixtures}\\${PDF_ALT_FIXTURE}' -Destination (Join-Path $repo '${PDF_NAME}') -Force; Copy-Item -LiteralPath '${fixtures}\\${EPUB_ALT_FIXTURE}' -Destination (Join-Path $repo '${EPUB_NAME}') -Force"`
  }
  const fixtures = `${rootPath}/${FIXTURE_REL_DIR}`
  return `rm -rf '${repoPath}' && mkdir -p '${repoPath}' && git -C '${repoPath}' init >/dev/null && git -C '${repoPath}' config user.name 'Onward Autotest' && git -C '${repoPath}' config user.email 'autotest@example.com' && cp "${fixtures}/${PDF_BASE_FIXTURE}" '${repoPath}/${PDF_NAME}' && cp "${fixtures}/${EPUB_BASE_FIXTURE}" '${repoPath}/${EPUB_NAME}' && git -C '${repoPath}' add '${PDF_NAME}' '${EPUB_NAME}' && git -C '${repoPath}' commit -m 'base PDF/EPUB' >/dev/null && cp "${fixtures}/${PDF_ALT_FIXTURE}" '${repoPath}/${PDF_NAME}' && cp "${fixtures}/${EPUB_ALT_FIXTURE}" '${repoPath}/${EPUB_NAME}'`
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
  await termExec(buildRepoSetupCommand(platform, repoPath, rootPath), 'setup-repo', 3000)

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
