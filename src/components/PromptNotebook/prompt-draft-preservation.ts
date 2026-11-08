/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure decision for the "double-click a history prompt while the editor
 * holds content" flow: should the current editor content be auto-preserved
 * into Prompt History BEFORE the double-clicked prompt is loaded?
 *
 * Contract (user-approved 2026-07-13):
 *  - Empty (whitespace-only) editor → nothing to preserve.
 *  - Editor content identical to the history entry it was loaded from
 *    (title AND content unmodified) → skip, otherwise browsing history by
 *    double-click would duplicate an entry on every switch.
 *  - Anything else (fresh draft, or a loaded entry the user edited) →
 *    preserve as a NEW history entry. Never silently discard user input.
 *
 * Callers normalize both content strings with transformVirtualPaddingForSend
 * (src/utils/prompt-io.ts) before calling, so this module stays a pure
 * string comparison and the Node unit layer can pin every branch
 * (test/unittest/prompt-draft-preservation.test.mts).
 */

export interface DraftPreservationInput {
  /** Editor content, already normalized (virtual padding stripped). */
  normalizedContent: string
  /** Editor title as typed (compared trimmed). */
  title: string
  /** Optional list of attached image paths on the current draft. */
  imagePaths?: readonly string[]
  /**
   * The history entry currently loaded for editing, both fields normalized
   * the same way as the editor values; null when the editor holds a fresh
   * draft that was never loaded from history.
   */
  editingOriginal: { normalizedContent: string; title: string; imagePaths?: readonly string[] } | null
}

export type DraftPreservationReason = 'empty' | 'unchanged-from-source' | 'draft-preserved'

export interface DraftPreservationDecision {
  preserve: boolean
  reason: DraftPreservationReason
}

function areImagePathsEqual(a?: readonly string[], b?: readonly string[]): boolean {
  const listA = a ?? []
  const listB = b ?? []
  if (listA.length !== listB.length) return false
  return listA.every((item, idx) => item === listB[idx])
}

export function decideDraftPreservation(input: DraftPreservationInput): DraftPreservationDecision {
  const hasImages = Boolean(input.imagePaths && input.imagePaths.length > 0)
  if (!input.normalizedContent.trim() && !hasImages) {
    return { preserve: false, reason: 'empty' }
  }
  const original = input.editingOriginal
  if (
    original &&
    input.normalizedContent === original.normalizedContent &&
    input.title.trim() === original.title.trim() &&
    areImagePathsEqual(input.imagePaths, original.imagePaths)
  ) {
    return { preserve: false, reason: 'unchanged-from-source' }
  }
  return { preserve: true, reason: 'draft-preserved' }
}
