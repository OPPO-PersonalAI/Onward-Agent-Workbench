/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { assert, runShellCommand, shellEscape, waitFor } from './auto-update-test-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const repository = 'OPPO-PersonalAI/Onward'

function parseArgs(argv) {
  const args = {
    tag: '',
    pushBranch: '',
    createTag: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--tag') {
      args.tag = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--push-branch') {
      args.pushBranch = argv[index + 1] || ''
      index += 1
      continue
    }
    if (value === '--create-tag') {
      args.createTag = true
      continue
    }
  }

  if (!args.tag) {
    throw new Error('Missing required --tag argument.')
  }

  return args
}

async function captureCommand(command) {
  const { spawn } = await import('child_process')
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${command}\n${stderr}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function headJson(url) {
  const { spawn } = await import('child_process')
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/zsh', ['-lc', `curl -sS -I -L ${shellEscape(url)}`], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`HEAD request failed (${code}): ${url}\n${stderr}`))
        return
      }
      resolve(stdout)
    })
  })
}

async function readGhPagesManifest(repository, manifestPath) {
  const manifestOutput = await captureCommand(
    `gh api ${shellEscape(`repos/${repository}/contents/${manifestPath}?ref=gh-pages`)} --jq .content`
  )
  return JSON.parse(Buffer.from(manifestOutput.trim(), 'base64').toString('utf-8'))
}

async function assertManifestArtifact(repository, manifestPath, expected) {
  const manifest = await readGhPagesManifest(repository, manifestPath)
  assert(manifest.tag === expected.tag, `Expected ${manifestPath} tag ${expected.tag}, got ${manifest.tag}`)
  assert(manifest.platform === expected.platform, `Expected ${manifestPath} platform=${expected.platform}, got ${manifest.platform}`)
  assert(manifest.arch === expected.arch, `Expected ${manifestPath} arch=${expected.arch}, got ${manifest.arch}`)
  assert(String(manifest.artifactName).endsWith(expected.extension),
    `Expected ${manifestPath} artifact to end with ${expected.extension}, got ${manifest.artifactName}`)
  assert(String(manifest.artifactUrl).includes(`/releases/download/${expected.tag}/`),
    `Expected ${manifestPath} artifact URL to point at the pushed tag release.`)
  const headResponse = await headJson(manifest.artifactUrl)
  assert(/HTTP\/2 200|HTTP\/1\.1 200/.test(headResponse), `Expected ${manifestPath} artifact URL to resolve successfully.`)
  return manifest
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  await runShellCommand('gh auth status', { cwd: repoRoot, stdio: 'inherit' })

  if (args.pushBranch) {
    console.log(`[github-e2e] Pushing branch ${args.pushBranch}`)
    await runShellCommand(`git push -u origin HEAD:refs/heads/${args.pushBranch}`, {
      cwd: repoRoot,
      stdio: 'inherit'
    })
  }

  if (args.createTag) {
    console.log(`[github-e2e] Creating local tag ${args.tag}`)
    await runShellCommand(`git tag ${args.tag}`, {
      cwd: repoRoot,
      stdio: 'inherit'
    })
  }

  console.log(`[github-e2e] Pushing tag ${args.tag}`)
  await runShellCommand(`git push origin refs/tags/${args.tag}`, {
    cwd: repoRoot,
    stdio: 'inherit'
  })

  console.log('[github-e2e] Waiting for GitHub Actions run')
  const run = await waitFor(async () => {
    const output = await captureCommand(
      `gh run list --repo ${repository} --workflow "Daily Build" --json databaseId,headBranch,status,conclusion,url --limit 20`
    )
    const runs = JSON.parse(output)
    return runs.find((candidate) => candidate.headBranch === args.tag) || null
  }, {
    timeoutMs: 180000,
    intervalMs: 5000,
    description: `GitHub Actions run for ${args.tag}`
  })

  console.log(`[github-e2e] Watching run ${run.databaseId}`)
  await runShellCommand(`gh run watch ${run.databaseId} --repo ${repository} --exit-status`, {
    cwd: repoRoot,
    stdio: 'inherit'
  })

  console.log('[github-e2e] Verifying GitHub Release assets')
  const releaseOutput = await captureCommand(
    `gh release view ${args.tag} --repo ${repository} --json tagName,isPrerelease,isDraft,url,assets`
  )
  const release = JSON.parse(releaseOutput)
  assert(release.tagName === args.tag, `Expected GitHub Release tag ${args.tag}`)
  assert(release.isDraft === false, 'Expected GitHub Release draft=false.')
  assert(release.isPrerelease === true, 'Expected GitHub Release prerelease=true for Daily builds.')
  const assetNames = release.assets.map((asset) => asset.name)
  assert(assetNames.some((name) => name.endsWith('-macos-arm64.dmg')), 'Expected macOS arm64 DMG asset.')
  assert(assetNames.some((name) => name.endsWith('-macos-arm64.zip')), 'Expected macOS arm64 ZIP asset.')
  assert(assetNames.some((name) => name.endsWith('-macos-x64.dmg')), 'Expected macOS x64 DMG asset.')
  assert(assetNames.some((name) => name.endsWith('-macos-x64.zip')), 'Expected macOS x64 ZIP asset.')
  assert(assetNames.some((name) => name.endsWith('-windows-x64.exe')), 'Expected Windows x64 NSIS installer asset.')
  assert(assetNames.some((name) => name.endsWith('-windows-x64.zip')), 'Expected Windows x64 ZIP inspection asset.')

  console.log('[github-e2e] Verifying gh-pages update manifests through GitHub API')
  await assertManifestArtifact(repository, 'updates/daily/macos/arm64/latest.json', {
    tag: args.tag,
    platform: 'macos',
    arch: 'arm64',
    extension: '.zip'
  })
  await assertManifestArtifact(repository, 'updates/daily/windows/x64/latest.json', {
    tag: args.tag,
    platform: 'windows',
    arch: 'x64',
    extension: '.exe'
  })

  console.log('[github-e2e] Passed')
}

main().catch((error) => {
  console.error(`[github-e2e] Failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  process.exitCode = 1
})
