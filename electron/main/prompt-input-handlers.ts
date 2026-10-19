/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcMain, webContents, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { terminalKeyToSequence, type PromptInputPayload, type PromptInputResult } from '../../src/utils/prompt-input'
import { PERF_TRACE_EVENT } from '../../src/utils/perf-trace-names'
import { IPC } from '../shared/ipc-channels'
import type { AutotestInputFocusResult } from '../shared/autotest-input-focus'
import { performanceTrace } from './performance-trace'
import { isPromptShortcutContext, promptInputShortcuts } from './prompt-input-shortcuts'
import { isValidPromptInputContent, ptyManager } from './pty-manager'

// IPC allocation bound in UTF-16 code units, not encoded bytes or a UI truncation.
const MAX_PROMPT_INPUT_LENGTH = 8 * 1024 * 1024
const CANCEL_REASONS = new Set(['escape', 'ime', 'blur', 'focus-changed', 'tab-changed', 'recording', 'blocked', 'unmount', 'context-changed', 'settings-changed', 'send', 'modal'])

export function isPromptInputPayload(value: unknown): value is PromptInputPayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as PromptInputPayload
  return typeof payload.includePrompt === 'boolean' && typeof payload.content === 'string' &&
    payload.content.length <= MAX_PROMPT_INPUT_LENGTH && typeof payload.terminalKey === 'string' &&
    payload.terminalKey.length <= 32 && terminalKeyToSequence(payload.terminalKey) !== null &&
    (payload.includePrompt ? isValidPromptInputContent(payload.content) : payload.terminalKey !== 'None')
}

export function registerPromptInputHandlers(
  window: BrowserWindow,
  ownsTerminal: (id: string) => boolean,
  bracketedPasteEnabled: (id: string) => boolean
): void {
  const trusted = (event: IpcMainInvokeEvent): boolean => !window.isDestroyed() &&
    !window.webContents.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  const control = (event: IpcMainInvokeEvent, operation: string, valid: boolean): void => {
    const accepted = trusted(event) && valid
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_SHORTCUT, { stage: 'ipc-received', operation, accepted })
    if (!accepted) throw new Error('Invalid prompt shortcut request')
  }
  ipcMain.handle(IPC.PROMPT_INPUT_SET_CONTEXT, (event, context: unknown) => {
    const valid = isPromptShortcutContext(context)
    control(event, 'set-context', valid)
    if (valid) promptInputShortcuts.setContext(context)
  })
  ipcMain.handle(IPC.PROMPT_INPUT_SUSPEND, (event, suspended: unknown, preserveNativeMenus: unknown = false) => {
    control(event, 'suspend', typeof suspended === 'boolean' && typeof preserveNativeMenus === 'boolean')
    // invoke resolves only AFTER cancellation and suspension are applied.
    promptInputShortcuts.suspend(suspended as boolean, preserveNativeMenus as boolean)
  })
  ipcMain.handle(IPC.PROMPT_INPUT_CANCEL, (event, reason: unknown) => {
    control(event, 'cancel', typeof reason === 'string' && reason.length <= 96)
    promptInputShortcuts.cancel(CANCEL_REASONS.has(reason as string) ? reason as string : 'renderer-cancel')
  })
  // Autotest-only: the main frame may drive native input only in its focused owned surface.
  ipcMain.handle(IPC.DEBUG_SEND_INPUT_EVENT, (event, input: unknown, contentsId?: unknown) => {
    if (process.env.ONWARD_AUTOTEST !== '1' || !trusted(event)) return false
    if (contentsId !== undefined && (typeof contentsId !== 'number' || !Number.isSafeInteger(contentsId) || contentsId <= 0)) return false
    const contents = contentsId === undefined ? webContents.getFocusedWebContents() : webContents.fromId(contentsId)
    return Boolean(contents && promptInputShortcuts.sendInputEventForAutotest(contents, input))
  })
  ipcMain.handle(IPC.DEBUG_GET_INPUT_FOCUS, (event): AutotestInputFocusResult | null => {
    if (process.env.ONWARD_AUTOTEST !== '1' || !trusted(event)) return null
    return {
      windowFocused: window.isFocused(),
      contentsFocused: window.webContents.isFocused(),
      focusedContentsId: webContents.getFocusedWebContents()?.id ?? null
    }
  })
  ipcMain.handle(IPC.PROMPT_INPUT_SEND, async (event, terminalId: unknown, payload: unknown): Promise<PromptInputResult> => {
    const payloadValid = isPromptInputPayload(payload)
    const valid = typeof terminalId === 'string' && terminalId.length > 0 && terminalId.length <= 128 && payloadValid
    const accepted = trusted(event) && valid
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT, { stage: 'ipc-received', accepted })
    if (!accepted || !payloadValid || typeof terminalId !== 'string') {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT, { stage: 'ipc-rejected', reason: 'invalid-input' })
      return { ok: false, phase: 'content', contentDelivered: false, reason: 'invalid-input' }
    }
    if (!ownsTerminal(terminalId)) {
      performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT, { stage: 'ipc-rejected', reason: 'unavailable', terminalId })
      return { ok: false, phase: payload.includePrompt ? 'content' : 'key', contentDelivered: false, reason: 'unavailable' }
    }
    const result = await ptyManager.sendPromptInput(terminalId, {
      content: payload.content, includePrompt: payload.includePrompt, terminalKey: payload.terminalKey
    }, () => bracketedPasteEnabled(terminalId))
    if (result.ok && payload.terminalKey === 'Enter') {
      performanceTrace.markTaskRunning(terminalId, undefined, { reason: 'prompt-input-enter' })
    }
    performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT, { stage: 'ipc-response', terminalId, ...result })
    return result
  })
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT, { stage: 'handlers-registered' })
}

export function cleanupPromptInputHandlers(): void {
  promptInputShortcuts.dispose()
  ipcMain.removeHandler(IPC.PROMPT_INPUT_SET_CONTEXT)
  ipcMain.removeHandler(IPC.PROMPT_INPUT_SUSPEND)
  ipcMain.removeHandler(IPC.PROMPT_INPUT_CANCEL)
  ipcMain.removeHandler(IPC.DEBUG_SEND_INPUT_EVENT)
  ipcMain.removeHandler(IPC.DEBUG_GET_INPUT_FOCUS)
  ipcMain.removeHandler(IPC.PROMPT_INPUT_SEND)
  performanceTrace.record(PERF_TRACE_EVENT.MAIN_PROMPT_INPUT, { stage: 'handlers-disposed' })
}
