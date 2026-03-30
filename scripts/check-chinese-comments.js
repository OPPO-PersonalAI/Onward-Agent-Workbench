#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const { execFileSync } = require('child_process')
const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')

const ROOT = resolve(__dirname, '..')
const HAN_RE = /\p{Script=Han}/u
const BINARY_RE = /\0/
const ALLOWLIST = new Set([
  'src/i18n/core.ts',
  // Historical lessons are maintained in Chinese for the local team.
  'docs/lessons.md',
  // Test files may contain Chinese strings as test data (not comments)
  'test/test-full-e2e.ts',
  'test/test-prompt-integrity.ts'
])
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.md',
  '.svg',
  '.sh',
  '.ps1',
  '.json',
  '.yml',
  '.yaml',
  '.d.ts'
])
const EXTRA_TEXT_FILES = new Set([
  'CLAUDE.md',
  'AGENTS.md',
  '.gitignore',
  '.npmrc',
  'pnpm-lock.yaml'
])

function getTrackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf-8'
  })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
}

function isTextFile(relPath) {
  if (EXTRA_TEXT_FILES.has(relPath)) return true
  const lastDot = relPath.lastIndexOf('.')
  if (lastDot === -1) return false
  return TEXT_EXTENSIONS.has(relPath.slice(lastDot))
}

function isBinaryText(content) {
  return BINARY_RE.test(content.slice(0, 4096))
}

function scanText(relPath) {
  if (ALLOWLIST.has(relPath)) {
    return []
  }

  const absolutePath = resolve(ROOT, relPath)
  if (!existsSync(absolutePath)) {
    return []
  }

  const content = readFileSync(absolutePath, 'utf-8')
  if (isBinaryText(content)) {
    return []
  }

  const hits = []
  const lines = content.split('\n')
  lines.forEach((lineText, index) => {
    if (!HAN_RE.test(lineText)) return
    hits.push({
      file: relPath,
      line: index + 1,
      snippet: lineText.trim()
    })
  })
  return hits
}

function main() {
  const files = getTrackedFiles().filter(isTextFile)
  const hits = files.flatMap(scanText)

  if (hits.length === 0) {
    console.log('[project-text-lint] Passed: no Simplified Chinese text found outside the locale dictionary allowlist.')
    return
  }

  console.error('[project-text-lint] Failed: Simplified Chinese text is only allowed in src/i18n/core.ts.')
  for (const hit of hits) {
    console.error(`${hit.file}:${hit.line}: ${hit.snippet}`)
  }
  process.exit(1)
}

main()
