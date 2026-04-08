/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type SubpageId = 'diff' | 'editor' | 'history'

export interface ProjectEditorOpenRequest {
  id: number
  terminalId: string
  filePath: string | null
  repoRoot: string | null
}

export interface ProjectEditorOpenEventDetail {
  terminalId?: string
  filePath?: string | null
  repoRoot?: string | null
}

export interface SubpageNavigateEventDetail {
  terminalId?: string
  target?: SubpageId
  filePath?: string | null
  repoRoot?: string | null
}
