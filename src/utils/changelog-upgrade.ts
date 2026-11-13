/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export const LAST_SEEN_RELEASE_TAG_STORAGE_KEY = 'onward.lastSeenReleaseTag'

export type ChangelogUpgradeReason =
  | 'no-tag'
  | 'changelog-unavailable'
  | 'autotest-suppressed'
  | 'fresh-install'
  | 'same-version'
  | 'upgrade'
  | 'simulated-upgrade'

export interface ChangelogUpgradeDecisionInput {
  currentTag: string | null | undefined
  changelogAvailable: boolean
  storedLastSeenTag: string | null | undefined
  simulateUpgrade?: boolean
  isAutotest?: boolean
  autotestAllowAutoOpen?: boolean
}

export interface ChangelogUpgradeDecision {
  shouldAutoOpen: boolean
  reason: ChangelogUpgradeReason
  nextStoredTag: string | null
}

function normalizeTag(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Pure decision function modeled after VS Code's `releaseNotesEditor.ts` (`lastKnownVersion`).
 * - Fresh installs record the current tag without popping up a modal.
 * - Single-step or multi-version upgrades (`storedLastSeenTag !== currentTag`) auto-open
 *   the single latest release note and advance `onward.lastSeenReleaseTag` to `currentTag`.
 * - `simulateUpgrade` (`ONWARD_SIMULATE_UPGRADE=1`) forces the post-upgrade auto-open for manual preview.
 */
export function evaluateChangelogUpgrade(
  input: ChangelogUpgradeDecisionInput
): ChangelogUpgradeDecision {
  const currentTag = normalizeTag(input.currentTag)
  if (!currentTag) {
    return {
      shouldAutoOpen: false,
      reason: 'no-tag',
      nextStoredTag: null
    }
  }

  if (!input.changelogAvailable) {
    return {
      shouldAutoOpen: false,
      reason: 'changelog-unavailable',
      nextStoredTag: null
    }
  }

  const storedLastSeenTag = normalizeTag(input.storedLastSeenTag)

  if (input.isAutotest && !input.autotestAllowAutoOpen && !input.simulateUpgrade) {
    return {
      shouldAutoOpen: false,
      reason: 'autotest-suppressed',
      nextStoredTag: currentTag
    }
  }

  if (input.simulateUpgrade) {
    return {
      shouldAutoOpen: true,
      reason: 'simulated-upgrade',
      nextStoredTag: currentTag
    }
  }

  if (!storedLastSeenTag) {
    return {
      shouldAutoOpen: false,
      reason: 'fresh-install',
      nextStoredTag: currentTag
    }
  }

  if (storedLastSeenTag === currentTag) {
    return {
      shouldAutoOpen: false,
      reason: 'same-version',
      nextStoredTag: currentTag
    }
  }

  return {
    shouldAutoOpen: true,
    reason: 'upgrade',
    nextStoredTag: currentTag
  }
}
