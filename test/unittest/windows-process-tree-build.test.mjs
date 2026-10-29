// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import contract from '../../scripts/ensure-windows-process-tree.js'

test('WPT-B01 native architecture gate rejects foreign, truncated and invalid PE headers', () => {
  for (const [arch, machine] of Object.entries({ x64: 0x8664, arm64: 0xaa64, ia32: 0x14c })) {
    const bytes = Buffer.alloc(128)
    bytes.writeUInt16LE(0x5a4d)
    bytes.writeUInt32LE(64, 0x3c)
    bytes.writeUInt32LE(0x4550, 64)
    bytes.writeUInt16LE(machine, 68)
    assert.equal(contract.matchesArchitecture(bytes, arch), true)
    assert.equal(contract.matchesArchitecture(bytes, 'unsupported'), false)
    assert.equal(contract.matchesArchitecture(bytes, arch === 'x64' ? 'arm64' : 'x64'), false)
    for (let size = 0; size < 70; size++) assert.equal(contract.matchesArchitecture(bytes.subarray(0, size), arch), false)
    bytes.writeUInt32LE(0xffffffff, 0x3c)
    assert.equal(contract.matchesArchitecture(bytes, arch), false)
    bytes.writeUInt32LE(64, 0x3c)
    bytes.writeUInt32LE(0, 64)
    assert.equal(contract.matchesArchitecture(bytes, arch), false)
  }
})
