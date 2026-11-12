/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { normalizeUpdateManifest } from '../../electron/main/update-manifest-utils.ts'

const require = createRequire(import.meta.url)
const { generateManifests, parseUpdateArtifact } = require('../../scripts/generate-update-manifest.js')

function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

function withTempFixture(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'onward-ut-manifest-'))
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('scripts/generate-update-manifest.js', () => {
  it('parses Windows installer (.exe), Windows archive (.zip), and macOS/Linux (.zip) artifacts', () => {
    assert.deepEqual(parseUpdateArtifact('Onward 2-2.1.0-windows-x64.exe'), {
      releaseOs: 'windows',
      arch: 'x64',
      kind: 'installer'
    })
    assert.deepEqual(parseUpdateArtifact('Onward 2-2.1.0-windows-x64.zip'), {
      releaseOs: 'windows',
      arch: 'x64',
      kind: 'archive'
    })
    assert.deepEqual(parseUpdateArtifact('Onward 2-2.1.0-macos-arm64.zip'), {
      releaseOs: 'macos',
      arch: 'arm64',
      kind: 'archive'
    })
    assert.equal(parseUpdateArtifact('Onward 2-2.1.0-macos-arm64.dmg'), null)
  })

  it('emits dual-field Windows manifest (.exe primary + archive.zip) while keeping macOS schema untouched', () => {
    withTempFixture((root) => {
      const artifactDir = join(root, 'artifacts')
      const manifestDir = join(root, 'manifests')
      const changelogRoot = join(root, 'changelog')
      const tag = 'v2.1.0-daily.20261112.1'

      mkdirSync(artifactDir, { recursive: true })
      mkdirSync(join(changelogRoot, 'en', 'daily'), { recursive: true })
      writeFileSync(join(changelogRoot, 'en', 'daily', `${tag}.md`), '## Highlights\n- Seamless update\n', 'utf-8')

      const winExeContent = 'dummy-windows-installer-binary'
      const winZipContent = 'dummy-windows-archive-zip'
      const macZipContent = 'dummy-macos-archive-zip'

      writeFileSync(join(artifactDir, 'Onward 2-2.1.0-daily.20261112.1-windows-x64.exe'), winExeContent, 'utf-8')
      writeFileSync(join(artifactDir, 'Onward 2-2.1.0-daily.20261112.1-windows-x64.zip'), winZipContent, 'utf-8')
      writeFileSync(join(artifactDir, 'Onward 2-2.1.0-daily.20261112.1-macos-arm64.zip'), macZipContent, 'utf-8')

      const count = generateManifests({
        repository: 'OPPO-AI-Agent/Onward-Agent-Workbench',
        releaseTag: tag,
        artifactDir,
        manifestDir,
        changelogRoot,
        nowIso: '2026-11-12T00:00:00.000Z'
      })
      assert.equal(count, 2)

      const winManifest = JSON.parse(
        readFileSync(join(manifestDir, 'daily', 'windows', 'x64', 'latest.json'), 'utf-8')
      )
      assert.equal(winManifest.artifactName, 'Onward.2-2.1.0-daily.20261112.1-windows-x64.exe')
      assert.equal(winManifest.sha256, sha256Text(winExeContent))
      assert.deepEqual(winManifest.archive, {
        artifactName: 'Onward.2-2.1.0-daily.20261112.1-windows-x64.zip',
        artifactUrl:
          'https://github.com/OPPO-AI-Agent/Onward-Agent-Workbench/releases/download/v2.1.0-daily.20261112.1/Onward.2-2.1.0-daily.20261112.1-windows-x64.zip',
        sha256: sha256Text(winZipContent)
      })

      const macManifest = JSON.parse(
        readFileSync(join(manifestDir, 'daily', 'macos', 'arm64', 'latest.json'), 'utf-8')
      )
      assert.equal(macManifest.artifactName, 'Onward.2-2.1.0-daily.20261112.1-macos-arm64.zip')
      assert.equal(macManifest.sha256, sha256Text(macZipContent))
      assert.equal('archive' in macManifest, false, 'macOS manifest schema must remain untouched')
    })
  })

  it('supports .zip-only Windows artifact directories', () => {
    withTempFixture((root) => {
      const artifactDir = join(root, 'artifacts')
      const manifestDir = join(root, 'manifests')
      const changelogRoot = join(root, 'changelog')
      const tag = 'v2.1.0-dev.20261112.1'

      mkdirSync(artifactDir, { recursive: true })
      mkdirSync(join(changelogRoot, 'en', 'dev'), { recursive: true })
      writeFileSync(join(changelogRoot, 'en', 'dev', `${tag}.md`), 'Dev notes', 'utf-8')

      const winZipContent = 'zip-only-payload'
      writeFileSync(join(artifactDir, 'Onward 2-2.1.0-dev.20261112.1-windows-x64.zip'), winZipContent, 'utf-8')

      generateManifests({
        repository: 'OPPO-AI-Agent/Onward-Agent-Workbench',
        releaseTag: tag,
        artifactDir,
        manifestDir,
        changelogRoot,
        nowIso: '2026-11-12T00:00:00.000Z'
      })

      const winManifest = JSON.parse(
        readFileSync(join(manifestDir, 'dev', 'windows', 'x64', 'latest.json'), 'utf-8')
      )
      assert.equal(winManifest.artifactName, 'Onward.2-2.1.0-dev.20261112.1-windows-x64.zip')
      assert.equal(winManifest.archive.artifactName, 'Onward.2-2.1.0-dev.20261112.1-windows-x64.zip')
      assert.equal(winManifest.sha256, sha256Text(winZipContent))
    })
  })
})

describe('electron/main/update-manifest-utils.ts', () => {
  const exeSha = 'a'.repeat(64)
  const zipSha = 'B'.repeat(64)

  it('prefers archive (.zip) descriptor on Windows dual-field manifests', () => {
    const normalized = normalizeUpdateManifest(
      {
        channel: 'daily',
        version: '2.1.0-daily.20261112.1',
        tag: 'v2.1.0-daily.20261112.1',
        platform: 'windows',
        arch: 'x64',
        artifactName: 'Onward.2-2.1.0-windows-x64.exe',
        artifactUrl: 'https://example.com/Onward.2-2.1.0-windows-x64.exe',
        sha256: exeSha,
        archive: {
          artifactName: 'Onward.2-2.1.0-windows-x64.zip',
          artifactUrl: 'https://example.com/Onward.2-2.1.0-windows-x64.zip',
          sha256: zipSha
        },
        releaseNotes: 'Notes',
        publishedAt: '2026-11-12T00:00:00.000Z'
      },
      { channel: 'daily', platform: 'windows', arch: 'x64' }
    )

    assert.equal(normalized.artifactName, 'Onward.2-2.1.0-windows-x64.zip')
    assert.equal(normalized.artifactUrl, 'https://example.com/Onward.2-2.1.0-windows-x64.zip')
    assert.equal(normalized.sha256, zipSha.toLowerCase())
  })

  it('accepts direct .zip primary fields on Windows when archive block is omitted', () => {
    const normalized = normalizeUpdateManifest(
      {
        channel: 'stable',
        version: '2.1.0',
        tag: 'v2.1.0',
        platform: 'windows',
        arch: 'arm64',
        artifactName: 'Onward.2-2.1.0-windows-arm64.zip',
        artifactUrl: 'https://example.com/Onward.2-2.1.0-windows-arm64.zip',
        sha256: zipSha,
        publishedAt: '2026-11-12T00:00:00.000Z'
      },
      { channel: 'stable', platform: 'windows', arch: 'arm64' }
    )

    assert.equal(normalized.artifactName, 'Onward.2-2.1.0-windows-arm64.zip')
    assert.equal(normalized.sha256, zipSha.toLowerCase())
  })

  it('rejects Windows manifests that only provide .exe without a .zip archive', () => {
    assert.throws(
      () =>
        normalizeUpdateManifest(
          {
            channel: 'daily',
            version: '2.1.0-daily.20261112.1',
            tag: 'v2.1.0-daily.20261112.1',
            platform: 'windows',
            arch: 'x64',
            artifactName: 'Onward.2-2.1.0-windows-x64.exe',
            artifactUrl: 'https://example.com/Onward.2-2.1.0-windows-x64.exe',
            sha256: exeSha
          },
          { channel: 'daily', platform: 'windows', arch: 'x64' }
        ),
      /must provide a \.zip archive artifact/i
    )
  })

  it('rejects unsafe path traversal artifact names and mismatched metadata', () => {
    assert.throws(
      () =>
        normalizeUpdateManifest(
          {
            channel: 'daily',
            version: '2.1.0-daily.20261112.1',
            tag: 'v2.1.0-daily.20261112.1',
            platform: 'windows',
            arch: 'x64',
            artifactName: 'Onward.2-windows-x64.exe',
            artifactUrl: 'https://example.com/a.exe',
            sha256: exeSha,
            archive: {
              artifactName: '../evil.zip',
              artifactUrl: 'https://example.com/evil.zip',
              sha256: zipSha
            }
          },
          { channel: 'daily', platform: 'windows', arch: 'x64' }
        ),
      /archive artifact name is invalid/i
    )

    assert.throws(
      () =>
        normalizeUpdateManifest(
          {
            channel: 'stable',
            version: '2.1.0',
            tag: 'v2.1.0',
            platform: 'macos',
            arch: 'arm64',
            artifactName: 'Onward.2-macos-arm64.exe',
            artifactUrl: 'https://example.com/a.exe',
            sha256: exeSha
          },
          { channel: 'stable', platform: 'macos', arch: 'arm64' }
        ),
      /artifact name is invalid for macos/i
    )
  })
})
