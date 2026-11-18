/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { compareVersions, parseVersion } from './release-version.ts'

export const LAST_SEEN_RELEASE_TAG_STORAGE_KEY = 'onward.lastSeenReleaseTag'

export interface ReleaseNotesState {
  schemaVersion: 1
  lastRunVersion: string
  pendingVersion: string | null
}

export type ReleaseNotesReason = 'no-tag' | 'invalid-version' | 'fresh-install' | 'same-version' | 'upgrade' | 'downgrade' | 'pending'

export interface ReleaseNotesStartupState {
  currentTag: string | null
  pendingTag: string | null
  reason: ReleaseNotesReason
}

export function normalizeReleaseVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const version = value.trim().replace(/^v/, '')
  try {
    const parsed = parseVersion(version)
    // Calendar-only releases cannot be ordered against semantic releases.
    if (parsed.major >= 2000) return null
    return version
  } catch {
    return null
  }
}

export function parseReleaseNotesState(value: unknown): ReleaseNotesState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ReleaseNotesState>
  const lastRunVersion = normalizeReleaseVersion(candidate.lastRunVersion)
  if (candidate.schemaVersion !== 1 || !lastRunVersion) return null
  if (candidate.pendingVersion !== null && candidate.pendingVersion !== lastRunVersion) return null
  return { schemaVersion: 1, lastRunVersion, pendingVersion: candidate.pendingVersion }
}

/** Advance the startup baseline independently of content availability or display acknowledgement. */
export function evaluateChangelogUpgrade(input: {
  currentTag: string | null
  state?: ReleaseNotesState | null
  previousSessionVersion?: string | null
  storedLastSeenTag?: string | null
}): { state: ReleaseNotesState | null; reason: ReleaseNotesReason; source: string } {
  const current = normalizeReleaseVersion(input.currentTag)
  if (!current) return { state: input.state ?? null, reason: input.currentTag ? 'invalid-version' : 'no-tag', source: 'none' }
  const previousSession = normalizeReleaseVersion(input.previousSessionVersion)
  const legacy = normalizeReleaseVersion(input.storedLastSeenTag)
  const previous = input.state?.lastRunVersion ?? previousSession ?? legacy
  const source = input.state ? 'state-file' : previousSession ? 'session-ledger' : legacy ? 'legacy-storage' : 'none'
  const comparison = previous ? compareVersions(current, previous) : 0
  const pending = comparison > 0 || (comparison === 0 && input.state?.pendingVersion === current)
  return {
    state: { schemaVersion: 1, lastRunVersion: current, pendingVersion: pending ? current : null },
    reason: !previous ? 'fresh-install' : comparison > 0 ? 'upgrade' : comparison < 0 ? 'downgrade' : pending ? 'pending' : 'same-version',
    source
  }
}

/** Ignore stale acknowledgements and make duplicate acknowledgements harmless. */
export function acknowledgeReleaseNotes(state: ReleaseNotesState, currentTag: string | null, shownTag: unknown): ReleaseNotesState {
  if (shownTag !== currentTag || normalizeReleaseVersion(shownTag) !== state.pendingVersion) return state
  return { ...state, pendingVersion: null }
}
