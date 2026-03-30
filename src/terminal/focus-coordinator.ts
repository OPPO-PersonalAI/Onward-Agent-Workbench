/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type TerminalFocusRestoreReason =
  | 'window-focus'
  | 'shortcut-activated'
  | 'shortcut-terminal'

export type TerminalFocusRequestReason =
  | TerminalFocusRestoreReason
  | 'layout-sync'
  | 'attach'
  | 'pointer-select'

type PointerTargetKind = 'terminal' | 'input' | 'other'

const POINTER_SUPPRESS_MS = 450

function classifyPointerTarget(target: EventTarget | null): PointerTargetKind {
  if (!(target instanceof Element)) return 'other'

  if (target.closest('.xterm, .terminal-grid-cell, [data-terminal-id]')) {
    return 'terminal'
  }

  if (target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, .project-editor')) {
    return 'input'
  }

  return 'other'
}

class FocusCoordinator {
  private lastPointerAt = 0
  private lastPointerTarget: PointerTargetKind = 'other'

  notePointerDown(target: EventTarget | null): void {
    this.lastPointerAt = performance.now()
    this.lastPointerTarget = classifyPointerTarget(target)
  }

  shouldRestoreTerminal(reason: TerminalFocusRestoreReason): boolean {
    if (reason === 'shortcut-activated' || reason === 'shortcut-terminal') {
      return true
    }
    return !this.isRecentPointer()
  }

  shouldRestoreInput(reason: TerminalFocusRestoreReason): boolean {
    if (reason === 'shortcut-activated') {
      return true
    }
    return !this.isRecentPointer()
  }

  shouldApplyFocusRequest(reason: TerminalFocusRequestReason): boolean {
    if (reason === 'shortcut-activated' || reason === 'shortcut-terminal') {
      return true
    }

    if (!this.isRecentPointer()) {
      return true
    }

    return false
  }

  getDebugState(): { recentPointer: boolean; pointerTarget: PointerTargetKind } {
    return {
      recentPointer: this.isRecentPointer(),
      pointerTarget: this.lastPointerTarget
    }
  }

  private isRecentPointer(): boolean {
    return performance.now() - this.lastPointerAt <= POINTER_SUPPRESS_MS
  }
}

export const focusCoordinator = new FocusCoordinator()
