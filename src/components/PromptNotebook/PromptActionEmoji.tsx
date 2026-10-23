/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react'
import { promptEmojiAssetPath } from '../../utils/prompt-emoji'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'

let reached = false

/** Shared local artwork; a broken package still leaves a recognizable glyph. */
export function PromptActionEmoji({ emoji }: { emoji: string }) {
  const src = promptEmojiAssetPath(emoji)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (failed && failed !== src) {
      setFailed(null)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_ASSET, { reason: 'fallback-reset' })
    }
  }, [src, failed])
  useEffect(() => {
    if (reached) return
    reached = true
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_ASSET, { reason: 'first-use' })
  }, [])
  return <span className="prompt-action-emoji" aria-hidden="true" data-emoji={emoji}>
    {failed === src ? emoji : <img src={src} alt="" draggable={false} onError={() => {
      setFailed(src)
      perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_EMOJI_ASSET, { reason: 'load-failed', fallback: 'unicode' })
    }} />}
  </span>
}
