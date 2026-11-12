// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { Arch } = require('electron-builder')

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  if (process.platform !== 'win32') throw new Error('Windows native process snapshot packaging requires a Windows build host')
  const arch = Arch[context.arch]
  for (const script of ['ensure-windows-process-tree.js', 'ensure-node-pty-native.js', 'ensure-windows-updater.js']) {
    const result = spawnSync(process.execPath, [join(__dirname, script)], {
      env: { ...process.env, npm_config_arch: arch }, stdio: 'inherit', windowsHide: true
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${script} failed for target ${arch}`)
  }
}
