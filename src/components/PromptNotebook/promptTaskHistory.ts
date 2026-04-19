/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Prompt } from '../../types/electron'

const TASK_NAME_PATTERN = /\bTask\s+(\d+)\b/i

export interface PromptTaskHistorySummary {
  promptTaskNumbers: Map<string, number[]>
  allTaskNumbers: number[]
}

export function extractTaskNumber(taskName: string): number | null {
  const match = taskName.match(TASK_NAME_PATTERN)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

// Task slots are driven by the currently active terminals in the tab (1..activeTaskCount).
// sendHistory records that reference slot numbers outside that range are stale and ignored.
export function buildPromptTaskHistorySummary(
  prompts: Prompt[],
  activeTaskCount: number
): PromptTaskHistorySummary {
  const normalizedCount = Number.isFinite(activeTaskCount) && activeTaskCount > 0
    ? Math.floor(activeTaskCount)
    : 0

  const promptTaskSet = new Map<string, Set<number>>()

  if (normalizedCount > 0) {
    prompts.forEach((prompt) => {
      ;(prompt.sendHistory ?? []).forEach((record) => {
        const taskNumber = extractTaskNumber(record.taskName)
        if (taskNumber === null || taskNumber > normalizedCount) return
        let set = promptTaskSet.get(prompt.id)
        if (!set) {
          set = new Set<number>()
          promptTaskSet.set(prompt.id, set)
        }
        set.add(taskNumber)
      })
    })
  }

  const promptTaskNumbers = new Map<string, number[]>()
  promptTaskSet.forEach((taskSet, promptId) => {
    promptTaskNumbers.set(promptId, [...taskSet].sort((a, b) => a - b))
  })

  const allTaskNumbers: number[] = []
  for (let i = 1; i <= normalizedCount; i++) {
    allTaskNumbers.push(i)
  }

  return { promptTaskNumbers, allTaskNumbers }
}
