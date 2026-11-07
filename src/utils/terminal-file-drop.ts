/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TerminalShellKind } from './terminal-command'

export const INTERNAL_DRAG_MIME_TYPES: readonly string[] = [
  'application/x-onward-quick-file'
]

type EffectiveShellFamily = 'posix' | 'powershell' | 'cmd'

const CONTROL_OR_WHITESPACE_RE = /[\s\u0000-\u001f\u007f]/
const LEADING_UNSAFE_RE = /^[-~\u2013\u2014\u2015]/
const POSIX_UNSAFE_RE = /[\\'"`$;&|<>()*?[\]{}!#^%~=,@]/
// PowerShell treats Unicode curly single/double quotes (U+2018..U+201F) as
// quote delimiters in its tokenizer, so they must be quoted and doubled.
const POWERSHELL_UNSAFE_RE = /['"`\u2018-\u201f$;&|<>()*?[\]{}!#^%~=,@]/
const POWERSHELL_SINGLE_QUOTE_RE = /['\u2018\u2019\u201a\u201b]/g
const CMD_UNSAFE_RE = /["'`;&|<>()*?[\]{}!^%=,@]/

export function resolveEffectiveShellFamily(
  platform: string,
  shellKind?: TerminalShellKind
): EffectiveShellFamily {
  if (shellKind === 'cmd') return 'cmd'
  if (shellKind === 'powershell') return 'powershell'
  if (shellKind === 'posix') return 'posix'
  return platform === 'win32' ? 'powershell' : 'posix'
}

/**
 * Returns true only when the drag event carries external OS files (`Files`)
 * and is not an internal Onward drag gesture.
 */
export function hasExternalFilesInDataTransfer(
  dataTransfer: { types?: readonly string[] | ArrayLike<string> | null } | null | undefined,
  internalMimeTypes: readonly string[] = INTERNAL_DRAG_MIME_TYPES
): boolean {
  if (!dataTransfer?.types) return false
  const types = Array.from(dataTransfer.types)
  if (types.length === 0) return false
  for (const internalType of internalMimeTypes) {
    if (types.includes(internalType)) return false
  }
  return types.includes('Files')
}

/**
 * Parses an RFC 2483 `text/uri-list` payload (used by Linux X11/Wayland file
 * managers and macOS/Windows drag sources) into local filesystem paths.
 * Non-`file:` URIs and `#` comment lines are ignored.
 */
export function parseFileUriList(uriListText: string, platform: string): string[] {
  if (!uriListText) return []
  const results: string[] = []
  for (const rawLine of uriListText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (!/^file:\/\//i.test(line)) continue
    try {
      const url = new URL(line)
      if (url.protocol !== 'file:') continue
      const decodedPathname = decodeURIComponent(url.pathname)
      if (platform === 'win32') {
        if (url.host && url.host.toLowerCase() !== 'localhost') {
          results.push(`\\\\${url.host}${decodedPathname.replace(/\//g, '\\')}`)
        } else {
          const stripped = decodedPathname.replace(/^\/+([A-Za-z]:)/, '$1')
          results.push(stripped.replace(/\//g, '\\'))
        }
      } else {
        results.push(decodedPathname)
      }
    } catch {
      // Ignore malformed URI lines
    }
  }
  return results
}

/**
 * Synchronously extracts absolute filesystem paths from a dropped FileList.
 * Uses Electron preload's `webUtils.getPathForFile(file)` bridge first,
 * falls back to legacy/synthetic `file.path`, and finally falls back to
 * `text/uri-list` (`file://`) for Linux Wayland/X11 file managers.
 */
export function extractDroppedFilePaths(
  files: ArrayLike<File> | Iterable<File> | null | undefined,
  resolvePath?: (file: File) => string,
  options?: { uriListText?: string; platform?: string }
): string[] {
  const paths: string[] = []
  if (files) {
    for (const file of Array.from(files)) {
      if (!file) continue
      let resolved = ''
      if (resolvePath) {
        try {
          resolved = resolvePath(file) || ''
        } catch {
          resolved = ''
        }
      }
      if (!resolved) {
        const fallback = (file as unknown as { path?: unknown }).path
        if (typeof fallback === 'string') {
          resolved = fallback
        }
      }
      if (typeof resolved === 'string' && resolved.length > 0) {
        paths.push(resolved)
      }
    }
  }
  if (paths.length === 0 && options?.uriListText) {
    return parseFileUriList(options.uriListText, options.platform ?? 'linux')
  }
  return paths
}

export function needsShellPathQuoting(
  filePath: string,
  platform: string,
  shellKind?: TerminalShellKind
): boolean {
  if (!filePath) return false
  if (LEADING_UNSAFE_RE.test(filePath)) return true
  if (CONTROL_OR_WHITESPACE_RE.test(filePath)) return true

  const family = resolveEffectiveShellFamily(platform, shellKind)
  if (family === 'posix') {
    return POSIX_UNSAFE_RE.test(filePath)
  }
  if (family === 'cmd') {
    return CMD_UNSAFE_RE.test(filePath)
  }
  return POWERSHELL_UNSAFE_RE.test(filePath)
}

export function formatDroppedFilePathForShell(
  filePath: string,
  platform: string,
  shellKind?: TerminalShellKind
): string {
  if (!filePath) return ''
  if (!needsShellPathQuoting(filePath, platform, shellKind)) {
    return filePath
  }

  const family = resolveEffectiveShellFamily(platform, shellKind)
  if (family === 'posix') {
    return "'" + filePath.replace(/'/g, "'\\''") + "'"
  }
  if (family === 'cmd') {
    // Double any embedded `"` and double trailing backslashes before the
    // closing `"` so Windows CommandLineToArgvW parsers do not treat `\"`
    // at the end of a directory path as an escaped quote.
    const escapedQuotes = filePath.replace(/"/g, '""')
    const safeTrailingSlashes = escapedQuotes.replace(/(\\+)$/, '$1$1')
    return `"${safeTrailingSlashes}"`
  }
  // PowerShell single-quoted literal: double both ASCII `'` and Unicode
  // curly single-quote characters (U+2018..U+201B) that PowerShell's lexer
  // treats as single-quote delimiters.
  return "'" + filePath.replace(POWERSHELL_SINGLE_QUOTE_RE, '$&$&') + "'"
}

/**
 * Formats one or more dropped filesystem paths for insertion into the terminal.
 * Multiple paths are space-separated with a single trailing space (macOS
 * Terminal convention) so the user can immediately type additional arguments
 * or press Enter.
 */
export function formatDroppedFilePathsForShell(
  filePaths: readonly string[],
  platform: string,
  shellKind?: TerminalShellKind
): string {
  const formatted = filePaths
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => formatDroppedFilePathForShell(p, platform, shellKind))
  if (formatted.length === 0) return ''
  return `${formatted.join(' ')} `
}
