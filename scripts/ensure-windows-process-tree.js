#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
const { join, dirname } = require('node:path')
const { readFileSync, mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const machines = { x64: 0x8664, arm64: 0xaa64, ia32: 0x14c }

function matchesArchitecture(bytes, arch) {
  if (!machines[arch] || bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false
  const offset = bytes.readUInt32LE(0x3c)
  return offset >= 64 && offset + 6 <= bytes.length &&
    bytes.readUInt32LE(offset) === 0x00004550 && bytes.readUInt16LE(offset + 4) === machines[arch]
}

async function main() {
  if (process.platform !== 'win32') return
  const root = join(__dirname, '..')
  const arch = process.env.npm_config_arch || process.arch
  if (!machines[arch]) throw new Error(`Unsupported Windows process snapshot architecture: ${arch}`)
  const moduleRoot = dirname(require.resolve('@vscode/windows-process-tree/package.json'))
  const binary = join(moduleRoot, 'build', 'Release', 'windows_process_tree.node')
  const machineMatches = () => {
    try {
      return matchesArchitecture(readFileSync(binary), arch)
    } catch { return false }
  }
  const probe = () => {
    if (!machineMatches()) return false
    if (arch !== process.arch) return false
    const result = spawnSync(process.execPath, ['-e',
      'const n=require(process.argv[1]);if(n.onwardCompleteSnapshot!==2)process.exit(2);n.getProcessList(r=>{if(!Array.isArray(r)||!r.some(p=>p.pid===process.pid))process.exitCode=3},0)', binary],
    { timeout: 10_000, encoding: 'utf8', windowsHide: true })
    return result.status === 0
  }
  if (!probe()) {
    console.log(`[process-tree] Rebuilding patched Node-API module for win32-${arch}`)
    const { rebuild } = require('@electron/rebuild')
    // pnpm's hashed store plus gyp's unnormalized ../ paths can exceed Win32's
    // path ceiling even when the final resolved path is short. Build a flat,
    // isolated dependency tree and copy only the resulting native binary back.
    mkdirSync(join(root, 'traces'), { recursive: true })
    const staging = mkdtempSync(join(root, 'traces', 'wpt-'))
    try {
      const target = join(staging, 'node_modules', '@vscode', 'windows-process-tree')
      mkdirSync(target, { recursive: true })
      for (const name of ['package.json', 'binding.gyp', 'src']) cpSync(join(moduleRoot, name), join(target, name), { recursive: true })
      const addonRoot = dirname(require.resolve('node-addon-api/package.json', { paths: [moduleRoot] }))
      cpSync(addonRoot, join(staging, 'node_modules', 'node-addon-api'), { recursive: true })
      writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: 'onward-native-build', version: '1.0.0', dependencies: { '@vscode/windows-process-tree': '0.8.0' } }))
      await rebuild({
        buildPath: staging,
        electronVersion: require('electron/package.json').version,
        arch, force: true, onlyModules: ['@vscode/windows-process-tree'], buildFromSource: true
      })
      mkdirSync(dirname(binary), { recursive: true })
      cpSync(join(target, 'build', 'Release', 'windows_process_tree.node'), binary)
      cpSync(join(target, 'build', 'Release', 'windows_process_tree.pdb'), join(dirname(binary), 'windows_process_tree.pdb'))
    } finally { rmSync(staging, { recursive: true, force: true }) }
    if (!machineMatches() || (arch === process.arch && !probe())) {
      throw new Error(`Patched Windows process snapshot validation failed for ${arch}`)
    }
  }
  console.log(`[process-tree] Patched native snapshot ready: win32-${arch}`)
}
module.exports = { matchesArchitecture }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
