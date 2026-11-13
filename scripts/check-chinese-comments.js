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
  'src/i18n/prompt-input.ts',
  'src/i18n/prompt-input-runtime.ts',
  'src/i18n/theme-schedule.ts',
  'src/i18n/settings-save.ts',
  // Generated bilingual Emojibase labels/keywords are dictionary data, not code comments.
  'src/data/prompt-emoji-catalog.json',
  // Test files may contain Chinese strings as test data (not comments)
  'test/autotest/test-full-e2e.ts',
  'test/autotest/test-prompt-integrity.ts',
  // CDP prompt-editor drivers type real Chinese IME input / assert on Chinese
  // round-trips, so the Han characters are required test data, not comments.
  'test/autotest/prompt-ime-latency-driver.mjs',
  'test/autotest/prompt-contenteditable-editing-driver.mjs',
  // Theme UI tests assert bilingual search labels and Unicode file paths.
  'test/autotest/test-themes-ui.mjs',
  'test/autotest/themes-ui-driver-support.mjs',
  // Prompt fixtures preserve literal Unicode for migration, IME and bilingual UI assertions.
  'test/autotest/fixtures/prompt-input-settings/acceptance.json',
  'test/autotest/fixtures/prompt-input-settings/legacy-settings-v9.json',
  'test/autotest/fixtures/prompt-input-shortcuts/guest-input.html',
  'test/autotest/fixtures/prompt-input-shortcuts/caret-draft.json',
  'test/autotest/fixtures/prompt-input-shortcuts/crowded-tabs.json',
  'test/autotest/fixtures/prompt-capture-stdin.cjs',
  'test/autotest/prompt-input-shortcuts-driver.mjs',
  'test/autotest/test-git-state-mirror-quit-cdp.mjs',
  'src/autotest/test-prompt-sender.ts',
  'src/autotest/test-prompt-list.ts',
  'src/autotest/test-markdown-latex-preview.ts',
  'src/autotest/test-change-log.ts',
  'test/unittest/prompt-input-shortcuts-main.test.mjs',
  'test/unittest/git-diff-hunk-actions.test.mts',
  'test/unittest/prompt-input-transaction.test.mts',
  'test/unittest/prompt-input-labels.test.mts',
  'test/unittest/prompt-input-history.test.mts',
  'test/unittest/prompt-input.test.mts',
  'test/unittest/sensitive-info-scanner.test.mts',
  // Project instruction files may quote Chinese phrases from user usage.
  'CLAUDE.md',
  'AGENTS.md'
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

function decodeEscapes(input) {
  return String(input)
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => {
      const cp = parseInt(hex, 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : _
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, hex) => {
      const cp = parseInt(hex, 16)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : _
    })
    .replace(/&#([0-9]{1,7});/g, (_, dec) => {
      const cp = parseInt(dec, 10)
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : _
    })
}

function containsChinese(text) {
  if (HAN_RE.test(text)) return true
  const decoded = decodeEscapes(text)
  return HAN_RE.test(decoded)
}

function isAllowlistedPath(relPath) {
  if (ALLOWLIST.has(relPath)) return true
  // Local skill definitions are project documentation, not product copy.
  if (relPath.startsWith('.claude/skills/')) return true
  // Vendored pdf.js ships Unicode normalization ranges that include Han
  // script blocks; it is third-party code we don't modify.
  if (relPath.startsWith('resources/pdfjs/')) return true
  // Regression reports are engineering logs that may quote Chinese from
  // CLAUDE.md / AGENTS.md or user-facing failure snapshots.
  if (relPath.startsWith('test/report/')) return true
  // Engineering / architecture docs may be authored bilingually; the
  // single-language constraint that applies to product UI copy is
  // intentionally relaxed here so design write-ups can use the natural
  // language for the audience. This also covers docs/html/ — the canonical
  // output dir for user-requested HTML interpretation docs (see CLAUDE.md).
  if (relPath.startsWith('docs/')) return true
  // The metrics report renderer embeds the reader-facing Chinese report
  // template (the generated HTML is the same document category as
  // docs/html/, it just lives in gitignored traces/metrics/). Code comments
  // in this file remain English per the repo rule; only the template
  // literals carry Chinese copy.
  if (relPath === 'scripts/metrics/build-metrics-report.mjs') return true
  // Bilingual release-note HTML showcases and their autotest fixtures carry both en and zh-CN copy.
  if (relPath.startsWith('resources/changelog/html/') || relPath.startsWith('test/autotest/fixtures/change-log/')) return true
  return false
}

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
  if (isAllowlistedPath(relPath)) {
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
    if (!containsChinese(lineText)) return
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

if (require.main === module) {
  main()
}

module.exports = {
  decodeEscapes,
  containsChinese,
  isAllowlistedPath,
  scanText
}

