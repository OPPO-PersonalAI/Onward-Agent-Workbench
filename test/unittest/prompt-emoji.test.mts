/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PROMPT_EMOJI_VALUES } from '../../src/data/prompt-emoji-manifest.ts'
import { getPromptActionEmoji, normalizePromptActionEmoji, promptEmojiAssetPath, promptEmojiKey } from '../../src/utils/prompt-emoji.ts'
import { EMOJI_PAGE_SIZE, indexPromptEmoji, movePromptEmojiIndex, visiblePromptEmojiIndex, searchPromptEmoji, type PromptEmojiEntry } from '../../src/utils/prompt-emoji-search.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const catalog: PromptEmojiEntry[] = JSON.parse(readFileSync(join(root, 'src/data/prompt-emoji-catalog.json'), 'utf8'))
const index = indexPromptEmoji(catalog)
const query = (query: string, group = -1, offset = 0, locale = 'en') => searchPromptEmoji(index, { id: 1, query, group, offset, locale })

test('PE-U01: complete Unicode sequences map to local art, including selectors, ZWJ and skin tones', () => {
  assert.equal(getPromptActionEmoji({ preset: 'sendAndExecute' }), '🚀')
  assert.equal(getPromptActionEmoji({}), '🤖')
  for (const emoji of ['🚀', '👩🏽‍💻', '👍🏻', '👍🏿', '🛠️']) {
    assert.equal(normalizePromptActionEmoji(emoji), emoji)
    assert.equal(getPromptActionEmoji({ emoji, preset: 'queue' }), emoji)
    assert.match(promptEmojiAssetPath(emoji), /^\.\/prompt-emoji\/flat\/[0-9a-f-]+\.svg$/)
  }
  assert.equal(normalizePromptActionEmoji('🛠'), '🛠️')
  for (const value of ['', 'text', '🚀🚀', ' 🚀', '../robot.svg', '<svg/>', '🚀\u200d', '\ud800', 42, null, {}, 'a'.repeat(65)]) {
    assert.equal(normalizePromptActionEmoji(value), undefined)
  }
  assert.equal(getPromptActionEmoji({ emoji: 'unknown', preset: 'execute' }), '⚡')
})

test('PE-U02: every shipped identity has bilingual metadata and exact pinned artwork bytes', () => {
  const provenance = JSON.parse(readFileSync(join(root, 'resources/emoji/provenance.json'), 'utf8'))
  assert.equal(catalog.length, 3145)
  assert.equal(PROMPT_EMOJI_VALUES.length, catalog.length)
  assert.equal(readdirSync(join(root, 'public/prompt-emoji/flat')).length, catalog.length)
  assert.equal(new Set(catalog.map(entry => entry.key)).size, catalog.length)
  for (const [position, entry] of catalog.entries()) {
    assert.equal(entry.emoji, PROMPT_EMOJI_VALUES[position])
    assert.equal(entry.key, promptEmojiKey(entry.emoji))
    assert.equal(normalizePromptActionEmoji(entry.emoji), entry.emoji)
    assert(entry.en && entry.zh && entry.group >= 0 && entry.group <= 9)
    const bytes = readFileSync(join(root, 'public/prompt-emoji/flat', `${entry.key}.svg`))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.assets[entry.key].sha256, entry.key)
  }
  const notices = readFileSync(join(root, 'resources/emoji/ThirdPartyNotices.txt'), 'utf8')
  for (const owner of ['Microsoft Corporation', 'Miles Johnson', 'UNICODE LICENSE V3']) assert(notices.includes(owner))
})

test('PE-U03: English/Chinese searches, single characters, category isolation and exact ranking', () => {
  for (const [text, emoji, locale] of [['rocket', '🚀', 'en'], ['火箭', '🚀', 'zh-CN'], ['robot', '🤖', 'zh-CN'], ['女程序员', '👩‍💻', 'zh-CN'], ['🛠️', '🛠️', 'en']]) {
    assert.equal(query(text, -1, 0, locale).items[0].emoji, emoji)
  }
  assert(query('火').total > 1)
  assert(query('  ＲＯＣＫＥＴ  ').items.some(entry => entry.emoji === '🚀'))
  assert(query('light skin').total > 0)
  assert(query('thumb', 1).items.every(entry => entry.group === 1))
  assert.equal(query('rocket', 4).total, 0)
  assert.equal(query('unfindable-emoji-12345').total, 0)
  assert.equal(query('').total, catalog.length)
})

test('PE-U04: bounded windows and keyboard movement cover the entire catalog without gaps', () => {
  const seen = new Set<string>()
  for (let offset = 0; offset < catalog.length; offset += EMOJI_PAGE_SIZE) {
    const page = query('', -1, offset)
    assert(page.items.length <= EMOJI_PAGE_SIZE)
    for (const entry of page.items) seen.add(entry.key)
  }
  assert.equal(seen.size, catalog.length)
  assert.equal(query('', -1, -10).offset, 0)
  assert(query('', -1, 100000).items.length > 0)
  assert.equal(movePromptEmojiIndex(0, 'ArrowLeft', 10), 0)
  assert.equal(movePromptEmojiIndex(0, 'ArrowDown', 10), 6)
  assert.equal(movePromptEmojiIndex(6, 'ArrowDown', 10), 9)
  assert.equal(movePromptEmojiIndex(9, 'Home', 10), 0)
  assert.equal(movePromptEmojiIndex(0, 'End', 10), 9)
  assert.equal(movePromptEmojiIndex(9, 'End', 0), 0)
  assert.equal(visiblePromptEmojiIndex(0, 400, 240, 3145), 60)
  assert.equal(visiblePromptEmojiIndex(75, 400, 240, 3145), 75)
  assert.equal(visiblePromptEmojiIndex(100, 401, 240, 3145), 66)
  assert.equal(visiblePromptEmojiIndex(0, 30000, 240, 3145), 3144)
  assert.equal(visiblePromptEmojiIndex(42, 400, 240, 0), 0)
})
