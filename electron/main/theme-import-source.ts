/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import type { ThemeDefinition } from '../../src/types/theme'
import { parseThemeImport, resolveImportReference } from './theme-import-parser.ts'
import { ThemeImportError, THEME_IMPORT_LIMITS, importErrorCode, type ThemeImportLimits, type ThemeImportErrorCode, type ThemeImportTraceSink } from './theme-import-types.ts'
import { createThemeImportIoTrace, type ThemeImportIoTrace } from './theme-import-trace.ts'

async function readBoundedFile(path: string, maxBytes: number, io: ThemeImportIoTrace): Promise<string> {
  io.begin('file-read')
  const handle = await open(path, 'r')
  io.stats.filesOpened++
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new ThemeImportError('file-unreadable')
    if (info.size > maxBytes) throw new ThemeImportError('size-limit')
    const chunks: Buffer[] = []
    let length = 0
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - length + 1))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > maxBytes) throw new ThemeImportError('size-limit')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    io.begin('file-cleanup')
    try {
      await handle.close()
      io.stats.filesClosed++
    } catch (error) {
      io.stats.cleanupFailures++
      io.emit('file-cleanup-failed', { ok: false, code: importErrorCode(error) })
      throw error
    }
  }
}

function confinedPath(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '..' && !child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(child)
}

async function openArchive(path: string): Promise<ZipFile> {
  return new Promise((resolveArchive, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(new ThemeImportError('invalid-archive'))
      else resolveArchive(zip)
    })
  })
}

async function readArchive(path: string, limits: ThemeImportLimits, io: ThemeImportIoTrace): Promise<ThemeDefinition[]> {
  io.begin('archive-open')
  const info = await stat(path)
  if (!info.isFile()) throw new ThemeImportError('file-unreadable')
  if (info.size > limits.maxArchiveBytes) throw new ThemeImportError('size-limit')
  const zip = await openArchive(path)
  io.stats.archiveOpened = true
  const entries = new Map<string, Entry>()
  let archiveFailed = false
  let closingArchive = false
  const pendingFailures = new Set<() => void>()
  const onArchiveError = () => {
    archiveFailed = true
    if (closingArchive) io.stats.cleanupFailures++
    io.begin(closingArchive ? 'archive-cleanup-failed' : 'archive-error', { ok: false, code: 'invalid-archive' })
    for (const reject of pendingFailures) reject()
  }
  zip.on('error', onArchiveError)
  try {
    io.begin('archive-index')
    await new Promise<void>((resolveIndex, reject) => {
      let bytes = 0
      let count = 0
      const fail = () => reject(new ThemeImportError('invalid-archive'))
      pendingFailures.add(fail)
      zip.on('entry', (entry: Entry) => {
        try {
          if (archiveFailed) throw new ThemeImportError('invalid-archive')
          count++
          bytes += entry.uncompressedSize
          io.stats.entries++
          io.stats.archiveBytes += entry.uncompressedSize
          if (count > limits.maxArchiveEntries || bytes > limits.maxArchiveBytes) throw new ThemeImportError('size-limit')
          const directory = entry.fileName.endsWith('/')
          const name = resolveImportReference('_root_', directory ? entry.fileName.slice(0, -1) : entry.fileName)
          if (entries.has(name)) throw new ThemeImportError('duplicate-entry')
          // No archive entries are extracted, and symlinks are never followed.
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000 || entry.isEncrypted()) {
            throw new ThemeImportError('invalid-archive')
          }
          entries.set(name, entry)
          zip.readEntry()
        } catch (error) {
          pendingFailures.delete(fail)
          reject(error)
        }
      })
      zip.once('end', () => { pendingFailures.delete(fail); resolveIndex() })
      zip.readEntry()
    })
    io.begin('archive-indexed')
    if (!entries.has('extension/package.json')) throw new ThemeImportError('invalid-package')
    return await parseThemeImport('package.json', async (path, maxBytes) => {
      if (archiveFailed) throw new ThemeImportError('invalid-archive')
      const entry = entries.get('extension/' + path)
      if (!entry) throw new ThemeImportError('file-not-found')
      if (entry.fileName.endsWith('/')) throw new ThemeImportError('file-unreadable')
      if (entry.uncompressedSize > maxBytes) throw new ThemeImportError('size-limit')
      io.begin('stream-read')
      const text = await new Promise<string>((resolveText, reject) => {
        let stream: Readable | undefined
        let done = false
        const finish = (error?: ThemeImportError, value?: string) => {
          if (done) return
          done = true
          pendingFailures.delete(fail)
          if (error) {
            if (stream) {
              io.stats.streamsDestroyed++
              stream.destroy()
            }
            reject(error)
          } else resolveText(value ?? '')
        }
        const fail = () => finish(new ThemeImportError('invalid-archive'))
        pendingFailures.add(fail)
        zip.openReadStream(entry, (error, opened) => {
          if (opened) {
            io.stats.streamsOpened++
            opened.once('close', () => { io.stats.streamsClosed++ })
          }
          if (done) {
            if (opened) { io.stats.streamsDestroyed++; opened.destroy() }
            return
          }
          if (error || !opened) { fail(); return }
          stream = opened
          const chunks: Buffer[] = []
          let bytes = 0
          opened.on('error', fail)
          opened.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > maxBytes) finish(new ThemeImportError('size-limit'))
            else chunks.push(chunk)
          })
          opened.once('end', () => finish(undefined, Buffer.concat(chunks).toString('utf8')))
        })
      })
      return { text, identity: path }
    }, { package: true, limits, io })
  } finally {
    pendingFailures.clear()
    closingArchive = true
    io.begin('archive-cleanup')
    try {
      zip.close()
    } catch (error) {
      io.stats.cleanupFailures++
      io.emit('archive-cleanup-failed', { ok: false, code: importErrorCode(error, 'invalid-archive') })
      throw error
    }
    // Keep the error listener until close: fd-slicer can emit an asynchronous
    // close error after a stream has already failed and settled its promise.
    zip.once('close', () => {
      zip.removeListener('error', onArchiveError)
      io.stats.archiveClosed = true
      io.emit('archive-closed', { ok: io.stats.cleanupFailures === 0 })
    })
  }
}

/** Read-only worker entry surface; all filesystem and archive work stays off the UI threads. */
export async function importThemeFile(path: string, overrides: Partial<ThemeImportLimits> = {}, onTrace?: ThemeImportTraceSink): Promise<ThemeDefinition[]> {
  const limits = { ...THEME_IMPORT_LIMITS, ...overrides }
  const startedAt = performance.now()
  const io = createThemeImportIoTrace(onTrace, typeof path === 'string' && extname(path).toLowerCase() === '.vsix' ? 'vsix' : 'file')
  let ok = false
  let count = 0
  let code: ThemeImportErrorCode | undefined
  io.begin('source-start')
  try {
    const extension = extname(path).toLowerCase()
    if (!['.json', '.jsonc', '.vsix'].includes(extension)) throw new ThemeImportError('unsupported-format')
    let themes: ThemeDefinition[]
    if (extension === '.vsix') themes = await readArchive(path, limits, io)
    else {
      const selected = resolve(path)
      const root = await realpath(dirname(selected))
      themes = await parseThemeImport(basename(selected), async (reference, maxBytes) => {
        const resolved = await realpath(join(root, ...reference.split('/')))
        if (!confinedPath(root, resolved)) throw new ThemeImportError('path-outside-root')
        return {
          text: await readBoundedFile(resolved, maxBytes, io),
          identity: process.platform === 'win32' ? resolved.toLowerCase() : resolved
        }
      }, { limits, io })
    }
    ok = true
    count = themes.length
    return themes
  } catch (error) {
    code = importErrorCode(error)
    throw new ThemeImportError(code)
  } finally {
    io.emit('source-complete', { durationMs: performance.now() - startedAt, ok, count, code })
  }
}
