#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// Release build script for CI environments.
// Reads the ONWARD_TAG environment variable (e.g. "v2026.04.01") and injects
// it into the electron-builder metadata so the packaged app displays the tag
// as part of its window title (e.g. "Onward 2 v2026.04.01").

const { spawnSync } = require('child_process')
const { readFileSync } = require('fs')
const { join } = require('path')

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function getBaseProductName() {
  try {
    const pkgPath = join(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    return pkg.productName || pkg.name || 'Onward 2'
  } catch {
    return 'Onward 2'
  }
}

function assertNoInjectedBuildSecrets() {
  const forbiddenEnvKeys = ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_API_TOKEN']
  const injectedKeys = forbiddenEnvKeys.filter(key => {
    const value = process.env[key]
    return typeof value === 'string' && value.trim().length > 0
  })

  if (injectedKeys.length > 0) {
    console.error(`Error: Release build step must not receive repository tokens: ${injectedKeys.join(', ')}`)
    process.exit(1)
  }
}

function getReleaseOsName() {
  const configured = String(process.env.ONWARD_RELEASE_OS || '').trim().toLowerCase()
  if (configured === 'macos' || configured === 'windows' || configured === 'linux') {
    return configured
  }

  switch (process.platform) {
    case 'darwin':
      return 'macos'
    case 'win32':
      return 'windows'
    case 'linux':
      return 'linux'
    default:
      console.error(`Error: Unsupported platform "${process.platform}" for release build.`)
      process.exit(1)
  }
}

function parseSemverReleaseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-(daily)\.(\d{8})\.(\d+))?$/.exec(tag)
  if (!match) {
    return null
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  const prereleaseType = match[4] || null
  const buildDate = match[5] || null
  const buildNumber = match[6] || null

  if (prereleaseType === 'daily') {
    const year = Number(buildDate.slice(0, 4))
    const month = Number(buildDate.slice(4, 6))
    const day = Number(buildDate.slice(6, 8))
    const utc = new Date(Date.UTC(year, month - 1, day))
    const isValidDate =
      utc.getUTCFullYear() === year &&
      utc.getUTCMonth() === month - 1 &&
      utc.getUTCDate() === day

    if (!isValidDate) {
      console.error(`Error: Invalid calendar date in tag "${tag}".`)
      process.exit(1)
    }
  }

  return {
    tag,
    version: tag.slice(1),
    releaseChannel: prereleaseType === 'daily' ? 'daily' : 'stable',
    major,
    minor,
    patch,
    buildDate,
    buildNumber
  }
}

function parseReleaseTag(tag) {
  if (!tag) {
    console.error('Error: ONWARD_TAG environment variable is not set.')
    console.error('Usage: ONWARD_TAG=v2.1.0-daily.20260402.1 node scripts/dist-release.js')
    process.exit(1)
  }

  const semverRelease = parseSemverReleaseTag(tag)
  if (semverRelease) {
    return semverRelease
  }

  const match = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(tag)
  if (!match) {
    console.error(`Error: Invalid tag format "${tag}".`)
    console.error('Expected format: v2.1.0, v2.1.0-daily.20260402.1, v2026.04.01, or v2026.04.01.2')
    process.exit(1)
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const rebuild = match[4] ? Number(match[4]) : null

  const utc = new Date(Date.UTC(year, month - 1, day))
  const isValidDate =
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day

  if (!isValidDate) {
    console.error(`Error: Invalid calendar date in tag "${tag}".`)
    process.exit(1)
  }

  const version = `${year}.${month}.${day}${rebuild !== null ? `-${rebuild}` : ''}`

  return {
    tag,
    version,
    releaseChannel: 'daily'
  }
}

assertNoInjectedBuildSecrets()

const release = parseReleaseTag(process.env.ONWARD_TAG)
const baseProductName = getBaseProductName()
const releaseOs = getReleaseOsName()
const artifactName = `${baseProductName}-${release.tag}-${releaseOs}-\${arch}.\${ext}`

console.log(`Building release with tag: ${release.tag}`)
console.log(`Resolved app version: ${release.version}`)
console.log(`Resolved release channel: ${release.releaseChannel}`)
console.log(`Resolved release OS: ${releaseOs}`)

run('node', [join(__dirname, 'check-chinese-comments.js')])
run('node', [join(__dirname, 'compile-changelog.js')])
// Generate third-party license notices for binary distribution
run('pnpm', ['generate-notices'])
run('electron-vite', ['build'])

// On Windows with shell: true, arguments containing spaces must be quoted
const q = process.platform === 'win32' ? '"' : ''
run('electron-builder', [
  `${q}-c.artifactName=${artifactName}${q}`,
  `${q}-c.extraMetadata.version=${release.version}${q}`,
  '-c.extraMetadata.buildChannel=prod',
  `${q}-c.extraMetadata.tag=${release.tag}${q}`,
  `${q}-c.extraMetadata.releaseChannel=${release.releaseChannel}${q}`,
  `${q}-c.extraMetadata.releaseOs=${releaseOs}${q}`,
  '-c.npmRebuild=false',
  '--publish',
  'never'
])
