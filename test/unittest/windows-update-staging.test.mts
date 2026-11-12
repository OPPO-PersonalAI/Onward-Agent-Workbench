/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { NormalizedUpdateManifest } from '../../electron/main/update-manifest-utils.ts'
import {
  WINDOWS_STAGE_READY_MARKER,
  cleanupTransientStageArtifacts,
  getWindowsStagePaths,
  inspectStagedWindowsUpdate,
  readAndClearLastInstallError,
  resolveLastInstallErrorPath,
  stageWindowsUpdateArchive
} from '../../electron/main/windows-update-staging.ts'
import { extractWindowsUpdateZip } from '../../electron/main/windows-zip-extract.ts'

const require = createRequire(import.meta.url)
const yazl = require('yazl')

async function createZipFromEntries(
  zipPath: string,
  entries: Array<{ name: string; content?: string | Buffer; directory?: boolean }>
): Promise<string> {
  const zipFile = new yazl.ZipFile()
  for (const entry of entries) {
    if (entry.directory) {
      zipFile.addEmptyDirectory(entry.name)
    } else {
      const buf = Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content ?? '', 'utf-8')
      zipFile.addBuffer(buf, entry.name)
    }
  }
  zipFile.end()

  await new Promise<void>((resolveWrite, rejectWrite) => {
    const out = createWriteStream(zipPath)
    out.on('close', () => resolveWrite())
    out.on('error', rejectWrite)
    zipFile.outputStream.on('error', rejectWrite)
    zipFile.outputStream.pipe(out)
  })

  return createHash('sha256').update(readFileSync(zipPath)).digest('hex')
}

async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'onward-ut-staging-'))
  try {
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function buildManifest(version: string, sha256: string, channel: 'daily' | 'dev' | 'stable' = 'daily'): NormalizedUpdateManifest {
  return {
    channel,
    version,
    tag: `v${version}`,
    platform: 'windows',
    arch: 'x64',
    artifactName: `Onward.2-${version}-windows-x64.zip`,
    artifactUrl: `http://127.0.0.1/releases/download/v${version}/Onward.2-${version}-windows-x64.zip`,
    sha256,
    releaseNotes: 'Test notes',
    publishedAt: '2026-11-12T00:00:00.000Z'
  }
}

describe('electron/main/windows-zip-extract.ts', () => {
  it('extracts flat Windows zip layout and nested directories', async () => {
    await withTempDir(async (root) => {
      const zipPath = join(root, 'flat.zip')
      const destDir = join(root, 'dest')
      await createZipFromEntries(zipPath, [
        { name: 'Onward 2.exe', content: 'exe-v2' },
        { name: 'resources/app.asar', content: 'asar-v2' },
        { name: 'locales/', directory: true },
        { name: 'locales/en-US.pak', content: 'pak' }
      ])

      const result = await extractWindowsUpdateZip({
        zipPath,
        destinationDir: destDir,
        expectedExecutableName: 'Onward 2.exe'
      })

      assert.equal(result.extractedFiles, 3)
      assert.equal(readFileSync(join(destDir, 'Onward 2.exe'), 'utf-8'), 'exe-v2')
      assert.equal(readFileSync(join(destDir, 'resources', 'app.asar'), 'utf-8'), 'asar-v2')
    })
  })

  it('extracts multi-chunk deflated binary entries (>256 KB compressed) without stalling under Node 22+/24+ stream backpressure', async () => {
    await withTempDir(async (root) => {
      const zipPath = join(root, 'multichunk.zip')
      const destDir = join(root, 'dest')
      // Mix high-entropy bytes (>256 KB compressed) and structured blocks so deflate exercises multi-chunk streaming + backpressure
      const largePakPayload = Buffer.concat([
        randomBytes(280 * 1024),
        Buffer.alloc(120 * 1024, 0x5a)
      ])
      await createZipFromEntries(zipPath, [
        { name: 'chrome_100_percent.pak', content: largePakPayload },
        { name: 'Onward 2.exe', content: 'exe-multichunk' }
      ])

      const result = await extractWindowsUpdateZip({
        zipPath,
        destinationDir: destDir,
        expectedExecutableName: 'Onward 2.exe'
      })

      assert.equal(result.extractedFiles, 2)
      assert.equal(Buffer.compare(readFileSync(join(destDir, 'chrome_100_percent.pak')), largePakPayload), 0)
    })
  })

  it('unwraps a single top-level directory when executable sits one level deep', async () => {
    await withTempDir(async (root) => {
      const zipPath = join(root, 'nested.zip')
      const destDir = join(root, 'dest')
      await createZipFromEntries(zipPath, [
        { name: 'win-unpacked/Onward 2.exe', content: 'nested-exe' },
        { name: 'win-unpacked/resources/app.asar', content: 'nested-asar' }
      ])

      await extractWindowsUpdateZip({
        zipPath,
        destinationDir: destDir,
        expectedExecutableName: 'Onward 2.exe'
      })

      assert.equal(existsSync(join(destDir, 'win-unpacked')), false)
      assert.equal(readFileSync(join(destDir, 'Onward 2.exe'), 'utf-8'), 'nested-exe')
      assert.equal(readFileSync(join(destDir, 'resources', 'app.asar'), 'utf-8'), 'nested-asar')
    })
  })

  it('blocks Zip-Slip path traversal entries and missing executable archives', async () => {
    await withTempDir(async (root) => {
      // Craft a minimal valid zip whose entry filename contains "../escape.txt" by mutating
      // a placeholder entry of identical byte length ("sub/escape.txt" -> "../escape.txt" is 1 byte shorter,
      // so use "aa/escape.txt" -> "../escape.txt", both 13 ASCII bytes).
      const rawZipPath = join(root, 'traversal.zip')
      await createZipFromEntries(rawZipPath, [
        { name: 'Onward 2.exe', content: 'exe' },
        { name: 'aa/escape.txt', content: 'pwned' }
      ])
      const mutatedBuf = Buffer.from(
        readFileSync(rawZipPath).toString('latin1').replaceAll('aa/escape.txt', '../escape.txt'),
        'latin1'
      )
      writeFileSync(rawZipPath, mutatedBuf)

      const destDir = join(root, 'nested', 'dest')
      await assert.rejects(
        () =>
          extractWindowsUpdateZip({
            zipPath: rawZipPath,
            destinationDir: destDir,
            expectedExecutableName: 'Onward 2.exe'
          }),
        /invalid relative path|traversal blocked|unsafe zip entry/i
      )
      assert.equal(existsSync(join(root, 'nested', 'escape.txt')), false)

      const missingExeZip = join(root, 'missing-exe.zip')
      await createZipFromEntries(missingExeZip, [{ name: 'README.txt', content: 'no exe here' }])
      await assert.rejects(
        () =>
          extractWindowsUpdateZip({
            zipPath: missingExeZip,
            destinationDir: join(root, 'dest-missing'),
            expectedExecutableName: 'Onward 2.exe'
          }),
        /missing expected executable/i
      )
    })
  })
})

describe('electron/main/windows-update-staging.ts', () => {
  it('stages archive into "_", writes ready metadata, recovers, supersedes, and cleans stale states', async () => {
    await withTempDir(async (root) => {
      const installDir = join(root, 'install')
      const execPath = join(installDir, 'Onward 2.exe')
      mkdirSync(installDir, { recursive: true })
      writeFileSync(execPath, 'exe-v1', 'utf-8')

      const zipAPath = join(root, 'update-a.zip')
      const shaA = await createZipFromEntries(zipAPath, [
        { name: 'Onward 2.exe', content: 'exe-vA' },
        { name: 'resources/version.txt', content: '2.1.0-daily.20990101.1' }
      ])
      const manifestA = buildManifest('2.1.0-daily.20990101.1', shaA)

      const metaA = await stageWindowsUpdateArchive({
        zipPath: zipAPath,
        installDir,
        execPath,
        currentVersion: '2.0.1-daily.20260101.1',
        manifest: manifestA
      })

      const paths = getWindowsStagePaths(installDir)
      assert.equal(existsSync(paths.stagingTempDir), false, '_staging must be renamed away')
      assert.equal(existsSync(paths.stageDir), true, '_ must exist')
      assert.equal(existsSync(paths.readyMarkerPath), true)
      assert.equal(metaA.version, '2.1.0-daily.20990101.1')

      // Inspect ready update
      const readyInspection = inspectStagedWindowsUpdate({
        installDir,
        execPath,
        currentVersion: '2.0.1-daily.20260101.1',
        currentChannel: 'daily',
        currentArch: 'x64'
      })
      assert.equal(readyInspection.state, 'ready')

      // Supersede A with newer B
      const zipBPath = join(root, 'update-b.zip')
      const shaB = await createZipFromEntries(zipBPath, [
        { name: 'Onward 2.exe', content: 'exe-vB' },
        { name: 'resources/version.txt', content: '2.1.0-daily.20990101.2' }
      ])
      const manifestB = buildManifest('2.1.0-daily.20990101.2', shaB)

      const metaB = await stageWindowsUpdateArchive({
        zipPath: zipBPath,
        installDir,
        execPath,
        currentVersion: '2.0.1-daily.20260101.1',
        manifest: manifestB
      })
      assert.equal(metaB.version, '2.1.0-daily.20990101.2')
      assert.equal(readFileSync(join(paths.stageDir, 'Onward 2.exe'), 'utf-8'), 'exe-vB')

      // Expired inspection (when app is already >= staged version) cleans "_"
      const expiredInspection = inspectStagedWindowsUpdate({
        installDir,
        execPath,
        currentVersion: '2.1.0-daily.20990101.2',
        currentChannel: 'daily',
        currentArch: 'x64'
      })
      assert.equal(expiredInspection.state, 'cleaned-expired')
      assert.equal(existsSync(paths.stageDir), false)

      // Corrupt marker cleans "_"
      mkdirSync(paths.stageDir, { recursive: true })
      writeFileSync(join(paths.stageDir, WINDOWS_STAGE_READY_MARKER), '{not-json', 'utf-8')
      const invalidInspection = inspectStagedWindowsUpdate({
        installDir,
        execPath,
        currentVersion: '2.0.1-daily.20260101.1',
        currentChannel: 'daily',
        currentArch: 'x64'
      })
      assert.equal(invalidInspection.state, 'cleaned-invalid')
      assert.equal(existsSync(paths.stageDir), false)

      // Transient _staging and _old cleanup
      mkdirSync(paths.stagingTempDir, { recursive: true })
      mkdirSync(paths.backupDir, { recursive: true })
      cleanupTransientStageArtifacts(installDir)
      assert.equal(existsSync(paths.stagingTempDir), false)
      assert.equal(existsSync(paths.backupDir), false)

      // Rollback error report read-once semantics
      const updatesRoot = join(root, 'updates')
      mkdirSync(updatesRoot, { recursive: true })
      const errPath = resolveLastInstallErrorPath(updatesRoot)
      writeFileSync(
        errPath,
        JSON.stringify({
          timestamp: 12345,
          targetVersion: '2.1.0-daily.20990101.2',
          error: 'Access denied moving locked.dll',
          rolledBack: true
        }),
        'utf-8'
      )
      const report = readAndClearLastInstallError(updatesRoot)
      assert.equal(report?.error, 'Access denied moving locked.dll')
      assert.equal(report?.rolledBack, true)
      assert.equal(existsSync(errPath), false)
      assert.equal(readAndClearLastInstallError(updatesRoot), null)
    })
  })
})
