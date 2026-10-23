/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { memo, useLayoutEffect } from 'react'
import { usePromptLeaderState } from '../../contexts/PromptActionsContext'
import { useI18n } from '../../i18n/useI18n'
import { perfTraceDiagnostic } from '../../utils/perf-trace'
import { PERF_TRACE_EVENT } from '../../utils/perf-trace-names'
import './PromptLeaderIndicator.css'

function useCueTrace(surface: string, visible: boolean, selected: boolean, selecting: boolean) {
  useLayoutEffect(() => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_LEADER_CUE, { surface, phase: 'state', visible, selected, selecting })
    return () => { perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_LEADER_CUE, { surface, phase: 'clear' }) }
  }, [surface, visible, selected, selecting])
}

export const PromptLeaderIndicator = memo(function PromptLeaderIndicator() {
  const view = usePromptLeaderState()
  const { t } = useI18n()
  const index = view?.targets.findIndex(target => target.id === view.event.targetId) ?? -1
  useLayoutEffect(() => {
    perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_LEADER_CUE, { surface: 'app-bar', phase: view ? 'commit' : 'clear',
      ...(view ? { durationMs: Math.max(0, performance.now() - view.publishedAt) } : {}),
      selecting: Boolean(view?.event.selecting), targetSelected: index >= 0, count: view?.targets.length ?? 0 })
  }, [view, index])
  useLayoutEffect(() => () => { perfTraceDiagnostic(PERF_TRACE_EVENT.RENDERER_PROMPT_LEADER_CUE, { surface: 'app-bar', phase: 'unmount' }) }, [])
  const label = !view ? '' : index >= 0 ? t('promptInput.leader.selected', { number: index + 1, name: view.targets[index].title })
    : view.event.selecting ? t('promptInput.leader.choosing', { count: view.targets.length }) : t('promptInput.leader.waiting')
  const short = index >= 0 ? `→${index + 1}` : view?.event.selecting ? (view.targets.length ? `1–${view.targets.length}` : '—') : t('promptInput.leader.short')
  return <div className="prompt-leader-slot" role="status" aria-live="polite" aria-atomic="true">
    {view && <span className="prompt-leader-indicator" data-testid="prompt-leader-indicator"
      data-selecting={Boolean(view.event.selecting)} data-target-id={view.event.targetId ?? ''} title={label} aria-label={label}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="1" y="3" width="14" height="10" rx="2" /><path d="M3 6h2m2 0h2m2 0h2M3 8h2m2 0h2m2 0h2M4 10h8" />
      </svg><span aria-hidden="true">{short}</span>
    </span>}
  </div>
})

export const PromptTaskTargetBadge = memo(function PromptTaskTargetBadge({ tabId, terminalId, index }: {
  tabId?: string; terminalId: string; index: number
}) {
  const view = usePromptLeaderState()
  const { t } = useI18n()
  const selected = Boolean(view && view.event.tabId === tabId && view.event.targetId === terminalId)
  const selecting = Boolean(view && view.event.tabId === tabId && view.event.selecting)
  const visible = selecting || selected
  useCueTrace('task-badge', visible, selected, selecting)
  return visible ? <span className="prompt-task-target-badge" data-testid="prompt-task-target-badge" data-selected={selected}
    title={t('promptInput.leader.slot', { number: index + 1 })}>{index + 1}</span> : null
})

/** Subpages cover the grid; this local map keeps its layout-owned recipients visible. */
export const PromptTargetMap = memo(function PromptTargetMap({ tabId }: { tabId?: string }) {
  const view = usePromptLeaderState()
  const { t } = useI18n()
  const visible = view?.event.tabId === tabId && Boolean(view?.event.selecting)
  useCueTrace('subpage-map', visible, Boolean(view?.event.targetId), Boolean(view?.event.selecting))
  return visible && view ? <div className="prompt-target-map" data-testid="prompt-target-map" aria-label={t('promptInput.leader.map')}>
    {view.targets.map((target, index) => <span key={target.id}>
      <b>{index + 1}</b><span>{target.title || t('promptInput.runtime.task', { number: index + 1 })}</span>
    </span>)}
  </div> : null
})
