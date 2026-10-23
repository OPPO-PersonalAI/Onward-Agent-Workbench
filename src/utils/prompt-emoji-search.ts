/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PromptEmojiEntry {
  key: string; emoji: string; group: number; en: string; zh: string; keywords: string[]
}
export type PromptEmojiOption = Omit<PromptEmojiEntry, 'keywords'>
export interface PromptEmojiQuery {
  id: number; query: string; group: number; offset: number; locale: string
}
export interface PromptEmojiPage {
  id: number; total: number; offset: number; items: PromptEmojiOption[]; durationMs: number
}
export const EMOJI_COLUMNS = 6
export const EMOJI_ROW_HEIGHT = 40
export const EMOJI_PAGE_SIZE = 48
const fold = (value: string) => value.normalize('NFKC').toLowerCase().trim()

export function indexPromptEmoji(entries: readonly PromptEmojiEntry[]) {
  return entries.map(entry => ({ entry, search: fold([entry.emoji, entry.en, entry.zh, ...entry.keywords].join(' ')) }))
}

/** Called only in the Worker; the renderer receives at most eight visible rows. */
export function searchPromptEmoji(index: ReturnType<typeof indexPromptEmoji>, request: PromptEmojiQuery) {
  const query = fold(request.query.slice(0, 96))
  const tokens = query.split(/\s+/).filter(Boolean)
  const ranked = index.filter(({ entry, search }) => (request.group < 0 || entry.group === request.group)
    && tokens.every(token => search.includes(token)))
  if (query) {
    const rank = (entry: PromptEmojiEntry) => {
      const label = fold(request.locale === 'zh-CN' ? entry.zh : entry.en)
      return label === query || entry.emoji === query ? 0 : label.startsWith(query) ? 1 : 2
    }
    ranked.sort((a, b) => rank(a.entry) - rank(b.entry))
  }
  const offset = Math.max(0, Math.min(Math.floor(request.offset / EMOJI_COLUMNS) * EMOJI_COLUMNS,
    Math.max(0, Math.ceil(ranked.length / EMOJI_COLUMNS) - 1) * EMOJI_COLUMNS))
  return {
    total: ranked.length, offset,
    items: ranked.slice(offset, offset + EMOJI_PAGE_SIZE).map(({ entry: { keywords: _keywords, ...entry } }) => entry)
  }
}

export function movePromptEmojiIndex(index: number, key: string, count: number): number {
  if (!count) return 0
  const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -EMOJI_COLUMNS, ArrowDown: EMOJI_COLUMNS,
    PageUp: -EMOJI_COLUMNS * 5, PageDown: EMOJI_COLUMNS * 5 }
  return key === 'Home' ? 0 : key === 'End' ? count - 1 : Math.max(0, Math.min(count - 1, index + (delta[key] ?? 0)))
}

/** Re-entering a wheel-scrolled list must expose a visible keyboard option. */
export function visiblePromptEmojiIndex(active: number, scrollTop: number, height: number, count: number): number {
  if (!count) return 0
  const first = Math.min(count - 1, Math.ceil(scrollTop / EMOJI_ROW_HEIGHT) * EMOJI_COLUMNS)
  const end = Math.min(count, Math.floor((scrollTop + height) / EMOJI_ROW_HEIGHT) * EMOJI_COLUMNS)
  return active >= first && active < end ? active : first
}
