#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { createHash } = require('crypto')
const { mkdirSync, readdirSync, readFileSync, writeFileSync } = require('fs')
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
  const semverMatch = /^v(\d+\.\d+\.\d+(?:-(daily)\.(\d{8})\.(\d+))?)$/.exec(tag)
  if (semverMatch) {
    return {
      tag,
      version: semverMatch[1],
      releaseChannel: semverMatch[2] === 'daily' ? 'daily' : 'stable'
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

function buildAssetUrl(repository, tag, fileName) {
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(fileName)}`
}

const repository = getRequiredEnv('ONWARD_GITHUB_REPOSITORY')
const releaseTag = getRequiredEnv('ONWARD_RELEASE_TAG')
const artifactDir = getRequiredEnv('ONWARD_ARTIFACT_DIR')
const manifestDir = getRequiredEnv('ONWARD_MANIFEST_DIR')
const release = parseReleaseTag(releaseTag)
const artifactFiles = readdirSync(artifactDir).filter(fileName => fileName.endsWith('.zip'))

if (artifactFiles.length === 0) {
  fail(`No zip artifacts found in "${artifactDir}".`)
}

for (const fileName of artifactFiles) {
  const match = /-(macos|windows|linux)-(arm64|x64)\.zip$/.exec(fileName)
  if (!match) {
    console.warn(`Skipping unsupported artifact name "${fileName}".`)
    continue
  }

  const releaseOs = match[1]
  const arch = match[2]
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
    artifactName: basename(fileName),
    artifactUrl: buildAssetUrl(repository, release.tag, fileName),
    sha256: checksum,
    releaseNotes: null,
    publishedAt: new Date().toISOString()
  }

  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  console.log(`Generated update manifest: ${outputPath}`)
}
