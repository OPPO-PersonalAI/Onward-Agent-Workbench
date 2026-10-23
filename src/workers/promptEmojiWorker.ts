/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import catalog from '../data/prompt-emoji-catalog.json'
import { indexPromptEmoji, searchPromptEmoji, type PromptEmojiQuery } from '../utils/prompt-emoji-search'

// One owner per open picker: terminating it cancels indexing, search and queued replies.
const started = performance.now()
const index = indexPromptEmoji(catalog)
self.postMessage({ type: 'ready', count: index.length, durationMs: performance.now() - started })
self.onmessage = (event: MessageEvent<PromptEmojiQuery>) => {
  const started = performance.now()
  try {
    self.postMessage({ type: 'page', id: event.data.id, ...searchPromptEmoji(index, event.data), durationMs: performance.now() - started })
  } catch {
    self.postMessage({ type: 'error', id: event.data.id })
  }
}
