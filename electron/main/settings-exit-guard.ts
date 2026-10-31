/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../shared/ipc-channels'
import { performanceTrace } from './performance-trace'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'

let owner: BrowserWindow | null = null
let dirty = false
let pending: { id: string; promise: Promise<boolean>; resolve: (allowed: boolean) => void } | null = null

export function installSettingsExitGuard(window: BrowserWindow): void {
  owner = window
  dirty = false
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'installed' })
  const settle = (allowed: boolean) => {
    const request = pending
    pending = null
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'settled', allowed })
    request?.resolve(allowed)
  }
  const state = (event: Electron.IpcMainEvent, value: unknown) => {
    if (event.sender !== window.webContents || typeof value !== 'boolean') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'state-rejected' })
      return
    }
    dirty = value
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'draft-received', dirty })
  }
  const reply = (event: Electron.IpcMainEvent, id: unknown, allowed: unknown) => {
    if (event.sender !== window.webContents || id !== pending?.id || typeof allowed !== 'boolean') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'reply-rejected' })
      return
    }
    settle(allowed)
  }
  ipcMain.on(IPC.SETTINGS_DRAFT_STATE, state)
  ipcMain.on(IPC.SETTINGS_CONFIRM_EXIT_REPLY, reply)
  window.once('closed', () => {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'disposed' })
    ipcMain.removeListener(IPC.SETTINGS_DRAFT_STATE, state)
    ipcMain.removeListener(IPC.SETTINGS_CONFIRM_EXIT_REPLY, reply)
    if (owner === window) { owner = null; dirty = false; settle(false) }
  })
  window.webContents.on('render-process-gone', () => {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'renderer-gone' })
    dirty = false
    settle(false)
  })
}

/** Interactive exits only: signal and recovery teardown never waits for a user dialog. */
export function confirmSettingsExit(): Promise<boolean> {
  if (pending) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'deduplicated' })
    return pending.promise
  }
  if (!dirty || !owner || owner.isDestroyed() || owner.webContents.isDestroyed()) {
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'confirmation-unneeded', dirty })
    return Promise.resolve(true)
  }
  let resolve!: (allowed: boolean) => void
  const promise = new Promise<boolean>(settle => { resolve = settle })
  pending = { id: randomUUID(), promise, resolve }
  if (owner.isMinimized()) owner.restore()
  owner.show()
  owner.focus()
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_SETTINGS_LEAVE, { stage: 'request-sent' })
  owner.webContents.send(IPC.SETTINGS_CONFIRM_EXIT, pending.id)
  return promise
}
