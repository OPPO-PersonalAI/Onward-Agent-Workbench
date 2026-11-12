#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Interactive Local Windows Update Sandbox.
 *
 * Spins up the local simulated GitHub Releases + CDN server, stages a fresh
 * isolated installation of OLD_VERSION under `test/autotest/results/local-update-sandbox/app`
 * (never touching real user data), publishes NEW_VERSION on the mock server,
 * and launches Onward 2 so you can interactively test:
 *  - Settings -> About download progress bar -> "Preparing update..." -> "Restart to update"
 *  - Top Update Banner -> "Restart to update"
 *  - Normal window close -> silent background swap -> manually re-opening `app/Onward 2.exe`
 *
 * Usage:
 *   node test/autotest/run-local-update-sandbox.mjs
 *   node test/autotest/run-local-update-sandbox.mjs --channel dev --speed-mbps 20
 */

import { execSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createMockGitHubUpdateServer,
  createZipFromUnpackedDir,
  publishMockReleaseManifest
} from './mock-github-update-server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const PRODUCT_NAME = 'Onward 2'

function parseArgs(argv) {
  let channel = 'daily'
  let speedMbps = 25
  let rebuild = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--channel' && argv[i + 1]) {
      channel = argv[i + 1]
      i += 1
    } else if (arg === '--speed-mbps' && argv[i + 1]) {
      speedMbps = Number(argv[i + 1])
      i += 1
    } else if (arg === '--rebuild') {
      rebuild = true
    }
  }

  if (channel !== 'daily' && channel !== 'dev') {
    throw new Error(`Unsupported --channel "${channel}" (use "daily" or "dev")`)
  }
  return { channel, speedMbps: Number.isFinite(speedMbps) && speedMbps > 0 ? speedMbps : 25, rebuild }
}

async function ensureSandboxBuild(tag, channel, cacheRoot, forceRebuild) {
  const version = tag.slice(1)
  const outDir = join(cacheRoot, tag)
  const zipPath = join(cacheRoot, `${PRODUCT_NAME}-${version}-windows-x64.zip`.replace(/ /g, '.'))

  if (!forceRebuild && existsSync(join(outDir, `${PRODUCT_NAME}.exe`))) {
    if (!existsSync(zipPath)) {
      await createZipFromUnpackedDir(outDir, zipPath)
    }
    return { dir: outDir, zipPath }
  }

  console.log(`[Sandbox] Building ${tag} ...`)
  execSync('node scripts/ensure-windows-updater.js', { cwd: PROJECT_ROOT, stdio: 'inherit' })
  execSync('pnpm exec electron-vite build', {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  })

  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })

  const q = '"'
  const artifactName = `${PRODUCT_NAME}-${tag}-windows-\${arch}.\${ext}`
  const builderArgs = [
    '--dir',
    '-c.appId=com.onward2.autoupdate.sandbox',
    `${q}-c.artifactName=${artifactName}${q}`,
    `${q}-c.extraMetadata.version=${version}${q}`,
    '-c.extraMetadata.buildChannel=prod',
    `${q}-c.extraMetadata.tag=${tag}${q}`,
    `-c.extraMetadata.releaseChannel=${channel}`,
    '-c.extraMetadata.releaseOs=windows',
    '-c.npmRebuild=false'
  ].join(' ')

  execSync(`pnpm exec electron-builder ${builderArgs}`, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
  })

  mkdirSync(outDir, { recursive: true })
  cpSync(join(PROJECT_ROOT, 'release', 'win-unpacked'), outDir, { recursive: true })
  rmSync(zipPath, { force: true })
  await createZipFromUnpackedDir(outDir, zipPath)
  rmSync(join(PROJECT_ROOT, 'release'), { recursive: true, force: true })

  return { dir: outDir, zipPath }
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('run-local-update-sandbox.mjs is for Windows only.')
  }

  const { channel, speedMbps, rebuild } = parseArgs(process.argv.slice(2))
  const oldTag = `v2.1.0-${channel}.20261112.1`
  const newTag = `v2.1.0-${channel}.20261112.2`

  const sharedCacheRoot =
    channel === 'daily'
      ? join(PROJECT_ROOT, 'test', 'autotest', 'results', 'auto-update-windows-e2e', 'fixtures')
      : join(PROJECT_ROOT, 'test', 'autotest', 'results', 'local-update-sandbox', `cache-${channel}`)

  const sandboxRoot = join(PROJECT_ROOT, 'test', 'autotest', 'results', 'local-update-sandbox', 'session')
  const serverRoot = join(sandboxRoot, 'mock-github')
  const installDir = join(sandboxRoot, 'app')
  const userDataDir = join(sandboxRoot, 'user-data')

  mkdirSync(sharedCacheRoot, { recursive: true })
  rmSync(sandboxRoot, { recursive: true, force: true })
  mkdirSync(serverRoot, { recursive: true })
  mkdirSync(userDataDir, { recursive: true })

  const oldBuild = await ensureSandboxBuild(oldTag, channel, sharedCacheRoot, rebuild)
  const newBuild = await ensureSandboxBuild(newTag, channel, sharedCacheRoot, rebuild)

  console.log(`[Sandbox] Provisioning isolated install at ${installDir}`)
  cpSync(oldBuild.dir, installDir, { recursive: true })

  const mockServer = createMockGitHubUpdateServer(serverRoot, {
    throttleBytesPerSec: Math.round(speedMbps * 1024 * 1024)
  })
  const port = await mockServer.listen()

  publishMockReleaseManifest({
    serverRootDir: serverRoot,
    port,
    tag: newTag,
    channel,
    zipArtifactPath: newBuild.zipPath,
    releaseNotes: `## Local Simulated Release ${newTag}\n- Zero console windows\n- Instant restart swap\n`
  })

  const execPath = join(installDir, `${PRODUCT_NAME}.exe`)
  const launchScriptPath = join(sandboxRoot, 'reopen-sandbox-app.cmd')
  writeFileSync(
    launchScriptPath,
    [
      '@echo off',
      `set "ONWARD_USER_DATA_DIR=${userDataDir}"`,
      `set "ONWARD_UPDATE_BASE_URL=http://127.0.0.1:${port}/updates"`,
      `start "" "${execPath}"`
    ].join('\r\n'),
    'utf-8'
  )

  console.log('\n============================================================')
  console.log(' Local Windows Update Sandbox Ready!')
  console.log('============================================================')
  console.log(`  Channel:         ${channel}`)
  console.log(`  Initial Version: ${oldTag}`)
  console.log(`  Target Update:   ${newTag}`)
  console.log(`  Download Speed:  ~${speedMbps} MB/s (throttled for UI observation)`)
  console.log(`  Mock GitHub URL: http://127.0.0.1:${port}/updates`)
  console.log(`  App Executable:  ${execPath}`)
  console.log(`  Reopen Helper:   ${launchScriptPath}`)
  console.log(`  Isolated Data:   ${userDataDir}`)
  console.log('------------------------------------------------------------')
  console.log('  Press Ctrl+C here when finished to stop the mock server.')
  console.log('============================================================\n')

  const child = spawn(execPath, [], {
    cwd: installDir,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ONWARD_USER_DATA_DIR: userDataDir,
      ONWARD_UPDATE_BASE_URL: `http://127.0.0.1:${port}/updates`
    }
  })
  child.unref()

  const shutdown = async () => {
    console.log('\n[Sandbox] Stopping mock GitHub server...')
    await mockServer.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((error) => {
  console.error(`[Sandbox] Fatal error: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exit(1)
})
