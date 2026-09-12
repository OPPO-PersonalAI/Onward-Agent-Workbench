/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const RESOURCE_PACK_API_VERSION = 1
export const RESOURCE_PACK_MAX_BYTES = 2 * 1024 * 1024
export const RESOURCE_PACK_MAX_ENTRIES = 64

export type ResourcePackKind = 'theme' | 'locale'
export type ResourceThemeKind = 'light' | 'dark'

export interface ResourceThemeDeclaration {
  id: string
  label: string
  kind: ResourceThemeKind
  entry: string
}

export interface ResourcePackManifest {
  schemaVersion: 1
  id: string
  version: string
  kind: ResourcePackKind
  displayName: string
  compatiblePackApi: 1
  entry?: string
  locale?: 'en' | 'zh-CN'
  themes?: ResourceThemeDeclaration[]
  source?: string
}

export interface ResourcePackError {
  code: 'PACK_INVALID_MANIFEST' | 'PACK_UNSUPPORTED_API' | 'PACK_PATH_ESCAPE' | 'PACK_LIMIT_EXCEEDED' | 'PACK_INCLUDE_CYCLE' | 'PACK_INVALID_COLOR' | 'PACK_PLACEHOLDER_MISMATCH' | 'PACK_PROTECTED_KEY' | 'PACK_CONTENT_CONFLICT' | 'PACK_NOT_FOUND' | 'PACK_STORAGE_FAILED'
  detail: string
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/
const SAFE_ENTRY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,160}$/
const COLOR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalid(detail: string): { ok: false; error: ResourcePackError } {
  return { ok: false, error: { code: 'PACK_INVALID_MANIFEST', detail } }
}

function validateEntry(value: unknown): string | null {
  return typeof value === 'string' && SAFE_ENTRY.test(value) ? value : null
}

export function validateResourcePackManifest(value: unknown): { ok: true; manifest: ResourcePackManifest } | { ok: false; error: ResourcePackError } {
  if (!record(value) || value.schemaVersion !== 1) return invalid('schemaVersion must be 1.')
  if (typeof value.id !== 'string' || !SAFE_ID.test(value.id) || value.id.startsWith('builtin.')) return invalid('id is invalid or reserved.')
  if (typeof value.version !== 'string' || !SAFE_VERSION.test(value.version)) return invalid('version is invalid.')
  if (value.kind !== 'theme' && value.kind !== 'locale') return invalid('kind must be theme or locale.')
  if (typeof value.displayName !== 'string' || value.displayName.trim().length === 0 || value.displayName.length > 100) return invalid('displayName is invalid.')
  if (value.compatiblePackApi !== RESOURCE_PACK_API_VERSION) {
    return { ok: false, error: { code: 'PACK_UNSUPPORTED_API', detail: 'compatiblePackApi must equal 1.' } }
  }
  if (value.kind === 'locale') {
    const entry = validateEntry(value.entry)
    if (!entry || (value.locale !== 'en' && value.locale !== 'zh-CN')) return invalid('locale packs require a supported locale and entry.')
    return { ok: true, manifest: { schemaVersion: 1, id: value.id, version: value.version, kind: 'locale', displayName: value.displayName.trim(), compatiblePackApi: 1, locale: value.locale, entry, ...(typeof value.source === 'string' ? { source: value.source.slice(0, 200) } : {}) } }
  }
  if (!Array.isArray(value.themes) || value.themes.length === 0 || value.themes.length > 8) return invalid('theme packs require one to eight themes.')
  const themes: ResourceThemeDeclaration[] = []
  const seen = new Set<string>()
  for (const candidate of value.themes) {
    if (!record(candidate) || typeof candidate.id !== 'string' || !SAFE_ID.test(candidate.id) || seen.has(candidate.id) || typeof candidate.label !== 'string' || candidate.label.trim().length === 0 || (candidate.kind !== 'light' && candidate.kind !== 'dark')) return invalid('theme declaration is invalid.')
    const entry = validateEntry(candidate.entry)
    if (!entry) return invalid('theme entry escapes the package root.')
    seen.add(candidate.id)
    themes.push({ id: candidate.id, label: candidate.label.trim().slice(0, 100), kind: candidate.kind, entry })
  }
  return { ok: true, manifest: { schemaVersion: 1, id: value.id, version: value.version, kind: 'theme', displayName: value.displayName.trim(), compatiblePackApi: 1, themes, ...(typeof value.source === 'string' ? { source: value.source.slice(0, 200) } : {}) } }
}

export function normalizeHexColor(value: unknown): string | null {
  return typeof value === 'string' && COLOR.test(value) ? value.toLowerCase() : null
}

export function validateLocaleOverlay(
  value: unknown,
  official: Readonly<Record<string, string>>,
  protectedKeys: ReadonlySet<string>
): { ok: true; overlay: Record<string, string>; ignoredKeys: string[] } | { ok: false; error: ResourcePackError } {
  if (!record(value)) return { ok: false, error: { code: 'PACK_INVALID_MANIFEST', detail: 'locale entry must be an object.' } }
  const overlay: Record<string, string> = {}
  const ignoredKeys: string[] = []
  for (const [key, text] of Object.entries(value)) {
    if (!(key in official)) { ignoredKeys.push(key); continue }
    if (protectedKeys.has(key)) return { ok: false, error: { code: 'PACK_PROTECTED_KEY', detail: key } }
    if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, error: { code: 'PACK_INVALID_MANIFEST', detail: `Invalid translation for ${key}.` } }
    const sourcePlaceholders = [...official[key].matchAll(/\{\{(.*?)\}\}/g)].map(item => item[1].trim()).sort().join('\u0000')
    const targetPlaceholders = [...text.matchAll(/\{\{(.*?)\}\}/g)].map(item => item[1].trim()).sort().join('\u0000')
    if (sourcePlaceholders !== targetPlaceholders) return { ok: false, error: { code: 'PACK_PLACEHOLDER_MISMATCH', detail: key } }
    overlay[key] = text
  }
  return { ok: true, overlay, ignoredKeys }
}
