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

function parseReleaseTag(tag) {
  if (!tag) {
    console.error('Error: ONWARD_TAG environment variable is not set.')
    console.error('Usage: ONWARD_TAG=v2026.04.01 node scripts/dist-release.js')
    process.exit(1)
  }

  const match = /^v(\d{4})\.(\d{2})\.(\d{2})(?:\.(\d+))?$/.exec(tag)
  if (!match) {
    console.error(`Error: Invalid tag format "${tag}".`)
    console.error('Expected format: v2026.04.01 or v2026.04.01.2')
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
    version
  }
}

const release = parseReleaseTag(process.env.ONWARD_TAG)
const baseProductName = getBaseProductName()
const artifactName = `${baseProductName}-${release.tag}-\${arch}.\${ext}`

console.log(`Building release with tag: ${release.tag}`)
console.log(`Resolved app version: ${release.version}`)

run('node', [join(__dirname, 'check-chinese-comments.js')])
// Generate third-party license notices for binary distribution
run('npx', ['license-checker-rseidelsohn', '--production', '--plainVertical', '--out', 'ThirdPartyNotices.txt'])
run('electron-vite', ['build'])

// On Windows with shell: true, arguments containing spaces must be quoted
const q = process.platform === 'win32' ? '"' : ''
run('electron-builder', [
  `${q}-c.artifactName=${artifactName}${q}`,
  `${q}-c.extraMetadata.version=${release.version}${q}`,
  '-c.extraMetadata.buildChannel=prod',
  `${q}-c.extraMetadata.tag=${release.tag}${q}`,
  '-c.npmRebuild=false',
  '--publish',
  'never'
])
