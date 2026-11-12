/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Simulated GitHub Releases + gh-pages + Azure CDN HTTP server for local
 * Windows auto-update E2E tests and interactive sandbox sessions.
 *
 * Emulates:
 *  - GET /updates/<channel>/<platform>/<arch>/latest.json  (gh-pages manifest)
 *  - GET /releases/download/<tag>/<asset>                  (302 redirect to /cdn/...)
 *  - GET /cdn/<tag>/<asset>                                (200 / 206 Range streaming,
 *                                                           optional bandwidth throttling,
 *                                                           optional mid-stream drop once
 *                                                           to verify HTTP Range resume)
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'

const require = createRequire(import.meta.url)
const yazl = require('yazl')
const { generateManifests } = require('../../scripts/generate-update-manifest.js')

function isSafeSubpath(rootDir, candidatePath) {
  const normalizedRoot = resolve(rootDir)
  const normalizedCandidate = resolve(candidatePath)
  const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  if (process.platform === 'win32') {
    return (
      normalizedCandidate.toLowerCase() === normalizedRoot.toLowerCase() ||
      normalizedCandidate.toLowerCase().startsWith(rootPrefix.toLowerCase())
    )
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootPrefix)
}

function collectFilesRecursively(dirPath, rootDir = dirPath, acc = []) {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const subEntries = readdirSync(fullPath)
      if (subEntries.length === 0) {
        const relDir = `${relative(rootDir, fullPath).split(sep).join('/')}/`
        acc.push({ fullPath, relPath: relDir, isDirectory: true })
      } else {
        collectFilesRecursively(fullPath, rootDir, acc)
      }
    } else if (entry.isFile()) {
      const relFile = relative(rootDir, fullPath).split(sep).join('/')
      acc.push({ fullPath, relPath: relFile, isDirectory: false })
    }
  }
  return acc
}

/**
 * Packages an electron-builder `win-unpacked` directory into a standard `.zip`
 * archive identical in structure to electron-builder's `win: [zip]` target.
 */
export async function createZipFromUnpackedDir(unpackedDir, outputZipPath) {
  mkdirSync(dirname(outputZipPath), { recursive: true })
  if (existsSync(outputZipPath)) {
    return outputZipPath
  }

  const zipFile = new yazl.ZipFile()
  const entries = collectFilesRecursively(unpackedDir)
  for (const entry of entries) {
    if (entry.isDirectory) {
      zipFile.addEmptyDirectory(entry.relPath)
    } else {
      zipFile.addFile(entry.fullPath, entry.relPath)
    }
  }
  zipFile.end()

  await new Promise((resolveDone, rejectDone) => {
    const out = createWriteStream(outputZipPath)
    out.on('close', () => resolveDone())
    out.on('error', rejectDone)
    zipFile.outputStream.on('error', rejectDone)
    zipFile.outputStream.pipe(out)
  })

  return outputZipPath
}

function createThrottleTransform(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return null
  const chunkBudget = Math.max(16 * 1024, Math.floor(bytesPerSec / 20))
  let windowBytes = 0
  let windowStart = Date.now()

  return new Transform({
    transform(chunk, _encoding, callback) {
      let offset = 0
      const pushNextSlice = () => {
        if (offset >= chunk.length) {
          callback()
          return
        }
        const sliceEnd = Math.min(offset + chunkBudget, chunk.length)
        const slice = chunk.subarray(offset, sliceEnd)
        offset = sliceEnd
        this.push(slice)
        windowBytes += slice.length

        const elapsedMs = Date.now() - windowStart
        const expectedMs = Math.floor((windowBytes / bytesPerSec) * 1000)
        const delayMs = expectedMs - elapsedMs
        if (windowBytes >= bytesPerSec) {
          windowBytes = 0
          windowStart = Date.now()
        }
        if (delayMs > 5) {
          setTimeout(pushNextSlice, delayMs)
        } else {
          setImmediate(pushNextSlice)
        }
      }
      pushNextSlice()
    }
  })
}

export function publishMockReleaseManifest({
  serverRootDir,
  port,
  tag,
  channel,
  zipArtifactPath,
  dummyExeArtifactPath = null,
  releaseNotes = `Simulated release ${tag}`
}) {
  const stagingArtifactsDir = join(serverRootDir, '_staging-artifacts', tag)
  const changelogRoot = join(serverRootDir, '_changelogs')
  const manifestsDir = join(serverRootDir, 'updates')
  const releaseAssetsDir = join(serverRootDir, 'assets', tag)

  mkdirSync(stagingArtifactsDir, { recursive: true })
  mkdirSync(join(changelogRoot, 'en', channel), { recursive: true })
  mkdirSync(releaseAssetsDir, { recursive: true })

  writeFileSync(join(changelogRoot, 'en', channel, `${tag}.md`), `${releaseNotes}\n`, 'utf-8')

  const zipBaseName = `Onward 2-${tag.slice(1)}-windows-x64.zip`
  const githubAssetZipName = zipBaseName.replace(/ /g, '.')
  const stagedZipPath = join(stagingArtifactsDir, zipBaseName)
  if (!existsSync(stagedZipPath)) {
    writeFileSync(stagedZipPath, readFileSync(zipArtifactPath))
  }
  writeFileSync(join(releaseAssetsDir, githubAssetZipName), readFileSync(zipArtifactPath))

  if (dummyExeArtifactPath && existsSync(dummyExeArtifactPath)) {
    const exeBaseName = `Onward 2-${tag.slice(1)}-windows-x64.exe`
    const githubAssetExeName = exeBaseName.replace(/ /g, '.')
    writeFileSync(join(stagingArtifactsDir, exeBaseName), readFileSync(dummyExeArtifactPath))
    writeFileSync(join(releaseAssetsDir, githubAssetExeName), readFileSync(dummyExeArtifactPath))
  } else {
    // Emit a lightweight placeholder .exe alongside the .zip so dual-field manifest compatibility is always exercised.
    const exeBaseName = `Onward 2-${tag.slice(1)}-windows-x64.exe`
    const githubAssetExeName = exeBaseName.replace(/ /g, '.')
    const placeholder = Buffer.from(`legacy-nsis-placeholder-${tag}`, 'utf-8')
    writeFileSync(join(stagingArtifactsDir, exeBaseName), placeholder)
    writeFileSync(join(releaseAssetsDir, githubAssetExeName), placeholder)
  }

  const fakeRepo = 'local-mock/Onward-Agent-Workbench'
  generateManifests({
    repository: fakeRepo,
    releaseTag: tag,
    artifactDir: stagingArtifactsDir,
    manifestDir: manifestsDir,
    changelogRoot
  })

  const manifestPath = join(manifestsDir, channel, 'windows', 'x64', 'latest.json')
  const rawText = readFileSync(manifestPath, 'utf-8')
  const rewrittenText = rawText.replaceAll(
    `https://github.com/${fakeRepo}/releases/download/`,
    `http://127.0.0.1:${port}/releases/download/`
  )
  writeFileSync(manifestPath, rewrittenText, 'utf-8')
  return JSON.parse(rewrittenText)
}

export function createMockGitHubUpdateServer(rootDir, options = {}) {
  const normalizedRoot = resolve(rootDir)
  let throttleBytesPerSec = options.throttleBytesPerSec ?? 0
  let interruptFirstCdnStreamAfterBytes = options.interruptFirstCdnStreamAfterBytes ?? 0
  const interruptedAssets = new Set()

  const stats = {
    manifestRequests: 0,
    redirectRequests: 0,
    cdnRequests: 0,
    rangeRequests: 0,
    interruptedStreams: 0
  }

  const server = http.createServer((req, res) => {
    const hostHeader = req.headers.host || '127.0.0.1'
    const reqUrl = new URL(req.url || '/', `http://${hostHeader}`)
    let pathname
    try {
      pathname = decodeURIComponent(reqUrl.pathname)
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }

    if (options.verbose !== false) {
      const rangeSuffix = req.headers.range ? ` [Range: ${req.headers.range}]` : ''
      console.log(`  [MockGitHub] ${req.method} ${pathname}${rangeSuffix}`)
    }

    // 1. gh-pages manifest route: /updates/...
    if (pathname.startsWith('/updates/')) {
      stats.manifestRequests += 1
      const filePath = resolve(normalizedRoot, pathname.replace(/^\/+/, ''))
      if (!isSafeSubpath(normalizedRoot, filePath) || !existsSync(filePath)) {
        res.writeHead(404)
        res.end('Manifest Not Found')
        return
      }
      const payload = readFileSync(filePath)
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
        'Cache-Control': 'no-store'
      })
      res.end(payload)
      return
    }

    // 2. GitHub Releases 302 redirect route: /releases/download/<tag>/<asset>
    const releaseMatch = /^\/releases\/download\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (releaseMatch) {
      stats.redirectRequests += 1
      const [, tag, assetName] = releaseMatch
      const redirectLocation = `http://${hostHeader}/cdn/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
      res.writeHead(302, {
        Location: redirectLocation,
        'Cache-Control': 'no-store'
      })
      res.end()
      return
    }

    // 3. Azure Blob CDN route with HTTP Range (206) support: /cdn/<tag>/<asset>
    const cdnMatch = /^\/cdn\/([^/]+)\/([^/]+)$/.exec(pathname)
    if (cdnMatch) {
      stats.cdnRequests += 1
      const [, tag, assetName] = cdnMatch
      const assetPath = resolve(normalizedRoot, 'assets', tag, assetName)
      if (!isSafeSubpath(normalizedRoot, assetPath) || !existsSync(assetPath)) {
        res.writeHead(404)
        res.end('Asset Not Found')
        return
      }

      const fileStat = statSync(assetPath)
      const totalSize = fileStat.size
      let start = 0
      let end = totalSize - 1
      let statusCode = 200
      const headers = {
        'Content-Type': assetName.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }

      const rangeHeader = req.headers.range
      if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
        const rangeMatch = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim())
        if (!rangeMatch) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
          res.end()
          return
        }
        start = Number(rangeMatch[1])
        end = rangeMatch[2] ? Math.min(Number(rangeMatch[2]), totalSize - 1) : totalSize - 1
        if (!Number.isInteger(start) || start < 0 || start >= totalSize || end < start) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` })
          res.end()
          return
        }
        statusCode = 206
        stats.rangeRequests += 1
        headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`
      }

      const contentLength = end - start + 1
      headers['Content-Length'] = contentLength
      res.writeHead(statusCode, headers)

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const assetKey = `${tag}/${assetName}`
      const shouldInterruptOnce =
        interruptFirstCdnStreamAfterBytes > 0 &&
        statusCode === 200 &&
        !interruptedAssets.has(assetKey) &&
        interruptFirstCdnStreamAfterBytes < contentLength

      if (shouldInterruptOnce) {
        interruptedAssets.add(assetKey)
        stats.interruptedStreams += 1
        const truncatedEnd = start + interruptFirstCdnStreamAfterBytes - 1
        const partialStream = createReadStream(assetPath, { start, end: truncatedEnd })
        partialStream.on('data', (chunk) => res.write(chunk))
        partialStream.on('end', () => {
          setTimeout(() => {
            res.socket?.destroy()
          }, 150)
        })
        partialStream.on('error', () => {
          res.socket?.destroy()
        })
        return
      }

      const readStream = createReadStream(assetPath, { start, end })
      const throttle = createThrottleTransform(throttleBytesPerSec)
      req.on('close', () => {
        readStream.destroy()
        throttle?.destroy()
      })
      if (throttle) {
        readStream.pipe(throttle).pipe(res)
      } else {
        readStream.pipe(res)
      }
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  })

  return {
    server,
    stats,
    setThrottleBytesPerSec(value) {
      throttleBytesPerSec = value
    },
    setInterruptFirstCdnStreamAfterBytes(value) {
      interruptFirstCdnStreamAfterBytes = value
    },
    async listen(preferredPort = 0) {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(preferredPort, '127.0.0.1', () => resolveListen())
      })
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        throw new Error('Failed to bind mock GitHub update server.')
      }
      return addr.port
    },
    async close() {
      await new Promise((resolveClose) => {
        server.close(() => resolveClose())
      })
    }
  }
}
