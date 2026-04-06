#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT_DIR = join(import.meta.dirname, '..')
const SCRIPT_PATH = join(ROOT_DIR, 'scripts', 'generate-update-manifest.js')

function runNode(args, env, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    ...options
  })
}

function writeFile(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, content, 'utf-8')
}

test('generate-update-manifest embeds English changelog notes into every platform manifest', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'onward-changelog-manifest-'))

  try {
    const artifactDir = join(tempDir, 'artifacts')
    const manifestDir = join(tempDir, 'manifests')
    const changelogRoot = join(tempDir, 'changelog')
    const tag = 'v2.0.1-daily.20260406.1'
    const changelog = [
      `# Onward Daily Build ${tag}`,
      '',
      '## New Features',
      '- Autotest manifest feature entry.',
      '',
      '## Bug Fixes',
      '- Autotest manifest bug fix entry.',
      ''
    ].join('\n')

    mkdirSync(artifactDir, { recursive: true })
    writeFile(join(artifactDir, 'Onward 2-macos-arm64.zip'), 'arm64-artifact')
    writeFile(join(artifactDir, 'Onward 2-macos-x64.zip'), 'x64-artifact')
    writeFile(join(changelogRoot, 'en', 'daily', `${tag}.md`), changelog)

    const result = runNode([SCRIPT_PATH], {
      ONWARD_GITHUB_REPOSITORY: 'OPPO-PersonalAI/Onward',
      ONWARD_RELEASE_TAG: tag,
      ONWARD_ARTIFACT_DIR: artifactDir,
      ONWARD_MANIFEST_DIR: manifestDir,
      ONWARD_CHANGELOG_ROOT: changelogRoot
    })

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)

    const arm64ManifestPath = join(manifestDir, 'daily', 'macos', 'arm64', 'latest.json')
    const x64ManifestPath = join(manifestDir, 'daily', 'macos', 'x64', 'latest.json')
    assert.equal(existsSync(arm64ManifestPath), true)
    assert.equal(existsSync(x64ManifestPath), true)

    const arm64Manifest = JSON.parse(readFileSync(arm64ManifestPath, 'utf-8'))
    const x64Manifest = JSON.parse(readFileSync(x64ManifestPath, 'utf-8'))

    assert.equal(arm64Manifest.version, '2.0.1-daily.20260406.1')
    assert.equal(arm64Manifest.releaseNotes, changelog)
    assert.equal(arm64Manifest.artifactName, 'Onward.2-macos-arm64.zip')
    assert.match(arm64Manifest.artifactUrl, /releases\/download\/v2\.0\.1-daily\.20260406\.1\/Onward\.2-macos-arm64\.zip/)

    assert.equal(x64Manifest.releaseNotes, changelog)
    assert.equal(x64Manifest.artifactName, 'Onward.2-macos-x64.zip')
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('generate-update-manifest fails fast when the English changelog draft is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'onward-changelog-manifest-missing-'))

  try {
    const artifactDir = join(tempDir, 'artifacts')
    const manifestDir = join(tempDir, 'manifests')
    const changelogRoot = join(tempDir, 'changelog')
    mkdirSync(artifactDir, { recursive: true })
    writeFile(join(artifactDir, 'Onward 2-macos-arm64.zip'), 'arm64-artifact')

    const result = runNode([SCRIPT_PATH], {
      ONWARD_GITHUB_REPOSITORY: 'OPPO-PersonalAI/Onward',
      ONWARD_RELEASE_TAG: 'v2.0.1-daily.20260406.1',
      ONWARD_ARTIFACT_DIR: artifactDir,
      ONWARD_MANIFEST_DIR: manifestDir,
      ONWARD_CHANGELOG_ROOT: changelogRoot
    })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Missing Change Log file/)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
