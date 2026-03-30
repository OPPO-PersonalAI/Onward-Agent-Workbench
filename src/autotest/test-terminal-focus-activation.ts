/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

const POINTER_SUPPRESS_SETTLE_MS = 180
const POINTER_STALE_WAIT_MS = 520

export async function testTerminalFocusActivation(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled, terminalId } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardTerminalFocusDebug
  const closeProjectEditorIfNeeded = async () => {
    const projectEditorApi = window.__onwardProjectEditorDebug
    if (!projectEditorApi?.isOpen()) {
      return true
    }

    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true
    }))

    const closed = await waitFor(
      'tfa-close-project-editor',
      () => !window.__onwardProjectEditorDebug?.isOpen?.(),
      4000,
      50
    )
    log('terminal-focus-activation:close-project-editor', { closed })
    return closed
  }
  const focusAppWindow = async (label: string) => {
    const requested = await window.electronAPI.debug.focusWindow()
    const focused = await waitFor(
      `tfa-window-focus-${label}`,
      () => document.hasFocus(),
      2000,
      50
    )
    log('terminal-focus-activation:focus-window', { label, requested, focused })
    return requested && focused
  }

  log('terminal-focus-activation:start', { terminalId })

  const api = getApi()
  _assert('TFA-01-debug-api-available', Boolean(api), {
    available: Boolean(api)
  })
  if (!api || cancelled()) {
    return results
  }

  await closeProjectEditorIfNeeded()
  await sleep(400)

  const prepared = api.prepareTerminalRestore(terminalId)
  _assert('TFA-02-prepare-terminal-restore', prepared, {
    terminalId,
    state: api.getState()
  })
  if (!prepared || cancelled()) {
    return results
  }

  await focusAppWindow('shortcut-restore')
  api.simulateRestore('shortcut-activated')
  const shortcutRestoreFocused = await waitFor(
    'tfa-shortcut-restore-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-03-shortcut-restore-focuses-terminal', shortcutRestoreFocused, api.getState())

  api.blurActiveElement()
  const blurClearedFocus = await waitFor(
    'tfa-blur-clears-focus',
    () => getApi()?.getFocusedTerminalId() === null,
    1500,
    50
  )
  _assert('TFA-04-blur-clears-terminal-focus', blurClearedFocus, api.getState())

  api.prepareTerminalRestore(terminalId)
  api.simulatePointerTarget('terminal', terminalId)
  api.simulateRestore('window-focus')
  await sleep(POINTER_SUPPRESS_SETTLE_MS)
  _assert('TFA-05-window-focus-after-terminal-pointer-does-not-refocus', api.getFocusedTerminalId() === null, api.getState())

  await focusAppWindow('shortcut-activated')
  api.simulateRestore('shortcut-activated')
  const shortcutActivatedFocused = await waitFor(
    'tfa-shortcut-activated-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-06-shortcut-activation-still-restores-terminal', shortcutActivatedFocused, api.getState())

  api.blurActiveElement()
  await waitFor('tfa-clear-focus-again', () => getApi()?.getFocusedTerminalId() === null, 1500, 50)
  api.prepareTerminalRestore(terminalId)
  api.simulatePointerTarget('other')
  api.simulateRestore('window-focus')
  await sleep(POINTER_SUPPRESS_SETTLE_MS)
  _assert('TFA-07-window-focus-after-mouse-other-does-not-refocus', api.getFocusedTerminalId() === null, api.getState())

  api.prepareTerminalRestore(terminalId)
  await sleep(POINTER_STALE_WAIT_MS)
  await focusAppWindow('stale-pointer')
  api.simulateRestore('window-focus')
  const stalePointerRestoreFocused = await waitFor(
    'tfa-stale-pointer-window-focus',
    () => getApi()?.getFocusedTerminalId() === terminalId,
    3000,
    50
  )
  _assert('TFA-08-window-focus-restores-terminal-when-pointer-is-stale', stalePointerRestoreFocused, api.getState())

  log('terminal-focus-activation:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
