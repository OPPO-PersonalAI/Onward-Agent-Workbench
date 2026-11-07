/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage: node --experimental-strip-types --test test/unittest/terminal-file-drop.test.mts
 *
 * Comprehensive unit test suite for dragging OS files/folders into a terminal pane:
 *   - TFD-U-01: external vs internal DataTransfer classification
 *   - TFD-U-02: synchronous File -> path extraction (preload webUtils + synthetic fallback + Linux text/uri-list)
 *   - TFD-U-03: clean file & folder paths stay unquoted across macOS/Linux/Windows & POSIX/PowerShell/CMD
 *   - TFD-U-04: whitespace combinations (ASCII spaces, tabs, newlines, Unicode NBSP/full-width spaces)
 *   - TFD-U-05: leading dash, tilde, and Unicode dash hazards (-rf, --help, ~user, en-dash/em-dash)
 *   - TFD-U-06: shell metacharacters, globs, brackets, braces, subshells, and injection vectors
 *   - TFD-U-07: embedded ASCII quotes and Unicode curly/smart quotes across POSIX, PowerShell, and CMD
 *   - TFD-U-08: cross-platform separator & UNC & trailing-backslash combinations (Git Bash on Win, pwsh on macOS/Linux, CMD trailing slash)
 *   - TFD-U-09: Unicode file & folder names (CJK, Japanese, Korean, Emoji, macOS APFS NFD decomposed)
 *   - TFD-U-10: multi-item batches (mixed clean/spaced files + folders, empty filtering, trailing space)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractDroppedFilePaths,
  formatDroppedFilePathForShell,
  formatDroppedFilePathsForShell,
  hasExternalFilesInDataTransfer,
  needsShellPathQuoting,
  parseFileUriList,
  resolveEffectiveShellFamily
} from '../../src/utils/terminal-file-drop.ts'

test('TFD-U-01: hasExternalFilesInDataTransfer accepts OS file drags and rejects internal drags', () => {
  assert.equal(hasExternalFilesInDataTransfer(null), false)
  assert.equal(hasExternalFilesInDataTransfer(undefined), false)
  assert.equal(hasExternalFilesInDataTransfer({ types: [] }), false)
  assert.equal(hasExternalFilesInDataTransfer({ types: ['text/plain'] }), false)
  assert.equal(
    hasExternalFilesInDataTransfer({ types: ['application/x-onward-quick-file', 'text/plain'] }),
    false
  )
  assert.equal(
    hasExternalFilesInDataTransfer({ types: ['application/x-onward-quick-file', 'Files'] }),
    false
  )
  assert.equal(hasExternalFilesInDataTransfer({ types: ['Files'] }), true)
  assert.equal(hasExternalFilesInDataTransfer({ types: ['text/uri-list', 'Files'] }), true)
})

test('TFD-U-02: extractDroppedFilePaths supports preload resolver, file.path fallback, and Linux/Win text/uri-list', () => {
  const fileA = { name: 'a.txt', path: '/fallback/a.txt' } as unknown as File
  const fileB = { name: 'b.txt', path: '/fallback/b.txt' } as unknown as File
  const fileEmpty = { name: 'empty.txt' } as unknown as File

  const viaResolver = extractDroppedFilePaths([fileA, fileB, fileEmpty], (f) => {
    if (f === fileA) return '/resolved/a.txt'
    return ''
  })
  assert.deepEqual(viaResolver, ['/resolved/a.txt', '/fallback/b.txt'])

  const throwingResolver = extractDroppedFilePaths([fileA], () => {
    throw new Error('preload unavailable')
  })
  assert.deepEqual(throwingResolver, ['/fallback/a.txt'])

  // Linux X11/Wayland RFC 2483 text/uri-list fallback (with comments, spaces, UTF-8, and non-file URLs)
  const linuxUriList = [
    '# comment line from Nautilus',
    'file:///home/dev/clean-folder',
    'file://localhost/home/dev/My%20Documents/%E6%B5%8B%E8%AF%95%20(1).md',
    'https://example.com/ignored'
  ].join('\r\n')
  assert.deepEqual(
    extractDroppedFilePaths([fileEmpty], () => '', {
      uriListText: linuxUriList,
      platform: 'linux'
    }),
    ['/home/dev/clean-folder', '/home/dev/My Documents/测试 (1).md']
  )

  // Windows file:// URI parsing (drive letter + UNC share)
  const winUriList = [
    'file:///D:/Users/dev/My%20Project/main.ts',
    'file://fileserver/Shared%20Folder/spec.pdf'
  ].join('\r\n')
  assert.deepEqual(parseFileUriList(winUriList, 'win32'), [
    'D:\\Users\\dev\\My Project\\main.ts',
    '\\\\fileserver\\Shared Folder\\spec.pdf'
  ])
})

test('TFD-U-03: clean file and folder paths stay unquoted across all platforms and shells', () => {
  assert.equal(resolveEffectiveShellFamily('darwin', 'unknown'), 'posix')
  assert.equal(resolveEffectiveShellFamily('linux', undefined), 'posix')
  assert.equal(resolveEffectiveShellFamily('win32', 'unknown'), 'powershell')
  assert.equal(resolveEffectiveShellFamily('win32', 'cmd'), 'cmd')
  assert.equal(resolveEffectiveShellFamily('darwin', 'powershell'), 'powershell')

  const posixCleanCases = [
    '/Users/dev/project/src/main.ts',
    '/Users/dev/project/folder-name_v2.1',
    '/Applications/VisualStudioCode.app',
    '/Volumes/External_SSD/data/archive.tar.gz',
    '/home/ubuntu/.config/nvim/init.lua',
    '/opt/c++/include/header.hpp'
  ]
  for (const p of posixCleanCases) {
    assert.equal(needsShellPathQuoting(p, 'darwin', 'posix'), false, `expected clean on darwin/posix: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'darwin', 'posix'), p)
    assert.equal(needsShellPathQuoting(p, 'linux', 'posix'), false, `expected clean on linux/posix: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'linux', 'posix'), p)
  }

  const winCleanCases = [
    'C:\\',
    'D:\\Users\\dev\\project\\main.ts',
    'D:\\Users\\dev\\folder_v2.0-beta',
    '\\\\fileserver\\public\\release_notes.txt'
  ]
  for (const p of winCleanCases) {
    assert.equal(needsShellPathQuoting(p, 'win32', 'powershell'), false, `expected clean on win32/powershell: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'powershell'), p)
    assert.equal(needsShellPathQuoting(p, 'win32', 'cmd'), false, `expected clean on win32/cmd: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'cmd'), p)
  }
})

test('TFD-U-04: whitespace variants (spaces, leading/trailing spaces, tabs, newlines, Unicode spaces) are quoted', () => {
  const whitespaceCases = [
    '/Users/dev/My Documents/report 2.pdf',
    '/Users/dev/multi   space/folder',
    '/Users/dev/ leading-space.txt',
    '/Users/dev/trailing-space ',
    '/tmp/tab\tin\tname.txt',
    '/tmp/newline\nin\nname.txt',
    '/Users/dev/non-breaking\u00A0space.txt',
    '/Users/dev/全角\u3000空格目录'
  ]
  for (const p of whitespaceCases) {
    assert.equal(needsShellPathQuoting(p, 'darwin', 'posix'), true, `expected quoted: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'darwin', 'posix'), `'${p}'`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'powershell'), `'${p}'`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'cmd'), `"${p}"`)
  }
})

test('TFD-U-05: leading dash, tilde, and Unicode dashes are quoted to prevent CLI flag or tilde expansion', () => {
  const leadingCases = [
    '-rf',
    '--help.txt',
    '-leading-dash-folder/file.txt',
    '~',
    '~/Documents/file.txt',
    '~backup_folder/data.db',
    '\u2013en-dash.txt',
    '\u2014em-dash.txt',
    '\u2015horizontal-bar.txt'
  ]
  for (const p of leadingCases) {
    assert.equal(needsShellPathQuoting(p, 'darwin', 'posix'), true, `expected quoted on posix: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'darwin', 'posix'), `'${p}'`)
    assert.equal(needsShellPathQuoting(p, 'win32', 'powershell'), true, `expected quoted on powershell: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'powershell'), `'${p}'`)
    assert.equal(needsShellPathQuoting(p, 'win32', 'cmd'), true, `expected quoted on cmd: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'cmd'), `"${p}"`)
  }
})

test('TFD-U-06: shell metacharacters, globs, brackets, braces, and command-injection vectors are quoted', () => {
  const metacharCases = [
    '/Users/dev/report(1).pdf',
    '/Users/dev/array[0].json',
    '/Users/dev/brace{a,b}.txt',
    '/Users/dev/glob*.log',
    '/Users/dev/question?.txt',
    '/Users/dev/$HOME/file.txt',
    '/Users/dev/$(whoami)/file.txt',
    '/Users/dev/`id`/file.txt',
    '/Users/dev/semi;rm -rf /;file.txt',
    '/Users/dev/amp&bg.txt',
    '/Users/dev/pipe|cat.txt',
    '/Users/dev/redirect<in>out.txt',
    '/Users/dev/#hashtag-folder/file.md',
    '/Users/dev/bang!history.txt',
    '/Users/dev/caret^pattern.txt',
    '/Users/dev/percent%env%.txt',
    '/Users/dev/equal=val,comma.txt',
    '/Users/dev/@scoped/pkg'
  ]
  for (const p of metacharCases) {
    assert.equal(needsShellPathQuoting(p, 'linux', 'posix'), true, `expected posix quoting for: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'linux', 'posix'), `'${p}'`)
    assert.equal(needsShellPathQuoting(p, 'win32', 'powershell'), true, `expected powershell quoting for: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'win32', 'powershell'), `'${p}'`)
    if (!p.includes('$') && !p.includes('#')) {
      assert.equal(needsShellPathQuoting(p, 'win32', 'cmd'), true, `expected cmd quoting for: ${p}`)
    }
  }
})

test('TFD-U-07: embedded ASCII quotes and Unicode smart quotes are escaped per shell family', () => {
  // Single quotes in POSIX -> '\''
  assert.equal(
    formatDroppedFilePathForShell("/tmp/it's $HOME/file.txt", 'linux', 'posix'),
    "'/tmp/it'\\''s $HOME/file.txt'"
  )
  assert.equal(
    formatDroppedFilePathForShell("/tmp/'quoted-folder'/''double''.txt", 'darwin', 'posix'),
    "'/tmp/'\\''quoted-folder'\\''/'\\'''\\''double'\\'''\\''.txt'"
  )

  // Single quotes in PowerShell -> ''
  assert.equal(
    formatDroppedFilePathForShell("D:\\it's $env:USERPROFILE\\file.txt", 'win32', 'powershell'),
    "'D:\\it''s $env:USERPROFILE\\file.txt'"
  )

  // Unicode smart single quotes (U+2018..U+201B) in PowerShell must be quoted and doubled
  assert.equal(
    needsShellPathQuoting('D:\\Users\\dev\\John\u2019s_Doc.pdf', 'win32', 'powershell'),
    true
  )
  assert.equal(
    formatDroppedFilePathForShell('D:\\Users\\dev\\John\u2019s_Doc.pdf', 'win32', 'powershell'),
    "'D:\\Users\\dev\\John\u2019\u2019s_Doc.pdf'"
  )
  assert.equal(
    formatDroppedFilePathForShell('/Users/dev/\u2018Smart\u2019Quote.txt', 'darwin', 'powershell'),
    "'/Users/dev/\u2018\u2018Smart\u2019\u2019Quote.txt'"
  )

  // Unicode smart double quotes (U+201C..U+201D) in PowerShell trigger single-quoting
  assert.equal(
    needsShellPathQuoting('D:\\Users\\dev\\\u201CSmartDouble\u201D.pdf', 'win32', 'powershell'),
    true
  )
  assert.equal(
    formatDroppedFilePathForShell('D:\\Users\\dev\\\u201CSmartDouble\u201D.pdf', 'win32', 'powershell'),
    "'D:\\Users\\dev\\\u201CSmartDouble\u201D.pdf'"
  )

  // Double quotes in POSIX & PowerShell stay inside single quotes; in CMD become ""
  assert.equal(
    formatDroppedFilePathForShell('/tmp/folder "quoted"/file.txt', 'darwin', 'posix'),
    '\'/tmp/folder "quoted"/file.txt\''
  )
  assert.equal(
    formatDroppedFilePathForShell('D:\\folder "quoted"\\file.txt', 'win32', 'powershell'),
    '\'D:\\folder "quoted"\\file.txt\''
  )
  assert.equal(
    formatDroppedFilePathForShell('D:\\folder "quoted"\\file.txt', 'win32', 'cmd'),
    '"D:\\folder ""quoted""\\file.txt"'
  )

  // Mixed single and double quotes in the same filename across all 3 shells
  const mixedQuotes = `/tmp/Bob's "Secret" Plan.txt`
  assert.equal(
    formatDroppedFilePathForShell(mixedQuotes, 'linux', 'posix'),
    `'/tmp/Bob'\\''s "Secret" Plan.txt'`
  )
  assert.equal(
    formatDroppedFilePathForShell(mixedQuotes, 'win32', 'powershell'),
    `'/tmp/Bob''s "Secret" Plan.txt'`
  )
  assert.equal(
    formatDroppedFilePathForShell(mixedQuotes, 'win32', 'cmd'),
    `"/tmp/Bob's ""Secret"" Plan.txt"`
  )
})

test('TFD-U-08: cross-platform separator, UNC, Git Bash on Windows, and CMD trailing-backslash combinations', () => {
  // Windows path dropped into Git Bash / MSYS2 (shellKind = 'posix') must quote backslashes
  const winPath = 'D:\\Users\\dev\\project\\file.txt'
  assert.equal(needsShellPathQuoting(winPath, 'win32', 'posix'), true)
  assert.equal(formatDroppedFilePathForShell(winPath, 'win32', 'posix'), "'D:\\Users\\dev\\project\\file.txt'")

  // Linux/macOS filename with a literal backslash must be quoted in POSIX
  const linuxBackslashFile = '/home/dev/weird\\name/file.txt'
  assert.equal(needsShellPathQuoting(linuxBackslashFile, 'linux', 'posix'), true)
  assert.equal(formatDroppedFilePathForShell(linuxBackslashFile, 'linux', 'posix'), "'/home/dev/weird\\name/file.txt'")

  // Windows UNC path with spaces across PowerShell, CMD, and Git Bash
  const uncSpaced = '\\\\server01\\Team Share (Dept)\\Q4 Report.xlsx'
  assert.equal(
    formatDroppedFilePathForShell(uncSpaced, 'win32', 'powershell'),
    "'\\\\server01\\Team Share (Dept)\\Q4 Report.xlsx'"
  )
  assert.equal(
    formatDroppedFilePathForShell(uncSpaced, 'win32', 'cmd'),
    '"\\\\server01\\Team Share (Dept)\\Q4 Report.xlsx"'
  )
  assert.equal(
    formatDroppedFilePathForShell(uncSpaced, 'win32', 'posix'),
    "'\\\\server01\\Team Share (Dept)\\Q4 Report.xlsx'"
  )

  // Directory path with trailing backslash in CMD doubles the trailing backslash so \" doesn't escape the closing quote
  assert.equal(
    formatDroppedFilePathForShell('D:\\My Folder\\', 'win32', 'cmd'),
    '"D:\\My Folder\\\\"'
  )
})

test('TFD-U-09: Unicode file & folder names (CJK, Japanese, Korean, Emoji, macOS NFD) follow exact quoting rules', () => {
  // Clean Unicode (no spaces or metacharacters) -> unquoted
  const cleanUnicode = [
    '/Users/dev/文档/项目源码/主程序.ts',
    '/Users/dev/プロジェクト/ソース/メイン.ts',
    '/Users/dev/프로젝트/소스/메인.ts',
    '/Users/dev/🚀_release_v1/📦_bundle.tgz',
    // macOS APFS NFD decomposed "café_résumé.pdf"
    '/Users/dev/caf\u0065\u0301_re\u0301sume\u0301.pdf'
  ]
  for (const p of cleanUnicode) {
    assert.equal(needsShellPathQuoting(p, 'darwin', 'posix'), false, `expected unquoted: ${p}`)
    assert.equal(formatDroppedFilePathForShell(p, 'darwin', 'posix'), p)
  }

  // Spaced or metachar Unicode -> quoted
  assert.equal(
    formatDroppedFilePathsForShell(['/Users/dev/我的 文档/项目 (最终版)'], 'darwin', 'posix'),
    "'/Users/dev/我的 文档/项目 (最终版)' "
  )
  assert.equal(
    formatDroppedFilePathsForShell(['D:\\我的 文档\\项目 (最终版)'], 'win32', 'powershell'),
    "'D:\\我的 文档\\项目 (最终版)' "
  )
})

test('TFD-U-10: formatDroppedFilePathsForShell handles multi-item batches, folders, and empty entries', () => {
  assert.equal(formatDroppedFilePathsForShell([], 'darwin', 'posix'), '')
  assert.equal(formatDroppedFilePathsForShell(['', ''], 'darwin', 'posix'), '')

  assert.equal(
    formatDroppedFilePathsForShell(
      ['/Users/dev/clean.txt', '', '/Users/dev/My Folder', "/Users/dev/ Bob's File (1).txt"],
      'darwin',
      'posix'
    ),
    "/Users/dev/clean.txt '/Users/dev/My Folder' '/Users/dev/ Bob'\\''s File (1).txt' "
  )

  assert.equal(
    formatDroppedFilePathsForShell(
      ['D:\\work\\a.txt', 'D:\\My Work\\folder', "D:\\John's Dir\\b.txt"],
      'win32',
      'powershell'
    ),
    "D:\\work\\a.txt 'D:\\My Work\\folder' 'D:\\John''s Dir\\b.txt' "
  )
})
