#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { execSync, spawnSync } = require('child_process')
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

function getBranchName() {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.toString().trim()
  } catch {
    return 'detached'
  }
}

function sanitizeBranchName(value) {
  let name = String(value || '').trim()
  if (!name || name === 'HEAD') {
    name = 'detached'
  }
  name = name.replace(/[^a-zA-Z0-9._-]+/g, '-')
  name = name.replace(/-+/g, '-')
  name = name.replace(/^-+|-+$/g, '')
  return name || 'branch'
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

const branchRaw = getBranchName()
const branch = sanitizeBranchName(branchRaw)
const baseName = getBaseProductName()
const productName = `${baseName}-${branch}`

run('node', [join(__dirname, 'check-chinese-comments.js')])
// Generate third-party license notices for binary distribution
run('npx', ['license-checker-rseidelsohn', '--production', '--plainVertical', '--out', 'ThirdPartyNotices.txt'])
run('electron-vite', ['build'])
// On Windows with shell: true, arguments containing spaces must be quoted
const q = process.platform === 'win32' ? '"' : ''
run('electron-builder', [
  `${q}-c.productName=${productName}${q}`,
  `${q}-c.extraMetadata.productName=${productName}${q}`,
  '-c.extraMetadata.buildChannel=dev',
  `${q}-c.extraMetadata.branch=${branch}${q}`,
  '-c.npmRebuild=false',
  '--dir'
])
