/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizePromptShortcut, type PromptInputAction, type PromptInputResult } from './prompt-input.ts'
import type { TranslationKey, TranslationParams } from '../i18n/core'

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/** User names take precedence; preset labels remain localizable. */
export function getPromptInputActionLabel(action: PromptInputAction, t: Translate): string {
  return action.name.trim() || t(`promptInput.action.${action.preset ?? 'custom'}`)
}

export function getPromptTerminalKeyLabel(key: string, t: Translate): string {
  return key.startsWith('Control+')
    ? t('promptInput.key.control', { key: key.slice(8) })
    : t(`promptInput.key.${key}` as TranslationKey)
}

export function formatPromptShortcutLabel(shortcut: string, platform: string): string {
  const normalized = normalizePromptShortcut(shortcut, platform)
  if (!normalized) return ''
  const modifiers: Record<string, string> = {
    Control: 'Ctrl', Meta: platform === 'darwin' ? '⌘' : platform === 'win32' ? 'Win' : 'Super',
    Alt: platform === 'darwin' ? '⌥' : 'Alt', Shift: platform === 'darwin' ? '⇧' : 'Shift', Plus: '+'
  }
  return normalized.split('+').map(part => modifiers[part] ?? part).join(platform === 'darwin' ? '' : '+')
}

/** Bounded UI-only details; task names must never be included in trace payloads. */
export function formatPromptInputFailureDetails(
  targets: ReadonlyArray<{ taskName: string; result: PromptInputResult }>, t: Translate
): string {
  const failed = targets.filter(target => !target.result.ok)
  const details = failed.slice(0, 8).map(({ taskName, result }, index) => {
    const clipped = taskName.slice(0, 80).replace(/\s+/g, ' ').trim()
    const task = clipped ? `${clipped}${taskName.length > 80 ? '…' : ''}` : t('promptInput.runtime.task', { number: index + 1 })
    const reason = t(result.reason ? `promptInput.runtime.failureReason.${result.reason}` : 'promptInput.runtime.failureReason.unknown')
    const detail = t(result.contentDelivered ? 'promptInput.runtime.failureAfterContent'
      : result.phase === 'key' ? 'promptInput.runtime.failureKey' : 'promptInput.runtime.failureBeforeContent', { reason })
    return t('promptInput.runtime.failureTarget', { task, detail })
  })
  if (failed.length > 8) details.push(t('promptInput.runtime.failureMore', { count: failed.length - 8 }))
  return details.join('\n')
}
