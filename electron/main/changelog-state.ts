/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  acknowledgeReleaseNotes, evaluateChangelogUpgrade, normalizeReleaseVersion, parseReleaseNotesState,
  type ReleaseNotesState, type ReleaseNotesStartupState
} from '../../src/utils/changelog-upgrade.ts'

type Trace = (detail: Record<string, string | boolean | null>) => void

/** One owner per application process; main-thread calls cannot interleave state mutations. */
export class ReleaseNotesStore {
  private state: ReleaseNotesState | null = null
  private initialized = false
  private reason: ReleaseNotesStartupState['reason'] = 'fresh-install'
  private path: string
  private currentTag: string | null
  private previousVersion: string | null
  private trace: Trace

  constructor(path: string, currentTag: string | null, previousVersion: string | null, trace: Trace) {
    this.path = path
    this.currentTag = currentTag
    this.previousVersion = previousVersion
    this.trace = trace
    try {
      this.state = parseReleaseNotesState(JSON.parse(readFileSync(path, 'utf8')))
      if (!this.state) trace({ action: 'invalid-state' })
    } catch (error) {
      trace({ action: 'read-state', missing: (error as NodeJS.ErrnoException).code === 'ENOENT' })
    }
    // Preserve upgrade intent before renderer startup can fail. Without a baseline,
    // wait for the renderer's one-time legacy-storage import before initializing.
    if (this.state || normalizeReleaseVersion(previousVersion)) this.prepare()
  }

  prepare(legacyTag?: string | null): ReleaseNotesStartupState {
    if (!this.initialized) {
      const decision = evaluateChangelogUpgrade({
        currentTag: this.currentTag, state: this.state,
        previousSessionVersion: this.previousVersion, storedLastSeenTag: legacyTag
      })
      this.initialized = true
      this.reason = decision.reason
      this.state = decision.state
      this.trace({ action: 'startup', reason: this.reason, source: decision.source, tag: this.currentTag })
      if (this.state && normalizeReleaseVersion(this.currentTag)) this.persist()
    }
    return this.snapshot()
  }

  snapshot(): ReleaseNotesStartupState {
    return {
      currentTag: this.currentTag,
      pendingTag: this.state?.pendingVersion && this.state.pendingVersion === normalizeReleaseVersion(this.currentTag) ? this.currentTag : null,
      reason: this.reason
    }
  }

  markShown(tag: unknown): { success: boolean } {
    if (!this.initialized || !this.state) {
      this.trace({ action: 'acknowledge-uninitialized' })
      return { success: false }
    }
    const next = acknowledgeReleaseNotes(this.state, this.currentTag, tag)
    if (next === this.state) {
      this.trace({ action: 'acknowledge-ignored', matchesCurrent: tag === this.currentTag })
      return { success: tag === this.currentTag && this.state.pendingVersion === null }
    }
    // Suppress repeated interruptions in this process on write failure;
    // the persisted pending version remains available for the next launch.
    this.state = next
    const success = this.persist()
    this.trace({ action: 'shown', tag: this.currentTag, success })
    return { success }
  }

  private persist(): boolean {
    const temporary = `${this.path}.pending`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temporary, JSON.stringify(this.state), 'utf8')
      renameSync(temporary, this.path)
      this.trace({ action: 'persisted', pending: Boolean(this.state?.pendingVersion) })
      return true
    } catch {
      this.trace({ action: 'write-failed' })
      try { rmSync(temporary, { force: true }) } catch { this.trace({ action: 'cleanup-failed' }) }
      return false
    }
  }
}
