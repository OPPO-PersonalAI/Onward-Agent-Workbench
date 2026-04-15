#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Static verification: subpage task line (larger type, no chrome, no "Task:"
 * prefix), production renderer bundle matches.
 *
 * Usage: run after `pnpm dist:dev` or `pnpm build` so out/renderer/assets exists.
 */

const fs = require('fs')
const path = require('path')

function fail(message) {
  console.error(`verify-subpage-task-chip: FAIL — ${message}`)
  process.exit(1)
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

const repoRoot = path.join(__dirname, '..')

const sourceFiles = [
  'src/components/SubpageSwitcher/SubpagePanelShell.tsx',
  'src/components/SubpageSwitcher/subpageTaskSource.css',
  'src/components/ProjectEditor/ProjectEditor.tsx',
  'src/components/GitDiffViewer/GitDiffViewer.tsx',
  'src/components/GitHistoryViewer/GitHistoryViewer.tsx',
  'src/i18n/core.ts'
]

for (const rel of sourceFiles) {
  const fp = path.join(repoRoot, rel)
  if (!fs.existsSync(fp)) fail(`missing source file: ${rel}`)
  const text = readUtf8(fp)
  if (text.includes('subpage-task-source-prefix')) {
    fail(`${rel} still references subpage-task-source-prefix`)
  }
  if (text.includes('subpageShell.taskSourceLabel') || text.includes('taskSourceLabel')) {
    fail(`${rel} still references taskSourceLabel`)
  }
}

const shell = readUtf8(path.join(repoRoot, 'src/components/SubpageSwitcher/SubpagePanelShell.tsx'))
if (!shell.includes('subpage-task-source-name')) {
  fail('SubpagePanelShell.tsx must render subpage-task-source-name')
}
if (!shell.includes('className="subpage-task-source"')) {
  fail('SubpagePanelShell.tsx must use subpage-task-source wrapper')
}

const cssSrc = readUtf8(path.join(repoRoot, 'src/components/SubpageSwitcher/subpageTaskSource.css'))
if (!cssSrc.includes('width: max-content') || !cssSrc.includes('max-width: 100%')) {
  fail('subpageTaskSource.css must size chip with max-content / max-width 100%')
}
if (!cssSrc.includes('font-size: var(--font-lg)')) {
  fail('subpageTaskSource.css must use font-lg for task name prominence')
}
if (cssSrc.includes('border-left:') || cssSrc.includes('border: 1px')) {
  fail('subpageTaskSource.css must not use boxed chrome (no border-left / 1px frame)')
}

const assetsDir = path.join(repoRoot, 'out', 'renderer', 'assets')
if (!fs.existsSync(assetsDir)) {
  fail('out/renderer/assets missing — run pnpm dist:dev (or pnpm build) first')
}

const jsChunks = fs.readdirSync(assetsDir).filter((f) => f.startsWith('index-') && f.endsWith('.js'))
const cssChunks = fs.readdirSync(assetsDir).filter((f) => f.startsWith('index-') && f.endsWith('.css'))
if (jsChunks.length === 0) fail('no index-*.js chunks under out/renderer/assets')
if (cssChunks.length === 0) fail('no index-*.css chunks under out/renderer/assets')

const bundledJs = jsChunks.map((f) => readUtf8(path.join(assetsDir, f))).join('\n')
const bundledCss = cssChunks.map((f) => readUtf8(path.join(assetsDir, f))).join('\n')

if (bundledJs.includes('subpage-task-source-prefix')) {
  fail('renderer bundle still contains class name subpage-task-source-prefix')
}
if (bundledJs.includes('taskSourceLabel')) {
  fail('renderer bundle still contains taskSourceLabel')
}
if (!bundledJs.includes('subpage-task-source-name')) {
  fail('renderer bundle missing subpage-task-source-name (chip not shipped)')
}

if (!bundledCss.includes('.subpage-task-source')) {
  fail('renderer CSS bundle missing .subpage-task-source')
}
if (bundledCss.includes('.subpage-task-source-prefix')) {
  fail('renderer CSS bundle still defines .subpage-task-source-prefix')
}
if (!bundledCss.includes('max-content')) {
  fail('renderer CSS bundle missing max-content (chip width rule missing)')
}

console.log('verify-subpage-task-chip: OK (source + out/renderer/assets)')
console.log(`  checked ${sourceFiles.length} source files, ${jsChunks.length} JS + ${cssChunks.length} CSS chunks`)
