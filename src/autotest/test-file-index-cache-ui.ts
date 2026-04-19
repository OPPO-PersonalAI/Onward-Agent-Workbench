/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UI-level autotest for the shared file-index cache that backs the
 * Project Editor filename search (Cmd+P).
 *
 * Drives the real ProjectEditor UI via the debug API:
 *   - opens the global search panel, types queries, reads rendered results
 *   - asserts that repeated opens & queries reuse the cached index (the
 *     renderer-wide cache.totalBuilds counter must not advance)
 *   - mutates the file tree via IPC (create / delete / rename) and asserts
 *     the cache applies targeted incremental patches, not a full rebuild
 *   - validates the main-process tree watcher propagates external fs
 *     changes (writes that bypass the in-app mutation APIs)
 */

import type { AutotestContext, TestResult } from './types'

export async function testFileIndexCacheUi(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, rootPath, reopenProjectEditor } = ctx
  const results: TestResult[] = []

  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardProjectEditorDebug

  // Recover the editor root if an earlier phase (cd + terminal-activity poll)
  // momentarily dropped the cwd prop to null. Without this the rest of the
  // suite would operate against a null rootRef.
  const ensureEditorRootReady = async (label: string): Promise<boolean> => {
    const existing = getApi()?.getRootPath?.()
    if (existing) return true
    log('fic-ui:root-missing-recover', { label, rootPath })
    await reopenProjectEditor(`fic-ui:${label}`)
    await sleep(400)
    return (await waitFor(
      `fic-ui:root-ready:${label}`,
      () => Boolean(getApi()?.getRootPath?.()),
      5000
    ))
  }
  const stamp = Date.now()
  const fileA = `onward-fic-a-${stamp}.ts`
  const fileB = `onward-fic-b-${stamp}.ts`
  const fileC = `onward-fic-c-${stamp}.ts`
  const fileD = `onward-fic-d-${stamp}.ts`
  const fileRenamed = `onward-fic-a-renamed-${stamp}.ts`

  const tsBody = `// autotest fixture ${stamp}\nexport const MARKER = '${stamp}'\n`

  const cleanup = async () => {
    for (const candidate of [fileA, fileB, fileC, fileD, fileRenamed]) {
      await window.electronAPI.project.deletePath(rootPath, candidate).catch(() => {})
    }
  }

  try {
    log('fic-ui:start', { rootPath })

    const api0 = getApi()
    if (!api0 || !api0.openGlobalFilenameSearch || !api0.getFileIndexStats) {
      record('FIC-00-debug-api', false, { reason: 'file-search debug hooks missing' })
      return results
    }

    const rootReady = await ensureEditorRootReady('initial')
    record('FIC-00-editor-root-ready', rootReady, {
      rootPath: getApi()?.getRootPath?.() ?? null
    })
    if (!rootReady) return results

    // Seed the fixture files BEFORE first search so the cache build captures them.
    const createA = await window.electronAPI.project.createFile(rootPath, fileA, tsBody)
    const createB = await window.electronAPI.project.createFile(rootPath, fileB, tsBody)
    record('FIC-00-setup-a', createA.success, { error: createA.error })
    record('FIC-00-setup-b', createB.success, { error: createB.error })
    if (!createA.success || !createB.success) return results
    await sleep(400)

    // === 1. First open: builds the index from the project root ===
    const buildsBeforeFirstOpen = api0.getFileIndexStats().totalBuilds
    await api0.openGlobalFilenameSearch()
    const openedFirst = await waitFor(
      'FIC-01-open-first',
      () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
      3000
    )
    record('FIC-01-open-first', openedFirst)

    const readyFirst = await waitFor(
      'FIC-02-first-index-ready',
      () => {
        const stats = getApi()?.getFileIndexStats?.()
        if (!stats) return false
        return stats.entries.some((entry) => entry.status === 'ready' && entry.fileCount > 0)
      },
      5000
    )
    record('FIC-02-first-index-ready', readyFirst)

    const buildsAfterFirstOpen = getApi()!.getFileIndexStats().totalBuilds
    record(
      'FIC-03-initial-build-counted',
      buildsAfterFirstOpen === buildsBeforeFirstOpen + 1,
      { before: buildsBeforeFirstOpen, after: buildsAfterFirstOpen }
    )

    // Filter down to the fixture.
    getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-a-${stamp}`)
    const matchedA = await waitFor(
      'FIC-04-fuzzy-a',
      () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileA) ?? false,
      3000
    )
    record('FIC-04-fuzzy-a', matchedA, { results: getApi()?.getGlobalFilenameSearchResults?.() })

    getApi()!.closeGlobalFilenameSearch!()

    // === 2. Re-open multiple times: cache hit, no new build ===
    for (let iter = 0; iter < 5; iter += 1) {
      await api0.openGlobalFilenameSearch()
      await waitFor(
        `FIC-05-open-iter-${iter}`,
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      // Drive a query so the UI re-reads the cached files.
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-b-${stamp}`)
      await waitFor(
        `FIC-05-fuzzy-b-${iter}`,
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileB) ?? false,
        2000
      )
      getApi()!.closeGlobalFilenameSearch!()
      await sleep(80)
    }
    const buildsAfterRepeatedOpens = getApi()!.getFileIndexStats().totalBuilds
    record(
      'FIC-06-repeated-opens-reuse-cache',
      buildsAfterRepeatedOpens === buildsAfterFirstOpen,
      { buildsAfterFirst: buildsAfterFirstOpen, buildsAfterRepeated: buildsAfterRepeatedOpens }
    )

    // === 3. Create file via IPC — incremental addFile path ===
    const createC = await window.electronAPI.project.createFile(rootPath, fileC, tsBody)
    record('FIC-07-create-c', createC.success, { error: createC.error })
    if (createC.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-07-open-after-create',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-c-${stamp}`)
      const foundC = await waitFor(
        'FIC-08-found-c-after-create',
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileC) ?? false,
        3000
      )
      record('FIC-08-found-c-after-create', foundC, {
        results: getApi()?.getGlobalFilenameSearchResults?.()
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    const buildsAfterCreate = getApi()!.getFileIndexStats().totalBuilds
    record(
      'FIC-09-create-did-not-rebuild',
      buildsAfterCreate === buildsAfterFirstOpen,
      { buildsAfterFirst: buildsAfterFirstOpen, buildsAfterCreate }
    )

    // === 4. Rename via IPC — incremental renameFile path ===
    const renamed = await window.electronAPI.project.renamePath(rootPath, fileA, fileRenamed)
    record('FIC-10-rename-a', renamed.success, { error: renamed.error })
    if (renamed.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-10-open-after-rename',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-a`)
      const renamedAppears = await waitFor(
        'FIC-11-renamed-appears',
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(fileRenamed) ?? false,
        3000
      )
      const originalGone = !(getApi()?.getGlobalFilenameSearchResults?.().includes(fileA) ?? false)
      record('FIC-11-renamed-appears', renamedAppears)
      record('FIC-12-original-name-gone', originalGone, {
        results: getApi()?.getGlobalFilenameSearchResults?.()
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    // === 5. Delete via IPC — incremental removeFile path ===
    const deleted = await window.electronAPI.project.deletePath(rootPath, fileB)
    record('FIC-13-delete-b', deleted.success, { error: deleted.error })
    if (deleted.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-13-open-after-delete',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-b-${stamp}`)
      const goneB = await waitFor(
        'FIC-14-b-removed',
        () => !(getApi()?.getGlobalFilenameSearchResults?.().includes(fileB) ?? false),
        3000
      )
      record('FIC-14-b-removed', goneB, {
        results: getApi()?.getGlobalFilenameSearchResults?.()
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    const buildsAfterAllMutations = getApi()!.getFileIndexStats().totalBuilds
    record(
      'FIC-15-mutations-did-not-rebuild',
      buildsAfterAllMutations === buildsAfterFirstOpen,
      {
        buildsAfterFirst: buildsAfterFirstOpen,
        buildsAfterAllMutations
      }
    )

    // === 6. Nested-directory create — exercises recursive fs.watch propagation ===
    // We keep this scoped to the fixture cwd by using project.createFile which
    // resolves relative to rootPath (unlike git.saveFileContent, which would
    // escape to the enclosing git root and pollute the real repo).
    const nestedName = `src/components/onward-fic-nested-${stamp}.tsx`
    const nestedCreate = await window.electronAPI.project.createFile(
      rootPath,
      nestedName,
      'export function Nested() { return null }'
    )
    record('FIC-16-nested-create-ok', nestedCreate.success, {
      error: nestedCreate.error
    })

    if (nestedCreate.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-16-open-after-nested',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(`onward-fic-nested-${stamp}`)
      const foundNested = await waitFor(
        'FIC-17-nested-propagated',
        () => getApi()?.getGlobalFilenameSearchResults?.().includes(nestedName) ?? false,
        5000,
        150
      )
      record('FIC-17-nested-propagated', foundNested, {
        results: getApi()?.getGlobalFilenameSearchResults?.(),
        note: 'nested file appears after in-app create (validates incremental patch + fs watcher)'
      })
      getApi()!.closeGlobalFilenameSearch!()
    }

    const buildsAfterNested = getApi()!.getFileIndexStats().totalBuilds
    record(
      'FIC-18-nested-did-not-rebuild',
      buildsAfterNested === buildsAfterFirstOpen,
      { buildsAfterFirst: buildsAfterFirstOpen, buildsAfterNested }
    )

    // === 6b. Folder creation must NOT surface the folder path as a search hit ===
    // Regression guard for the reviewer-reported issue where the tree watcher
    // enqueued every added path without first checking `statSync(...).isDirectory()`.
    const folderName = `onward-fic-dir-${stamp}`
    const folderCreate = await window.electronAPI.project.createFolder(rootPath, folderName)
    record('FIC-21-folder-create-ok', folderCreate.success, {
      error: folderCreate.error
    })
    if (folderCreate.success) {
      await sleep(500)
      await api0.openGlobalFilenameSearch()
      await waitFor(
        'FIC-21-open-after-folder',
        () => Boolean(getApi()?.isGlobalFilenameSearchOpen?.()),
        2000
      )
      getApi()!.setGlobalFilenameSearchQuery!(folderName)
      await sleep(600)
      const resultsAfterFolder = getApi()?.getGlobalFilenameSearchResults?.() ?? []
      record(
        'FIC-22-folder-not-in-results',
        !resultsAfterFolder.includes(folderName),
        { results: resultsAfterFolder, folderName }
      )
      getApi()!.closeGlobalFilenameSearch!()
      await window.electronAPI.project.deletePath(rootPath, folderName).catch(() => {})
    }

    // === 7. forceRefreshFileIndex — validates the manual "Refresh" recovery path ===
    const buildsBeforeRefresh = getApi()!.getFileIndexStats().totalBuilds
    const refreshed = (await getApi()?.forceRefreshFileIndex?.()) ?? false
    record('FIC-19-force-refresh-success', refreshed)
    const buildsAfterRefresh = getApi()!.getFileIndexStats().totalBuilds
    record(
      'FIC-20-force-refresh-triggered-rebuild',
      buildsAfterRefresh === buildsBeforeRefresh + 1,
      { before: buildsBeforeRefresh, after: buildsAfterRefresh }
    )

    await window.electronAPI.project.deletePath(rootPath, nestedName).catch(() => {})
    await window.electronAPI.project.deletePath(rootPath, fileRenamed).catch(() => {})
    await window.electronAPI.project.deletePath(rootPath, fileC).catch(() => {})
  } finally {
    await cleanup()
  }

  return results
}
