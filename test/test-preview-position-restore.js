/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

(async () => {
  const api = window.__onwardProjectEditorDebug
  if (!api) {
    console.error('[Test] __onwardProjectEditorDebug is unavailable. Open Project Editor first.')
    return
  }

  const markdownFile = 'dl_math_foundations.md'
  const otherFile = 'README.md'

  console.log('[Test] Starting preview position restore test')
  console.log('[Test] Markdown file:', markdownFile)
  console.log('[Test] Switch file:', otherFile)

  const result = await api.runPreviewPositionTest?.(markdownFile, otherFile)
  if (result) {
    console.log('[Test] Preview position restore passed.')
  } else {
    console.error('[Test] Preview position restore failed.')
  }
})()
