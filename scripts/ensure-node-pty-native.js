#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
const { join, dirname } = require('node:path')
const { readFileSync, mkdirSync, mkdtempSync, cpSync, writeFileSync, rmSync, readdirSync, statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { matchesArchitecture } = require('./ensure-windows-process-tree')

function copyCompanionBinary(source, destination) {
  const sourceStat = statSync(source, { bigint: true })
  const destinationStat = statSync(destination, { bigint: true, throwIfNoEntry: false })
  // pnpm may materialize identical package assets as hard links to one file.
  if (sourceStat.isFile() && destinationStat?.isFile() && sourceStat.ino !== 0n &&
      sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) return
  cpSync(source, destination)
}

async function main() {
  if (process.platform !== 'win32') return
  const root = join(__dirname, '..')
  const arch = process.env.npm_config_arch || process.arch
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported ConPTY target: ${arch}`)
  const moduleRoot = dirname(require.resolve('node-pty/package.json'))
  const binary = join(moduleRoot, 'build', 'Release', 'conpty.node')
  const valid = () => {
    try {
      if (!matchesArchitecture(readFileSync(binary), arch) || arch !== process.arch) return false
      const result = spawnSync(process.execPath, ['-e',
        'const u=require(process.argv[1]);const n=u.loadNativeModule("conpty");if(n.module.onwardSafeExitCallback!==1||!n.dir.includes("build/Release"))process.exit(2)',
        join(moduleRoot, 'lib', 'utils.js')], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      return result.status === 0
    } catch { return false }
  }
  if (!valid()) {
    console.log(`[node-pty] Building exception-safe ConPTY callback for win32-${arch}`)
    mkdirSync(join(root, 'traces'), { recursive: true })
    const staging = mkdtempSync(join(root, 'traces', 'pty-'))
    try {
      const target = join(staging, 'node_modules', 'node-pty')
      mkdirSync(target, { recursive: true })
      for (const name of ['package.json', 'binding.gyp', 'src']) cpSync(join(moduleRoot, name), join(target, name), { recursive: true })
      const addon = dirname(require.resolve('node-addon-api/package.json', { paths: [moduleRoot] }))
      cpSync(addon, join(staging, 'node_modules', 'node-addon-api'), { recursive: true })
      writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: 'onward-pty-build', version: '1.0.0', dependencies: { 'node-pty': require('node-pty/package.json').version } }))
      await require('@electron/rebuild').rebuild({ buildPath: staging, electronVersion: require('electron/package.json').version,
        arch, force: true, onlyModules: ['node-pty'], buildFromSource: true })
      const output = join(target, 'build', 'Release')
      mkdirSync(dirname(binary), { recursive: true })
      for (const name of readdirSync(output).filter(name => /\.(node|pdb)$/.test(name))) cpSync(join(output, name), join(dirname(binary), name))
    } finally { rmSync(staging, { recursive: true, force: true }) }
    if (!matchesArchitecture(readFileSync(binary), arch) || (arch === process.arch && !valid())) throw new Error('Patched ConPTY binary validation failed')
  }
  // Loading from build/Release also changes the bundled ConPTY DLL lookup.
  const conpty = join(moduleRoot, 'third_party', 'conpty')
  const versions = readdirSync(conpty)
  if (versions.length !== 1) throw new Error('Ambiguous bundled ConPTY version')
  for (const name of ['conpty.dll', 'OpenConsole.exe']) {
    const source = join(conpty, versions[0], `win10-${arch}`, name)
    if (!matchesArchitecture(readFileSync(source), arch)) throw new Error(`Invalid ConPTY ${arch} artifact: ${name}`)
    mkdirSync(join(dirname(binary), 'conpty'), { recursive: true })
    copyCompanionBinary(source, join(dirname(binary), 'conpty', name))
  }
  console.log(`[node-pty] Patched ConPTY and companion binaries ready: win32-${arch}`)
}
module.exports = { copyCompanionBinary }
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
