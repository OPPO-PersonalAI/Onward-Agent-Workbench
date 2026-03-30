/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useCallback } from 'react'
import type { PromptSchedule, ExecutionLogEntry } from '../types/tab.d.ts'
import type { Prompt } from '../types/electron.d.ts'
import { computeNextExecution } from '../utils/schedule'
import { useI18n } from '../i18n/useI18n'
import { terminalSessionManager } from '../terminal/terminal-session-manager'

/** Maximum polling interval (60 seconds) */
const MAX_POLL_INTERVAL = 60 * 1000

/** Maximum number of execution logs */
const MAX_LOG_ENTRIES = 50

/** Append execution log entries */
function appendLogEntry(schedule: PromptSchedule, entry: ExecutionLogEntry): ExecutionLogEntry[] {
  const log = [...(schedule.executionLog ?? []), entry]
  return log.slice(-MAX_LOG_ENTRIES)
}

export interface ScheduleNotification {
  type: 'terminal-missing' | 'missed-execution'
  promptId: string
  promptTitle: string
  scheduleDescription: string
  message: string
}

interface UseScheduleEngineOptions {
  /** Whether the application state has been loaded (used to avoid missed detection before hydrate) */
  isLoaded: boolean
  /** All scheduled tasks */
  schedules: PromptSchedule[]
  /** Status of all Tabs (used to verify the terminal exists) */
  tabs: { id: string; terminals: { id: string }[] }[]
  /** All Prompts (globalPrompts + localPrompts for each Tab) */
  allPrompts: Prompt[]
  /** Update scheduled tasks */
  updateSchedule: (schedule: PromptSchedule) => void
  /** Notification callback */
  onNotification: (notification: ScheduleNotification) => void
}

/**
 * Scheduling engine Hook
 *
 * Strategy: single setTimeout + latest trigger time point + 60 second upper limit polling
 */
export function useScheduleEngine({
  isLoaded,
  schedules,
  tabs,
  allPrompts,
  updateSchedule,
  onNotification
}: UseScheduleEngineOptions) {
  const { t } = useI18n()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const missedScanDoneRef = useRef(false)
  const schedulesRef = useRef(schedules)
  const tabsRef = useRef(tabs)
  const allPromptsRef = useRef(allPrompts)
  const updateScheduleRef = useRef(updateSchedule)
  const onNotificationRef = useRef(onNotification)

  // Keep ref up to date
  schedulesRef.current = schedules
  tabsRef.current = tabs
  allPromptsRef.current = allPrompts
  updateScheduleRef.current = updateSchedule
  onNotificationRef.current = onNotification

  /**
   * Execute a single scheduled task
   */
  const executeSchedule = useCallback(async (schedule: PromptSchedule) => {
    const prompt = allPromptsRef.current.find(p => p.id === schedule.promptId)
    if (!prompt) {
      updateScheduleRef.current({
        ...schedule,
        status: 'failed',
        lastError: t('schedule.promptDeleted')
      })
      return
    }

    // Verify that the target terminal exists
    const tab = tabsRef.current.find(t => t.id === schedule.tabId)
    const existingTerminalIds = schedule.targetTerminalIds.filter(tid =>
      tab?.terminals.some(t => t.id === tid)
    )

    if (existingTerminalIds.length === 0) {
      const logEntry: ExecutionLogEntry = {
        timestamp: Date.now(),
        success: false,
        targetTerminalIds: schedule.targetTerminalIds,
        error: t('schedule.targetTerminalMissing')
      }
      onNotificationRef.current({
        type: 'terminal-missing',
        promptId: schedule.promptId,
        promptTitle: prompt.title || prompt.content.slice(0, 50),
        scheduleDescription: '',
        message: t('schedule.targetTerminalMissingNotice')
      })
      // Recurring tasks continue to the next run; one-time tasks are marked as failed.
      if (schedule.scheduleType === 'recurring') {
        const nextTime = computeNextExecution(schedule, Date.now() + 1)
        updateScheduleRef.current({
          ...schedule,
          nextExecutionAt: nextTime,
          lastError: t('schedule.targetTerminalMissing'),
          executionLog: appendLogEntry(schedule, logEntry)
        })
      } else {
        updateScheduleRef.current({
          ...schedule,
          status: 'failed',
          lastError: t('schedule.targetTerminalMissing'),
          executionLog: appendLogEntry(schedule, logEntry)
        })
      }
      return
    }

    // Reuse the same send-and-execute logic as handleSendAndExecuteOnTerminals.
    // Tier 1: session manager (handles single-line vs multi-line internally).
    // Tier 2: direct PTY write fallback for sessions without xterm instance.
    try {
      for (const terminalId of existingTerminalIds) {
        if (terminalSessionManager.pasteAndExecute(terminalId, prompt.content)) {
          continue
        }
        // Fallback: direct PTY write
        const result = await window.electronAPI.terminal.writeSplit(terminalId, prompt.content, '\r')
        if (!result.ok) {
          console.warn('[Schedule] writeSplit failed:', {
            terminalId,
            phase: result.phase,
            error: result.error
          })
        }
      }

      const now = Date.now()
      const newCount = schedule.executedCount + 1
      const successLog: ExecutionLogEntry = {
        timestamp: now,
        success: true,
        targetTerminalIds: existingTerminalIds
      }

      if (schedule.scheduleType === 'recurring') {
        // Check if the maximum number of executions has been reached
        if (schedule.maxExecutions !== null && newCount >= schedule.maxExecutions) {
          updateScheduleRef.current({
            ...schedule,
            executedCount: newCount,
            lastExecutedAt: now,
            status: 'completed',
            lastError: null,
            executionLog: appendLogEntry(schedule, successLog)
          })
        } else {
          const nextTime = computeNextExecution(schedule, now + 1)
          updateScheduleRef.current({
            ...schedule,
            executedCount: newCount,
            lastExecutedAt: now,
            nextExecutionAt: nextTime,
            lastError: null,
            executionLog: appendLogEntry(schedule, successLog)
          })
        }
      } else {
        // One-time task completed
        updateScheduleRef.current({
          ...schedule,
          executedCount: newCount,
          lastExecutedAt: now,
          status: 'completed',
          lastError: null,
          executionLog: appendLogEntry(schedule, successLog)
        })
      }
    } catch (error) {
      const errorLog: ExecutionLogEntry = {
        timestamp: Date.now(),
        success: false,
        targetTerminalIds: existingTerminalIds,
        error: String(error)
      }
      updateScheduleRef.current({
        ...schedule,
        lastError: String(error),
        executionLog: appendLogEntry(schedule, errorLog)
      })
    }
  }, [])

  /**
   * Check and execute all due tasks
   */
  const tick = useCallback(async () => {
    const now = Date.now()
    const activeSchedules = schedulesRef.current.filter(s => s.status === 'active')

    for (const schedule of activeSchedules) {
      if (schedule.nextExecutionAt <= now) {
        await executeSchedule(schedule)
      }
    }
  }, [executeSchedule])

  /**
   * Schedule the next tick
   */
  const scheduleNextTick = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const activeSchedules = schedulesRef.current.filter(s => s.status === 'active')
    if (activeSchedules.length === 0) return

    const now = Date.now()
    const nextTime = Math.min(...activeSchedules.map(s => s.nextExecutionAt))
    const delay = Math.max(0, Math.min(nextTime - now, MAX_POLL_INTERVAL))

    timerRef.current = setTimeout(async () => {
      await tick()
      scheduleNextTick()
    }, delay)
  }, [tick])

  // Monitor schedule changes and reschedule
  useEffect(() => {
    scheduleNextTick()
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [schedules, scheduleNextTick])

  // Check for missed executions on startup
  useEffect(() => {
    if (!isLoaded || missedScanDoneRef.current) {
      return
    }
    missedScanDoneRef.current = true

    const now = Date.now()
    const activeSchedules = schedules.filter(s => s.status === 'active')

    for (const schedule of activeSchedules) {
      // If the missed time exceeds 5 minutes, it is considered a missed execution
      if (schedule.nextExecutionAt < now - 5 * 60 * 1000) {
        const prompt = allPrompts.find(p => p.id === schedule.promptId)
        if (prompt) {
          onNotification({
            type: 'missed-execution',
            promptId: schedule.promptId,
            promptTitle: prompt.title || prompt.content.slice(0, 50),
            scheduleDescription: '',
            message: t('schedule.missedExecutionNotice')
          })
          updateSchedule({
            ...schedule,
            missedExecutions: schedule.missedExecutions + 1
          })
        }
      }
    }
  }, [isLoaded, schedules, allPrompts, onNotification, updateSchedule])
}
