#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT_DIR = join(import.meta.dirname, '..')
const SCRIPT_PATH = join(ROOT_DIR, 'scripts', 'generate-changelog.js')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf-8'
  })

  if (!options.allowFailure) {
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }

  return result
}

function writeFile(targetPath, content) {
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, content, 'utf-8')
}

function commitAll(repoDir, message) {
  run('git', ['add', '.'], { cwd: repoDir })
  run('git', ['commit', '-m', message], { cwd: repoDir })
}

function createRepo() {
  const repoDir = mkdtempSync(join(tmpdir(), 'onward-changelog-generation-'))
  run('git', ['init'], { cwd: repoDir })
  run('git', ['config', 'user.name', 'Onward Tests'], { cwd: repoDir })
  run('git', ['config', 'user.email', 'onward-tests@example.com'], { cwd: repoDir })
  return repoDir
}

test('generate-changelog produces an English-only draft and chooses the nearest lower daily tag', () => {
  const repoDir = createRepo()

  try {
    writeFile(join(repoDir, 'notes.txt'), 'base\n')
    commitAll(repoDir, 'chore: bootstrap repository')
    run('git', ['tag', 'v2.0.0-daily.20260401.1'], { cwd: repoDir })

    writeFile(join(repoDir, 'notes.txt'), 'base\nfeature\n')
    commitAll(repoDir, 'feat: add searchable change log modal')

    writeFile(join(repoDir, 'notes.txt'), 'base\nfeature\nfix\n')
    commitAll(repoDir, 'fix: repair modal close handling')

    writeFile(join(repoDir, 'notes.txt'), 'base\nfeature\nfix\ndocs\n')
    commitAll(repoDir, 'docs(changelog): add release notes for v2.0.0-daily.20260402.1')

    run('git', ['tag', 'v2.1.0-daily.20260407.1'], { cwd: repoDir })

    const outputDir = join(repoDir, 'generated-output')
    const targetTag = 'v2.0.1-daily.20260406.1'
    const result = run(process.execPath, [SCRIPT_PATH, '--tag', targetTag, '--output', outputDir], { cwd: repoDir })

    assert.match(result.stdout, /Previous tag: v2\.0\.0-daily\.20260401\.1/)

    const markdownPath = join(outputDir, 'en', 'daily', `${targetTag}.md`)
    const htmlPath = join(outputDir, 'html', 'en', 'daily', `${targetTag}.html`)
    const indexPath = join(outputDir, 'index.json')
    const zhPath = join(outputDir, 'zh-CN', 'daily', `${targetTag}.md`)

    assert.equal(existsSync(markdownPath), true)
    assert.equal(existsSync(htmlPath), true)
    assert.equal(existsSync(indexPath), true)
    assert.equal(existsSync(zhPath), false)

    const markdown = readFileSync(markdownPath, 'utf-8')
    const html = readFileSync(htmlPath, 'utf-8')
    assert.match(markdown, /# Onward Daily Build v2\.0\.1-daily\.20260406\.1/)
    assert.match(markdown, /Changes since `v2\.0\.0-daily\.20260401\.1`\./)
    assert.match(markdown, /## New Features/)
    assert.match(markdown, /- add searchable change log modal/)
    assert.match(markdown, /## Bug Fixes/)
    assert.match(markdown, /- repair modal close handling/)
    assert.doesNotMatch(markdown, /release notes/i)
    assert.match(html, /<h1>Onward Daily Build v2\.0\.1-daily\.20260406\.1<\/h1>/)
    assert.match(html, /<h2>New Features<\/h2>/)
    assert.match(html, /repair modal close handling/)

    const index = JSON.parse(readFileSync(indexPath, 'utf-8'))
    assert.equal(index.entries.length, 1)
    assert.deepEqual(index.entries[0].markdown, {
      en: `en/daily/${targetTag}.md`
    })
    assert.deepEqual(index.entries[0].html, {
      en: `html/en/daily/${targetTag}.html`
    })
    assert.equal(index.entries[0].previousTag, 'v2.0.0-daily.20260401.1')
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('generate-changelog marks the first tagged build as an initial tagged release', () => {
  const repoDir = createRepo()

  try {
    writeFile(join(repoDir, 'README.md'), 'initial\n')
    commitAll(repoDir, 'feat: initial public entry point')

    const outputDir = join(repoDir, 'generated-output')
    const targetTag = 'v1.0.0-daily.20260401.1'
    run(process.execPath, [SCRIPT_PATH, '--tag', targetTag, '--output', outputDir], { cwd: repoDir })

    const markdownPath = join(outputDir, 'en', 'daily', `${targetTag}.md`)
    const htmlPath = join(outputDir, 'html', 'en', 'daily', `${targetTag}.html`)
    const indexPath = join(outputDir, 'index.json')
    const markdown = readFileSync(markdownPath, 'utf-8')
    const html = readFileSync(htmlPath, 'utf-8')
    const index = JSON.parse(readFileSync(indexPath, 'utf-8'))

    assert.match(markdown, /Initial tagged release\. Review and refine the sections below before publishing\./)
    assert.match(html, /Initial tagged release\. Review and refine the sections below before publishing\./)
    assert.equal(index.entries[0].previousTag, null)
    assert.equal(index.entries[0].tag, targetTag)
    assert.deepEqual(index.entries[0].html, {
      en: `html/en/daily/${targetTag}.html`
    })
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})
