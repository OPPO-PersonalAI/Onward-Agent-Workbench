/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, normalize, resolve, sep } from 'path'
import { getAppInfo } from './app-info'

export type ChangelogLocale = 'en' | 'zh-CN'
export type ChangelogChannel = 'daily' | 'dev' | 'stable'
export type ChangelogReadReason = 'no-tag' | 'index-missing' | 'entry-missing' | 'file-missing' | 'invalid-index' | 'read-failed'

export interface ChangelogEntry {
  tag: string
  version: string
  channel: ChangelogChannel
  previousTag: string | null
  publishedAt: string | null
  markdown: {
    en: string
    'zh-CN'?: string
  }
  html?: {
    en: string
    'zh-CN'?: string
  }
}

interface ChangelogIndexFile {
  entries: ChangelogEntry[]
}

export interface CurrentChangelogResult {
  success: boolean
  locale: ChangelogLocale
  tag: string | null
  entry?: ChangelogEntry
  html?: string
  content?: string
  reason?: ChangelogReadReason
  error?: string
}

function normalizeLocale(value: string | null | undefined): ChangelogLocale {
  return value === 'zh-CN' ? 'zh-CN' : 'en'
}

function normalizeChannel(value: unknown): ChangelogChannel | null {
  return value === 'daily' || value === 'dev' || value === 'stable' ? value : null
}

function getChangelogRoot(): string {
  const overrideRoot = String(process.env.ONWARD_CHANGELOG_ROOT || '').trim()
  if (overrideRoot) {
    return overrideRoot
  }
  const resourcesRoot = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(__dirname, '../../resources')
  return join(resourcesRoot, 'changelog')
}

function getIndexPath(): string {
  return join(getChangelogRoot(), 'index.json')
}

function resolveEntryPath(root: string, relativePath: string): string | null {
  const normalizedPath = normalize(relativePath).replace(/^([/\\])+/, '')
  const absolutePath = resolve(root, normalizedPath)
  const expectedPrefix = `${root}${sep}`
  if (absolutePath !== root && !absolutePath.startsWith(expectedPrefix)) {
    return null
  }
  return absolutePath
}

function readIndex(): ChangelogIndexFile {
  const indexPath = getIndexPath()
  if (!existsSync(indexPath)) {
    throw new Error('Changelog index is missing.')
  }

  const parsed = JSON.parse(readFileSync(indexPath, 'utf-8')) as Partial<ChangelogIndexFile>
  if (!Array.isArray(parsed.entries)) {
    throw new Error('Changelog index is invalid.')
  }

  const entries: ChangelogEntry[] = []
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== 'object') continue
    const localeMap = (entry as Partial<ChangelogEntry>).markdown
    const channel = normalizeChannel((entry as Partial<ChangelogEntry>).channel)
    if (
      typeof (entry as Partial<ChangelogEntry>).tag !== 'string' ||
      typeof (entry as Partial<ChangelogEntry>).version !== 'string' ||
      !channel ||
      !localeMap ||
      typeof localeMap.en !== 'string' ||
      (localeMap['zh-CN'] !== undefined && typeof localeMap['zh-CN'] !== 'string')
    ) {
      continue
    }

    const htmlMap = (entry as Partial<ChangelogEntry>).html

    entries.push({
      tag: (entry as Partial<ChangelogEntry>).tag,
      version: (entry as Partial<ChangelogEntry>).version,
      channel,
      previousTag: typeof (entry as Partial<ChangelogEntry>).previousTag === 'string'
        ? (entry as Partial<ChangelogEntry>).previousTag
        : null,
      publishedAt: typeof (entry as Partial<ChangelogEntry>).publishedAt === 'string'
        ? (entry as Partial<ChangelogEntry>).publishedAt
        : null,
      markdown: {
        en: localeMap.en,
        ...(typeof localeMap['zh-CN'] === 'string' ? { 'zh-CN': localeMap['zh-CN'] } : {})
      },
      ...(htmlMap && typeof htmlMap === 'object' && typeof htmlMap.en === 'string'
        ? {
          html: {
            en: htmlMap.en,
            ...(typeof htmlMap['zh-CN'] === 'string' ? { 'zh-CN': htmlMap['zh-CN'] } : {})
          }
        }
        : {})
    })
  }

  return { entries }
}

export function readCurrentChangelog(locale?: string | null): CurrentChangelogResult {
  const requestedLocale = normalizeLocale(locale)
  const appInfo = getAppInfo()
  const currentTag = appInfo.tag

  if (!currentTag) {
    return {
      success: false,
      locale: requestedLocale,
      tag: null,
      reason: 'no-tag'
    }
  }

  let index: ChangelogIndexFile
  try {
    index = readIndex()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      locale: requestedLocale,
      tag: currentTag,
      reason: message.includes('invalid') ? 'invalid-index' : 'index-missing',
      error: message
    }
  }

  const entry = index.entries.find((item) => item.tag === currentTag)
  if (!entry) {
    return {
      success: false,
      locale: requestedLocale,
      tag: currentTag,
      reason: 'entry-missing'
    }
  }

  const changelogRoot = getChangelogRoot()
  const htmlRelativePath = entry.html?.[requestedLocale] || entry.html?.en || null
  const markdownRelativePath = entry.markdown[requestedLocale] || entry.markdown.en

  const resolveAndRead = (relativePath: string): { success: true; value: string } | { success: false; error: string; reason: ChangelogReadReason } => {
    const resolvedPath = resolveEntryPath(changelogRoot, relativePath)
    if (!resolvedPath) {
      return {
        success: false,
        reason: 'read-failed',
        error: `Changelog path escapes the changelog root: ${relativePath}`
      }
    }
    if (!existsSync(resolvedPath)) {
      return {
        success: false,
        reason: 'file-missing',
        error: `Missing changelog file: ${relativePath}`
      }
    }
    try {
      return {
        success: true,
        value: readFileSync(resolvedPath, 'utf-8')
      }
    } catch (error) {
      return {
        success: false,
        reason: 'read-failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  if (htmlRelativePath) {
    const htmlResult = resolveAndRead(htmlRelativePath)
    if (htmlResult.success) {
      return {
        success: true,
        locale: requestedLocale,
        tag: currentTag,
        entry,
        html: htmlResult.value
      }
    }
  }

  const markdownResult = resolveAndRead(markdownRelativePath)
  if (markdownResult.success) {
    return {
      success: true,
      locale: requestedLocale,
      tag: currentTag,
      entry,
      content: markdownResult.value
    }
  }

  return {
    success: false,
    locale: requestedLocale,
    tag: currentTag,
    entry,
    reason: markdownResult.reason,
    error: markdownResult.error
  }
}
