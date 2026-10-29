// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
const require = createRequire(import.meta.url)

test('PTY-NATIVE callback owns every payload and handles teardown statuses', () => {
  const root = resolve(import.meta.dirname, '../..')
  const fixture = join(root, 'test/autotest/fixtures/pty-exit-callback')
  const include = join(dirname(require.resolve('node-pty/package.json')), 'src/win')
  const scratchRoot = join(root, 'test/autotest/results/pty-exit-callback')
  mkdirSync(scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(scratchRoot, 'unit-'))
  const binary = join(scratch, process.platform === 'win32' ? 'ownership.exe' : 'ownership')
  try {
    if (process.platform === 'win32') {
      const toolchains = {
        x64: { component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', environment: 'x64' },
        ia32: { component: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', environment: 'x86' },
        arm64: { component: 'Microsoft.VisualStudio.Component.VC.Tools.ARM64', environment: 'arm64' }
      }
      const toolchain = toolchains[process.arch]
      assert(toolchain, `Unsupported MSVC target architecture: ${process.arch}`)
      const vswhere = join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
      const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', toolchain.component, '-property', 'installationPath'], { encoding: 'utf8' }).trim()
      assert(installation, `MSVC ${process.arch} tools are required for native ownership verification`)
      const setup = join(installation, 'VC/Auxiliary/Build/vcvarsall.bat')
      const command = `"${setup}" ${toolchain.environment} >nul && cl /nologo /EHsc /std:c++20 /I"${fixture}" /I"${include}" "${join(fixture, 'ownership.cc')}" /Fe:"${binary}"`
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: scratch, timeout: 60_000, windowsVerbatimArguments: true, stdio: 'pipe' })
    } else {
      execFileSync(process.env.CXX || 'c++', ['-std=c++17', '-I', fixture, '-I', include, join(fixture, 'ownership.cc'), '-o', binary], { cwd: scratch, timeout: 60_000 })
    }
    assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 5000 }), /ownership\/status cases passed/)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('PTY-NATIVE real Node-API callback preserves the exact JavaScript exception', async () => {
  const root = resolve(import.meta.dirname, '../..')
  const fixture = join(root, 'test/autotest/fixtures/pty-exit-callback')
  const scratchRoot = join(root, 'traces')
  mkdirSync(scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(scratchRoot, 'pty-api-test-'))
  try {
    const target = join(scratch, 'node_modules', 'onward-exit-test')
    mkdirSync(target, { recursive: true })
    for (const file of ['bridge.cc', 'binding.gyp']) cpSync(join(fixture, file), join(target, file))
    cpSync(join(dirname(require.resolve('node-pty/package.json')), 'src/win/onward_exit_callback.h'), join(target, 'onward_exit_callback.h'))
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'onward-exit-test', version: '1.0.0', gypfile: true }))
    writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'onward-exit-test-root', version: '1.0.0', dependencies: { 'onward-exit-test': '1.0.0' } }))
    await require('@electron/rebuild').rebuild({ buildPath: scratch, electronVersion: require('electron/package.json').version,
      arch: process.arch, force: true, onlyModules: ['onward-exit-test'], buildFromSource: true })
    // A child owns the loaded DLL so Windows can remove the fixture afterward.
    execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const addon = require(process.argv[1]);
      let value;
      addon.run(code => { value = code });
      assert.equal(value, 42);
      const original = new Error('original callback error');
      assert.throws(() => addon.run(() => { throw original }), error => error === original);
    `, join(target, 'build/Release/exit_callback_test.node')], { timeout: 10_000 })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
