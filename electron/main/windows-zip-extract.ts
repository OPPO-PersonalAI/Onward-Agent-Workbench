/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { dirname, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { rawFs } from './raw-fs.ts'

const {
  close: closeFd,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  read: readFd,
  readdirSync,
  renameSync,
  rmSync
} = rawFs

export interface ExtractWindowsZipOptions {
  zipPath: string
  destinationDir: string
  expectedExecutableName: string
}

function isSafeRelativeZipEntry(rawFileName: string): string {
  const unified = rawFileName.replace(/\\/g, '/')
  if (!unified || unified.startsWith('/') || unified.includes('\0') || /^[a-zA-Z]:/.test(unified)) {
    throw new Error(`Unsafe zip entry path: ${rawFileName}`)
  }

  const segments = unified.split('/')
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Zip path traversal blocked: ${rawFileName}`)
    }
  }

  return normalize(unified)
}

function isInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const resolvedRoot = resolve(rootDir)
  const resolvedCandidate = resolve(candidatePath)
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
  if (process.platform === 'win32') {
    const lowerRoot = resolvedRoot.toLowerCase()
    const lowerRootWithSep = rootWithSep.toLowerCase()
    const lowerCandidate = resolvedCandidate.toLowerCase()
    return lowerCandidate === lowerRoot || lowerCandidate.startsWith(lowerRootWithSep)
  }
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(rootWithSep)
}

// Custom RandomAccessReader backed by rawFs to avoid yauzl's bundled fd-slicer,
// whose legacy ReadStream sets `this.destroyed = true` before `this.push(null)`
// and stalls multi-chunk deflate streams on Node 22+/24+.
const BaseRandomAccessReader = yauzl.RandomAccessReader as unknown as {
  new (): yauzl.RandomAccessReader & {
    _readStreamForRange(start: number, end: number): Readable
    read(buffer: Buffer, offset: number, length: number, position: number, callback: (err: Error | null, bytesRead?: number) => void): void
    close(callback: (err: Error | null) => void): void
  }
}

class RawFileRandomAccessReader extends BaseRandomAccessReader {
  private readonly fd: number
  private closed = false

  constructor(fd: number) {
    super()
    this.fd = fd
  }

  override _readStreamForRange(start: number, end: number): Readable {
    const fd = this.fd
    let pos = start
    return new Readable({
      highWaterMark: 64 * 1024,
      read(size) {
        const remaining = end - pos
        if (remaining <= 0) {
          this.push(null)
          return
        }
        const chunkLen = Math.min(size || 64 * 1024, remaining)
        const buf = Buffer.allocUnsafe(chunkLen)
        readFd(fd, buf, 0, chunkLen, pos, (err, bytesRead) => {
          if (err) {
            this.destroy(err)
            return
          }
          if (bytesRead <= 0) {
            this.push(null)
            return
          }
          pos += bytesRead
          this.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
        })
      }
    })
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void
  ): void {
    if (length === 0) {
      setImmediate(() => callback(null, 0))
      return
    }
    readFd(this.fd, buffer, offset, length, position, (err, bytesRead) => {
      if (err) {
        callback(err)
        return
      }
      callback(null, bytesRead)
    })
  }

  override close(callback: (err: Error | null) => void): void {
    if (this.closed) {
      setImmediate(() => callback(null))
      return
    }
    this.closed = true
    closeFd(this.fd, (err) => callback(err ?? null))
  }
}

function openZipFile(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    let fd: number
    let totalSize: number
    try {
      fd = openSync(zipPath, 'r')
      totalSize = fstatSync(fd).size
    } catch (err) {
      rejectZip(err instanceof Error ? err : new Error(String(err)))
      return
    }

    const reader = new RawFileRandomAccessReader(fd)
    yauzl.fromRandomAccessReader(reader, totalSize, { lazyEntries: true, autoClose: true }, (err, zipFile) => {
      if (err || !zipFile) {
        try {
          closeFd(fd, () => {})
        } catch {
          // ignore
        }
        rejectZip(err || new Error('Failed to open zip file.'))
        return
      }
      resolveZip(zipFile)
    })
  })
}

function openEntryReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        rejectStream(err || new Error(`Failed to read zip entry: ${entry.fileName}`))
        return
      }
      resolveStream(stream)
    })
  })
}

function unwrapSingleNestedRootIfNeeded(destinationDir: string, expectedExecutableName: string): void {
  if (existsSync(join(destinationDir, expectedExecutableName))) {
    return
  }

  const entries = readdirSync(destinationDir, { withFileTypes: true })
  if (entries.length !== 1 || !entries[0].isDirectory()) {
    return
  }

  const nestedRoot = join(destinationDir, entries[0].name)
  if (!existsSync(join(nestedRoot, expectedExecutableName))) {
    return
  }

  const nestedChildren = readdirSync(nestedRoot)
  for (const childName of nestedChildren) {
    renameSync(join(nestedRoot, childName), join(destinationDir, childName))
  }
  rmSync(nestedRoot, { recursive: true, force: true })
}

export async function extractWindowsUpdateZip(options: ExtractWindowsZipOptions): Promise<{ extractedFiles: number }> {
  const { zipPath, destinationDir, expectedExecutableName } = options

  rmSync(destinationDir, { recursive: true, force: true })
  mkdirSync(destinationDir, { recursive: true })

  const zipFile = await openZipFile(zipPath)
  let extractedFiles = 0

  await new Promise<void>((resolveDone, rejectDone) => {
    let settled = false
    const finishError = (err: unknown) => {
      if (settled) return
      settled = true
      try {
        zipFile.close()
      } catch {
        // ignore close errors on abort
      }
      rejectDone(err instanceof Error ? err : new Error(String(err)))
    }

    zipFile.on('error', finishError)
    zipFile.on('end', () => {
      if (settled) return
      settled = true
      resolveDone()
    })

    zipFile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          const safeRelativePath = isSafeRelativeZipEntry(entry.fileName)
          const outputPath = resolve(destinationDir, safeRelativePath)
          if (!isInsideDirectory(destinationDir, outputPath)) {
            throw new Error(`Zip entry escaped destination directory: ${entry.fileName}`)
          }

          const isDirectory = /[/\\]$/.test(entry.fileName)
          if (isDirectory) {
            mkdirSync(outputPath, { recursive: true })
          } else {
            mkdirSync(dirname(outputPath), { recursive: true })
            const readStream = await openEntryReadStream(zipFile, entry)
            const writeStream = createWriteStream(outputPath)
            await pipeline(readStream, writeStream)
            extractedFiles += 1
          }

          if (!settled) {
            zipFile.readEntry()
          }
        } catch (err) {
          finishError(err)
        }
      })()
    })

    zipFile.readEntry()
  })

  unwrapSingleNestedRootIfNeeded(destinationDir, expectedExecutableName)

  const expectedExePath = join(destinationDir, expectedExecutableName)
  if (!existsSync(expectedExePath)) {
    throw new Error(`Extracted Windows update archive is missing expected executable: ${expectedExecutableName}`)
  }

  return { extractedFiles }
}
