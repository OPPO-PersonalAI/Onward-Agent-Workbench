/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import BetterSqlite3 from 'better-sqlite3'
import { readdir, stat, readFile, writeFile, mkdir, rename, rm, unlink, access } from 'fs/promises'
import { resolve, relative, dirname, sep, normalize, extname } from 'path'

const MAX_FILE_SIZE = 1024 * 1024
const SQLITE_DEFAULT_LIMIT = 100
const SQLITE_MAX_LIMIT = 500
const SQLITE_MAX_QUERY_ROWS = 500

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg'
])

const SQLITE_EXTENSIONS = new Set([
  '.sqlite',
  '.sqlite3',
  '.db',
  '.db3',
  '.s3db'
])

const SQLITE_MAGIC_HEADER = Buffer.from('SQLite format 3\u0000', 'utf-8')

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

type SqliteDatabase = InstanceType<typeof BetterSqlite3>

type SqliteBlobValue = {
  type: 'blob'
  base64: string
  bytes: number
}

type SqliteValue = string | number | null | SqliteBlobValue

type SqliteRowKey =
  | { kind: 'rowid'; rowid: number }
  | { kind: 'primary-key'; values: Record<string, SqliteValue> }

type SqliteColumnMeta = {
  name: string
  type: string
  notNull: boolean
  primaryKeyOrder: number
  hasDefault: boolean
}

type SqliteTableMeta = {
  name: string
  rowCount: number
  columns: SqliteColumnMeta[]
  hasRowid: boolean
  editable: boolean
  primaryKeyColumns: string[]
}

type SqlitePathResult =
  | { ok: true; rootPath: string; fullPath: string }
  | { ok: false; rootPath: string; error: string }

function normalizePath(value: string): string {
  return normalize(value)
}

function normalizeForCompare(value: string): string {
  const normalized = normalizePath(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSubPath(root: string, target: string): boolean {
  const rootNormalized = normalizeForCompare(root)
  const targetNormalized = normalizeForCompare(target)
  if (targetNormalized === rootNormalized) return true
  return targetNormalized.startsWith(rootNormalized + sep)
}

export function resolveInRoot(root: string, relativePath: string): string | null {
  const safeRelative = relativePath
    ? relativePath.split('/').join(sep)
    : ''
  const fullPath = resolve(root, safeRelative)
  if (!isSubPath(root, fullPath)) return null
  return fullPath
}

function resolveSqlitePath(root: string, path: string): SqlitePathResult {
  const rootPath = resolve(root)
  if (!path.trim()) {
    return { ok: false, rootPath, error: 'Database file path cannot be empty.' }
  }
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { ok: false, rootPath, error: 'Invalid path. It is outside the working directory.' }
  }
  return { ok: true, rootPath, fullPath }
}

function toRelativePath(root: string, fullPath: string): string {
  const rel = relative(root, fullPath)
  return rel.split(sep).join('/')
}

function sortEntries(entries: Array<{ name: string; path: string; type: 'file' | 'dir' }>) {
  return entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1
    }
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
  })
}

function isLikelySqliteFile(filePath: string, buffer: Buffer): boolean {
  const ext = extname(filePath).toLowerCase()
  if (SQLITE_EXTENSIONS.has(ext)) return true
  if (buffer.length < SQLITE_MAGIC_HEADER.length) return false
  return buffer.subarray(0, SQLITE_MAGIC_HEADER.length).equals(SQLITE_MAGIC_HEADER)
}

function quoteIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function coerceSqliteValue(rawValue: unknown): SqliteValue {
  if (rawValue === null || rawValue === undefined) return null
  if (typeof rawValue === 'string') return rawValue
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : String(rawValue)
  if (typeof rawValue === 'boolean') return rawValue ? 1 : 0
  if (typeof rawValue === 'bigint') {
    const asNumber = Number(rawValue)
    return Number.isFinite(asNumber) ? asNumber : String(rawValue)
  }
  if (Buffer.isBuffer(rawValue)) {
    return {
      type: 'blob',
      base64: rawValue.toString('base64'),
      bytes: rawValue.length
    }
  }
  if (rawValue instanceof Uint8Array) {
    const buffer = Buffer.from(rawValue)
    return {
      type: 'blob',
      base64: buffer.toString('base64'),
      bytes: buffer.length
    }
  }
  return String(rawValue)
}

function coerceLastInsertRowId(rawValue: unknown): number | null {
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) ? rawValue : null
  }
  if (typeof rawValue === 'bigint') {
    const asNumber = Number(rawValue)
    return Number.isFinite(asNumber) ? asNumber : null
  }
  return null
}

function clampSqliteLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return SQLITE_DEFAULT_LIMIT
  return Math.max(1, Math.min(SQLITE_MAX_LIMIT, Math.floor(limit)))
}

function clampSqliteOffset(offset?: number): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

function normalizeSqliteBindValue(rawValue: unknown): string | number | null | Buffer {
  if (rawValue === null || rawValue === undefined) return null
  if (typeof rawValue === 'string') return rawValue
  if (typeof rawValue === 'number') return Number.isFinite(rawValue) ? rawValue : String(rawValue)
  if (typeof rawValue === 'boolean') return rawValue ? 1 : 0
  if (typeof rawValue === 'bigint') {
    const asNumber = Number(rawValue)
    return Number.isFinite(asNumber) ? asNumber : String(rawValue)
  }
  if (Buffer.isBuffer(rawValue)) return rawValue
  if (rawValue instanceof Uint8Array) return Buffer.from(rawValue)
  if (typeof rawValue === 'object') {
    const blobLike = rawValue as { type?: unknown; base64?: unknown }
    if (
      blobLike.type === 'blob' &&
      typeof blobLike.base64 === 'string'
    ) {
      try {
        return Buffer.from(blobLike.base64, 'base64')
      } catch {
        return null
      }
    }
  }
  return String(rawValue)
}

function coerceMutationInputValue(rawValue: unknown, columnType: string): string | number | null | Buffer {
  if (rawValue === null || rawValue === undefined) return null
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim()
    if (trimmed.toUpperCase() === 'NULL') return null
    if (trimmed.length > 0) {
      const numericColumn = /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/i.test(columnType || '')
      if (numericColumn && /^[-+]?\d+(?:\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed)
        if (Number.isFinite(parsed)) return parsed
      }
    }
    return rawValue
  }
  return normalizeSqliteBindValue(rawValue)
}

function readTableColumns(db: SqliteDatabase, tableName: string): SqliteColumnMeta[] {
  const pragmaRows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{
    name: string
    type: string | null
    notnull: number
    dflt_value: unknown
    pk: number
  }>

  return pragmaRows.map((row) => ({
    name: String(row.name),
    type: String(row.type || ''),
    notNull: Number(row.notnull) === 1,
    primaryKeyOrder: Number(row.pk) || 0,
    hasDefault: row.dflt_value !== null && row.dflt_value !== undefined
  }))
}

function readTableMetaList(db: SqliteDatabase): SqliteTableMeta[] {
  const tableRows = db.prepare(
    `SELECT name, sql
     FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name COLLATE NOCASE`
  ).all() as Array<{ name: string; sql: string | null }>

  return tableRows.map((tableRow) => {
    const tableName = String(tableRow.name)
    const columns = readTableColumns(db, tableName)
    const primaryKeyColumns = columns
      .filter(column => column.primaryKeyOrder > 0)
      .sort((a, b) => a.primaryKeyOrder - b.primaryKeyOrder)
      .map(column => column.name)
    const withoutRowId = /WITHOUT\s+ROWID/i.test(String(tableRow.sql || ''))

    let rowCount = 0
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(tableName)}`).get() as { c?: unknown } | undefined
      const numericCount = Number(row?.c ?? 0)
      rowCount = Number.isFinite(numericCount) ? numericCount : 0
    } catch {
      rowCount = 0
    }

    return {
      name: tableName,
      rowCount,
      columns,
      hasRowid: !withoutRowId,
      editable: columns.length > 0,
      primaryKeyColumns
    }
  })
}

function findTableMeta(db: SqliteDatabase, table: string): SqliteTableMeta | null {
  const target = table.trim()
  if (!target) return null
  const tableMetaList = readTableMetaList(db)
  return tableMetaList.find(item => item.name === target) ?? null
}

function buildWhereClauseFromRowKey(key: unknown, primaryKeyColumns: string[]): { sql: string; params: Array<string | number | null | Buffer> } | null {
  if (!key || typeof key !== 'object') return null
  const rowKey = key as {
    kind?: unknown
    rowid?: unknown
    values?: Record<string, unknown>
  }

  if (rowKey.kind === 'rowid') {
    const rowId = Number(rowKey.rowid)
    if (!Number.isFinite(rowId)) return null
    return {
      sql: 'WHERE rowid = ?',
      params: [Math.trunc(rowId)]
    }
  }

  if (rowKey.kind === 'primary-key' && rowKey.values && primaryKeyColumns.length > 0) {
    const clauses: string[] = []
    const params: Array<string | number | null | Buffer> = []

    for (const column of primaryKeyColumns) {
      const rawValue = rowKey.values[column]
      if (rawValue === undefined) return null
      const boundValue = normalizeSqliteBindValue(rawValue)
      if (boundValue === null) {
        clauses.push(`${quoteIdentifier(column)} IS NULL`)
      } else {
        clauses.push(`${quoteIdentifier(column)} = ?`)
        params.push(boundValue)
      }
    }

    return {
      sql: `WHERE ${clauses.join(' AND ')}`,
      params
    }
  }

  return null
}

function buildRowKeyFromRecord(
  rowRecord: Record<string, unknown>,
  hasRowid: boolean,
  primaryKeyColumns: string[]
): SqliteRowKey | null {
  if (hasRowid) {
    const rawRowId = rowRecord.__onward_rowid
    const rowId = Number(rawRowId)
    if (!Number.isFinite(rowId)) return null
    return {
      kind: 'rowid',
      rowid: Math.trunc(rowId)
    }
  }

  if (primaryKeyColumns.length > 0) {
    const values: Record<string, SqliteValue> = {}
    for (const column of primaryKeyColumns) {
      values[column] = coerceSqliteValue(rowRecord[column])
    }
    return {
      kind: 'primary-key',
      values
    }
  }

  return null
}

function getSafeSqliteError(error: unknown): string {
  return `SQLite operation failed: ${String(error)}`
}

export async function listDirectory(root: string, path: string) {
  const rootPath = resolve(root)
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, entries: [], error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    const dirents = await readdir(fullPath, { withFileTypes: true })
    const entries: Array<{ name: string; path: string; type: 'file' | 'dir' }> = dirents.map((dirent) => {
      const entryFullPath = resolve(fullPath, dirent.name)
      return {
        name: dirent.name,
        path: toRelativePath(rootPath, entryFullPath),
        type: dirent.isDirectory() ? 'dir' : 'file'
      }
    })

    return {
      success: true,
      root: rootPath,
      path,
      entries: sortEntries(entries)
    }
  } catch (error) {
    return {
      success: false,
      root: rootPath,
      path,
      entries: [],
      error: `Failed to read directory: ${String(error)}`
    }
  }
}

export async function readProjectFile(root: string, path: string) {
  const rootPath = resolve(root)
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return {
      success: false,
      root: rootPath,
      path,
      content: '',
      isBinary: false,
      isImage: false,
      isSqlite: false,
      error: 'Invalid path. It is outside the working directory.'
    }
  }

  try {
    const fileStat = await stat(fullPath)
    if (!fileStat.isFile()) {
      return {
        success: false,
        root: rootPath,
        path,
        content: '',
        isBinary: false,
        isImage: false,
        isSqlite: false,
        error: 'The target is not a file.'
      }
    }
    const ext = extname(fullPath).toLowerCase()
    const isSqliteByExt = SQLITE_EXTENSIONS.has(ext)
    if (fileStat.size > MAX_FILE_SIZE && !isSqliteByExt) {
      return {
        success: false,
        root: rootPath,
        path,
        content: '',
        isBinary: false,
        isImage: false,
        isSqlite: false,
        error: `File is too large to load (>${Math.floor(MAX_FILE_SIZE / 1024)}KB).`
      }
    }

    if (isSqliteByExt) {
      return {
        success: true,
        root: rootPath,
        path,
        content: '',
        isBinary: true,
        isImage: false,
        isSqlite: true
      }
    }

    const buffer = await readFile(fullPath)
    const isBinary = buffer.includes(0)
    const isImage = IMAGE_EXTENSIONS.has(ext)
    const isSqlite = isLikelySqliteFile(fullPath, buffer)
    const mime = IMAGE_MIME_TYPES[ext]
    const previewUrl = isImage && mime
      ? `data:${mime};base64,${buffer.toString('base64')}`
      : undefined

    if (isImage) {
      return {
        success: true,
        root: rootPath,
        path,
        content: '',
        isBinary,
        isImage: true,
        isSqlite: false,
        previewUrl
      }
    }

    if (isSqlite) {
      return {
        success: true,
        root: rootPath,
        path,
        content: '',
        isBinary: true,
        isImage: false,
        isSqlite: true
      }
    }

    if (isBinary) {
      return { success: true, root: rootPath, path, content: '', isBinary: true, isImage: false, isSqlite: false }
    }

    return {
      success: true,
      root: rootPath,
      path,
      content: buffer.toString('utf-8'),
      isBinary: false,
      isImage: false,
      isSqlite: false
    }
  } catch (error) {
    return {
      success: false,
      root: rootPath,
      path,
      content: '',
      isBinary: false,
      isImage: false,
      isSqlite: false,
      error: `Failed to read file: ${String(error)}`
    }
  }
}

export async function saveProjectFile(root: string, path: string, content: string) {
  const rootPath = resolve(root)
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    await writeFile(fullPath, content, 'utf-8')
    return { success: true, root: rootPath, path }
  } catch (error) {
    return { success: false, root: rootPath, path, error: `Failed to save file: ${String(error)}` }
  }
}

export async function createProjectFile(root: string, path: string, content: string) {
  const rootPath = resolve(root)
  if (!path.trim()) {
    return { success: false, root: rootPath, path, error: 'File name cannot be empty.' }
  }
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    await access(fullPath)
    return { success: false, root: rootPath, path, error: 'File already exists.' }
  } catch {
    // ok
  }

  try {
    const parent = dirname(fullPath)
    const parentStat = await stat(parent)
    if (!parentStat.isDirectory()) {
      return { success: false, root: rootPath, path, error: 'Target directory does not exist.' }
    }
    await writeFile(fullPath, content, 'utf-8')
    return { success: true, root: rootPath, path }
  } catch (error) {
    return { success: false, root: rootPath, path, error: `Failed to create file: ${String(error)}` }
  }
}

export async function createProjectFolder(root: string, path: string) {
  const rootPath = resolve(root)
  if (!path.trim()) {
    return { success: false, root: rootPath, path, error: 'Folder name cannot be empty.' }
  }
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    await access(fullPath)
    return { success: false, root: rootPath, path, error: 'Folder already exists.' }
  } catch {
    // ok
  }

  try {
    await mkdir(fullPath, { recursive: true })
    return { success: true, root: rootPath, path }
  } catch (error) {
    return { success: false, root: rootPath, path, error: `Failed to create folder: ${String(error)}` }
  }
}

export async function renameProjectPath(root: string, oldPath: string, newPath: string) {
  const rootPath = resolve(root)
  if (!oldPath.trim() || !newPath.trim()) {
    return { success: false, root: rootPath, oldPath, newPath, error: 'Path cannot be empty.' }
  }

  const oldFullPath = resolveInRoot(rootPath, oldPath)
  const newFullPath = resolveInRoot(rootPath, newPath)
  if (!oldFullPath || !newFullPath) {
    return { success: false, root: rootPath, oldPath, newPath, error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    await rename(oldFullPath, newFullPath)
    return { success: true, root: rootPath, oldPath, newPath }
  } catch (error) {
    return { success: false, root: rootPath, oldPath, newPath, error: `Failed to rename: ${String(error)}` }
  }
}

export async function deleteProjectPath(root: string, path: string) {
  const rootPath = resolve(root)
  if (!path.trim()) {
    return { success: false, root: rootPath, path, error: 'Path cannot be empty.' }
  }
  const fullPath = resolveInRoot(rootPath, path)
  if (!fullPath) {
    return { success: false, root: rootPath, path, error: 'Invalid path. It is outside the working directory.' }
  }

  try {
    const fileStat = await stat(fullPath)
    if (fileStat.isDirectory()) {
      await rm(fullPath, { recursive: true, force: false })
    } else {
      await unlink(fullPath)
    }
    return { success: true, root: rootPath, path }
  } catch (error) {
    return { success: false, root: rootPath, path, error: `Failed to delete: ${String(error)}` }
  }
}

export async function getProjectSqliteSchema(root: string, path: string) {
  const resolvedPath = resolveSqlitePath(root, path)
  if (!resolvedPath.ok) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      tables: [],
      error: resolvedPath.error
    }
  }

  let db: SqliteDatabase | null = null
  try {
    db = new BetterSqlite3(resolvedPath.fullPath, { fileMustExist: true })
    const tableMetaList = readTableMetaList(db)
    return {
      success: true,
      root: resolvedPath.rootPath,
      path,
      tables: tableMetaList.map(meta => ({
        name: meta.name,
        rowCount: meta.rowCount,
        columns: meta.columns,
        hasRowid: meta.hasRowid,
        editable: meta.editable
      }))
    }
  } catch (error) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      tables: [],
      error: getSafeSqliteError(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}

export async function readProjectSqliteTableRows(
  root: string,
  path: string,
  table: string,
  limit?: number,
  offset?: number
) {
  const resolvedPath = resolveSqlitePath(root, path)
  if (!resolvedPath.ok) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      columns: [],
      rows: [],
      totalRows: 0,
      limit: clampSqliteLimit(limit),
      offset: clampSqliteOffset(offset),
      hasRowid: true,
      editable: false,
      error: resolvedPath.error
    }
  }

  const safeLimit = clampSqliteLimit(limit)
  const safeOffset = clampSqliteOffset(offset)
  let db: SqliteDatabase | null = null

  try {
    db = new BetterSqlite3(resolvedPath.fullPath, { fileMustExist: true })
    const meta = findTableMeta(db, table)
    if (!meta) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        columns: [],
        rows: [],
        totalRows: 0,
        limit: safeLimit,
        offset: safeOffset,
        hasRowid: true,
        editable: false,
        error: `Table does not exist: ${table}`
      }
    }

    const tableNameSql = quoteIdentifier(meta.name)
    const orderBySql = (() => {
      if (meta.hasRowid) return 'ORDER BY rowid'
      if (meta.primaryKeyColumns.length > 0) {
        return `ORDER BY ${meta.primaryKeyColumns.map(column => quoteIdentifier(column)).join(', ')}`
      }
      return ''
    })()
    const selectColumnsSql = meta.hasRowid
      ? `rowid AS __onward_rowid, *`
      : '*'
    const querySql = `SELECT ${selectColumnsSql} FROM ${tableNameSql} ${orderBySql} LIMIT ? OFFSET ?`
    const rowRecords = db.prepare(querySql).all(safeLimit, safeOffset) as Array<Record<string, unknown>>

    const rows = rowRecords.map((rowRecord) => {
      const values: Record<string, SqliteValue> = {}
      for (const column of meta.columns) {
        values[column.name] = coerceSqliteValue(rowRecord[column.name])
      }
      const key = buildRowKeyFromRecord(rowRecord, meta.hasRowid, meta.primaryKeyColumns)
      return {
        key,
        values
      }
    }).filter(row => row.key !== null) as Array<{
      key: SqliteRowKey
      values: Record<string, SqliteValue>
    }>

    return {
      success: true,
      root: resolvedPath.rootPath,
      path,
      table: meta.name,
      columns: meta.columns,
      rows,
      totalRows: meta.rowCount,
      limit: safeLimit,
      offset: safeOffset,
      hasRowid: meta.hasRowid,
      editable: meta.editable
    }
  } catch (error) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      columns: [],
      rows: [],
      totalRows: 0,
      limit: safeLimit,
      offset: safeOffset,
      hasRowid: true,
      editable: false,
      error: getSafeSqliteError(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}

export async function insertProjectSqliteRow(
  root: string,
  path: string,
  table: string,
  values: Record<string, unknown>
) {
  const resolvedPath = resolveSqlitePath(root, path)
  if (!resolvedPath.ok) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      changes: 0,
      lastInsertRowid: null as number | null,
      error: resolvedPath.error
    }
  }

  let db: SqliteDatabase | null = null
  try {
    db = new BetterSqlite3(resolvedPath.fullPath, { fileMustExist: true })
    const meta = findTableMeta(db, table)
    if (!meta) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        lastInsertRowid: null as number | null,
        error: `Table does not exist: ${table}`
      }
    }

    const columnTypeMap = new Map(meta.columns.map(column => [column.name, column.type]))
    const inputEntries = Object.entries(values || {}).filter(([, value]) => value !== undefined)
    const unknownColumns = inputEntries
      .map(([column]) => column)
      .filter(column => !columnTypeMap.has(column))

    if (unknownColumns.length > 0) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        lastInsertRowid: null as number | null,
        error: `Unknown columns included: ${unknownColumns.join(', ')}`
      }
    }

    const tableNameSql = quoteIdentifier(meta.name)
    let info: { changes: number; lastInsertRowid: unknown }
    if (inputEntries.length === 0) {
      info = db.prepare(`INSERT INTO ${tableNameSql} DEFAULT VALUES`).run() as { changes: number; lastInsertRowid: unknown }
    } else {
      const columnsSql = inputEntries.map(([column]) => quoteIdentifier(column)).join(', ')
      const placeholders = inputEntries.map(() => '?').join(', ')
      const params = inputEntries.map(([column, value]) => coerceMutationInputValue(value, columnTypeMap.get(column) || ''))
      info = db.prepare(`INSERT INTO ${tableNameSql} (${columnsSql}) VALUES (${placeholders})`).run(...params) as { changes: number; lastInsertRowid: unknown }
    }

    return {
      success: true,
      root: resolvedPath.rootPath,
      path,
      table: meta.name,
      changes: Number(info.changes) || 0,
      lastInsertRowid: coerceLastInsertRowId(info.lastInsertRowid)
    }
  } catch (error) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      changes: 0,
      lastInsertRowid: null as number | null,
      error: getSafeSqliteError(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}

export async function updateProjectSqliteRow(
  root: string,
  path: string,
  table: string,
  key: unknown,
  values: Record<string, unknown>
) {
  const resolvedPath = resolveSqlitePath(root, path)
  if (!resolvedPath.ok) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      changes: 0,
      error: resolvedPath.error
    }
  }

  let db: SqliteDatabase | null = null
  try {
    db = new BetterSqlite3(resolvedPath.fullPath, { fileMustExist: true })
    const meta = findTableMeta(db, table)
    if (!meta) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        error: `Table does not exist: ${table}`
      }
    }

    const whereClause = buildWhereClauseFromRowKey(key, meta.primaryKeyColumns)
    if (!whereClause) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        error: 'Invalid row identifier. Unable to update.'
      }
    }

    const columnTypeMap = new Map(meta.columns.map(column => [column.name, column.type]))
    const updateEntries = Object.entries(values || {}).filter(([, value]) => value !== undefined)
    if (updateEntries.length === 0) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        error: 'Update content cannot be empty.'
      }
    }

    const unknownColumns = updateEntries
      .map(([column]) => column)
      .filter(column => !columnTypeMap.has(column))

    if (unknownColumns.length > 0) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        error: `Unknown columns included: ${unknownColumns.join(', ')}`
      }
    }

    const assignmentSql = updateEntries
      .map(([column]) => `${quoteIdentifier(column)} = ?`)
      .join(', ')
    const params = [
      ...updateEntries.map(([column, value]) => coerceMutationInputValue(value, columnTypeMap.get(column) || '')),
      ...whereClause.params
    ]
    const tableNameSql = quoteIdentifier(meta.name)
    const info = db.prepare(`UPDATE ${tableNameSql} SET ${assignmentSql} ${whereClause.sql}`).run(...params) as { changes: number }

    return {
      success: true,
      root: resolvedPath.rootPath,
      path,
      table: meta.name,
      changes: Number(info.changes) || 0
    }
  } catch (error) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      changes: 0,
      error: getSafeSqliteError(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}

export async function deleteProjectSqliteRow(
  root: string,
  path: string,
  table: string,
  key: unknown
) {
  const resolvedPath = resolveSqlitePath(root, path)
  if (!resolvedPath.ok) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      changes: 0,
      error: resolvedPath.error
    }
  }

  let db: SqliteDatabase | null = null
  try {
    db = new BetterSqlite3(resolvedPath.fullPath, { fileMustExist: true })
    const meta = findTableMeta(db, table)
    if (!meta) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        error: `Table does not exist: ${table}`
      }
    }

    const whereClause = buildWhereClauseFromRowKey(key, meta.primaryKeyColumns)
    if (!whereClause) {
      return {
        success: false,
        root: resolvedPath.rootPath,
        path,
        table,
        changes: 0,
        error: 'Invalid row identifier. Unable to delete.'
      }
    }

    const tableNameSql = quoteIdentifier(meta.name)
    const info = db.prepare(`DELETE FROM ${tableNameSql} ${whereClause.sql}`).run(...whereClause.params) as { changes: number }
    return {
      success: true,
      root: resolvedPath.rootPath,
      path,
      table: meta.name,
      changes: Number(info.changes) || 0
    }
  } catch (error) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      table,
      changes: 0,
      error: getSafeSqliteError(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}

export async function executeProjectSqlite(
  root: string,
  path: string,
  sql: string
) {
  const resolvedPath = resolveSqlitePath(root, path)
  if (!resolvedPath.ok) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      mode: 'run' as const,
      columns: [] as string[],
      rows: [] as Array<Record<string, SqliteValue>>,
      changes: 0,
      lastInsertRowid: null as number | null,
      truncated: false,
      error: resolvedPath.error
    }
  }

  const statement = String(sql || '').trim()
  if (!statement) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      mode: 'run' as const,
      columns: [] as string[],
      rows: [] as Array<Record<string, SqliteValue>>,
      changes: 0,
      lastInsertRowid: null as number | null,
      truncated: false,
      error: 'SQL cannot be empty.'
    }
  }

  let db: SqliteDatabase | null = null
  try {
    db = new BetterSqlite3(resolvedPath.fullPath, { fileMustExist: false })
    const executeSingleStatement = () => {
      const prepared = db!.prepare(statement)
      if (prepared.reader) {
        const rawRows = prepared.all() as Array<Record<string, unknown>>
        const columns = prepared.columns().map((column: { name: string }) => String(column.name))
        const truncated = rawRows.length > SQLITE_MAX_QUERY_ROWS
        const rows = rawRows
          .slice(0, SQLITE_MAX_QUERY_ROWS)
          .map((rawRow) => {
            const normalizedRow: Record<string, SqliteValue> = {}
            for (const column of columns) {
              normalizedRow[column] = coerceSqliteValue(rawRow[column])
            }
            return normalizedRow
          })
        return {
          success: true,
          root: resolvedPath.rootPath,
          path,
          mode: 'rows' as const,
          columns,
          rows,
          changes: 0,
          lastInsertRowid: null as number | null,
          truncated
        }
      }

      const info = prepared.run() as { changes: number; lastInsertRowid: unknown }
      return {
        success: true,
        root: resolvedPath.rootPath,
        path,
        mode: 'run' as const,
        columns: [] as string[],
        rows: [] as Array<Record<string, SqliteValue>>,
        changes: Number(info.changes) || 0,
        lastInsertRowid: coerceLastInsertRowId(info.lastInsertRowid),
        truncated: false
      }
    }

    try {
      return executeSingleStatement()
    } catch (error) {
      const errorMessage = String(error || '')
      const isMultiStatementError =
        errorMessage.includes('contains more than one statement') ||
        errorMessage.includes('You can only execute one statement at a time')

      if (!isMultiStatementError) {
        throw error
      }

      db.exec(statement)
      const changesRow = db.prepare('SELECT changes() AS c').get() as { c?: unknown } | undefined
      const rowIdRow = db.prepare('SELECT last_insert_rowid() AS id').get() as { id?: unknown } | undefined
      return {
        success: true,
        root: resolvedPath.rootPath,
        path,
        mode: 'exec' as const,
        columns: [] as string[],
        rows: [] as Array<Record<string, SqliteValue>>,
        changes: Number(changesRow?.c ?? 0) || 0,
        lastInsertRowid: coerceLastInsertRowId(rowIdRow?.id),
        truncated: false
      }
    }
  } catch (error) {
    return {
      success: false,
      root: resolvedPath.rootPath,
      path,
      mode: 'run' as const,
      columns: [] as string[],
      rows: [] as Array<Record<string, SqliteValue>>,
      changes: 0,
      lastInsertRowid: null as number | null,
      truncated: false,
      error: getSafeSqliteError(error)
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error
    }
  }
}
