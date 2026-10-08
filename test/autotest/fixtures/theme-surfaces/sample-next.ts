/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ReadingState {
  chapter: string
  position: number
}

// Comments must be readable in both appearances.
export function describeReadingState(state: ReadingState): string {
  const label = 'updated-reading-state'
  return `${label}: ${state.chapter} at ${state.position + 1}`
}

export const initialReadingState = { chapter: 'Introduction', position: 43 }
