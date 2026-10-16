/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

// User-approved total deadline, identical in production and autotests.
export const QUIT_DEADLINE_MS = 10_000
// Reserve part of the total budget for OS process termination and Electron exit.
export const QUIT_EXIT_RESERVE_MS = 500
export interface QuitStage { name: string; required?: boolean; run: () => void | Promise<void> }
export type QuitOutcome = 'cancelled' | 'ready' | 'forced'
export interface QuitEffects {
  stages: (reason: string) => QuitStage[]
  begin: (reason: string) => void
  finish: (reason: string, clean: boolean) => void
  force: (reason: string, clean: boolean) => void
  trace: (phase: string, data: Record<string, unknown>) => void
  now: () => number
  schedule: (callback: () => void, ms: number) => unknown
  cancel: (timer: unknown) => void
}

/** One owner for confirmation, teardown, and the deadline through actual exit. */
export class QuitCoordinator {
  private active: Promise<QuitOutcome> | null = null
  private confirmation: Promise<QuitOutcome> | null = null
  private timer: unknown = null
  private forced = false
  private requiredRemaining = 0
  private requiredFailed = false

  private readonly effects: QuitEffects
  constructor(effects: QuitEffects) { this.effects = effects }

  get stopping(): boolean { return this.active !== null }

  request(reason: string, confirm?: () => Promise<boolean>): Promise<QuitOutcome> {
    if (this.active) {
      this.effects.trace('duplicate-request', { reason })
      return this.active
    }
    if (!confirm) return this.start(reason)
    if (this.confirmation) {
      this.effects.trace('duplicate-confirmation', { reason })
      return this.confirmation
    }
    this.effects.trace('confirmation-start', { reason })
    const confirmation = Promise.resolve().then(confirm).then(accepted => {
      // A signal/external quit can supersede an outstanding native dialog.
      if (this.active) return this.active
      this.effects.trace('confirmation-result', { reason, accepted })
      return accepted ? this.start(reason) : 'cancelled' as const
    }).finally(() => { if (this.confirmation === confirmation) this.confirmation = null })
    this.confirmation = confirmation
    return confirmation
  }

  exited(): void {
    if (this.timer !== null) this.effects.cancel(this.timer)
    this.timer = null
  }

  private start(reason: string): Promise<QuitOutcome> {
    let resolve!: (outcome: QuitOutcome) => void
    this.active = new Promise<QuitOutcome>(done => { resolve = done })
    const stages = this.effects.stages(reason)
    this.requiredRemaining = stages.filter(stage => stage.required).length
    const clean = () => this.requiredRemaining === 0 && !this.requiredFailed
    this.timer = this.effects.schedule(() => {
      this.forced = true
      this.effects.trace('deadline', { reason, clean: clean(), deadlineMs: QUIT_DEADLINE_MS })
      this.effects.force(reason, clean())
      resolve('forced')
    }, QUIT_DEADLINE_MS - QUIT_EXIT_RESERVE_MS)
    try { this.effects.begin(reason) }
    catch {
      this.requiredFailed = true
      this.effects.trace('begin-failed', { reason })
    }
    void (async () => {
      for (const stage of stages) {
        if (this.forced) return
        const started = this.effects.now()
        this.effects.trace('stage-start', { reason, stage: stage.name })
        let failed = false
        try { await stage.run() }
        catch {
          failed = true
          if (stage.required) this.requiredFailed = true
        }
        if (this.forced) return
        if (stage.required) this.requiredRemaining -= 1
        this.effects.trace('stage-end', { reason, stage: stage.name, failed, durationMs: this.effects.now() - started })
      }
      if (this.forced) return
      this.effects.trace('ready', { reason, clean: clean() })
      try {
        this.effects.finish(reason, clean())
        resolve('ready')
      } catch {
        this.effects.trace('exit-request-failed', { reason })
        // The original deadline remains armed; no second timer or clean retry.
      }
    })()
    return this.active
  }
}
