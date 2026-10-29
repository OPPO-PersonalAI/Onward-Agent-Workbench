// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync, execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

test('OWD-PS preserves launch and first-check failures while allowing successful stderr', { skip: process.platform !== 'win32' }, () => {
  const root = resolve(import.meta.dirname, '../..')
  const scratchRoot = join(root, 'test/autotest/results/orchestrator-watchdog')
  mkdirSync(scratchRoot, { recursive: true })
  const scratch = mkdtempSync(join(scratchRoot, 'powershell-'))
  const log = join(root, 'traces/test-logs/watchdog-powershell-unit.log')
  const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const python = process.env.PYTHON3 || execFileSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  try {
    const checks = join(scratch, 'test/autotest')
    mkdirSync(checks, { recursive: true })
    for (const name of ['check-regression-entry.py', 'check-orchestrator-watchdog.py']) {
      cpSync(join(root, 'test/autotest/fixtures/orchestrator-entry/watchdog-check.py'), join(checks, name))
    }
    const invoke = (interpreter, fail = '') => spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(root, 'test/autotest/run-orchestrator-watchdog-autotest.ps1'), '-LogFile', log], {
      env: { ...process.env, ONWARD_REPO_ROOT: scratch, PYTHON3: interpreter, ONWARD_FIXTURE_FAIL_CHECK: fail },
      encoding: 'utf8', timeout: 20_000, windowsHide: true
    })
    let result = invoke(join(scratch, 'absent-python.exe'))
    assert.equal(result.status, 127, result.stderr)
    result = invoke(python, 'check-regression-entry.py')
    assert.equal(result.status, 7, result.stderr)
    assert.match(readFileSync(log, 'utf8'), /CHECK check-orchestrator-watchdog.py/)
    result = invoke(python)
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(log, 'utf8'), /Expected fixture diagnostic on stderr/)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
