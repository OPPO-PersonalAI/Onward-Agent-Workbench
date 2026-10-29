// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cpSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import contract from '../../scripts/ensure-node-pty-native.js'

const fixtures = resolve(import.meta.dirname, '../autotest/fixtures/pty-exit-callback')
const scratchRoot = resolve(import.meta.dirname, '../autotest/results/companion-copy')

function fixture(run) {
  mkdirSync(scratchRoot, { recursive: true })
  const root = mkdtempSync(join(scratchRoot, 'copy-'))
  try {
    const source = join(root, 'source.bin')
    const destination = join(root, 'destination.bin')
    cpSync(join(fixtures, 'node_api.h'), source)
    run({ source, destination, root })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test('PTY-COPY-01 same-file hard links retain identity and exact contents', () => fixture(({ source, destination }) => {
  linkSync(source, destination)
  const bytes = readFileSync(source)
  const before = statSync(source, { bigint: true })
  contract.copyCompanionBinary(source, destination)
  assert.deepEqual(readFileSync(destination), bytes)
  assert.deepEqual(readFileSync(source), bytes)
  assert.equal(statSync(destination, { bigint: true }).ino, before.ino)
  assert.equal(statSync(destination, { bigint: true }).nlink, before.nlink)
}))

test('PTY-COPY-02 identical path is an already satisfied copy', () => fixture(({ source }) => {
  const bytes = readFileSync(source)
  contract.copyCompanionBinary(source, source)
  assert.deepEqual(readFileSync(source), bytes)
}))

test('PTY-COPY-03 missing target receives the exact source bytes', () => fixture(({ source, destination }) => {
  contract.copyCompanionBinary(source, destination)
  assert.deepEqual(readFileSync(destination), readFileSync(source))
}))

test('PTY-COPY-04 a distinct stale target is overwritten', () => fixture(({ source, destination }) => {
  cpSync(join(fixtures, 'ownership.cc'), destination)
  assert.notDeepEqual(readFileSync(destination), readFileSync(source))
  contract.copyCompanionBinary(source, destination)
  assert.deepEqual(readFileSync(destination), readFileSync(source))
}))

test('PTY-COPY-05 missing source and invalid target remain real failures', () => fixture(({ source, destination, root }) => {
  assert.throws(() => contract.copyCompanionBinary(join(root, 'absent.bin'), destination), { code: 'ENOENT' })
  mkdirSync(destination)
  assert.throws(() => contract.copyCompanionBinary(source, destination))
  assert.equal(statSync(destination).isDirectory(), true)
}))
