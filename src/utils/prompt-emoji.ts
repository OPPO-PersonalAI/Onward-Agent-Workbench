/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { PROMPT_EMOJI_VALUES } from '../data/prompt-emoji-manifest.ts'

/** Variation selectors do not change the identity of our color artwork. */
export function promptEmojiKey(value: string): string {
  return Array.from(value).filter(char => char !== '\ufe0f').map(char => char.codePointAt(0)!.toString(16)).join('-')
}

const EMOJI_BY_KEY = new Map(PROMPT_EMOJI_VALUES.map(emoji => [promptEmojiKey(emoji), emoji]))
const DEFAULTS: Record<string, string> = {
  sendAndExecute: '🚀', execute: '⚡', send: '📤', sendAllAndExecute: '📣', queue: '⏳'
}

export function normalizePromptActionEmoji(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 64) return undefined
  return EMOJI_BY_KEY.get(promptEmojiKey(value))
}

export function getPromptActionEmoji(action: { emoji?: string; preset?: string }): string {
  return normalizePromptActionEmoji(action.emoji) ?? DEFAULTS[action.preset ?? ''] ?? '🤖'
}

/** Only validated catalog identities become relative, bundled resource paths. */
export function promptEmojiAssetPath(emoji: string): string {
  return `./prompt-emoji/flat/${promptEmojiKey(normalizePromptActionEmoji(emoji) ?? '🤖')}.svg`
}
