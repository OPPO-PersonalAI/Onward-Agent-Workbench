/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, normalize, resolve, sep } from 'path'
import { getAppInfo } from './app-info'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

export type ChangelogLocale = 'en' | 'zh-CN'
export type ChangelogChannel = 'daily' | 'stable'
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
  simulateUpgrade?: boolean
  reason?: ChangelogReadReason
  error?: string
}

function normalizeLocale(value: string | null | undefined): ChangelogLocale {
  return value === 'zh-CN' ? 'zh-CN' : 'en'
}

function normalizeChannel(value: unknown): ChangelogChannel | null {
  return value === 'daily' || value === 'stable' ? value : null
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
    const rawEntry = entry as Partial<ChangelogEntry>
    const localeMap = rawEntry.markdown
    const channel = normalizeChannel(rawEntry.channel)
    if (
      typeof rawEntry.tag !== 'string' ||
      typeof rawEntry.version !== 'string' ||
      !channel ||
      !localeMap ||
      typeof localeMap.en !== 'string' ||
      (localeMap['zh-CN'] !== undefined && typeof localeMap['zh-CN'] !== 'string')
    ) {
      continue
    }

    const htmlMap = rawEntry.html
    const tag = rawEntry.tag
    const version = rawEntry.version
    const previousTag = typeof rawEntry.previousTag === 'string' ? rawEntry.previousTag : null
    const publishedAt = typeof rawEntry.publishedAt === 'string' ? rawEntry.publishedAt : null

    entries.push({
      tag,
      version,
      channel,
      previousTag,
      publishedAt,
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
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_CHANGELOG_READ, {
      tag: null,
      locale: requestedLocale,
      success: false,
      reason: 'no-tag'
    })
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
    const reason: ChangelogReadReason = message.includes('invalid') ? 'invalid-index' : 'index-missing'
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_CHANGELOG_READ, {
      tag: currentTag,
      locale: requestedLocale,
      success: false,
      reason
    })
    return {
      success: false,
      locale: requestedLocale,
      tag: currentTag,
      reason,
      error: message
    }
  }

  const entry = index.entries.find((item) => item.tag === currentTag)
  if (!entry) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_CHANGELOG_READ, {
      tag: currentTag,
      locale: requestedLocale,
      success: false,
      reason: 'entry-missing'
    })
    return {
      success: false,
      locale: requestedLocale,
      tag: currentTag,
      reason: 'entry-missing'
    }
  }

  const changelogRoot = getChangelogRoot()
  const simulateUpgrade = process.env.ONWARD_SIMULATE_UPGRADE === '1'
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
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_CHANGELOG_READ, {
        tag: currentTag,
        locale: requestedLocale,
        success: true,
        format: 'html',
        simulateUpgrade
      })
      return {
        success: true,
        locale: requestedLocale,
        tag: currentTag,
        entry,
        html: htmlResult.value,
        ...(simulateUpgrade ? { simulateUpgrade: true } : {})
      }
    }
  }

  const markdownResult = resolveAndRead(markdownRelativePath)
  if (!markdownResult.success) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_CHANGELOG_READ, {
      tag: currentTag,
      locale: requestedLocale,
      success: false,
      reason: markdownResult.reason
    })
    return {
      success: false,
      locale: requestedLocale,
      tag: currentTag,
      entry,
      reason: markdownResult.reason,
      error: markdownResult.error
    }
  }

  performanceTrace.record(PERF_TRACE_EVENT.MAIN_CHANGELOG_READ, {
    tag: currentTag,
    locale: requestedLocale,
    success: true,
    format: 'markdown',
    simulateUpgrade
  })
  return {
    success: true,
    locale: requestedLocale,
    tag: currentTag,
    entry,
    content: markdownResult.value,
    ...(simulateUpgrade ? { simulateUpgrade: true } : {})
  }
}
