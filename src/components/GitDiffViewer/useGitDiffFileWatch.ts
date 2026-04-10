/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react'
import type { GitFileStatus } from '../../types/electron'

interface UseGitDiffFileWatchOptions {
  /** Whether the diff viewer is currently open / visible. */
  isOpen: boolean
  /** The file currently selected in the diff file list. */
  selectedFile: GitFileStatus | null
  /** Repo root for the selected file (submodule root or activeCwd). */
  repoRoot: string | null
  /** Called when the watched file changes on disk. */
  onFileChanged: (changeType: 'changed' | 'deleted') => void
}

/**
 * Watches the working-tree copy of the currently selected diff file for
 * external changes, reusing the existing FileWatchManager infrastructure
 * (same IPC channels as the Markdown preview live-refresh).
 *
 * Only one file is watched at a time — the currently selected file.
 * The watcher is automatically cleaned up when the file changes, the
 * viewer closes, or the component unmounts.
 */
export function useGitDiffFileWatch({
  isOpen,
  selectedFile,
  repoRoot,
  onFileChanged
}: UseGitDiffFileWatchOptions): void {
  const onFileChangedRef = useRef(onFileChanged)
  useEffect(() => {
    onFileChangedRef.current = onFileChanged
  }, [onFileChanged])

  useEffect(() => {
    // Only watch when the viewer is open, a non-deleted file is selected,
    // and we have a valid repo root.
    if (!isOpen || !selectedFile || !repoRoot || selectedFile.status === 'D') {
      return
    }

    const filename = selectedFile.filename
    const root = selectedFile.repoRoot || repoRoot

    // Start watching the working-tree file.
    void window.electronAPI.project.watchFile(root, filename)

    // Build the expected absolute path for filtering incoming events.
    // Match the normalisation that FileWatchManager uses (Node path.normalize).
    const separator = root.includes('\\') ? '\\' : '/'
    const expectedPath = root.endsWith(separator)
      ? `${root}${filename}`
      : `${root}${separator}${filename}`
    const normalizePath = (value: string) => value.replace(/[\\/]/g, '/')

    const unsubscribe = window.electronAPI.project.onFileChanged(
      (fullPath, changeType) => {
        if (changeType !== 'changed' && changeType !== 'deleted') return
        if (normalizePath(fullPath) !== normalizePath(expectedPath)) return
        onFileChangedRef.current(changeType)
      }
    )

    return () => {
      unsubscribe()
      void window.electronAPI.project.unwatchFile(root, filename)
    }
  }, [isOpen, selectedFile, repoRoot])
}
