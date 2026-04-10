/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react'
import type { SubpageId } from '../../types/subpage'
import { SubpageSwitcher } from './SubpageSwitcher'
import './SubpagePanelShell.css'

interface SubpagePanelShellProps {
  current: SubpageId
  onSelect: (target: SubpageId) => void
  actions?: ReactNode
  workingDirectoryLabel: string
  workingDirectoryPath: string | null
  metaExtra?: ReactNode
  taskTitle?: string
  children?: ReactNode
}

export interface SubpagePanelShellState {
  current: SubpageId
  onSelect: (target: SubpageId) => void
  actions?: ReactNode
  workingDirectoryLabel: string
  workingDirectoryPath: string | null
  metaExtra?: ReactNode
  taskTitle?: string
}

export function SubpagePanelShell({
  current,
  onSelect,
  actions,
  workingDirectoryLabel,
  workingDirectoryPath,
  metaExtra,
  taskTitle,
  children
}: SubpagePanelShellProps) {
  return (
    <div className="subpage-panel-shell" data-subpage-panel-shell="true">
      <div className="subpage-panel-shell-header">
        <SubpageSwitcher current={current} onSelect={onSelect} />
        {taskTitle && (
          <div className="subpage-panel-shell-task-title" title={taskTitle}>
            {taskTitle}
          </div>
        )}
        {actions && <div className="subpage-panel-shell-actions">{actions}</div>}
      </div>
      <div className="subpage-panel-shell-meta">
        <div className="subpage-panel-shell-location">
          <span className="subpage-panel-shell-location-label">{workingDirectoryLabel}</span>
          <span
            className="subpage-panel-shell-location-path"
            title={workingDirectoryPath || '-'}
          >
            {workingDirectoryPath || '-'}
          </span>
        </div>
        {metaExtra && <div className="subpage-panel-shell-meta-extra">{metaExtra}</div>}
      </div>
      {children ? (
        <div className="subpage-panel-shell-content">
          {children}
        </div>
      ) : null}
    </div>
  )
}
