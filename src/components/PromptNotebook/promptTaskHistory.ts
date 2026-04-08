/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Prompt } from '../../types/electron'

const TASK_NAME_PATTERN = /\bTask\s+(\d+)\b/i

interface TaskHistoryRecord {
  promptId: string
  taskId: string
  taskName: string
  sentAt: number
}

interface TaskHistoryMeta {
  taskId: string
  firstSeenAt: number
  preferredNumber: number | null
}

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

function collectHistoryRecords(prompts: Prompt[]): TaskHistoryRecord[] {
  const records: TaskHistoryRecord[] = []
  prompts.forEach((prompt) => {
    ;(prompt.sendHistory ?? []).forEach((record) => {
      records.push({
        promptId: prompt.id,
        taskId: record.taskId,
        taskName: record.taskName,
        sentAt: record.sentAt
      })
    })
  })
  return records.sort((a, b) => {
    if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt
    if (a.promptId !== b.promptId) return a.promptId.localeCompare(b.promptId)
    return a.taskId.localeCompare(b.taskId)
  })
}

function assignTaskNumbers(records: TaskHistoryRecord[]): Map<string, number> {
  const metaByTaskId = new Map<string, TaskHistoryMeta>()

  records.forEach((record) => {
    const parsedNumber = extractTaskNumber(record.taskName)
    const existing = metaByTaskId.get(record.taskId)
    if (!existing) {
      metaByTaskId.set(record.taskId, {
        taskId: record.taskId,
        firstSeenAt: record.sentAt,
        preferredNumber: parsedNumber
      })
      return
    }
    if (parsedNumber !== null && existing.preferredNumber === null) {
      existing.preferredNumber = parsedNumber
    }
    if (record.sentAt < existing.firstSeenAt) {
      existing.firstSeenAt = record.sentAt
    }
  })

  const preferredNumbers = new Set<number>()
  metaByTaskId.forEach((meta) => {
    if (meta.preferredNumber !== null) {
      preferredNumbers.add(meta.preferredNumber)
    }
  })

  const assigned = new Set<number>()
  const taskNumberByTaskId = new Map<string, number>()
  const orderedMetas = [...metaByTaskId.values()].sort((a, b) => {
    if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt - b.firstSeenAt
    return a.taskId.localeCompare(b.taskId)
  })

  let nextFallback = 1
  const allocateFallback = () => {
    while (assigned.has(nextFallback) || preferredNumbers.has(nextFallback)) {
      nextFallback += 1
    }
    const value = nextFallback
    assigned.add(value)
    nextFallback += 1
    return value
  }

  orderedMetas.forEach((meta) => {
    if (meta.preferredNumber !== null && !assigned.has(meta.preferredNumber)) {
      assigned.add(meta.preferredNumber)
      taskNumberByTaskId.set(meta.taskId, meta.preferredNumber)
      return
    }
    taskNumberByTaskId.set(meta.taskId, allocateFallback())
  })

  return taskNumberByTaskId
}

export function buildPromptTaskHistorySummary(prompts: Prompt[]): PromptTaskHistorySummary {
  const records = collectHistoryRecords(prompts)
  if (records.length === 0) {
    return {
      promptTaskNumbers: new Map<string, number[]>(),
      allTaskNumbers: []
    }
  }

  const taskNumberByTaskId = assignTaskNumbers(records)
  const promptTaskSet = new Map<string, Set<number>>()
  const allTaskNumbers = new Set<number>()

  records.forEach((record) => {
    const taskNumber = taskNumberByTaskId.get(record.taskId)
    if (taskNumber === undefined) return
    let set = promptTaskSet.get(record.promptId)
    if (!set) {
      set = new Set<number>()
      promptTaskSet.set(record.promptId, set)
    }
    set.add(taskNumber)
    allTaskNumbers.add(taskNumber)
  })

  const promptTaskNumbers = new Map<string, number[]>()
  promptTaskSet.forEach((taskSet, promptId) => {
    promptTaskNumbers.set(promptId, [...taskSet].sort((a, b) => a - b))
  })

  return {
    promptTaskNumbers,
    allTaskNumbers: [...allTaskNumbers].sort((a, b) => a - b)
  }
}
