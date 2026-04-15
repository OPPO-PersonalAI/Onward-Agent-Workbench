#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { createHash } = require('crypto')
const { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('fs')
const { join, basename } = require('path')

function fail(message) {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function getRequiredEnv(name) {
  const value = String(process.env[name] || '').trim()
  if (!value) {
    fail(`Missing required environment variable "${name}".`)
  }
  return value
}

function parseReleaseTag(tag) {
  const semverMatch = /^v(\d+\.\d+\.\d+(?:-(daily|dev)\.(\d{8})\.(\d+))?)$/.exec(tag)
  if (semverMatch) {
    const channel = semverMatch[2]
    return {
      tag,
      version: semverMatch[1],
      releaseChannel: channel === 'daily' ? 'daily' : channel === 'dev' ? 'dev' : 'stable'
    }
  }

  const legacyMatch = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(tag)
  if (legacyMatch) {
    const year = Number(legacyMatch[1])
    const month = Number(legacyMatch[2])
    const day = Number(legacyMatch[3])
    const rebuild = legacyMatch[4] ? Number(legacyMatch[4]) : null
    return {
      tag,
      version: `${year}.${month}.${day}${rebuild !== null ? `-${rebuild}` : ''}`,
      releaseChannel: 'daily'
    }
  }

  fail(`Unsupported release tag format "${tag}".`)
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

function toGitHubReleaseAssetName(fileName) {
  // GitHub release uploads normalize spaces in asset names to dots.
  return fileName.replace(/ /g, '.')
}

function buildAssetUrl(repository, tag, fileName) {
  const releaseAssetName = toGitHubReleaseAssetName(fileName)
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(releaseAssetName)}`
}

function readReleaseNotes(changelogRoot, release) {
  // Dev channel changelogs are stored alongside daily changelogs with a -dev tag suffix.
  // Try the exact tag first, then fall back to the daily directory with a base tag name.
  const candidates = [
    join(changelogRoot, 'en', release.releaseChannel, `${release.tag}.md`),
    join(changelogRoot, 'en', 'daily', `${release.tag}.md`),
    join(changelogRoot, 'en', 'daily', `${release.tag.replace(/-dev\./, '-daily.')}.md`)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return readFileSync(candidate, 'utf-8')
    }
  }
  fail(`Missing Change Log file. Searched:\n${candidates.map(p => `  - ${p}`).join('\n')}\nGenerate and commit the changelog before publishing.`)
}

const repository = getRequiredEnv('ONWARD_GITHUB_REPOSITORY')
const releaseTag = getRequiredEnv('ONWARD_RELEASE_TAG')
const artifactDir = getRequiredEnv('ONWARD_ARTIFACT_DIR')
const manifestDir = getRequiredEnv('ONWARD_MANIFEST_DIR')
const changelogRoot = String(process.env.ONWARD_CHANGELOG_ROOT || join(process.cwd(), 'resources', 'changelog')).trim()
const release = parseReleaseTag(releaseTag)
const releaseNotes = readReleaseNotes(changelogRoot, release)
const artifactFiles = readdirSync(artifactDir).filter(fileName => /\.(zip|exe)$/i.test(fileName))

if (artifactFiles.length === 0) {
  fail(`No update artifacts found in "${artifactDir}".`)
}

function parseUpdateArtifact(fileName) {
  const windowsInstallerMatch = /-(windows)-(arm64|x64)\.exe$/i.exec(fileName)
  if (windowsInstallerMatch) {
    return {
      releaseOs: windowsInstallerMatch[1],
      arch: windowsInstallerMatch[2]
    }
  }

  const zipMatch = /-(macos|linux)-(arm64|x64)\.zip$/i.exec(fileName)
  if (zipMatch) {
    return {
      releaseOs: zipMatch[1],
      arch: zipMatch[2]
    }
  }

  return null
}

let generatedCount = 0
for (const fileName of artifactFiles) {
  const artifact = parseUpdateArtifact(fileName)
  if (!artifact) {
    console.warn(`Skipping unsupported artifact name "${fileName}".`)
    continue
  }

  const releaseOs = artifact.releaseOs
  const arch = artifact.arch
  const artifactPath = join(artifactDir, fileName)
  const outputDir = join(manifestDir, release.releaseChannel, releaseOs, arch)
  const outputPath = join(outputDir, 'latest.json')
  const checksum = sha256File(artifactPath)

  ensureDir(outputDir)

  const manifest = {
    channel: release.releaseChannel,
    version: release.version,
    tag: release.tag,
    platform: releaseOs,
    arch,
    artifactName: toGitHubReleaseAssetName(basename(fileName)),
    artifactUrl: buildAssetUrl(repository, release.tag, fileName),
    sha256: checksum,
    releaseNotes,
    publishedAt: new Date().toISOString()
  }

  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  console.log(`Generated update manifest: ${outputPath}`)
  generatedCount++
}

if (generatedCount === 0) {
  fail(`No supported update artifacts found in "${artifactDir}".`)
}
