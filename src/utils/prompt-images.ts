/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TerminalShellKind } from './terminal-command.ts'
import { formatDroppedFilePathForShell, parseFileUriList } from './terminal-file-drop.ts'

export type PromptAttachmentKind =
  | 'image'
  | 'video'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'code'
  | 'other'

export interface PromptImageAttachment {
  /** 1-based sequential index (1, 2, 3...) matching `#1` and `item-1.<ext>` */
  index: number
  /** Batch directory identifier under `<userData>/prompt-images/<batchId>/` */
  batchId: string
  /** Absolute filesystem path to `<userData>/prompt-images/<batchId>/item-<index>.<ext>` */
  path: string
  /** Image width in pixels (0 for non-image attachments) */
  width: number
  /** Image height in pixels (0 for non-image attachments) */
  height: number
  /** Timestamp (ms) of creation or last renumber for cache-busting `file://` URLs */
  updatedAt: number
  /** File extension with leading dot (e.g. `.png`, `.pdf`, `.mp4`, `.md`) */
  ext?: string
  /** Classified media kind for card & Lightbox rendering */
  mediaKind?: PromptAttachmentKind
  /** Original basename when pasted from a local file on disk */
  originalName?: string
}

export const PROMPT_IMAGE_GC_GRACE_MS = 5000

const BATCH_ID_RE = /^[a-zA-Z0-9_-]{4,80}$/
const IMAGE_TOKEN_RE = /(?<![A-Za-z0-9_.-])@(\d+)(?!\d)|\[(?:(?:Image|File|Attachment)\s*)?#(\d+)\]/gi
const MENTION_TRIGGER_RE = /(?:^|(?<![A-Za-z0-9_.-]))@(\d*)$/
const PROMPT_IMAGES_PATH_BATCH_RE = /[\\/]prompt-images[\\/]([a-zA-Z0-9_-]{4,80})[\\/]/g

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg'])
const PDF_EXTS = new Set(['.pdf'])
const HTML_EXTS = new Set(['.html', '.htm'])
const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx'])
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.ps1', '.sql', '.json', '.yaml', '.yml',
  '.toml', '.xml', '.css', '.scss', '.less', '.vue', '.svelte', '.txt', '.log', '.ini', '.env', '.csv'
])

export function isValidPromptImageBatchId(value: unknown): value is string {
  return typeof value === 'string' && BATCH_ID_RE.test(value)
}

export function createPromptImageBatchId(now = Date.now(), randomSuffix?: string): string {
  const timePart = Math.max(0, Math.floor(now)).toString(36)
  const suffix = (randomSuffix ?? Math.random().toString(36).slice(2, 10))
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 12) || '0000'
  return `p-${timePart}-${suffix}`
}

export function normalizePromptAttachmentExt(rawExtOrPath?: string): string {
  if (!rawExtOrPath || typeof rawExtOrPath !== 'string') return '.png'
  const trimmed = rawExtOrPath.trim()
  if (!trimmed) return '.png'
  if (trimmed.startsWith('.') && /^[.][a-zA-Z0-9]{1,16}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  const base = trimmed.split(/[\\/]/).pop() ?? ''
  const dotIdx = base.lastIndexOf('.')
  if (dotIdx <= 0 || dotIdx === base.length - 1) {
    return '.bin'
  }
  const ext = base.slice(dotIdx).toLowerCase()
  return /^[.][a-zA-Z0-9]{1,16}$/.test(ext) ? ext : '.bin'
}

export function inferPromptAttachmentKind(extOrPath?: string): PromptAttachmentKind {
  const ext = normalizePromptAttachmentExt(extOrPath)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (PDF_EXTS.has(ext)) return 'pdf'
  if (HTML_EXTS.has(ext)) return 'html'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (CODE_EXTS.has(ext)) return 'code'
  return 'other'
}

export function formatPromptImageFilename(index: number, extOrPath = '.png'): string {
  const safeIndex = Math.max(1, Math.floor(index))
  const ext = normalizePromptAttachmentExt(extOrPath)
  return `item-${safeIndex}${ext}`
}

export function formatPromptImageToken(index: number): string {
  return `@${Math.max(1, Math.floor(index))}`
}

export interface PromptMentionTrigger {
  /** 0-based index of the `@` character in the editor text */
  startOffset: number
  /** 0-based caret index right after `@<query>` */
  endOffset: number
  /** Digit query typed after `@` (empty string immediately after typing `@`) */
  query: string
  /** Matching attachments for the current query */
  candidates: PromptImageAttachment[]
}

/**
 * Detects whether the caret in the Prompt Editor is currently positioned at an
 * `@` attachment mention trigger (e.g. `@` or `@1`) and returns matching attachment
 * candidates.
 *
 * Rules:
 * - Only triggers when `images` has at least 1 attachment.
 * - `@` must be at the start of text or preceded by a non-ASCII-identifier character
 *   (whitespace, newline, punctuation, or CJK character), avoiding false positives on
 *   email addresses like `user@example.com`.
 */
export function detectPromptMentionTrigger(
  text: string,
  caretOffset: number,
  images: readonly PromptImageAttachment[] | undefined | null
): PromptMentionTrigger | null {
  if (!images || images.length === 0 || !text) return null
  const caret = Math.max(0, Math.min(caretOffset, text.length))
  if (caret === 0) return null
  // Do not trigger inside the middle of a multi-digit number
  if (caret < text.length && /\d/.test(text[caret])) {
    return null
  }
  // Inspect only a small O(1) trailing window before the caret so large drafts
  // (e.g. 78 KB) never allocate a large substring on keystrokes.
  const windowStart = Math.max(0, caret - 16)
  const beforeCaretWindow = text.slice(windowStart, caret)
  const match = MENTION_TRIGGER_RE.exec(beforeCaretWindow)
  if (!match) return null
  const query = match[1] ?? ''
  const startOffset = caret - match[0].length
  const candidates = images.filter((img) => (
    img &&
    img.index >= 1 &&
    (query === '' || String(img.index).startsWith(query))
  ))
  if (candidates.length === 0) return null
  return {
    startOffset,
    endOffset: caret,
    query,
    candidates
  }
}

/**
 * Replaces the active `@<query>` mention range with `@<index> ` (adding a trailing
 * space unless one is already present) and returns the new text and caret offset.
 */
export function applyPromptMentionCandidate(
  text: string,
  trigger: Pick<PromptMentionTrigger, 'startOffset' | 'endOffset'>,
  index: number
): { nextText: string; nextCaret: number } {
  const token = formatPromptImageToken(index)
  const start = Math.max(0, Math.min(trigger.startOffset, text.length))
  const end = Math.max(start, Math.min(trigger.endOffset, text.length))
  const before = text.slice(0, start)
  const after = text.slice(end)
  if (after.startsWith(' ')) {
    const nextText = `${before}${token}${after}`
    return {
      nextText,
      nextCaret: start + token.length + 1
    }
  }
  const inserted = `${token} `
  return {
    nextText: `${before}${inserted}${after}`,
    nextCaret: start + inserted.length
  }
}

export function toPromptImageFileUrl(filePath: string, cacheKey?: number | string): string {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\/g, '/')
  let pathname = normalized
  if (/^[A-Za-z]:\//.test(pathname)) {
    pathname = `/${pathname}`
  } else if (!pathname.startsWith('/')) {
    pathname = `/${pathname}`
  }
  const encoded = pathname
    .split('/')
    .map((segment, idx) => {
      if (idx === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join('/')
  const suffix = cacheKey !== undefined && cacheKey !== '' ? `?v=${encodeURIComponent(String(cacheKey))}` : ''
  return `file://${encoded}${suffix}`
}

export function normalizePromptImageAttachments(raw: unknown): PromptImageAttachment[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const valid: PromptImageAttachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<PromptImageAttachment>
    if (
      typeof candidate.index !== 'number' ||
      !Number.isInteger(candidate.index) ||
      candidate.index < 1 ||
      !isValidPromptImageBatchId(candidate.batchId) ||
      typeof candidate.path !== 'string' ||
      candidate.path.length === 0
    ) {
      continue
    }
    const ext = normalizePromptAttachmentExt(candidate.ext || candidate.path)
    const mediaKind = candidate.mediaKind ?? inferPromptAttachmentKind(ext)
    valid.push({
      index: candidate.index,
      batchId: candidate.batchId,
      path: candidate.path,
      width: typeof candidate.width === 'number' && Number.isFinite(candidate.width) && candidate.width > 0
        ? Math.round(candidate.width)
        : 0,
      height: typeof candidate.height === 'number' && Number.isFinite(candidate.height) && candidate.height > 0
        ? Math.round(candidate.height)
        : 0,
      updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : 0,
      ext,
      mediaKind,
      ...(typeof candidate.originalName === 'string' && candidate.originalName.trim()
        ? { originalName: candidate.originalName.trim() }
        : {})
    })
  }
  valid.sort((a, b) => a.index - b.index)
  return valid.map((item, idx) => ({
    ...item,
    index: idx + 1
  }))
}

/**
 * Updates `@k` (and legacy `[#k]` / `[Image #k]` / `[File #k]`) references in the
 * prompt editor text when attachment `#removedIndex` is deleted:
 * - Removes `@<removedIndex>` (collapsing duplicate horizontal spaces around it).
 * - Renumbers `@<k>` -> `@<k - 1>` for all `k > removedIndex`.
 */
export function renumberPromptTextAfterImageRemove(content: string, removedIndex: number): string {
  if (!content || removedIndex < 1) return content
  let hadRemovedToken = false
  const replaced = content.replace(IMAGE_TOKEN_RE, (fullMatch, atDigits?: string, bracketDigits?: string) => {
    const digits = atDigits ?? bracketDigits ?? ''
    const num = Number.parseInt(digits, 10)
    if (!Number.isFinite(num) || num < 1) return fullMatch
    if (num === removedIndex) {
      hadRemovedToken = true
      return ''
    }
    if (num > removedIndex) {
      return formatPromptImageToken(num - 1)
    }
    return formatPromptImageToken(num)
  })
  if (!hadRemovedToken) return replaced
  // Collapse multiple horizontal spaces created by removing a token on the same line,
  // while preserving leading indentation and line breaks.
  return replaced
    .split('\n')
    .map((line) => {
      const leadingMatch = line.match(/^[ \t]*/)
      const leading = leadingMatch ? leadingMatch[0] : ''
      const rest = line.slice(leading.length).replace(/ {2,}/g, ' ').trimEnd()
      return rest ? `${leading}${rest}` : ''
    })
    .join('\n')
}

/**
 * Pure helper that removes `removedIndex` from `images` and renumbers remaining
 * attachments sequentially `1..N`, updating their `item-<k>.<ext>` filenames.
 */
export function renumberPromptImageAttachmentsAfterRemove(
  images: readonly PromptImageAttachment[],
  removedIndex: number,
  now = Date.now()
): PromptImageAttachment[] {
  if (!images || images.length === 0) return []
  const filtered = images.filter((img) => img.index !== removedIndex)
  return filtered.map((img, idx) => {
    const nextIndex = idx + 1
    const ext = normalizePromptAttachmentExt(img.ext || img.path)
    const mediaKind = img.mediaKind ?? inferPromptAttachmentKind(ext)
    if (nextIndex === img.index) {
      return {
        ...img,
        ext,
        mediaKind
      }
    }
    const nextFilename = formatPromptImageFilename(nextIndex, ext)
    const nextPath = img.path.replace(/([\\/])(?:item|image)-\d+\.[a-zA-Z0-9]+$/i, `$1${nextFilename}`)
    return {
      ...img,
      index: nextIndex,
      path: nextPath,
      ext,
      mediaKind,
      updatedAt: now
    }
  })
}

/**
 * Resolves the prompt text + attached items into the final payload string sent to
 * target Task terminals:
 * 1. Replaces any explicit `@k` (or legacy `[#k]` / `[Image #k]` / `[File #k]`) token
 *    with the shell-formatted path of attachment `#k`.
 * 2. Appends the shell-formatted paths of any attached items that were not explicitly
 *    referenced via token at the end of the text.
 */
export function buildPromptContentWithImagesForSend(
  content: string,
  images: readonly PromptImageAttachment[] | undefined | null,
  platform: string,
  shellKind?: TerminalShellKind,
  options?: { appendUnreferenced?: boolean }
): string {
  if (!images || images.length === 0) {
    return content
  }
  const byIndex = new Map<number, PromptImageAttachment>()
  for (const img of images) {
    if (img && img.index >= 1 && img.path) {
      byIndex.set(img.index, img)
    }
  }
  if (byIndex.size === 0) {
    return content
  }

  const referencedIndices = new Set<number>()
  const resolvedText = content.replace(
    IMAGE_TOKEN_RE,
    (fullMatch, atDigits?: string, bracketDigits?: string, offset?: number, source?: string) => {
      const digits = atDigits ?? bracketDigits ?? ''
      const idx = Number.parseInt(digits, 10)
      const target = byIndex.get(idx)
      if (!target) return fullMatch
      referencedIndices.add(idx)
      const formattedPath = formatDroppedFilePathForShell(target.path, platform, shellKind)
      if (typeof offset === 'number' && typeof source === 'string') {
        const prevChar = offset > 0 ? source[offset - 1] : ''
        const endOffset = offset + fullMatch.length
        const nextChar = endOffset < source.length ? source[endOffset] : ''
        const needLeadingSpace = Boolean(prevChar && !/\s/.test(prevChar) && !/[(\[{'"“‘]/.test(prevChar))
        const needTrailingSpace = Boolean(nextChar && !/\s/.test(nextChar) && !/[)\]}.,;:!?'"”’，。；：！？、]/.test(nextChar))
        return `${needLeadingSpace ? ' ' : ''}${formattedPath}${needTrailingSpace ? ' ' : ''}`
      }
      return formattedPath
    }
  )

  if (options?.appendUnreferenced === false) {
    return resolvedText
  }

  const unreferencedPaths: string[] = []
  for (const img of images) {
    if (!referencedIndices.has(img.index) && img.path) {
      const formatted = formatDroppedFilePathForShell(img.path, platform, shellKind)
      if (formatted) unreferencedPaths.push(formatted)
    }
  }

  if (unreferencedPaths.length === 0) {
    return resolvedText
  }

  const suffix = unreferencedPaths.join(' ')
  if (!resolvedText.trim()) {
    return suffix
  }
  const needsSpace = !/\s$/.test(resolvedText)
  return `${resolvedText}${needsSpace ? ' ' : ''}${suffix}`
}

export type PromptEditorPasteDecision =
  | { kind: 'files'; paths: string[] }
  | { kind: 'native-probe' }
  | { kind: 'image' }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

/**
 * Determines how a paste gesture (`Ctrl+V` / `Cmd+V`) in the Prompt Editor should be handled:
 * 1. Copied local files/folders on disk (`droppedFilePaths` non-empty) ->
 *    regular files are copied into `<batchId>/item-<k>.<ext>` in the top attachment bar,
 *    while directories are inserted as formatted paths into the editor text.
 * 2. OS file-clipboard indicator (`hasFilesType === true`) when Chromium's `DataTransfer.files`
 *    did not expose the non-image file or directory (common on macOS Finder `NSFilenamesPboardType`
 *    and Windows Explorer `CF_HDROP` for folders/non-images) -> `native-probe` delegates to
 *    the main-process native clipboard reader, which falls back to image/text if no disk files exist.
 * 3. Pure clipboard image (`!clipboardText && hasImage`) -> save as `item-<k>.png` in top bar.
 * 4. Plain or rich text (`clipboardText` non-empty, even if accompanied by image preview) -> paste text.
 */
export function decidePromptEditorPasteAction(input: {
  droppedFilePaths: readonly string[]
  clipboardText: string
  hasImage: boolean
  hasFilesType?: boolean
}): PromptEditorPasteDecision {
  const validPaths = input.droppedFilePaths.filter((p) => typeof p === 'string' && p.length > 0)
  if (validPaths.length > 0) {
    return { kind: 'files', paths: validPaths }
  }
  if (!input.clipboardText && input.hasImage) {
    return { kind: 'image' }
  }
  if (input.hasFilesType) {
    return { kind: 'native-probe' }
  }
  if (input.clipboardText) {
    return { kind: 'text', text: input.clipboardText }
  }
  return { kind: 'empty' }
}

function unescapeXmlEntities(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/**
 * Parses macOS Finder's `NSFilenamesPboardType` XML property list into POSIX paths.
 */
export function parseMacOsFilenamesPlist(plistXml: string): string[] {
  if (!plistXml || typeof plistXml !== 'string') return []
  const results: string[] = []
  const stringTagRe = /<string>([\s\S]*?)<\/string>/gi
  let match: RegExpExecArray | null
  while ((match = stringTagRe.exec(plistXml)) !== null) {
    const raw = unescapeXmlEntities(match[1].trim())
    if (raw.startsWith('/')) {
      results.push(raw)
    }
  }
  return results
}

/**
 * Parses a Windows `FileNameW` clipboard buffer (UTF-16LE null-terminated path).
 */
export function parseWindowsFileNameWBuffer(buf: Uint8Array | null | undefined): string[] {
  if (!buf || buf.byteLength < 2) return []
  const evenLen = buf.byteLength - (buf.byteLength % 2)
  const decoder = new TextDecoder('utf-16le')
  const decoded = decoder.decode(buf.subarray(0, evenLen))
  return decoded
    .split('\0')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)))
}

/**
 * Parses a Windows `CF_HDROP` (`DROPFILES`) clipboard buffer into a list of file/folder paths.
 * Layout: 20-byte header (`DWORD pFiles` at offset 0, `BOOL fWide` at offset 16) followed at
 * byte offset `pFiles` by a double-null-terminated sequence of UTF-16LE (`fWide != 0`) or
 * ANSI/Latin1 (`fWide == 0`) paths.
 */
export function parseWindowsDropFilesBuffer(buf: Uint8Array | null | undefined): string[] {
  if (!buf || buf.byteLength < 22) return []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const pFiles = view.getUint32(0, true)
  const fWide = view.getUint32(16, true)
  if (pFiles < 20 || pFiles >= buf.byteLength) return []
  const payload = buf.subarray(pFiles)
  const rawEntries: string[] = []
  if (fWide !== 0) {
    const evenLen = payload.byteLength - (payload.byteLength % 2)
    const decoded = new TextDecoder('utf-16le').decode(payload.subarray(0, evenLen))
    for (const part of decoded.split('\0')) {
      if (!part) break
      rawEntries.push(part.trim())
    }
  } else {
    const decoded = new TextDecoder('latin1').decode(payload)
    for (const part of decoded.split('\0')) {
      if (!part) break
      rawEntries.push(part.trim())
    }
  }
  return rawEntries.filter((s) => s.length > 0 && (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)))
}

/**
 * Parses Linux `x-special/gnome-copied-files` (or `x-special/mate-copied-files`)
 * clipboard payload (`copy\nfile:///path/to/a\nfile:///path/to/b`) into POSIX paths.
 */
export function parseLinuxGnomeCopiedFiles(rawText: string): string[] {
  if (!rawText || typeof rawText !== 'string') return []
  return parseFileUriList(rawText, 'linux')
}

export interface NativeClipboardFileReader {
  availableFormats: () => readonly string[]
  readText: (format: string) => string
  readBuffer: (format: string) => Uint8Array
}

/**
 * Cross-platform native clipboard file-path extractor for macOS (`darwin`),
 * Windows (`win32`), and Linux (`linux`).
 *
 * Used by main-process `pastePromptClipboard` when the renderer does not already
 * have resolved `DataTransfer.files` paths (e.g., copying non-image files or folders
 * in Finder / Explorer, or pasting via the Right-Click Context Menu).
 */
export function extractClipboardFilePathsFromNative(
  reader: NativeClipboardFileReader,
  platform: string
): string[] {
  const seen = new Set<string>()
  const addAll = (items: readonly string[]) => {
    for (const item of items) {
      const trimmed = item.trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
      }
    }
  }

  let formats: readonly string[] = []
  try {
    formats = reader.availableFormats() ?? []
  } catch {
    formats = []
  }
  const formatLowerSet = new Set(formats.map((f) => f.toLowerCase()))

  if (platform === 'darwin') {
    for (const fmt of ['NSFilenamesPboardType', 'dyn.ah62d4rv4gu8y6y4grf0gn5xbrzw1gydcr7u1e3cytf2gn']) {
      try {
        const xml = reader.readText(fmt) || new TextDecoder('utf8').decode(reader.readBuffer(fmt))
        if (xml && xml.includes('<string>')) {
          addAll(parseMacOsFilenamesPlist(xml))
        }
      } catch {
        // Ignore unsupported format
      }
    }
    if (seen.size === 0) {
      for (const fmt of ['public.file-url', 'text/uri-list']) {
        try {
          const uriText = reader.readText(fmt) || new TextDecoder('utf8').decode(reader.readBuffer(fmt))
          if (uriText && uriText.includes('file://')) {
            addAll(parseFileUriList(uriText, 'darwin'))
          }
        } catch {
          // Ignore unsupported format
        }
      }
    }
  } else if (platform === 'win32') {
    for (const fmt of ['CF_HDROP', 'Shell IDList Array']) {
      if (fmt === 'CF_HDROP') {
        try {
          const buf = reader.readBuffer('CF_HDROP')
          if (buf && buf.byteLength >= 22) {
            addAll(parseWindowsDropFilesBuffer(buf))
          }
        } catch {
          // Ignore unsupported format
        }
      }
    }
    if (seen.size === 0) {
      for (const fmt of ['FileNameW', 'UniformResourceLocatorW']) {
        try {
          const buf = reader.readBuffer(fmt)
          if (buf && buf.byteLength >= 2) {
            if (fmt === 'FileNameW') {
              addAll(parseWindowsFileNameWBuffer(buf))
            } else {
              const uriText = new TextDecoder('utf-16le').decode(buf).split('\0')[0] ?? ''
              if (uriText.startsWith('file://')) {
                addAll(parseFileUriList(uriText, 'win32'))
              }
            }
          }
        } catch {
          // Ignore unsupported format
        }
      }
    }
    if (seen.size === 0 && formatLowerSet.has('text/uri-list')) {
      try {
        const uriText = reader.readText('text/uri-list') || new TextDecoder('utf8').decode(reader.readBuffer('text/uri-list'))
        if (uriText && uriText.includes('file://')) {
          addAll(parseFileUriList(uriText, 'win32'))
        }
      } catch {
        // Ignore
      }
    }
  } else {
    for (const fmt of ['x-special/gnome-copied-files', 'x-special/mate-copied-files', 'text/uri-list']) {
      try {
        const text = reader.readText(fmt) || new TextDecoder('utf8').decode(reader.readBuffer(fmt))
        if (text && text.includes('file://')) {
          addAll(parseLinuxGnomeCopiedFiles(text))
        }
      } catch {
        // Ignore
      }
    }
  }

  return Array.from(seen)
}

/**
 * Computes the resulting string and caret position when inserting text into the
 * Prompt Editor at the active (or last-known pre-blur) selection, or appending at
 * the end when the editor has not been focused yet.
 */
export function computePromptEditorTextInsertion(
  currentText: string,
  selection: { start: number; end: number } | null | undefined,
  insertText: string
): { nextText: string; nextCaret: number } {
  if (!insertText) {
    const fallbackCaret = selection
      ? Math.max(0, Math.min(selection.end, currentText.length))
      : currentText.length
    return { nextText: currentText, nextCaret: fallbackCaret }
  }
  if (!selection) {
    const nextText = currentText + insertText
    return { nextText, nextCaret: nextText.length }
  }
  const start = Math.max(0, Math.min(selection.start, currentText.length))
  const end = Math.max(start, Math.min(selection.end, currentText.length))
  const nextText = currentText.slice(0, start) + insertText + currentText.slice(end)
  return {
    nextText,
    nextCaret: start + insertText.length
  }
}

interface PromptLikeWithImages {
  batchId?: string
  content?: string
  images?: ReadonlyArray<{ batchId?: string; path?: string }>
}

export interface AppStateLikeForPromptImageGc {
  globalPrompts?: ReadonlyArray<PromptLikeWithImages>
  tabs?: ReadonlyArray<{
    localPrompts?: ReadonlyArray<PromptLikeWithImages>
    editorDraft?: PromptLikeWithImages | null
  }>
}

function collectFromPromptLike(item: PromptLikeWithImages | null | undefined, out: Set<string>): void {
  if (!item) return
  if (isValidPromptImageBatchId(item.batchId)) {
    out.add(item.batchId)
  }
  if (Array.isArray(item.images)) {
    for (const img of item.images) {
      if (img && isValidPromptImageBatchId(img.batchId)) {
        out.add(img.batchId)
      }
      if (img && typeof img.path === 'string') {
        PROMPT_IMAGES_PATH_BATCH_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = PROMPT_IMAGES_PATH_BATCH_RE.exec(img.path)) !== null) {
          if (isValidPromptImageBatchId(match[1])) {
            out.add(match[1])
          }
        }
      }
    }
  }
  if (typeof item.content === 'string' && item.content.includes('prompt-images')) {
    PROMPT_IMAGES_PATH_BATCH_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PROMPT_IMAGES_PATH_BATCH_RE.exec(item.content)) !== null) {
      if (isValidPromptImageBatchId(match[1])) {
        out.add(match[1])
      }
    }
  }
}

/**
 * Scans `globalPrompts`, `tabs[*].localPrompts`, and `tabs[*].editorDraft` to find
 * every `batchId` that is still referenced by at least one saved prompt or draft.
 */
export function collectReferencedPromptImageBatchIds(
  state: AppStateLikeForPromptImageGc | null | undefined
): Set<string> {
  const referenced = new Set<string>()
  if (!state) return referenced
  if (Array.isArray(state.globalPrompts)) {
    for (const prompt of state.globalPrompts) {
      collectFromPromptLike(prompt, referenced)
    }
  }
  if (Array.isArray(state.tabs)) {
    for (const tab of state.tabs) {
      if (!tab) continue
      if (Array.isArray(tab.localPrompts)) {
        for (const prompt of tab.localPrompts) {
          collectFromPromptLike(prompt, referenced)
        }
      }
      collectFromPromptLike(tab.editorDraft, referenced)
    }
  }
  return referenced
}

/**
 * Given the batch directories on disk under `<userData>/prompt-images/` and the
 * set of referenced batchIds in `AppState`, returns the list of unreferenced
 * batchIds that are eligible for immediate deletion (respecting the short
 * `gracePeriodMs` window for newly pasted items awaiting the 300ms draft flush).
 */
export function selectUnreferencedPromptImageBatchesForGc(
  diskBatches: ReadonlyArray<{ batchId: string; mtimeMs: number }>,
  referencedBatchIds: ReadonlySet<string>,
  nowMs = Date.now(),
  gracePeriodMs = PROMPT_IMAGE_GC_GRACE_MS
): string[] {
  const toDelete: string[] = []
  for (const entry of diskBatches) {
    if (!isValidPromptImageBatchId(entry.batchId)) continue
    if (referencedBatchIds.has(entry.batchId)) continue
    const ageMs = nowMs - (Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0)
    if (ageMs < gracePeriodMs) continue
    toDelete.push(entry.batchId)
  }
  return toDelete
}
