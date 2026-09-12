/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { parse, type ParseError } from 'jsonc-parser'
import yauzl from 'yauzl'
import { getOfficialTranslations, PROTECTED_LOCALE_PACK_KEYS } from '../../src/i18n/core'
import {
  RESOURCE_PACK_MAX_BYTES,
  RESOURCE_PACK_MAX_ENTRIES,
  normalizeHexColor,
  validateLocaleOverlay,
  validateResourcePackManifest,
  type ResourcePackError,
  type ResourcePackKind,
  type ResourcePackManifest
} from '../shared/resource-pack-schema'

type ThemeColors = Record<'--bg-0' | '--bg-1' | '--bg-2' | '--panel' | '--border' | '--border-strong' | '--text-1' | '--text-2' | '--text-3' | '--accent' | '--accent-strong' | '--shadow-1', string>

interface InstalledPack {
  id: string
  version: string
  kind: ResourcePackKind
  displayName: string
  contentHash: string
  installedAt: number
  path: string
  themes?: Array<{ id: string; label: string; kind: 'light' | 'dark' }>
  locale?: 'en' | 'zh-CN'
}

interface StagedPack {
  manifest: ResourcePackManifest
  payload: Record<string, unknown>
  contentHash: string
  summary: NonNullable<PackInspection['summary']>
}

export interface PackInspection {
  ok: boolean
  token?: string
  summary?: {
    id: string
    version: string
    kind: ResourcePackKind
    displayName: string
    themes?: Array<{ id: string; label: string; kind: 'light' | 'dark' }>
    locale?: 'en' | 'zh-CN'
    ignoredKeys?: string[]
    compatibility?: { mapped: string[]; ignored: string[] }
  }
  error?: ResourcePackError
}

function error(code: ResourcePackError['code'], detail: string): PackInspection {
  return { ok: false, error: { code, detail } }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function parseJsonc(text: string): unknown {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length > 0) throw new Error('Invalid JSONC.')
  return value
}

function colorsFromVsCode(raw: unknown, kind: 'light' | 'dark'): { colors: ThemeColors; mapped: string[]; ignored: string[] } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as Record<string, unknown>
  const colors = source.colors && typeof source.colors === 'object' && !Array.isArray(source.colors) ? source.colors as Record<string, unknown> : source
  const base: ThemeColors = kind === 'light'
    ? { '--bg-0': '#f5f7fa', '--bg-1': '#eff2f6', '--bg-2': '#ffffff', '--panel': '#ffffff', '--border': '#d8dee8', '--border-strong': '#79869a', '--text-1': '#17212f', '--text-2': '#465469', '--text-3': '#586477', '--accent': '#175cd3', '--accent-strong': '#144faf', '--shadow-1': '0 4px 14px rgba(23, 33, 47, 0.12)' }
    : { '--bg-0': '#101012', '--bg-1': '#161618', '--bg-2': '#1c1c1f', '--panel': '#212124', '--border': '#2c2c30', '--border-strong': '#38383d', '--text-1': '#e8e8ec', '--text-2': '#b4b4bc', '--text-3': '#8a8a94', '--accent': '#8b8f98', '--accent-strong': '#7a7e86', '--shadow-1': '0 6px 18px rgba(0, 0, 0, 0.4)' }
  const mappings: Array<[string, keyof ThemeColors]> = [
    ['editor.background', '--bg-0'], ['sideBar.background', '--bg-1'], ['editorWidget.background', '--bg-2'], ['panel.background', '--panel'], ['editorGroup.border', '--border'], ['focusBorder', '--border-strong'], ['editor.foreground', '--text-1'], ['descriptionForeground', '--text-2'], ['foreground', '--text-3'], ['button.background', '--accent'], ['button.hoverBackground', '--accent-strong']
  ]
  const mapped: string[] = []
  for (const [sourceKey, target] of mappings) {
    const color = normalizeHexColor(colors[sourceKey])
    if (color) { base[target] = color; mapped.push(sourceKey) }
  }
  const ignored = Object.keys(colors).filter(key => !mappings.some(([sourceKey]) => sourceKey === key))
  return mapped.length > 0 ? { colors: base, mapped, ignored } : null
}

class ResourcePackService {
  private readonly root = join(app.getPath('userData'), 'resource-packs')
  private readonly registryPath = join(this.root, 'registry.json')
  private staged = new Map<string, StagedPack>()

  async inspectPath(inputPath: string): Promise<PackInspection> {
    try {
      const stat = statSync(inputPath)
      if (stat.isDirectory()) return this.inspectDirectory(inputPath)
      if (extname(inputPath).toLowerCase() === '.onward-pack') return await this.inspectZip(inputPath)
      return this.inspectVsCodeTheme(inputPath)
    } catch {
      return error('PACK_INVALID_MANIFEST', 'The selected resource could not be read.')
    }
  }

  private async inspectZip(inputPath: string): Promise<PackInspection> {
    try {
      const entries = await this.readZipEntries(inputPath)
      const manifestText = entries.get('onward-pack.json') ?? entries.get('manifest.json')
      if (!manifestText) return error('PACK_INVALID_MANIFEST', 'A resource-pack manifest was not found.')
      const manifestResult = validateResourcePackManifest(parseJsonc(manifestText))
      if (!manifestResult.ok) return { ok: false, error: manifestResult.error }
      const manifest = manifestResult.manifest
      if (manifest.kind === 'locale') {
        const entry = entries.get(manifest.entry!)
        if (!entry) return error('PACK_PATH_ESCAPE', 'Locale entry was not found inside the package.')
        const validation = validateLocaleOverlay(parseJsonc(entry), getOfficialTranslations(manifest.locale!), PROTECTED_LOCALE_PACK_KEYS)
        if (!validation.ok) return { ok: false, error: validation.error }
        return this.stage(manifest, { locale: manifest.locale, overlay: validation.overlay }, { id: manifest.id, version: manifest.version, kind: manifest.kind, displayName: manifest.displayName, locale: manifest.locale, ignoredKeys: validation.ignoredKeys })
      }
      const themes: Record<string, unknown> = {}
      for (const declaration of manifest.themes ?? []) {
        const entry = entries.get(declaration.entry)
        if (!entry) return error('PACK_PATH_ESCAPE', `Theme entry ${declaration.entry} was not found inside the package.`)
        const parsed = colorsFromVsCode(parseJsonc(entry), declaration.kind)
        if (!parsed) return error('PACK_INVALID_COLOR', `${declaration.id} has no supported colors.`)
        themes[declaration.id] = { kind: declaration.kind, colors: parsed.colors }
      }
      return this.stage(manifest, { themes }, { id: manifest.id, version: manifest.version, kind: manifest.kind, displayName: manifest.displayName, themes: manifest.themes?.map(({ id, label, kind }) => ({ id, label, kind })) })
    } catch (caught) {
      return error('PACK_INVALID_MANIFEST', caught instanceof Error ? caught.message : 'The resource package could not be read.')
    }
  }

  private readZipEntries(inputPath: string): Promise<Map<string, string>> {
    return new Promise((resolveEntries, rejectEntries) => {
      yauzl.open(inputPath, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
        if (openError || !zip) { rejectEntries(openError ?? new Error('Could not open resource package.')); return }
        const entries = new Map<string, string>()
        let count = 0
        let total = 0
        const fail = (reason: Error) => { zip.close(); rejectEntries(reason) }
        zip.on('error', fail)
        zip.on('end', () => resolveEntries(entries))
        zip.on('entry', entry => {
          count += 1
          if (count > RESOURCE_PACK_MAX_ENTRIES || entry.uncompressedSize > RESOURCE_PACK_MAX_BYTES || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/.test(entry.fileName)) {
            fail(new Error('PACK_LIMIT_EXCEEDED: archive entry is not allowed.'))
            return
          }
          if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) { fail(streamError ?? new Error('Could not read archive entry.')); return }
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => {
              total += chunk.length
              if (total > RESOURCE_PACK_MAX_BYTES) stream.destroy(new Error('PACK_LIMIT_EXCEEDED: package is too large.'))
              else chunks.push(chunk)
            })
            stream.on('error', fail)
            stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks).toString('utf-8')); zip.readEntry() })
          })
        })
        zip.readEntry()
      })
    })
  }

  private inspectDirectory(root: string): PackInspection {
    const manifestPath = ['onward-pack.json', 'manifest.json'].map(name => join(root, name)).find(existsSync)
    if (!manifestPath) return error('PACK_INVALID_MANIFEST', 'A resource-pack manifest was not found.')
    const manifestResult = validateResourcePackManifest(parseJsonc(readFileSync(manifestPath, 'utf-8')))
    if (!manifestResult.ok) return { ok: false, error: manifestResult.error }
    const manifest = manifestResult.manifest
    try {
      const payload = manifest.kind === 'locale'
        ? this.readLocalePayload(root, manifest)
        : this.readThemePayload(root, manifest)
      return this.stage(manifest, payload.payload, payload.summary)
    } catch (caught) {
      return error('PACK_INVALID_MANIFEST', caught instanceof Error ? caught.message : 'Invalid resource pack.')
    }
  }

  private readLocalePayload(root: string, manifest: ResourcePackManifest): { payload: Record<string, unknown>; summary: NonNullable<PackInspection['summary']> } {
    const entryPath = this.safeEntry(root, manifest.entry!)
    const validation = validateLocaleOverlay(parseJsonc(readFileSync(entryPath, 'utf-8')), getOfficialTranslations(manifest.locale!), PROTECTED_LOCALE_PACK_KEYS)
    if (!validation.ok) throw new Error(`${validation.error.code}: ${validation.error.detail}`)
    return { payload: { locale: manifest.locale, overlay: validation.overlay }, summary: { id: manifest.id, version: manifest.version, kind: manifest.kind, displayName: manifest.displayName, locale: manifest.locale, ignoredKeys: validation.ignoredKeys } }
  }

  private readThemePayload(root: string, manifest: ResourcePackManifest): { payload: Record<string, unknown>; summary: NonNullable<PackInspection['summary']> } {
    const themes: Record<string, unknown> = {}
    for (const declaration of manifest.themes ?? []) {
      const parsed = colorsFromVsCode(this.readJsoncWithIncludes(root, declaration.entry), declaration.kind)
      if (!parsed) throw new Error(`PACK_INVALID_COLOR: ${declaration.id} has no supported colors.`)
      themes[declaration.id] = { kind: declaration.kind, colors: parsed.colors }
    }
    return { payload: { themes }, summary: { id: manifest.id, version: manifest.version, kind: manifest.kind, displayName: manifest.displayName, themes: manifest.themes?.map(({ id, label, kind }) => ({ id, label, kind })) } }
  }

  private inspectVsCodeTheme(filePath: string): PackInspection {
    try {
      const source = this.readJsoncWithIncludes(dirname(filePath), basename(filePath)) as Record<string, unknown>
      const kind = source.type === 'light' || source.uiTheme === 'vs' || source.uiTheme === 'vs-light' ? 'light' : 'dark'
      const parsed = colorsFromVsCode(source, kind)
      if (!parsed) return error('PACK_INVALID_COLOR', 'The theme has no supported workbench colors.')
      const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16)
      const id = `imported.vscode.${hash}`
      const manifest: ResourcePackManifest = { schemaVersion: 1, id, version: '0.0.0-local', kind: 'theme', displayName: typeof source.name === 'string' ? source.name.slice(0, 100) : basename(filePath), compatiblePackApi: 1, themes: [{ id: 'default', label: 'Default', kind, entry: 'theme.json' }], source: 'local-vscode-theme' }
      return this.stage(manifest, { themes: { default: { kind, colors: parsed.colors } } }, { id, version: manifest.version, kind: 'theme', displayName: manifest.displayName, themes: [{ id: 'default', label: 'Default', kind }], compatibility: { mapped: parsed.mapped, ignored: parsed.ignored } })
    } catch {
      return error('PACK_INVALID_MANIFEST', 'The selected VS Code color theme is not valid JSONC.')
    }
  }

  private safeEntry(root: string, entry: string): string {
    const rootReal = realpathSync(root)
    const target = resolve(rootReal, entry)
    if (!isInside(rootReal, target)) throw new Error('PACK_PATH_ESCAPE: entry escapes the package root.')
    const targetReal = realpathSync(target)
    if (!isInside(rootReal, targetReal)) throw new Error('PACK_PATH_ESCAPE: symlink escapes the package root.')
    const stat = statSync(targetReal)
    if (!stat.isFile() || stat.size > RESOURCE_PACK_MAX_BYTES) throw new Error('PACK_LIMIT_EXCEEDED: entry is too large.')
    return targetReal
  }

  private readJsoncWithIncludes(root: string, entry: string, seen = new Set<string>()): unknown {
    const entryPath = this.safeEntry(root, entry)
    if (seen.has(entryPath)) throw new Error('PACK_INCLUDE_CYCLE: theme includes itself.')
    seen.add(entryPath)
    const parsed = parseJsonc(readFileSync(entryPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed
    const candidate = parsed as Record<string, unknown>
    if (typeof candidate.include !== 'string') return candidate
    const parentEntry = resolve(dirname(entryPath), candidate.include)
    const parentRootRelative = relative(realpathSync(root), parentEntry)
    if (parentRootRelative === '..' || parentRootRelative.startsWith(`..${sep}`) || isAbsolute(parentRootRelative)) throw new Error('PACK_PATH_ESCAPE: include escapes the package root.')
    const parent = this.readJsoncWithIncludes(root, parentRootRelative, seen)
    if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return candidate
    const parentRecord = parent as Record<string, unknown>
    const parentColors = parentRecord.colors && typeof parentRecord.colors === 'object' ? parentRecord.colors : {}
    const childColors = candidate.colors && typeof candidate.colors === 'object' ? candidate.colors : {}
    return { ...parentRecord, ...candidate, colors: { ...parentColors, ...childColors } }
  }

  private stage(manifest: ResourcePackManifest, payload: Record<string, unknown>, summary: NonNullable<PackInspection['summary']>): PackInspection {
    const contentHash = createHash('sha256').update(JSON.stringify({ manifest, payload })).digest('hex')
    const token = randomUUID()
    this.staged.set(token, { manifest, payload, contentHash, summary })
    return { ok: true, token, summary }
  }

  confirmInstall(token: string): { ok: boolean; pack?: InstalledPack; error?: ResourcePackError } {
    const staged = this.staged.get(token)
    if (!staged) return { ok: false, error: { code: 'PACK_INVALID_MANIFEST', detail: 'The inspection expired.' } }
    this.staged.delete(token)
    const registry = this.readRegistry()
    const existing = registry.find(item => item.id === staged.manifest.id)
    if (existing && existing.version === staged.manifest.version && existing.contentHash !== staged.contentHash) return { ok: false, error: { code: 'PACK_CONTENT_CONFLICT', detail: 'The same id and version already has different content.' } }
    if (existing && existing.version === staged.manifest.version) return { ok: true, pack: existing }
    const finalPath = join(this.root, staged.manifest.id, staged.manifest.version)
    const tempPath = `${finalPath}.tmp-${randomUUID()}`
    try {
      mkdirSync(tempPath, { recursive: true })
      writeFileSync(join(tempPath, 'manifest.json'), JSON.stringify(staged.manifest, null, 2), 'utf-8')
      writeFileSync(join(tempPath, 'payload.json'), JSON.stringify(staged.payload), 'utf-8')
      mkdirSync(dirname(finalPath), { recursive: true })
      if (existsSync(finalPath)) rmSync(finalPath, { recursive: true, force: true })
      renameSync(tempPath, finalPath)
      const pack: InstalledPack = { id: staged.manifest.id, version: staged.manifest.version, kind: staged.manifest.kind, displayName: staged.manifest.displayName, contentHash: staged.contentHash, installedAt: Date.now(), path: finalPath, ...(staged.summary.themes ? { themes: staged.summary.themes } : {}), ...(staged.summary.locale ? { locale: staged.summary.locale } : {}) }
      this.writeRegistry([...registry.filter(item => item.id !== pack.id), pack])
      return { ok: true, pack }
    } catch {
      if (existsSync(tempPath)) rmSync(tempPath, { recursive: true, force: true })
      return { ok: false, error: { code: 'PACK_INVALID_MANIFEST', detail: 'PACK_STORAGE_FAILED' } }
    }
  }

  list(): Omit<InstalledPack, 'path' | 'contentHash'>[] {
    return this.readRegistry().map(({ path: _path, contentHash: _contentHash, ...pack }) => pack)
  }

  getTheme(packId: string, themeId: string): { kind: 'light' | 'dark'; colors: ThemeColors } | null {
    const pack = this.readRegistry().find(item => item.id === packId && item.kind === 'theme')
    if (!pack) return null
    try {
      const payload = JSON.parse(readFileSync(join(pack.path, 'payload.json'), 'utf-8')) as { themes?: Record<string, { kind?: unknown; colors?: ThemeColors }> }
      const theme = payload.themes?.[themeId]
      return theme && (theme.kind === 'light' || theme.kind === 'dark') && theme.colors ? { kind: theme.kind, colors: theme.colors } : null
    } catch { return null }
  }

  getLocaleOverlay(packId: string, locale: 'en' | 'zh-CN'): Record<string, string> | null {
    const pack = this.readRegistry().find(item => item.id === packId && item.kind === 'locale' && item.locale === locale)
    if (!pack) return null
    try {
      const payload = JSON.parse(readFileSync(join(pack.path, 'payload.json'), 'utf-8')) as { overlay?: Record<string, string> }
      return payload.overlay ?? null
    } catch { return null }
  }

  hasPack(packId: string): boolean {
    return this.readRegistry().some(pack => pack.id === packId)
  }

  uninstall(packId: string): { ok: boolean; error?: ResourcePackError } {
    const registry = this.readRegistry()
    const pack = registry.find(item => item.id === packId)
    if (!pack) return { ok: false, error: { code: 'PACK_NOT_FOUND', detail: 'The resource pack is no longer installed.' } }

    const removalPath = `${pack.path}.removing-${randomUUID()}`
    try {
      if (existsSync(pack.path)) renameSync(pack.path, removalPath)
      this.writeRegistry(registry.filter(item => item.id !== packId))
      if (existsSync(removalPath)) rmSync(removalPath, { recursive: true, force: true })
      return { ok: true }
    } catch {
      try {
        if (existsSync(removalPath) && !existsSync(pack.path)) renameSync(removalPath, pack.path)
      } catch {
        // The registry remains the authority; a later startup will ignore an orphaned directory.
      }
      return { ok: false, error: { code: 'PACK_STORAGE_FAILED', detail: 'The resource pack could not be removed safely.' } }
    }
  }

  private readRegistry(): InstalledPack[] {
    try { return JSON.parse(readFileSync(this.registryPath, 'utf-8')) as InstalledPack[] } catch { return [] }
  }

  private writeRegistry(registry: InstalledPack[]): void {
    mkdirSync(this.root, { recursive: true })
    const temp = `${this.registryPath}.tmp-${randomUUID()}`
    writeFileSync(temp, JSON.stringify(registry, null, 2), 'utf-8')
    renameSync(temp, this.registryPath)
  }
}

export const resourcePackService = new ResourcePackService()
