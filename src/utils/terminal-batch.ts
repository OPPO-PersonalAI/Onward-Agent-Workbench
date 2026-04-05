/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TerminalBatchResult } from '../types/prompt'

export function createTerminalBatchResult(
  overrides: Partial<TerminalBatchResult> = {}
): TerminalBatchResult {
  return {
    successIds: [],
    sentOnlyIds: [],
    failedIds: [],
    issues: [],
    ...overrides
  }
}

export function getDeliveredTerminalIds(result: TerminalBatchResult): string[] {
  return [...result.successIds, ...result.sentOnlyIds]
}

export function hasDeliveredTerminals(result: TerminalBatchResult): boolean {
  return result.successIds.length > 0 || result.sentOnlyIds.length > 0
}

export function mergeTerminalBatchResult(
  target: TerminalBatchResult,
  next: TerminalBatchResult
): TerminalBatchResult {
  target.successIds.push(...next.successIds)
  target.sentOnlyIds.push(...next.sentOnlyIds)
  target.failedIds.push(...next.failedIds)
  target.issues.push(...next.issues)
  return target
}
