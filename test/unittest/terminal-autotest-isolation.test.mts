/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isolateWindowsShellArgsForAutotest } from '../../electron/main/terminal-env.ts'

test('TAI-01 Windows test shells cannot load user profiles, history, or cmd AutoRun', () => {
  const args = ['-NoLogo', '-NoExit', '-Command', 'fixture-label']
  assert.deepEqual(isolateWindowsShellArgsForAutotest('powershell', args), ['-NoProfile', '-NonInteractive', ...args])
  assert.deepEqual(isolateWindowsShellArgsForAutotest('cmd', []), ['/d'])
  assert.deepEqual(isolateWindowsShellArgsForAutotest('posix', ['-l']), ['-l'])
  assert.deepEqual(args, ['-NoLogo', '-NoExit', '-Command', 'fixture-label'])
})
