/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/sensitive-info-scanner.test.mts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  decodeEscapes,
  containsChinese
} = require('../../scripts/check-chinese-comments.js')
const {
  decodeObfuscatedText,
  scanLineForSensitiveInfo,
  scanTextContent,
  scanTarBuffer,
  scanTarGzBuffer,
  validateGitAuthorIdentity,
  scanCommitMessageText
} = require('../../scripts/check-sensitive-info.js')

// Join fragments at runtime so this test file itself never contains raw
// forbidden tokens in static source text.
const p = (...parts: string[]): string => parts.join('')

test('check-chinese-comments: detects literal and Unicode/HTML-escaped Han characters', () => {
  assert.equal(containsChinese('// Pure English comment'), false)
  assert.equal(containsChinese('const x = "hello world"'), false)

  // Literal Chinese constructed via codePoint
  const literalHan = String.fromCodePoint(0x4e2d, 0x6587)
  assert.equal(containsChinese(`// ${literalHan}`), true)

  // Escaped Unicode \uXXXX and \u{XXXXX}
  assert.equal(containsChinese(p('// \\u4e', '2d\\u65', '87')), true)
  assert.equal(containsChinese(p('// \\u{4e', '2d}')), true)

  // HTML hex and decimal numeric character references
  assert.equal(containsChinese(p('<span>&#x4e', '2d;</span>')), true)
  assert.equal(containsChinese(p('<span>&#20', '013;</span>')), true)
  assert.equal(decodeEscapes(p('\\u4e', '2d\\u65', '87')), literalHan)
})

test('check-sensitive-info Category 1: flags real local OS user paths and allows generic placeholders', () => {
  const blockedPaths = [
    p('D:\\Users\\', '8025', '3146\\Projects\\repo'),
    p('D:/Users/', '8025', '3146/Projects/repo'),
    p('C:\\Users\\', 'w907', '7731\\AppData\\Local'),
    p('/Users/', 'ying', 'yun/Projects/repo'),
    p('/Users/', 'realperson/workspace/project'),
    p('/home/', 'realperson/workspace/project'),
    p('D:/Users/', 'Documents/repo'),
    p('Y:\\oppo_', 'W907', '7731\\workspace')
  ]

  for (const sample of blockedPaths) {
    const hits = scanLineForSensitiveInfo(sample)
    assert.ok(
      hits.length > 0,
      `Expected path "${sample}" to be flagged as sensitive, but got 0 hits`
    )
  }

  const allowedPaths = [
    'C:\\Users\\example\\Projects\\repo',
    'D:/Users/user/Documents/repo',
    '/Users/me/Projects/animation',
    '/Users/dev/real-repo',
    '/Users/test/Projects/repo',
    '/Users/someone/private/repo',
    '/Users/x/file.html',
    '/Users/.../foo/bar',
    '/Users/<username>/Projects',
    '/home/me/.config',
    '/home/x/work'
  ]

  for (const sample of allowedPaths) {
    const hits = scanLineForSensitiveInfo(sample)
    assert.deepEqual(
      hits,
      [],
      `Expected placeholder path "${sample}" to be allowed, but got: ${JSON.stringify(hits)}`
    )
  }
})

test('check-sensitive-info Category 2–4: flags employee IDs, internal projects, and EDR vendor tokens', () => {
  const blockedTokens = [
    p('8025', '3146'),
    p('w907', '7731'),
    p('user@adc', '.com'),
    p('https://gitlab.', 'oppo.com/group/repo'),
    p('tested by ', 'lan', 'xi on macOS'),
    p('author ', 'ying', 'yun'),
    p('OPPO', '-KAR'),
    p('KAR-Game', '-Develop'),
    p('kar', '-qemu'),
    p('kar', 'qemu'),
    p('src/third_party/', 'KAR/.git/index.lock'),
    p('kar_air', '_control.py'),
    p('winWatch', 'RTOS-Build'),
    p('RTOS-', 'stablity'),
    p('win-rtos-build', '-worktree_fable'),
    p('origin/kae', '-0.36'),
    p('kae_', 'compiler'),
    p('kae-', 'feature'),
    p('wf-', 'ai'),
    p('wf_', 'tool'),
    p('Onward_report', '_material'),
    p('Project_', 'Forward'),
    p('Project%20', 'Forward'),
    p('Battle', 'Project'),
    p('Project_Books_', 'Translation'),
    p('Dark_PDF', '_Reader'),
    p('Project_', 'ASR'),
    p('Project_', 'Onward2'),
    p('Onward-', 'Github'),
    p('Microsoft In', 'tune policy'),
    p('Sang', 'for EDR driver'),
    p('a', 'Trust agent'),
    p('Isa', 'Agent filter')
  ]

  for (const token of blockedTokens) {
    const hits = scanLineForSensitiveInfo(token)
    assert.ok(
      hits.length > 0,
      `Expected token "${token}" to be flagged, but got 0 hits`
    )
  }

  const allowedStrings = [
    'SPDX-FileCopyrightText: 2026 OPPO',
    'https://github.com/OPPO-PersonalAI/Onward-Agent-Workbench.git',
    'developer@oppo.com',
    'src/third_party/sublib/.git/index.lock',
    'endpoint-security filter driver and device management policy'
  ]

  for (const safe of allowedStrings) {
    const hits = scanLineForSensitiveInfo(safe)
    assert.deepEqual(
      hits,
      [],
      `Expected safe string "${safe}" to pass, but got: ${JSON.stringify(hits)}`
    )
  }
})

test('check-sensitive-info obfuscation decoding: catches Unicode, hex, HTML entity, and URL-escaped leaks', () => {
  // Unicode-escaped employee ID
  const unicodeEscaped = p('\\u0038\\u0030\\u0032\\u0035', '\\u0033\\u0031\\u0034\\u0036')
  assert.ok(scanLineForSensitiveInfo(unicodeEscaped).length > 0)

  // Hex-escaped submodule name
  const hexEscaped = p('\\x6b\\x61\\x72\\x2d', '\\x71\\x65\\x6d\\x75')
  assert.ok(scanLineForSensitiveInfo(hexEscaped).length > 0)

  // HTML-entity-escaped vendor name
  const htmlEntityEscaped = p('&#x49;&#x6e;&#x74;', '&#x75;&#x6e;&#x65;')
  assert.ok(decodeObfuscatedText(htmlEntityEscaped).length > 0)
  assert.ok(scanLineForSensitiveInfo(htmlEntityEscaped).length > 0)
})

function buildSyntheticTarBlock(options: {
  name?: string
  uidOctal?: string
  gidOctal?: string
  uname?: string
  gname?: string
  payload?: string
}): Buffer {
  const payloadBuf = Buffer.from(options.payload ?? 'clean content\n', 'utf-8')
  const dataBlocks = Math.ceil(payloadBuf.length / 512)
  const total = Buffer.alloc((1 + dataBlocks + 2) * 512, 0)

  total.write(options.name ?? 'repo/README.md', 0, 100, 'ascii')
  total.write('0000644\0', 100, 8, 'ascii')
  total.write(options.uidOctal ?? '0000000\0', 108, 8, 'ascii')
  total.write(options.gidOctal ?? '0000000\0', 116, 8, 'ascii')
  total.write(`${payloadBuf.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  total.write('00000000000\0', 136, 12, 'ascii')
  total.write('0', 156, 1, 'ascii')
  total.write('ustar\0', 257, 6, 'ascii')
  total.write('00', 263, 2, 'ascii')
  if (options.uname) {
    total.write(options.uname, 265, 32, 'ascii')
  }
  if (options.gname) {
    total.write(options.gname, 297, 32, 'ascii')
  }

  payloadBuf.copy(total, 512)
  return total
}

test('check-sensitive-info Category 5: inspects tar/tar.gz ustar headers and inner payloads', () => {
  const cleanTar = buildSyntheticTarBlock({})
  assert.deepEqual(scanTarBuffer(cleanTar, 'clean.tar'), [])

  const leakedUnameTar = buildSyntheticTarBlock({
    uname: p('8025', '3146')
  })
  const unameFindings = scanTarBuffer(leakedUnameTar, 'leaked-uname.tar')
  assert.ok(unameFindings.some((f: { ruleId: string }) => f.ruleId === 'tar-ustar-uname'))

  const leakedUidTar = buildSyntheticTarBlock({
    uidOctal: '0001750\0'
  })
  const uidFindings = scanTarBuffer(leakedUidTar, 'leaked-uid.tar')
  assert.ok(uidFindings.some((f: { ruleId: string }) => f.ruleId === 'tar-ustar-uid'))

  const leakedPayloadGz = zlib.gzipSync(
    buildSyntheticTarBlock({
      payload: p('path = D:\\Users\\', '8025', '3146\\Projects\n')
    })
  )
  const payloadFindings = scanTarGzBuffer(leakedPayloadGz, 'leaked-payload.tar.gz')
  assert.ok(payloadFindings.length > 0)
})

test('check-sensitive-info Category 5: any materialized git-state-mirror-latency .tar.gz fixtures and temporary .tar.gz files are scanned accurately', () => {
  const { existsSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs')
  const { tmpdir } = require('node:os')

  const fixtureDir = resolve(
    import.meta.dirname,
    '../autotest/fixtures/git-state-mirror-latency'
  )
  const archives = existsSync(fixtureDir)
    ? readdirSync(fixtureDir).filter((f) => f.endsWith('.tar.gz'))
    : []

  for (const archive of archives) {
    const fullPath = join(fixtureDir, archive)
    const findings = scanTarGzBuffer(readFileSync(fullPath), archive)
    assert.deepEqual(
      findings,
      [],
      `Expected fixture archive ${archive} to have sanitized ustar headers and clean payload, got: ${JSON.stringify(findings)}`
    )
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), 'onward-tar-scan-test-'))
  try {
    const cleanPath = join(tmpRoot, 'clean.tar.gz')
    const cleanGz = zlib.gzipSync(buildSyntheticTarBlock({ payload: 'clean content\n' }))
    writeFileSync(cleanPath, cleanGz)
    assert.deepEqual(scanTarGzBuffer(readFileSync(cleanPath), 'clean.tar.gz'), [])

    const dirtyPath = join(tmpRoot, 'dirty.tar.gz')
    const dirtyGz = zlib.gzipSync(
      buildSyntheticTarBlock({
        uname: p('8025', '3146'),
        payload: p('path = D:\\Users\\', '8025', '3146\\Projects\n')
      })
    )
    writeFileSync(dirtyPath, dirtyGz)
    assert.ok(scanTarGzBuffer(readFileSync(dirtyPath), 'dirty.tar.gz').length > 0)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('check-sensitive-info Category 6: validates git author identity and commit messages', () => {
  // Allowed identities (@oppo.com and @users.noreply.github.com with non-ID names)
  assert.equal(
    validateGitAuthorIdentity({
      name: 'Onward Developer',
      email: 'developer@oppo.com'
    }).ok,
    true
  )
  assert.equal(
    validateGitAuthorIdentity({
      name: 'Alice',
      email: 'alice@users.noreply.github.com'
    }).ok,
    true
  )

  // Blocked identities: empty, employee ID, contractor ID, internal domain, blocked handle
  assert.equal(validateGitAuthorIdentity({ name: '', email: 'dev@oppo.com' }).ok, false)
  assert.equal(
    validateGitAuthorIdentity({
      name: p('8025', '3146'),
      email: 'dev@oppo.com'
    }).ok,
    false
  )
  assert.equal(
    validateGitAuthorIdentity({
      name: 'Developer',
      email: p('8025', '3146@oppo.com')
    }).ok,
    false
  )
  assert.equal(
    validateGitAuthorIdentity({
      name: 'Developer',
      email: p('dev@adc', '.com')
    }).ok,
    false
  )
  assert.equal(
    validateGitAuthorIdentity({
      name: p('ying', 'yun'),
      email: 'dev@example.com'
    }).ok,
    false
  )

  // Commit messages
  assert.equal(
    scanCommitMessageText('fix(git): deduplicate submodule status refresh\n\n# comment line').ok,
    true
  )
  assert.equal(
    scanCommitMessageText(
      `fix(git): ${String.fromCodePoint(0x4fee, 0x590d)} submodule status`
    ).ok,
    false
  )
  assert.equal(
    scanCommitMessageText(
      p('fix(git): optimize ', 'kar', '-qemu diff cache')
    ).ok,
    false
  )
  assert.equal(
    scanCommitMessageText(
      p('test: reproduce on D:/Users/', '8025', '3146/repo')
    ).ok,
    false
  )
})

test('scanTextContent reports accurate 1-based line numbers and enforces file path rules', () => {
  const {
    isTextFilePath,
    scanFilePathForForbiddenRules
  } = require('../../scripts/check-sensitive-info.js')

  const text = [
    'line 1 is clean',
    p('line 2 leaks ', 'OPPO', '-KAR'),
    'line 3 is clean'
  ].join('\n')
  const findings = scanTextContent(text, 'sample.ts')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].file, 'sample.ts')
  assert.equal(findings[0].line, 2)

  // Dotfiles, extensionless scripts, and uncommon text extensions are scanned as text
  assert.equal(isTextFilePath('.gitignore'), true)
  assert.equal(isTextFilePath('resources/shell-integration/zsh/.zshrc'), true)
  assert.equal(isTextFilePath('.husky/pre-commit'), true)
  assert.equal(isTextFilePath('resources/icons/app.png'), false)
  assert.equal(isTextFilePath('test/autotest/fixtures/git-state-mirror-latency/repo-A.tar.gz'), false)

  // Forbidden root handoff HTML files and ow_log_analysis artifacts are blocked by path rule even if content is empty
  assert.ok(
    scanFilePathForForbiddenRules('HANDOFF.html').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-handoff-file'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules('HANDOFF-2.html').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-handoff-file'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules(
      p('Logs/reports/onward-diagnostic-', '2026-07-21_17-36-04-scrollback.html')
    ).some((f: { ruleId: string }) => f.ruleId === 'forbidden-logs-dir')
  )
  assert.ok(
    scanFilePathForForbiddenRules('./Logs/reports/report.html').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-logs-dir'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules('docs/bug-tracking/INDEX.md').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-bug-tracking-artifact'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules('bug-tracking/INDEX.md').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-bug-tracking-artifact'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules('docs/bug-tracking/BUG-0001-codex-tui-scrollback-invisible.md').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-bug-tracking-artifact'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules('docs/html/BUG-0001-report.html').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-bug-tracking-artifact'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules(
      p('docs/html/onward-diagnostic-', '2026-07-21_17-36-04-report.html')
    ).some((f: { ruleId: string }) => f.ruleId === 'forbidden-diagnostic-bundle-or-report')
  )
  assert.ok(
    scanFilePathForForbiddenRules(
      p('onward-diagnostic-', '2026-07-21_17-36-04.zip')
    ).some((f: { ruleId: string }) => f.ruleId === 'forbidden-diagnostic-bundle-or-report')
  )
  assert.ok(
    scanFilePathForForbiddenRules('onward-diagnostic-custom.zip').some(
      (f: { ruleId: string }) => f.ruleId === 'forbidden-diagnostic-bundle-or-report'
    )
  )
  assert.ok(
    scanFilePathForForbiddenRules(
      p('onward-diagnostic-', '2026-07-21_17-36-04/README.txt')
    ).some((f: { ruleId: string }) => f.ruleId === 'forbidden-diagnostic-bundle-or-report')
  )
  assert.ok(
    scanTextContent(
      p('Analyzed bundle onward-diagnostic-', '2026-07-21_17-36-04.zip'),
      'docs/html/renamed-report.html'
    ).some((f: { ruleId: string }) => f.ruleId === 'diagnostic-bundle-filename')
  )
  assert.deepEqual(scanFilePathForForbiddenRules('docs/html/architecture.html'), [])
  assert.deepEqual(scanFilePathForForbiddenRules('electron/main/diagnostic-bundle.ts'), [])
})
