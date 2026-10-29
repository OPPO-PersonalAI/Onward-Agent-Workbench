// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('PTN-04 installed patch removes truncation and distinguishes enumeration errors', () => {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('@vscode/windows-process-tree/package.json'))
  const source = readFileSync(join(root, 'src/process.cc'), 'utf8')
  assert.doesNotMatch(source, /process_count\s*<\s*1024/)
  assert.match(source, /snapshot_handle == INVALID_HANDLE_VALUE/)
  assert.match(source, /GetLastError\(\) != ERROR_NO_MORE_FILES/)
  assert.match(readFileSync(join(root, 'src/process_worker.cc'), 'utf8'), /process_count_ == UINT32_MAX/)
  if (process.platform === 'win32') {
    const native = require(join(root, 'build/Release/windows_process_tree.node'))
    assert.equal(native.onwardCompleteSnapshot, 2, 'Packaged upstream prebuild must not bypass source patch')
  }
})

test('PTN-05 real native completion preserves JavaScript exception identity', { skip: process.platform !== 'win32' }, () => {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('@vscode/windows-process-tree/package.json'))
  const driver = fileURLToPath(new URL('../autotest/test-windows-process-tree-callback.cjs', import.meta.url))
  for (const mode of ['process', 'cpu']) {
    const output = execFileSync(process.execPath, ['--force-node-api-uncaught-exceptions-policy', driver,
      join(root, 'build/Release/windows_process_tree.node'), mode], { encoding: 'utf8', timeout: 10_000 })
    assert.match(output, new RegExp(`PASS callback-${mode}`))
  }
})
