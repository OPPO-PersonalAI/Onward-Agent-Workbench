/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('fs')
const { dirname, extname, join, relative, resolve } = require('path')
const { marked } = require('marked')

const RICH_RELEASE_NOTE_SENTINEL = '<!-- onward-rich-release-note -->'

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function writeFile(path, content) {
  ensureDir(dirname(path))
  // Idempotent write: skip when the on-disk content is already byte-identical, so an
  // unchanged rebuild does not bump the file mtime and spuriously mark it modified in
  // git.
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf-8') === content) return
    } catch {
      // fall through to write on any read error
    }
  }
  writeFileSync(path, content, 'utf-8')
}

function readJsonFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf-8'))
  return parsed && typeof parsed === 'object' ? parsed : {}
}

function toHtmlRelativePath(markdownRelativePath) {
  const normalized = String(markdownRelativePath || '').replace(/\\/g, '/').replace(/^\//, '')
  const extension = extname(normalized)
  const withoutExtension = extension ? normalized.slice(0, -extension.length) : normalized
  return join('html', `${withoutExtension}.html`).replace(/\\/g, '/')
}

function renderMarkdownToHtml(markdown) {
  return marked.parse(markdown, {
    async: false,
    gfm: true
  })
}

function removeEmptyDirs(dirPath, stopAtRoot) {
  if (!existsSync(dirPath)) return
  for (const name of readdirSync(dirPath)) {
    const child = join(dirPath, name)
    if (statSync(child).isDirectory()) {
      removeEmptyDirs(child, stopAtRoot)
    }
  }
  if (resolve(dirPath) !== resolve(stopAtRoot) && readdirSync(dirPath).length === 0) {
    rmSync(dirPath, { recursive: true, force: true })
  }
}

function pruneChangelogFiles(changelogRoot, allowedRelativePaths) {
  const rootResolved = resolve(changelogRoot)
  if (!existsSync(rootResolved)) return 0

  const keepSet = new Set(
    [...allowedRelativePaths, 'index.json'].map((rel) =>
      resolve(rootResolved, String(rel).replace(/\\/g, '/'))
    )
  )

  let removedCount = 0
  function walk(currentDir) {
    for (const name of readdirSync(currentDir)) {
      const fullPath = join(currentDir, name)
      const st = statSync(fullPath)
      if (st.isDirectory()) {
        walk(fullPath)
      } else if (!keepSet.has(resolve(fullPath))) {
        rmSync(fullPath, { force: true })
        removedCount += 1
      }
    }
  }

  walk(rootResolved)
  removeEmptyDirs(rootResolved, rootResolved)
  return removedCount
}

function compileChangelogAssets(changelogRoot) {
  const indexPath = join(changelogRoot, 'index.json')
  if (!existsSync(indexPath)) {
    throw new Error(`Missing changelog index: ${indexPath}`)
  }

  const index = readJsonFile(indexPath)
  const entries = Array.isArray(index.entries) ? index.entries : []
  let compiledCount = 0

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const markdown = entry.markdown && typeof entry.markdown === 'object' ? entry.markdown : null
    if (!markdown || typeof markdown.en !== 'string') continue

    const nextHtml = {}
    for (const [locale, markdownRelativePath] of Object.entries(markdown)) {
      if (typeof markdownRelativePath !== 'string' || !markdownRelativePath.trim()) continue
      const markdownPath = join(changelogRoot, markdownRelativePath)
      if (!existsSync(markdownPath)) {
        throw new Error(`Missing changelog markdown: ${markdownPath}`)
      }
      const configuredHtmlRel =
        entry.html && typeof entry.html === 'object' && typeof entry.html[locale] === 'string'
          ? entry.html[locale].replace(/\\/g, '/')
          : toHtmlRelativePath(markdownRelativePath)
      const htmlPath = join(changelogRoot, configuredHtmlRel)

      let preserveRichHtml = false
      if (existsSync(htmlPath)) {
        try {
          const existingHtml = readFileSync(htmlPath, 'utf-8')
          if (existingHtml.includes(RICH_RELEASE_NOTE_SENTINEL)) {
            preserveRichHtml = true
          }
        } catch {
          preserveRichHtml = false
        }
      }

      if (!preserveRichHtml) {
        const markdownContent = readFileSync(markdownPath, 'utf-8')
        const htmlContent = renderMarkdownToHtml(markdownContent)
        writeFile(htmlPath, `${htmlContent.trim()}\n`)
      }

      nextHtml[locale] = relative(changelogRoot, htmlPath).replace(/\\/g, '/')
      compiledCount += 1
    }

    if (Object.keys(nextHtml).length > 0) {
      entry.html = nextHtml
    }
  }

  const activeRelativePaths = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    for (const rel of Object.values(entry.markdown || {})) {
      if (typeof rel === 'string' && rel.trim()) activeRelativePaths.push(rel)
    }
    for (const rel of Object.values(entry.html || {})) {
      if (typeof rel === 'string' && rel.trim()) activeRelativePaths.push(rel)
    }
  }

  writeFile(indexPath, `${JSON.stringify({ entries }, null, 2)}\n`)
  if (activeRelativePaths.length > 0) {
    pruneChangelogFiles(changelogRoot, activeRelativePaths)
  }
  return { compiledCount, entries: entries.length, indexPath }
}

module.exports = {
  RICH_RELEASE_NOTE_SENTINEL,
  compileChangelogAssets,
  pruneChangelogFiles,
  toHtmlRelativePath,
  writeFile
}
