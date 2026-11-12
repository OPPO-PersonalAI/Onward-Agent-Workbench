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

  throw new Error(`Unsupported release tag format "${tag}".`)
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
  throw new Error(`Missing Change Log file. Searched:\n${candidates.map(p => `  - ${p}`).join('\n')}\nGenerate and commit the changelog before publishing.`)
}

function parseUpdateArtifact(fileName) {
  const windowsInstallerMatch = /-(windows)-(arm64|x64)\.exe$/i.exec(fileName)
  if (windowsInstallerMatch) {
    return {
      releaseOs: windowsInstallerMatch[1].toLowerCase(),
      arch: windowsInstallerMatch[2].toLowerCase(),
      kind: 'installer'
    }
  }

  const windowsZipMatch = /-(windows)-(arm64|x64)\.zip$/i.exec(fileName)
  if (windowsZipMatch) {
    return {
      releaseOs: windowsZipMatch[1].toLowerCase(),
      arch: windowsZipMatch[2].toLowerCase(),
      kind: 'archive'
    }
  }

  const zipMatch = /-(macos|linux)-(arm64|x64)\.zip$/i.exec(fileName)
  if (zipMatch) {
    return {
      releaseOs: zipMatch[1].toLowerCase(),
      arch: zipMatch[2].toLowerCase(),
      kind: 'archive'
    }
  }

  return null
}

function generateManifests({ repository, releaseTag, artifactDir, manifestDir, changelogRoot, nowIso }) {
  const release = parseReleaseTag(releaseTag)
  const releaseNotes = readReleaseNotes(changelogRoot, release)
  const artifactFiles = readdirSync(artifactDir).filter(fileName => /\.(zip|exe)$/i.test(fileName))

  if (artifactFiles.length === 0) {
    throw new Error(`No update artifacts found in "${artifactDir}".`)
  }

  const windowsByArch = new Map()
  const nonWindowsArtifacts = []

  for (const fileName of artifactFiles) {
    const artifact = parseUpdateArtifact(fileName)
    if (!artifact) {
      console.warn(`Skipping unsupported artifact name "${fileName}".`)
      continue
    }

    if (artifact.releaseOs === 'windows') {
      const slot = windowsByArch.get(artifact.arch) || { installer: null, archive: null }
      if (artifact.kind === 'installer') {
        slot.installer = fileName
      } else if (artifact.kind === 'archive') {
        slot.archive = fileName
      }
      windowsByArch.set(artifact.arch, slot)
    } else {
      nonWindowsArtifacts.push({ fileName, ...artifact })
    }
  }

  const publishedAt = nowIso || new Date().toISOString()
  let generatedCount = 0

  // Emit macOS / Linux manifests with zero schema change.
  for (const item of nonWindowsArtifacts) {
    const artifactPath = join(artifactDir, item.fileName)
    const outputDir = join(manifestDir, release.releaseChannel, item.releaseOs, item.arch)
    const outputPath = join(outputDir, 'latest.json')
    const checksum = sha256File(artifactPath)

    ensureDir(outputDir)

    const manifest = {
      channel: release.releaseChannel,
      version: release.version,
      tag: release.tag,
      platform: item.releaseOs,
      arch: item.arch,
      artifactName: toGitHubReleaseAssetName(basename(item.fileName)),
      artifactUrl: buildAssetUrl(repository, release.tag, item.fileName),
      sha256: checksum,
      releaseNotes,
      publishedAt
    }

    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    console.log(`Generated update manifest: ${outputPath}`)
    generatedCount++
  }

  // Emit Windows manifests with dual-field compatibility:
  // - Primary artifact* fields point to the .exe installer when present (backward compatible with legacy clients).
  // - Optional archive object points to the .zip package for background-staging clients.
  for (const [arch, slot] of windowsByArch.entries()) {
    const primaryFileName = slot.installer || slot.archive
    if (!primaryFileName) continue

    const primaryPath = join(artifactDir, primaryFileName)
    const primaryChecksum = sha256File(primaryPath)
    const outputDir = join(manifestDir, release.releaseChannel, 'windows', arch)
    const outputPath = join(outputDir, 'latest.json')

    ensureDir(outputDir)

    const manifest = {
      channel: release.releaseChannel,
      version: release.version,
      tag: release.tag,
      platform: 'windows',
      arch,
      artifactName: toGitHubReleaseAssetName(basename(primaryFileName)),
      artifactUrl: buildAssetUrl(repository, release.tag, primaryFileName),
      sha256: primaryChecksum,
      ...(slot.archive
        ? {
            archive: {
              artifactName: toGitHubReleaseAssetName(basename(slot.archive)),
              artifactUrl: buildAssetUrl(repository, release.tag, slot.archive),
              sha256: slot.archive === primaryFileName
                ? primaryChecksum
                : sha256File(join(artifactDir, slot.archive))
            }
          }
        : {}),
      releaseNotes,
      publishedAt
    }

    writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
    console.log(`Generated update manifest: ${outputPath}`)
    generatedCount++
  }

  if (generatedCount === 0) {
    throw new Error(`No supported update artifacts found in "${artifactDir}".`)
  }

  return generatedCount
}

if (require.main === module) {
  try {
    const repository = getRequiredEnv('ONWARD_GITHUB_REPOSITORY')
    const releaseTag = getRequiredEnv('ONWARD_RELEASE_TAG')
    const artifactDir = getRequiredEnv('ONWARD_ARTIFACT_DIR')
    const manifestDir = getRequiredEnv('ONWARD_MANIFEST_DIR')
    const changelogRoot = String(process.env.ONWARD_CHANGELOG_ROOT || join(process.cwd(), 'resources', 'changelog')).trim()
    generateManifests({
      repository,
      releaseTag,
      artifactDir,
      manifestDir,
      changelogRoot
    })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

module.exports = {
  buildAssetUrl,
  generateManifests,
  parseReleaseTag,
  parseUpdateArtifact,
  toGitHubReleaseAssetName
}
