/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { createRequire } from 'module'
import { basename, join, resolve, sep } from 'path'
import {
  PROMPT_IMAGE_GC_GRACE_MS,
  collectReferencedPromptImageBatchIds,
  extractClipboardFilePathsFromNative,
  formatPromptImageFilename,
  inferPromptAttachmentKind,
  isValidPromptImageBatchId,
  normalizePromptAttachmentExt,
  normalizePromptImageAttachments,
  renumberPromptImageAttachmentsAfterRemove,
  selectUnreferencedPromptImageBatchesForGc,
  type AppStateLikeForPromptImageGc,
  type PromptImageAttachment
} from '../../src/utils/prompt-images.ts'
import { hasClipboardImage } from '../../src/terminal/terminal-clipboard.ts'

const requireElectron = createRequire(import.meta.url)
function getElectronModule(): typeof import('electron') {
  return requireElectron('electron') as typeof import('electron')
}

export function getPromptImagesRootDir(customRootDir?: string): string {
  return customRootDir ?? join(getElectronModule().app.getPath('userData'), 'prompt-images')
}

export function getPromptImageBatchDir(batchId: string, customRootDir?: string): string {
  if (!isValidPromptImageBatchId(batchId)) {
    throw new Error(`Invalid prompt image batchId: ${String(batchId)}`)
  }
  return join(getPromptImagesRootDir(customRootDir), batchId)
}

function touchBatchDir(batchDir: string): void {
  try {
    const now = new Date()
    utimesSync(batchDir, now, now)
  } catch {
    // Ignore utimes errors on filesystems that disallow directory utimes
  }
}

export interface PastePromptClipboardOptions {
  filePaths?: string[]
  autotestImage?: { width: number; height: number }
}

export interface PastePromptClipboardResult {
  ok: boolean
  kind: 'files' | 'image' | 'text' | 'empty' | 'error'
  text?: string
  attachment?: PromptImageAttachment
  attachments?: PromptImageAttachment[]
  directoryPaths?: string[]
  error?: string
}

export function savePngBufferToPromptImageBatch(
  batchId: string,
  index: number,
  pngBuffer: Buffer,
  dimensions: { width: number; height: number },
  customRootDir?: string
): PromptImageAttachment {
  if (!isValidPromptImageBatchId(batchId)) {
    throw new Error('Invalid batchId')
  }
  const safeIndex = Math.max(1, Math.min(100, Math.floor(index)))
  const batchDir = getPromptImageBatchDir(batchId, customRootDir)
  mkdirSync(batchDir, { recursive: true })
  const filename = formatPromptImageFilename(safeIndex, '.png')
  const filePath = join(batchDir, filename)
  writeFileSync(filePath, pngBuffer)
  touchBatchDir(batchDir)
  return {
    index: safeIndex,
    batchId,
    path: filePath,
    width: Math.max(0, Math.round(dimensions.width || 0)),
    height: Math.max(0, Math.round(dimensions.height || 0)),
    updatedAt: Date.now(),
    ext: '.png',
    mediaKind: 'image'
  }
}

export function copyFilesToPromptImageBatch(
  batchId: string,
  startIndex: number,
  sourcePaths: readonly string[],
  customRootDir?: string
): { attachments: PromptImageAttachment[]; directoryPaths: string[] } {
  if (!isValidPromptImageBatchId(batchId)) {
    throw new Error('Invalid batchId')
  }
  const attachments: PromptImageAttachment[] = []
  const directoryPaths: string[] = []
  let currentIndex = Math.max(1, Math.floor(startIndex))
  const batchDir = getPromptImageBatchDir(batchId, customRootDir)
  let dirCreated = false

  for (const rawSourcePath of sourcePaths) {
    if (typeof rawSourcePath !== 'string' || !rawSourcePath.trim()) continue
    const sourcePath = rawSourcePath.trim()
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(sourcePath)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      directoryPaths.push(sourcePath)
      continue
    }
    if (!stat.isFile()) {
      continue
    }
    if (currentIndex > 100) {
      break
    }
    if (!dirCreated) {
      mkdirSync(batchDir, { recursive: true })
      dirCreated = true
    }
    const ext = normalizePromptAttachmentExt(sourcePath)
    const mediaKind = inferPromptAttachmentKind(ext)
    const filename = formatPromptImageFilename(currentIndex, ext)
    const dstPath = join(batchDir, filename)
    try {
      if (resolve(sourcePath) !== resolve(dstPath)) {
        copyFileSync(sourcePath, dstPath)
      }
    } catch {
      continue
    }
    let width = 0
    let height = 0
    if (mediaKind === 'image') {
      try {
        const size = getElectronModule().nativeImage.createFromPath(dstPath).getSize()
        width = Math.max(0, Math.round(size.width || 0))
        height = Math.max(0, Math.round(size.height || 0))
      } catch {
        // Optional dimension probe when running outside Electron
      }
    }
    attachments.push({
      index: currentIndex,
      batchId,
      path: dstPath,
      width,
      height,
      updatedAt: Date.now(),
      ext,
      mediaKind,
      originalName: basename(sourcePath)
    })
    currentIndex += 1
  }

  if (dirCreated) {
    touchBatchDir(batchDir)
  }
  return { attachments, directoryPaths }
}

export function pastePromptClipboard(
  batchId: string,
  nextIndex: number,
  customRootDir?: string,
  options?: PastePromptClipboardOptions
): PastePromptClipboardResult {
  if (!isValidPromptImageBatchId(batchId) || !Number.isInteger(nextIndex) || nextIndex < 1 || nextIndex > 100) {
    return { ok: false, kind: 'error', error: 'invalid-arguments' }
  }
  try {
    const candidateFiles = Array.isArray(options?.filePaths)
      ? options!.filePaths.filter((p) => typeof p === 'string' && p.trim().length > 0)
      : []
    if (candidateFiles.length > 0) {
      const { attachments, directoryPaths } = copyFilesToPromptImageBatch(
        batchId,
        nextIndex,
        candidateFiles,
        customRootDir
      )
      if (attachments.length === 0 && directoryPaths.length === 0) {
        return { ok: true, kind: 'empty' }
      }
      return {
        ok: true,
        kind: 'files',
        attachment: attachments[0],
        attachments,
        directoryPaths
      }
    }

    const { clipboard, nativeImage } = getElectronModule()
    if (process.env.ONWARD_AUTOTEST === '1' && options?.autotestImage) {
      const reqW = Math.max(1, Math.round(options.autotestImage.width || 64))
      const reqH = Math.max(1, Math.round(options.autotestImage.height || 64))
      const bitmapW = 4
      const bitmapH = 4
      const rawBitmap = Buffer.alloc(bitmapW * bitmapH * 4, 0xcc)
      const pngBuffer = nativeImage.createFromBitmap(rawBitmap, { width: bitmapW, height: bitmapH }).toPNG()
      const attachment = savePngBufferToPromptImageBatch(
        batchId,
        nextIndex,
        pngBuffer,
        { width: reqW, height: reqH },
        customRootDir
      )
      return { ok: true, kind: 'image', attachment, attachments: [attachment] }
    }

    // Probe native OS clipboard file formats (macOS NSFilenamesPboardType / public.file-url,
    // Windows CF_HDROP / FileNameW, Linux x-special/gnome-copied-files / text/uri-list)
    // when the renderer did not receive resolved paths via DataTransfer.files (e.g.,
    // non-image files or folders copied in Finder/Explorer, or Right-Click -> Paste).
    const nativeFiles = extractClipboardFilePathsFromNative(
      {
        availableFormats: () => clipboard.availableFormats(),
        readText: (fmt) => clipboard.read(fmt),
        readBuffer: (fmt) => clipboard.readBuffer(fmt)
      },
      process.platform
    )
    if (nativeFiles.length > 0) {
      const { attachments, directoryPaths } = copyFilesToPromptImageBatch(
        batchId,
        nextIndex,
        nativeFiles,
        customRootDir
      )
      if (attachments.length > 0 || directoryPaths.length > 0) {
        return {
          ok: true,
          kind: 'files',
          attachment: attachments[0],
          attachments,
          directoryPaths
        }
      }
    }

    const text = clipboard.readText()
    const formats = clipboard.availableFormats()
    const hasImage = hasClipboardImage(formats)
    if (!text && hasImage) {
      const image = clipboard.readImage()
      if (!image.isEmpty()) {
        const size = image.getSize()
        const pngBuffer = image.toPNG()
        if (pngBuffer && pngBuffer.length > 0) {
          const attachment = savePngBufferToPromptImageBatch(
            batchId,
            nextIndex,
            pngBuffer,
            size,
            customRootDir
          )
          return { ok: true, kind: 'image', attachment, attachments: [attachment] }
        }
      }
    }
    if (text) {
      return { ok: true, kind: 'text', text }
    }
    return { ok: true, kind: 'empty' }
  } catch (error) {
    return { ok: false, kind: 'error', error: String(error) }
  }
}

export function removePromptImageFromBatchOnDisk(
  batchId: string,
  removedIndex: number,
  currentAttachments: readonly PromptImageAttachment[],
  customRootDir?: string
): PromptImageAttachment[] {
  if (!isValidPromptImageBatchId(batchId)) {
    return []
  }
  const normalized = normalizePromptImageAttachments(currentAttachments)
  const batchDir = getPromptImageBatchDir(batchId, customRootDir)
  if (existsSync(batchDir)) {
    const removedEntry = normalized.find((item) => item.index === removedIndex)
    const removedExt = normalizePromptAttachmentExt(removedEntry?.ext || removedEntry?.path || '.png')
    const candidateRemovedPaths = [
      removedEntry?.path,
      join(batchDir, formatPromptImageFilename(removedIndex, removedExt)),
      join(batchDir, `image-${removedIndex}${removedExt}`)
    ].filter((p): p is string => typeof p === 'string' && p.length > 0)
    for (const p of candidateRemovedPaths) {
      try {
        if (existsSync(p)) {
          unlinkSync(p)
        }
      } catch {
        // Ignore unlink race
      }
    }
    const sortedAfter = normalized
      .filter((item) => item.index > removedIndex)
      .sort((a, b) => a.index - b.index)
    for (const item of sortedAfter) {
      const ext = normalizePromptAttachmentExt(item.ext || item.path)
      const fromPath = existsSync(item.path)
        ? item.path
        : join(batchDir, formatPromptImageFilename(item.index, ext))
      const toPath = join(batchDir, formatPromptImageFilename(item.index - 1, ext))
      try {
        if (existsSync(fromPath) && fromPath !== toPath) {
          renameSync(fromPath, toPath)
        }
      } catch {
        // Ignore rename failure if already moved
      }
    }
    touchBatchDir(batchDir)
  }
  const now = Date.now()
  return renumberPromptImageAttachmentsAfterRemove(normalized, removedIndex, now).map((item) => {
    const ext = normalizePromptAttachmentExt(item.ext || item.path)
    return {
      ...item,
      batchId,
      ext,
      mediaKind: item.mediaKind ?? inferPromptAttachmentKind(ext),
      path: join(batchDir, formatPromptImageFilename(item.index, ext)),
      updatedAt: now
    }
  })
}

export function clonePromptImageBatchOnDisk(
  sourceBatchId: string,
  targetBatchId: string,
  sourceAttachments: readonly PromptImageAttachment[],
  customRootDir?: string
): PromptImageAttachment[] {
  if (!isValidPromptImageBatchId(sourceBatchId) || !isValidPromptImageBatchId(targetBatchId)) {
    return []
  }
  const normalized = normalizePromptImageAttachments(sourceAttachments)
  if (normalized.length === 0) return []
  const sourceDir = getPromptImageBatchDir(sourceBatchId, customRootDir)
  const targetDir = getPromptImageBatchDir(targetBatchId, customRootDir)
  mkdirSync(targetDir, { recursive: true })
  const now = Date.now()
  const cloned: PromptImageAttachment[] = []
  for (const item of normalized) {
    const ext = normalizePromptAttachmentExt(item.ext || item.path)
    const filename = formatPromptImageFilename(item.index, ext)
    const srcPath = existsSync(item.path) ? item.path : join(sourceDir, filename)
    const dstPath = join(targetDir, filename)
    try {
      if (existsSync(srcPath) && srcPath !== dstPath) {
        copyFileSync(srcPath, dstPath)
      }
    } catch {
      // Best-effort copy
    }
    cloned.push({
      ...item,
      batchId: targetBatchId,
      path: dstPath,
      ext,
      mediaKind: item.mediaKind ?? inferPromptAttachmentKind(ext),
      updatedAt: now
    })
  }
  touchBatchDir(targetDir)
  return cloned
}

export function readPromptAttachmentTextPreview(
  filePath: string,
  customRootDir?: string,
  maxBytes = 65536
): { ok: boolean; content?: string; truncated?: boolean; error?: string } {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { ok: false, error: 'invalid-path' }
  }
  try {
    const rootDir = resolve(getPromptImagesRootDir(customRootDir))
    const resolvedTarget = resolve(filePath)
    const rootWithSep = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`
    if (!resolvedTarget.startsWith(rootWithSep)) {
      return { ok: false, error: 'outside-prompt-images-root' }
    }
    if (!existsSync(resolvedTarget)) {
      return { ok: false, error: 'not-found' }
    }
    const stat = statSync(resolvedTarget)
    if (!stat.isFile()) {
      return { ok: false, error: 'not-a-file' }
    }
    const bytesToRead = Math.min(stat.size, Math.max(1024, maxBytes))
    const buf = Buffer.alloc(bytesToRead)
    const fd = openSync(resolvedTarget, 'r')
    let bytesRead = 0
    try {
      bytesRead = readSync(fd, buf, 0, bytesToRead, 0)
    } finally {
      closeSync(fd)
    }
    return {
      ok: true,
      content: buf.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > bytesRead
    }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export function gcUnreferencedPromptImageBatches(
  state: AppStateLikeForPromptImageGc | null | undefined,
  options?: {
    customRootDir?: string
    nowMs?: number
    gracePeriodMs?: number
  }
): { deletedBatchIds: string[]; keptBatchIds: string[] } {
  const rootDir = getPromptImagesRootDir(options?.customRootDir)
  if (!existsSync(rootDir)) {
    return { deletedBatchIds: [], keptBatchIds: [] }
  }
  const referenced = collectReferencedPromptImageBatchIds(state)
  const diskBatches: Array<{ batchId: string; mtimeMs: number }> = []
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const batchId = entry.name
      if (!isValidPromptImageBatchId(batchId)) continue
      const batchDir = join(rootDir, batchId)
      let latestMtimeMs = 0
      try {
        latestMtimeMs = statSync(batchDir).mtimeMs
        const children = readdirSync(batchDir)
        for (const child of children) {
          try {
            const childStat = statSync(join(batchDir, child))
            if (childStat.mtimeMs > latestMtimeMs) {
              latestMtimeMs = childStat.mtimeMs
            }
          } catch {
            // Ignore child stat race
          }
        }
      } catch {
        continue
      }
      diskBatches.push({ batchId, mtimeMs: latestMtimeMs })
    }
  } catch {
    return { deletedBatchIds: [], keptBatchIds: [] }
  }

  const toDelete = new Set(
    selectUnreferencedPromptImageBatchesForGc(
      diskBatches,
      referenced,
      options?.nowMs ?? Date.now(),
      options?.gracePeriodMs ?? PROMPT_IMAGE_GC_GRACE_MS
    )
  )

  const deletedBatchIds: string[] = []
  const keptBatchIds: string[] = []
  for (const { batchId } of diskBatches) {
    if (toDelete.has(batchId)) {
      try {
        rmSync(join(rootDir, batchId), { recursive: true, force: true })
        deletedBatchIds.push(batchId)
      } catch {
        keptBatchIds.push(batchId)
      }
    } else {
      keptBatchIds.push(batchId)
    }
  }
  return { deletedBatchIds, keptBatchIds }
}
