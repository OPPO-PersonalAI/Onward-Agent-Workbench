/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { focusCoordinator, type TerminalFocusRestoreReason } from './focus-coordinator'
import { terminalSessionManager } from './terminal-session-manager'

export interface TerminalFocusDebugApi {
  blurActiveElement: () => boolean
  prepareTerminalRestore: (terminalId: string) => boolean
  simulatePointerTarget: (target: 'terminal' | 'input' | 'other', terminalId?: string | null) => boolean
  simulateRestore: (reason: TerminalFocusRestoreReason) => void
  getFocusedTerminalId: () => string | null
  getState: () => {
    windowHasFocus: boolean
    activeTagName: string | null
    activeClassName: string | null
    focusedTerminalId: string | null
    activeTerminalId: string | null
    lastFocusedTerminalId: string | null
    lastFocusOwner: 'terminal' | 'input'
    recentPointer: boolean
    pointerTarget: 'terminal' | 'input' | 'other'
    targetTerminal: ReturnType<typeof terminalSessionManager.getFocusDebugSnapshot>
  }
}

interface TerminalFocusDebugBindings {
  restoreFocus: (reason: TerminalFocusRestoreReason) => void
  prepareTerminalRestore: (terminalId: string) => boolean
  getLastFocusOwner: () => 'terminal' | 'input'
  getLastFocusedTerminalId: () => string | null
  getActiveTerminalId: () => string | null
}

declare global {
  interface Window {
    __onwardTerminalFocusDebug?: TerminalFocusDebugApi
    __onwardTerminalFocusBindings?: TerminalFocusDebugBindings
  }
}

export function registerTerminalFocusDebugApi(
  bindings: TerminalFocusDebugBindings
): () => void {
  const debugWindow = window as Window
  debugWindow.__onwardTerminalFocusBindings = bindings

  const getBindings = (): TerminalFocusDebugBindings | null => {
    return debugWindow.__onwardTerminalFocusBindings ?? null
  }

  if (!debugWindow.__onwardTerminalFocusDebug) {
    debugWindow.__onwardTerminalFocusDebug = {
      blurActiveElement: () => {
        if (!(document.activeElement instanceof HTMLElement)) return false
        document.activeElement.blur()
        return true
      },
      prepareTerminalRestore: (terminalId) => {
        return getBindings()?.prepareTerminalRestore(terminalId) ?? false
      },
      simulatePointerTarget: (target, terminalId) => {
        let element: Element | null = null

        if (target === 'terminal' && terminalId) {
          element = document.querySelector(`[data-terminal-id="${terminalId}"] .terminal-grid-header`)
            ?? document.querySelector(`[data-terminal-id="${terminalId}"]`)
        } else if (target === 'input') {
          element = document.querySelector('input, textarea, select, [contenteditable="true"]')
        } else {
          element = document.body
        }

        if (!element) return false
        focusCoordinator.notePointerDown(element)
        return true
      },
      simulateRestore: (reason) => {
        getBindings()?.restoreFocus(reason)
      },
      getFocusedTerminalId: () => terminalSessionManager.getFocusedTerminalId(),
      getState: () => {
        const currentBindings = getBindings()
        const activeElement = document.activeElement as HTMLElement | null
        const pointerState = focusCoordinator.getDebugState()
        const lastFocusedTerminalId = currentBindings?.getLastFocusedTerminalId() ?? null
        const focusedTerminalId = terminalSessionManager.getFocusedTerminalId()
        const activeTerminalId = currentBindings?.getActiveTerminalId() ?? null
        const targetTerminalId = lastFocusedTerminalId ?? focusedTerminalId ?? activeTerminalId
        return {
          windowHasFocus: document.hasFocus(),
          activeTagName: activeElement?.tagName ?? null,
          activeClassName: activeElement?.className ?? null,
          focusedTerminalId,
          activeTerminalId,
          lastFocusedTerminalId,
          lastFocusOwner: currentBindings?.getLastFocusOwner() ?? 'terminal',
          recentPointer: pointerState.recentPointer,
          pointerTarget: pointerState.pointerTarget,
          targetTerminal: targetTerminalId
            ? terminalSessionManager.getFocusDebugSnapshot(targetTerminalId)
            : terminalSessionManager.getFocusDebugSnapshot('')
        }
      }
    }
  }

  return () => {
    if (debugWindow.__onwardTerminalFocusBindings === bindings) {
      delete debugWindow.__onwardTerminalFocusBindings
    }
  }
}
