/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/** Synchronous producers publish their local debounces before AppState snapshots. */
export function createPendingStateFlushRegistry() {
  const participants = new Set<() => void>()
  return {
    register(flush: () => void): () => void {
      participants.add(flush)
      return () => { participants.delete(flush) }
    },
    flush(): number {
      const errors: unknown[] = []
      const snapshot = [...participants]
      for (const flush of snapshot) {
        try { flush() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'Pending renderer state flush failed')
      return snapshot.length
    }
  }
}

export const pendingStateFlush = createPendingStateFlushRegistry()

/** Default UI state must never overwrite disk while the initial load is pending. */
export async function awaitInitialStateForFlush(load: Promise<boolean> | null): Promise<void> {
  if (!load || !await load) throw new Error('Initial AppState load did not complete')
}

export function snapshotPromptDraft(
  title: string,
  content: string,
  height: number,
  savedAt: number,
  batchId?: string,
  images?: import('./prompt-images').PromptImageAttachment[]
) {
  const hasImages = Array.isArray(images) && images.length > 0
  if (!title.trim() && !content.trim() && !hasImages) return null
  return {
    title,
    content,
    height,
    savedAt,
    ...(batchId ? { batchId } : {}),
    ...(hasImages ? { images } : {})
  }
}
