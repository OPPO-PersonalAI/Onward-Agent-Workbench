/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { parseDiffFromFile, SPLIT_WITH_NEWLINES } from '@pierre/diffs'
import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from '@pierre/diffs'
import type * as monacoTypes from 'monaco-editor'
import type { GitDiffResult, GitFileStatus, GitFileContentResult, GitFileActionResult } from '../../types/electron'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
import './GitDiffViewer.css'

const DEBUG_GIT_DIFF = Boolean(window.electronAPI?.debug?.enabled)

function debugLog(...args: unknown[]) {
  if (!DEBUG_GIT_DIFF) return
  console.log('[GitDiffViewer]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore
  }
}

// local storage key name
const STORAGE_KEY_FILE_LIST_WIDTH = 'git-diff-file-list-width'
const STORAGE_KEY_MODAL_SIZE = 'git-diff-modal-size'

// File list width limit
const DEFAULT_FILE_LIST_WIDTH = 280
const MIN_FILE_LIST_WIDTH = 150
const MAX_FILE_LIST_WIDTH = 600

// Pop-up window size limit
const DEFAULT_MODAL_WIDTH = 1200
const DEFAULT_MODAL_HEIGHT = 600
const MIN_MODAL_WIDTH = 600
const MIN_MODAL_HEIGHT = 400
const MAX_MODAL_WIDTH_PERCENT = 95  // Percentage relative to viewport
const MAX_MODAL_HEIGHT_PERCENT = 95

interface GitDiffViewerProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  cwd: string | null
  displayMode?: 'modal' | 'panel'
}

// Status color map
const statusColors: Record<GitFileStatus['status'], string> = {
  'M': '#e2c08d', // Modified - Orange
  'A': '#89d185', // Added - green
  'D': '#f14c4c', // Deleted - red
  'R': '#569cd6', // Renamed - blue
  'C': '#c586c0', // Copied - Purple
  '?': '#858585'  // Untracked - Gray
}

interface FileContentState {
  loading: boolean
  originalContent: string
  modifiedContent: string
  draftContent?: string
  isBinary: boolean
  error?: string
}

type DiffViewAnchor = {
  line: number | null        // Modify the first visible line number in the editor
  scrollTop: number          // Editor scroll position
}

type DiffViewMemoryEntry = {
  fileKey: string
  filePath: string
  originalFilename?: string
  anchor: DiffViewAnchor | null
  scrollTop: number
  signature: string | null
  updatedAt: number
}

type DiffViewMemory = {
  selectedFileKey: string | null
  entries: Record<string, DiffViewMemoryEntry>
}

type GitDiffDebugApi = {
  isOpen: () => boolean
  getFileList: () => GitFileStatus[]
  getSelectedFile: () => { filename: string; originalFilename?: string } | null
  selectFileByPath: (path: string) => boolean
  selectFileByIndex: (index: number) => boolean
  isSelectedReady: () => boolean
  getRestoreNotice: () => { type: 'missing' | 'changed'; message: string; fileName?: string } | null
  getScrollTop: () => number
  getFirstVisibleLine: () => number
  scrollToFraction: (fraction: number) => boolean
  scrollToLine: (line: number) => boolean
  getDiffFontSize: () => number
  getCwd: () => string | null
  getRepoRoot: () => string | null
}

type LineSelectionInfo =
  | {
    valid: false
    side: SelectionSide
    count: number
    message: string
  }
  | {
    valid: true
    side: SelectionSide
    start: number
    end: number
    count: number
  }

function buildFileKey(repoRoot: string, file: GitFileStatus): string {
  const original = file.originalFilename ?? ''
  return `${repoRoot}::${file.changeType}::${file.status}::${original}::${file.filename}`
}

const SIGNATURE_SAMPLE_SIZE = 256

function hashString(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function buildTextSignature(text: string): string {
  if (!text) return '0:0:0'
  const head = text.slice(0, SIGNATURE_SAMPLE_SIZE)
  const tail = text.slice(-SIGNATURE_SAMPLE_SIZE)
  return `${text.length}:${hashString(head)}:${hashString(tail)}`
}

function buildDiffSignature(original: string, modified: string): string {
  return `${buildTextSignature(original)}|${buildTextSignature(modified)}`
}

function getLatestMemoryEntry(entries: Record<string, DiffViewMemoryEntry>): DiffViewMemoryEntry | null {
  let latest: DiffViewMemoryEntry | null = null
  for (const entry of Object.values(entries)) {
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = entry
    }
  }
  return latest
}

function buildContentWithSelection(
  diff: FileDiffMetadata,
  side: SelectionSide,
  selectedLines: Set<number>,
  applySelected: boolean,
  oldContent: string,
  newContent: string
): string {
  const oldLines = diff.oldLines ?? oldContent.split(SPLIT_WITH_NEWLINES)
  const newLines = diff.newLines ?? newContent.split(SPLIT_WITH_NEWLINES)
  const output: string[] = []
  let oldIndex = 1
  let newIndex = 1

  for (const hunk of diff.hunks) {
    while (oldIndex < hunk.deletionStart && newIndex < hunk.additionStart) {
      output.push(oldLines[oldIndex - 1] ?? '')
      oldIndex += 1
      newIndex += 1
    }

    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines.length; i += 1) {
          output.push(oldLines[oldIndex - 1] ?? '')
          oldIndex += 1
          newIndex += 1
        }
      } else {
        for (let i = 0; i < content.deletions.length; i += 1) {
          const lineNumber = oldIndex
          const isSelected = side === 'deletions' && selectedLines.has(lineNumber)
          const shouldApply = applySelected ? isSelected : !isSelected
          if (!shouldApply) {
            output.push(oldLines[oldIndex - 1] ?? '')
          }
          oldIndex += 1
        }
        for (let i = 0; i < content.additions.length; i += 1) {
          const lineNumber = newIndex
          const isSelected = side === 'additions' && selectedLines.has(lineNumber)
          const shouldApply = applySelected ? isSelected : !isSelected
          if (shouldApply) {
            output.push(newLines[newIndex - 1] ?? '')
          }
          newIndex += 1
        }
      }
    }
  }

  while (oldIndex <= oldLines.length && newIndex <= newLines.length) {
    output.push(oldLines[oldIndex - 1] ?? '')
    oldIndex += 1
    newIndex += 1
  }

  return output.join('')
}

export function GitDiffViewer({
  isOpen,
  onClose,
  terminalId,
  cwd,
  displayMode = 'modal'
}: GitDiffViewerProps) {
  const isPanel = displayMode === 'panel'
  const { settings } = useSettings()
  const { t } = useI18n()
  const perfCountersRef = useRef({
    renders: 0,
    loadDiff: 0,
    diffViewBuild: 0
  })
  const perfIntervalRef = useRef<number | null>(null)
  const diffMemoryRef = useRef<Record<string, DiffViewMemory>>({})
  const diffRestoreCycleRef = useRef(0)
  const diffRestoreAppliedRef = useRef<{ cycle: number; fileKey: string | null }>({ cycle: 0, fileKey: null })
  const diffScrollCaptureTimerRef = useRef<number | null>(null)
  const suppressScrollCaptureRef = useRef(false)
  const [diffRestoreNotice, setDiffRestoreNotice] = useState<{
    type: 'missing' | 'changed'
    message: string
    fileName?: string
  } | null>(null)
  if (DEBUG_GIT_DIFF) {
    perfCountersRef.current.renders += 1
  }
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  const [selectedFile, setSelectedFile] = useState<GitFileStatus | null>(null)
  const [fileContents, setFileContents] = useState<Record<string, FileContentState>>({})
  const fileContentsRef = useRef<Record<string, FileContentState>>({})
  const inFlightRef = useRef<Partial<Record<string, Promise<void>>>>({})
  const loadTokenRef = useRef(0)
  const loadInFlightRef = useRef(false)
  const loadQueuedRef = useRef<{ reset?: boolean; silent?: boolean; force?: boolean } | null>(null)
  const lastDiffRef = useRef<{ cwd: string; originalCwd: string; at: number; result: GitDiffResult } | null>(null)
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [lineMessage, setLineMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [actionState, setActionState] = useState<{ type: 'keep' | 'deny'; fileKey: string } | null>(null)
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null)
  const [lineActionState, setLineActionState] = useState<{ type: 'keep' | 'deny'; fileKey: string } | null>(null)
  const [editMessage, setEditMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const editMessageTimerRef = useRef<number>(0)
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; targetFile: GitFileStatus } | null>(null)
  const [copyMessage, setCopyMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const diffEditorRef = useRef<monacoTypes.editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof monacoTypes | null>(null)
  const isDraftDirtyRef = useRef(false)
  const originalDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const modifiedDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const selectedFileRef = useRef<GitFileStatus | null>(null)
  const lastSelectedFileRef = useRef<GitFileStatus | null>(null)
  const activeCwd = useMemo(() => diffResult?.cwd || cwd, [diffResult?.cwd, cwd])
  const getFileKey = useCallback((file: GitFileStatus, repoRoot = activeCwd || '') => {
    return buildFileKey(repoRoot, file)
  }, [activeCwd])

  const selectedFileKey = selectedFile ? getFileKey(selectedFile) : null
  const selectedFileState = selectedFileKey ? fileContents[selectedFileKey] : null
  const statusText = useMemo(() => ({
    M: t('gitDiff.status.modified'),
    A: t('gitDiff.status.added'),
    D: t('gitDiff.status.deleted'),
    R: t('gitDiff.status.renamed'),
    C: t('gitDiff.status.copied'),
    '?': t('gitDiff.status.untracked'),
  }), [t])
  const changeTypeText = useMemo(() => ({
    unstaged: t('gitDiff.changeType.unstaged'),
    staged: t('gitDiff.changeType.staged'),
    untracked: t('gitDiff.changeType.untracked'),
  }), [t])
  const isDraftDirty = selectedFileState?.draftContent !== undefined &&
    selectedFileState.draftContent !== selectedFileState.modifiedContent
  const hasAnyUnsavedDraft = useMemo(() => {
    return Object.values(fileContents).some((state) =>
      state?.draftContent !== undefined && state.draftContent !== state.modifiedContent
    )
  }, [fileContents])
  const effectiveModifiedContent = selectedFileState?.draftContent ?? selectedFileState?.modifiedContent ?? ''
  const editDisabledReason = useMemo(() => {
    if (!selectedFile) return t('gitDiff.editDisabled.noFile')
    if (!selectedFileState) return t('gitDiff.editDisabled.fileNotLoaded')
    if (selectedFileState.loading) return t('gitDiff.editDisabled.fileLoading')
    if (selectedFileState.error) return t('gitDiff.editDisabled.readFailed')
    if (selectedFileState.isBinary) return t('gitDiff.editDisabled.binary')
    if (selectedFile.status === 'D') return t('gitDiff.editDisabled.deleted')
    if (selectedFile.changeType === 'staged') return t('gitDiff.editDisabled.staged')
    return ''
  }, [selectedFile, selectedFileState, t])
  const canEditFile = editDisabledReason.length === 0
  const canSaveDraft = canEditFile && isDraftDirty && !isSavingEdit
  const confirmCloseWithDraft = useCallback(() => {
    if (!hasAnyUnsavedDraft) return true
    return window.confirm(t('gitDiff.confirm.closeWithDraft'))
  }, [hasAnyUnsavedDraft, t])

  // ---Copy function ---
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopyMessage({ type: 'success', text: t('common.copied', { label, text }) })
    } catch {
      setCopyMessage({ type: 'error', text: t('gitDiff.copyFailed') })
    }
  }, [t])

  useEffect(() => {
    if (!copyMessage) return
    const timer = window.setTimeout(() => setCopyMessage(null), 2000)
    return () => window.clearTimeout(timer)
  }, [copyMessage])

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!selectedFile) return
    const rootCwd = activeCwd || ''
    const isAbsolute = e.altKey
    const relativePath = selectedFile.filename
    const pathToCopy = isAbsolute ? `${rootCwd}/${relativePath}` : relativePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    await copyToClipboard(pathToCopy, label)
  }, [selectedFile, activeCwd, copyToClipboard, t])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, targetFile: file })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const copyContextMenuPath = useCallback(async (file: GitFileStatus, kind: 'name' | 'relative' | 'absolute') => {
    const rootCwd = activeCwd || ''
    if (kind === 'name') {
      const name = file.filename.split('/').pop() || file.filename
      await copyToClipboard(name, t('common.name'))
    } else if (kind === 'relative') {
      await copyToClipboard(file.filename, t('common.relativePath'))
    } else {
      await copyToClipboard(`${rootCwd}/${file.filename}`, t('common.absolutePath'))
    }
    closeContextMenu()
  }, [activeCwd, copyToClipboard, closeContextMenu, t])

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = () => setContextMenu(null)
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [contextMenu])

  // File list width (read from localStorage)
  const [fileListWidth, setFileListWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const isDraggingRef = useRef(false)

  // Pop-up window size (read from localStorage)
  const [modalSize, setModalSize] = useState(() => {
    if (isPanel) {
      return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
    }
    const saved = localStorage.getItem(STORAGE_KEY_MODAL_SIZE)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        return {
          width: parsed.width || DEFAULT_MODAL_WIDTH,
          height: parsed.height || DEFAULT_MODAL_HEIGHT
        }
      } catch {
        return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
      }
    }
    return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
  })
  const modalSizeRef = useRef(modalSize)
  const isResizingModalRef = useRef(false)
  const resizeDirectionRef = useRef<string>('')

  const getMemoryKey = useCallback((repoRootOverride?: string | null) => {
    const repo = repoRootOverride || activeCwd || cwd || ''
    const terminal = terminalId || ''
    if (!repo || !terminal) return ''
    return `${terminal}::${repo}`
  }, [activeCwd, cwd, terminalId])

  const getMemoryStore = useCallback(() => {
    const key = getMemoryKey()
    if (!key) return null
    if (!diffMemoryRef.current[key]) {
      diffMemoryRef.current[key] = {
        selectedFileKey: null,
        entries: {}
      }
    }
    return diffMemoryRef.current[key]
  }, [getMemoryKey])

  const findMemoryEntry = useCallback((
    memory: DiffViewMemory,
    file: GitFileStatus,
    fileKey: string
  ): DiffViewMemoryEntry | null => {
    const direct = memory.entries[fileKey]
    if (direct) return direct
    const match = Object.values(memory.entries).find((entry) =>
      entry.filePath === file.filename &&
      (entry.originalFilename ?? '') === (file.originalFilename ?? '')
    )
    return match ?? null
  }, [])

  const captureDiffView = useCallback((fileKeyOverride?: string | null) => {
    const memory = getMemoryStore()
    if (!memory) return
    const editor = diffEditorRef.current
    if (!editor) return
    const fileKey = fileKeyOverride ?? selectedFileKey
    if (!fileKey || !selectedFile) return
    const modifiedEditor = editor.getModifiedEditor()
    const visibleRanges = modifiedEditor.getVisibleRanges()
    const firstVisibleLine = visibleRanges.length > 0 ? visibleRanges[0].startLineNumber : null
    const scrollTop = modifiedEditor.getScrollTop()
    const anchor: DiffViewAnchor = {
      line: firstVisibleLine,
      scrollTop
    }
    const signature = selectedFileState && !selectedFileState.isBinary
      ? buildDiffSignature(
        selectedFileState.originalContent ?? '',
        selectedFileState.draftContent ?? selectedFileState.modifiedContent ?? ''
      )
      : null
    memory.entries[fileKey] = {
      fileKey,
      filePath: selectedFile.filename,
      originalFilename: selectedFile.originalFilename,
      anchor,
      scrollTop,
      signature,
      updatedAt: Date.now()
    }
    memory.selectedFileKey = fileKey
  }, [
    getMemoryStore,
    selectedFile,
    selectedFileKey,
    selectedFileState
  ])

  const scrollToFirstChange = useCallback(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    const changes = editor.getLineChanges()
    if (!changes || changes.length === 0) return
    const firstChange = changes[0]
    const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
    editor.getModifiedEditor().revealLineNearTop(targetLine)
  }, [])

  const scrollToTop = useCallback(() => {
    const editor = diffEditorRef.current
    if (!editor) return
    editor.getModifiedEditor().setScrollTop(0)
  }, [])

  // Load Git Diff data
  const resetViewerState = useCallback(() => {
    setDiffResult(null)
    setSelectedFile(null)
    setFileContents({})
    setActionMessage(null)
    setLineMessage(null)
    setSelectedLineRange(null)
    setLineActionState(null)
    setEditMessage(null)
    setIsSavingEdit(false)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
    originalDecorationsRef.current = null
    modifiedDecorationsRef.current = null
    diffEditorRef.current = null
    monacoRef.current = null
  }, [])

  const loadDiff = useCallback(async (options?: { reset?: boolean; silent?: boolean; force?: boolean }) => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.loadDiff += 1
    }
    const previousSelection = lastSelectedFileRef.current || selectedFileRef.current
    if (!cwd) {
      setDiffResult({
        success: false,
        cwd: '',
        isGitRepo: false,
        gitInstalled: true,
        files: [],
        error: t('gitDiff.error.noWorkingDirectory')
      })
      return
    }

    if (!options?.reset && !options?.force) {
      const cached = lastDiffRef.current
      if (cached && (cached.originalCwd === cwd || cached.cwd === cwd)) {
        const age = Date.now() - cached.at
        if (age < 800) {
          debugLog('diff:load:cache', { cwd, age })
          setDiffResult(cached.result)
          return
        }
      }
    }

    if (loadInFlightRef.current) {
      const previous = loadQueuedRef.current
      const nextSilent = options?.silent ?? false
      loadQueuedRef.current = {
        reset: Boolean(previous?.reset || options?.reset),
        force: Boolean(previous?.force || options?.force),
        silent: previous ? Boolean(previous.silent ?? true) && nextSilent : nextSilent
      }
      debugLog('diff:load:skip', { cwd, reason: 'in-flight' })
      return
    }
    loadInFlightRef.current = true

    if (options?.reset) {
      resetViewerState()
    }

    const currentToken = ++loadTokenRef.current
    const start = performance.now()
    debugLog('diff:load:start', {
      cwd,
      token: currentToken,
      reset: Boolean(options?.reset),
      silent: Boolean(options?.silent),
      force: Boolean(options?.force)
    })
    try {
      const result = await window.electronAPI.git.getDiff(cwd)
      if (loadTokenRef.current !== currentToken) return
      setDiffResult(result)
      lastDiffRef.current = {
        cwd: result.cwd || cwd,
        originalCwd: cwd,
        at: Date.now(),
        result
      }

      const repoRoot = result.cwd || cwd
      const nextKeys = new Set(result.files.map((file) => buildFileKey(repoRoot, file)))
      const memoryKey = getMemoryKey(repoRoot)
      const memoryStore = memoryKey
        ? (diffMemoryRef.current[memoryKey] || {
          selectedFileKey: null,
          entries: {}
        })
        : {
          selectedFileKey: null,
          entries: {}
        }
      if (memoryKey) {
        diffMemoryRef.current[memoryKey] = memoryStore
      }

      // Clean cache that no longer exists
      setFileContents((prev) => {
        const next: Record<string, FileContentState> = {}
        for (const key of nextKeys) {
          if (prev[key]) {
            next[key] = prev[key]
          }
        }
        return next
      })

      // Keep the last selected file (use memory first, then try the last selected file)
      if (result.success && result.files.length > 0) {
        const memorySelectedKey = memoryStore.selectedFileKey
        const memoryEntryByKey = memorySelectedKey ? memoryStore.entries[memorySelectedKey] : null
        const memoryEntry = memoryEntryByKey ?? getLatestMemoryEntry(memoryStore.entries)
        const memoryMatched = memoryEntry
          ? result.files.find((file) =>
            file.filename === memoryEntry.filePath &&
            (file.originalFilename ?? '') === (memoryEntry.originalFilename ?? '')
          )
          : (memorySelectedKey
            ? result.files.find((file) => buildFileKey(repoRoot, file) === memorySelectedKey)
            : null)
        const previous = previousSelection
        const matched = memoryMatched || (previous
          ? result.files.find((file) => file.filename === previous.filename && file.changeType === previous.changeType)
          : null)
        const fallback = (!matched && previous)
          ? result.files.find((file) => file.filename === previous.filename &&
            (file.originalFilename ?? '') === (previous.originalFilename ?? ''))
          : null
        if ((memorySelectedKey || memoryEntry) && !memoryMatched) {
          const headerTitle = memoryEntry
            ? (memoryEntry.originalFilename
              ? `${memoryEntry.originalFilename} → ${memoryEntry.filePath}`
              : memoryEntry.filePath)
            : (previous?.originalFilename && (previous.status === 'R' || previous.status === 'C')
              ? `${previous.originalFilename} → ${previous.filename}`
              : (previous?.filename || t('gitDiff.unknownFile')))
          setDiffRestoreNotice({
            type: 'missing',
            message: t('gitDiff.restore.fileMissing', { fileName: headerTitle }),
            fileName: headerTitle
          })
        } else if (previous && !matched && !fallback) {
          const headerTitle = previous.originalFilename && (previous.status === 'R' || previous.status === 'C')
            ? `${previous.originalFilename} → ${previous.filename}`
            : previous.filename
          setDiffRestoreNotice({
            type: 'missing',
            message: t('gitDiff.restore.fileMissing', { fileName: headerTitle }),
            fileName: headerTitle
          })
        }
        setSelectedFile(matched || fallback || result.files[0])
      } else {
        setSelectedFile(null)
        const memorySelectedKey = memoryStore.selectedFileKey
        const memoryEntryByKey = memorySelectedKey ? memoryStore.entries[memorySelectedKey] : null
        const memoryEntry = memoryEntryByKey ?? getLatestMemoryEntry(memoryStore.entries)
        if (memoryEntry) {
          const headerTitle = memoryEntry.originalFilename
            ? `${memoryEntry.originalFilename} → ${memoryEntry.filePath}`
            : memoryEntry.filePath
          setDiffRestoreNotice({
            type: 'missing',
            message: t('gitDiff.restore.fileMissing', { fileName: headerTitle }),
            fileName: headerTitle
          })
        }
      }
      debugLog('diff:load:done', {
        cwd: result.cwd || cwd,
        token: currentToken,
        success: result.success,
        fileCount: result.files?.length ?? 0,
        duration: Math.round(performance.now() - start)
      })
    } catch (error) {
      if (loadTokenRef.current !== currentToken) return
      setDiffResult({
        success: false,
        cwd: cwd || '',
        isGitRepo: false,
        gitInstalled: true,
        files: [],
        error: t('gitDiff.error.loadFailed', { error: String(error) })
      })
      debugLog('diff:load:error', { cwd, token: currentToken, error: String(error) })
    } finally {
      loadInFlightRef.current = false
      if (loadQueuedRef.current) {
        const queued = loadQueuedRef.current
        loadQueuedRef.current = null
        window.setTimeout(() => {
          void loadDiff(queued)
        }, 0)
      }
    }
  }, [cwd, getMemoryKey, resetViewerState, t])

  // Load data when opening
  useEffect(() => {
    if (isOpen) {
      loadDiff({ reset: true })
    }
  }, [isOpen, loadDiff])

  useLayoutEffect(() => {
    if (isOpen) {
      resetViewerState()
    }
  }, [isOpen, resetViewerState])

  useEffect(() => {
    selectedFileRef.current = selectedFile
    if (selectedFile) {
      lastSelectedFileRef.current = selectedFile
    }
  }, [selectedFile])

  useEffect(() => {
    fileContentsRef.current = fileContents
  }, [fileContents])

  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (isOpen) {
      diffRestoreCycleRef.current += 1
      diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey: null }
      wasOpenRef.current = true
      return
    }
    if (wasOpenRef.current) {
      captureDiffView()
      wasOpenRef.current = false
    }
  }, [captureDiffView, getMemoryKey, getMemoryStore, isOpen])

  // Scroll capture is now registered via onDidScrollChange in handleEditorDidMount
  // Position restoration is done directly in handleEditorDidMount by checking memory storage (to avoid effect timing competition)

  useEffect(() => {
    if (!diffRestoreNotice || !selectedFile) return
    if (diffRestoreNotice.type !== 'changed') return
    const headerTitle = selectedFile.originalFilename && (selectedFile.status === 'R' || selectedFile.status === 'C')
      ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
      : selectedFile.filename
    if (diffRestoreNotice.fileName && diffRestoreNotice.fileName !== headerTitle) {
      setDiffRestoreNotice(null)
    }
  }, [diffRestoreNotice, selectedFile])

  // Drag and drop to adjust file list width
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    const startX = e.clientX
    const startWidth = fileListWidth

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientX - startX
      const newWidth = Math.max(MIN_FILE_LIST_WIDTH, Math.min(MAX_FILE_LIST_WIDTH, startWidth + delta))
      setFileListWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        // Save to localStorage
        localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(fileListWidth))
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('git-diff-resizing')
    }

    document.body.classList.add('git-diff-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileListWidth])

  // Save width to localStorage (when width changes)
  useEffect(() => {
    if (!isDraggingRef.current) {
      localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, String(fileListWidth))
    }
  }, [fileListWidth])

  // Drag and drop to adjust pop-up window size
  const handleModalResizeMouseDown = useCallback((e: React.MouseEvent, direction: string) => {
    if (isPanel) return
    e.preventDefault()
    e.stopPropagation()
    isResizingModalRef.current = true
    resizeDirectionRef.current = direction

    const startX = e.clientX
    const startY = e.clientY
    const startWidth = modalSize.width
    const startHeight = modalSize.height

    const maxWidth = window.innerWidth * MAX_MODAL_WIDTH_PERCENT / 100
    const maxHeight = window.innerHeight * MAX_MODAL_HEIGHT_PERCENT / 100

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingModalRef.current) return

      let newWidth = startWidth
      let newHeight = startHeight

      const dir = resizeDirectionRef.current

      // Handle horizontal orientation
      if (dir.includes('e')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth + (e.clientX - startX) * 2))
      } else if (dir.includes('w')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth - (e.clientX - startX) * 2))
      }

      // Handle vertical orientation
      if (dir.includes('s')) {
        newHeight = Math.max(MIN_MODAL_HEIGHT, Math.min(maxHeight, startHeight + (e.clientY - startY) * 2))
      } else if (dir.includes('n')) {
        newHeight = Math.max(MIN_MODAL_HEIGHT, Math.min(maxHeight, startHeight - (e.clientY - startY) * 2))
      }

      setModalSize({ width: newWidth, height: newHeight })
    }

    const handleMouseUp = () => {
      if (isResizingModalRef.current) {
        isResizingModalRef.current = false
        resizeDirectionRef.current = ''
        // Save to localStorage
        localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSizeRef.current))
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('git-diff-modal-resizing')
    }

    document.body.classList.add('git-diff-modal-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isPanel, modalSize])

  // Save popup window size to localStorage
  useEffect(() => {
    if (isPanel) return
    if (!isResizingModalRef.current) {
      localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSize))
    }
  }, [isPanel, modalSize])

  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  const ensureFileContent = useCallback(async (file: GitFileStatus, force = false) => {
    if (!activeCwd) return
    const fileKey = getFileKey(file)
    const cached = fileContentsRef.current[fileKey]
    if (cached && !force) {
      return
    }
    if (inFlightRef.current[fileKey]) {
      return
    }

    setFileContents((prev) => ({
      ...prev,
      [fileKey]: {
        ...(prev[fileKey] || {
          originalContent: '',
          modifiedContent: '',
          isBinary: false
        }),
        loading: true,
        error: undefined
      }
    }))

    const task = (async () => {
      try {
        const result: GitFileContentResult = await window.electronAPI.git.getFileContent(activeCwd, {
          filename: file.filename,
          status: file.status,
          originalFilename: file.originalFilename,
          changeType: file.changeType
        })

        if (!result.success) {
          setFileContents((prev) => ({
            ...prev,
            [fileKey]: {
              ...(prev[fileKey] || {
                originalContent: '',
                modifiedContent: '',
                isBinary: false
              }),
              loading: false,
              error: result.error || t('gitDiff.error.readFile'),
              originalContent: '',
              modifiedContent: '',
              draftContent: prev[fileKey]?.draftContent,
              isBinary: false
            }
          }))
          return
        }

        setFileContents((prev) => {
          const previous = prev[fileKey]
          const draft = previous?.draftContent
          const nextDraft = draft !== undefined && draft !== result.modifiedContent ? draft : undefined
          return {
            ...prev,
            [fileKey]: {
              loading: false,
              error: undefined,
              originalContent: result.originalContent,
              modifiedContent: result.modifiedContent,
              draftContent: nextDraft,
              isBinary: result.isBinary
            }
          }
        })
      } catch (error) {
        setFileContents((prev) => ({
          ...prev,
          [fileKey]: {
              ...(prev[fileKey] || {
                originalContent: '',
                modifiedContent: '',
                isBinary: false
              }),
              loading: false,
            error: t('gitDiff.error.readFailed', { error: String(error) }),
            originalContent: '',
            modifiedContent: '',
            draftContent: prev[fileKey]?.draftContent,
            isBinary: false
          }
        }))
      }
    })()

    inFlightRef.current[fileKey] = task
    try {
      await task
    } finally {
      delete inFlightRef.current[fileKey]
    }
  }, [activeCwd, getFileKey, t])

  useEffect(() => {
    if (selectedFile) {
      ensureFileContent(selectedFile)
      setActionMessage(null)
    }
    setSelectedLineRange(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
  }, [selectedFile, ensureFileContent])

  useEffect(() => { isDraftDirtyRef.current = isDraftDirty }, [isDraftDirty])
  const handleFileSelect = useCallback((file: GitFileStatus) => {
    const nextKey = getFileKey(file)
    if (selectedFileKey && nextKey !== selectedFileKey) {
      captureDiffView(selectedFileKey)
      setDiffRestoreNotice(null)
    }
    if (selectedFileKey && nextKey !== selectedFileKey && isDraftDirty) {
      const confirmed = window.confirm(t('gitDiff.confirm.switchFileWithDraft'))
      if (!confirmed) return
    }
    setSelectedFile(file)
  }, [captureDiffView, getFileKey, isDraftDirty, selectedFileKey, t])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const api: GitDiffDebugApi = {
      isOpen: () => isOpen,
      getFileList: () => diffResult?.files ?? [],
      getSelectedFile: () => (selectedFile ? {
        filename: selectedFile.filename,
        originalFilename: selectedFile.originalFilename
      } : null),
      selectFileByPath: (path: string) => {
        const files = diffResult?.files ?? []
        const target = files.find((file) =>
          file.filename === path || file.originalFilename === path
        )
        if (target) {
          handleFileSelect(target)
          return true
        }
        return false
      },
      selectFileByIndex: (index: number) => {
        const files = diffResult?.files ?? []
        const target = files[index]
        if (target) {
          handleFileSelect(target)
          return true
        }
        return false
      },
      isSelectedReady: () => {
        const key = selectedFileKey
        if (!key) return false
        const state = fileContentsRef.current[key]
        return Boolean(state && !state.loading && !state.error && !state.isBinary)
      },
      getRestoreNotice: () => diffRestoreNotice,
      getScrollTop: () => diffEditorRef.current?.getModifiedEditor().getScrollTop() ?? 0,
      getFirstVisibleLine: () => {
        const editor = diffEditorRef.current
        if (!editor) return 0
        const ranges = editor.getModifiedEditor().getVisibleRanges()
        return ranges.length > 0 ? ranges[0].startLineNumber : 0
      },
      scrollToFraction: (fraction: number) => {
        const editor = diffEditorRef.current
        if (!editor) return false
        const modifiedEditor = editor.getModifiedEditor()
        const scrollHeight = modifiedEditor.getScrollHeight()
        const clientHeight = modifiedEditor.getLayoutInfo().height
        const max = Math.max(0, scrollHeight - clientHeight)
        const next = Math.max(0, Math.min(max, max * Math.max(0, Math.min(1, fraction))))
        modifiedEditor.setScrollTop(next)
        window.requestAnimationFrame(() => {
          if (!isDraftDirtyRef.current) {
            captureDiffView()
          }
        })
        return true
      },
      scrollToLine: (line: number) => {
        const editor = diffEditorRef.current
        if (!editor) return false
        editor.getModifiedEditor().revealLineNearTop(line)
        window.requestAnimationFrame(() => {
          if (!isDraftDirtyRef.current) {
            captureDiffView()
          }
        })
        return true
      },
      getDiffFontSize: () => settings?.terminalStyles[terminalId]?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE,
      getCwd: () => cwd,
      getRepoRoot: () => diffResult?.cwd || null
    }
    ;(window as any).__onwardGitDiffDebug = api
    return () => {
      if ((window as any).__onwardGitDiffDebug === api) {
        delete (window as any).__onwardGitDiffDebug
      }
    }
  }, [
    captureDiffView,
    cwd,
    diffRestoreNotice,
    diffResult,
    handleFileSelect,
    isOpen,
    selectedFile,
    selectedFileKey,
    settings,
    terminalId
  ])

  const clearLineSelection = useCallback(() => {
    setSelectedLineRange(null)
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
  }, [])

  const discardDraft = useCallback(() => {
    if (!selectedFileKey) return
    setFileContents((prev) => {
      const current = prev[selectedFileKey]
      if (!current) return prev
      return {
        ...prev,
        [selectedFileKey]: {
          ...current,
          draftContent: undefined
        }
      }
    })
    setEditMessage(null)
  }, [selectedFileKey])

  const handleDraftChange = useCallback((value?: string) => {
    if (!selectedFileKey) return
    setFileContents((prev) => {
      const current = prev[selectedFileKey]
      if (!current) return prev
      const nextValue = value ?? ''
      const nextDraft = nextValue === current.modifiedContent ? undefined : nextValue
      if (current.draftContent === nextDraft) return prev
      return {
        ...prev,
        [selectedFileKey]: {
          ...current,
          draftContent: nextDraft
        }
      }
    })
    setEditMessage(null)
  }, [selectedFileKey])

  const handleEditorDidMount = useCallback(
    (editor: monacoTypes.editor.IStandaloneDiffEditor, monaco: typeof monacoTypes) => {
      diffEditorRef.current = editor
      monacoRef.current = monaco
      // Reset decoration refs (the old editor was destroyed, the old collection is no longer valid)
      originalDecorationsRef.current = null
      modifiedDecorationsRef.current = null

      const originalEditor = editor.getOriginalEditor()
      const modifiedEditor = editor.getModifiedEditor()

      // Monitor content changes in the editor on the right (direct editing, automatic draft maintenance)
      modifiedEditor.onDidChangeModelContent(() => {
        const value = modifiedEditor.getValue()
        handleDraftChange(value)
      })

      // Auxiliary: Convert editor selection to row selection range
      const handleCursorSelection = (
        side: SelectionSide,
        selection: monacoTypes.Selection
      ) => {
        // Skip row selection when there are unsaved drafts to avoid confusion between editing text and row-level operation status
        if (isDraftDirtyRef.current) return

        const startLine = selection.startLineNumber
        const endLine = selection.endLineNumber === selection.startLineNumber
          ? selection.endLineNumber
          : (selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber)

        if (startLine === endLine && selection.startColumn === selection.endColumn) {
          // No selection (cursor click), clear row selection
          setSelectedLineRange(null)
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current?.clear()
          return
        }

        const start = Math.min(startLine, endLine)
        const end = Math.max(startLine, endLine)

        setSelectedLineRange({
          start,
          end,
          side,
          endSide: side
        })

        // Apply decorative highlighting
        const decorations: monacoTypes.editor.IModelDeltaDecoration[] = []
        for (let i = start; i <= end; i++) {
          decorations.push({
            range: new monaco.Range(i, 1, i, 1),
            options: {
              isWholeLine: true,
              className: 'git-diff-selected-line'
            }
          })
        }

        if (side === 'deletions') {
          modifiedDecorationsRef.current?.clear()
          if (!originalDecorationsRef.current) {
            originalDecorationsRef.current = originalEditor.createDecorationsCollection(decorations)
          } else {
            originalDecorationsRef.current.set(decorations)
          }
        } else {
          originalDecorationsRef.current?.clear()
          if (!modifiedDecorationsRef.current) {
            modifiedDecorationsRef.current = modifiedEditor.createDecorationsCollection(decorations)
          } else {
            modifiedDecorationsRef.current.set(decorations)
          }
        }
      }

      // Register selection changes for the original editor (left = deletions)
      originalEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('deletions', e.selection)
      })

      // Register selection changes in the modification editor (right = additions)
      modifiedEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('additions', e.selection)
      })

      // Suppress scroll capture during initial mount to prevent initial layout scrollTop=0 from overwriting memory
      suppressScrollCaptureRef.current = true

      // Scroll capture (replacing DOM scroll monitoring)
      modifiedEditor.onDidScrollChange(() => {
        if (suppressScrollCaptureRef.current) return
        if (diffScrollCaptureTimerRef.current) {
          window.clearTimeout(diffScrollCaptureTimerRef.current)
        }
        diffScrollCaptureTimerRef.current = window.setTimeout(() => {
          diffScrollCaptureTimerRef.current = null
          if (!isDraftDirtyRef.current) {
            // Read the latest editor status directly through ref to avoid closure expiration
            const currentEditor = diffEditorRef.current
            if (!currentEditor) return
            const currentMemory = getMemoryStore()
            if (!currentMemory) return
            const currentFile = selectedFileRef.current
            const currentFileKey = currentFile ? getFileKey(currentFile) : null
            if (!currentFileKey || !currentFile) return
            const currentFileState = fileContentsRef.current[currentFileKey]
            const me = currentEditor.getModifiedEditor()
            const ranges = me.getVisibleRanges()
            const firstLine = ranges.length > 0 ? ranges[0].startLineNumber : null
            const st = me.getScrollTop()
            const sig = currentFileState && !currentFileState.isBinary
              ? buildDiffSignature(
                currentFileState.originalContent ?? '',
                currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
              )
              : null
            currentMemory.entries[currentFileKey] = {
              fileKey: currentFileKey,
              filePath: currentFile.filename,
              originalFilename: currentFile.originalFilename,
              anchor: { line: firstLine, scrollTop: st },
              scrollTop: st,
              signature: sig,
              updatedAt: Date.now()
            }
            currentMemory.selectedFileKey = currentFileKey
            debugLog('capture:scroll', { fileKey: currentFileKey, line: firstLine, scrollTop: st })
          }
        }, 120)
      })

      // Position recovery: Check memory storage directly (does not rely on effect to set ref, avoiding timing competition)
      // Delay execution to wait for diff calculation to complete
      setTimeout(() => {
        const currentCycle = diffRestoreCycleRef.current
        const file = selectedFileRef.current
        const fileKey = file ? getFileKey(file) : null
        if (!file || !fileKey) {
          suppressScrollCaptureRef.current = false
          return
        }
        if (
          diffRestoreAppliedRef.current.cycle === currentCycle &&
          diffRestoreAppliedRef.current.fileKey === fileKey
        ) {
          suppressScrollCaptureRef.current = false
          return
        }
        const memory = getMemoryStore()
        if (!memory) {
          suppressScrollCaptureRef.current = false
          return
        }
        const entry = findMemoryEntry(memory, file, fileKey)
        if (!entry) {
          debugLog('restore:no-entry', { fileKey })
          suppressScrollCaptureRef.current = false
          return
        }
        const headerTitle = file.originalFilename && (file.status === 'R' || file.status === 'C')
          ? `${file.originalFilename} → ${file.filename}`
          : file.filename
        if (file.status === 'D') {
          diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
          setDiffRestoreNotice({
            type: 'missing',
            message: t('gitDiff.restore.deletedLocation', { fileName: headerTitle }),
            fileName: headerTitle
          })
          suppressScrollCaptureRef.current = false
          return
        }
        const currentFileState = fileContentsRef.current[fileKey]
        if (entry.signature && currentFileState && !currentFileState.isBinary) {
          const currentSignature = buildDiffSignature(
            currentFileState.originalContent ?? '',
            currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
          )
          if (currentSignature !== entry.signature) {
            diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
            setDiffRestoreNotice({
              type: 'changed',
              message: t('gitDiff.restore.changedLocation', { fileName: headerTitle }),
              fileName: headerTitle
            })
            suppressScrollCaptureRef.current = false
            return
          }
        }
        // Perform recovery
        const me = editor.getModifiedEditor()
        if (entry.anchor?.line) {
          me.revealLineNearTop(entry.anchor.line)
          debugLog('restore:line', { fileKey, line: entry.anchor.line })
        } else if (entry.scrollTop > 0) {
          me.setScrollTop(entry.scrollTop)
          debugLog('restore:scrollTop', { fileKey, scrollTop: entry.scrollTop })
        }
        diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
        setDiffRestoreNotice(null)
        // Delay the release of capture suppression after recovery is completed, allowing scrolling events caused by recovery to be digested naturally
        setTimeout(() => {
          suppressScrollCaptureRef.current = false
        }, 200)
      }, 80)
    },
    [findMemoryEntry, getFileKey, getMemoryStore, handleDraftChange, t]
  )

  const showEditMessage = useCallback((msg: { type: 'success' | 'error'; text: string }) => {
    setEditMessage(msg)
    if (editMessageTimerRef.current) {
      window.clearTimeout(editMessageTimerRef.current)
    }
    editMessageTimerRef.current = window.setTimeout(() => {
      setEditMessage(null)
    }, 2000)
  }, [])

  const handleSaveDraft = useCallback(async () => {
    if (!selectedFile || !selectedFileKey || !selectedFileState || !activeCwd) return
    if (!canEditFile) return
    const draft = selectedFileState.draftContent
    if (draft === undefined || draft === selectedFileState.modifiedContent) return
    setIsSavingEdit(true)
    setEditMessage(null)
    try {
      const result = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, draft)
      if (!result.success) {
        showEditMessage({ type: 'error', text: result.error || t('gitDiff.error.saveFailed') })
        return
      }
      setFileContents((prev) => {
        const current = prev[selectedFileKey]
        if (!current) return prev
        return {
          ...prev,
          [selectedFileKey]: {
            ...current,
            modifiedContent: draft,
            draftContent: undefined
          }
        }
      })
      await loadDiff({ silent: true, force: true })
      showEditMessage({ type: 'success', text: t('gitDiff.saved') })
    } catch (error) {
      showEditMessage({ type: 'error', text: t('gitDiff.error.saveFailedWithReason', { error: String(error) }) })
    } finally {
      setIsSavingEdit(false)
    }
  }, [
    selectedFile,
    selectedFileKey,
    selectedFileState,
    activeCwd,
    canEditFile,
    loadDiff,
    showEditMessage,
    t
  ])


  const handleKeep = useCallback(async () => {
    if (!selectedFile || !activeCwd) return
    const fileKey = getFileKey(selectedFile)
    setActionState({ type: 'keep', fileKey })
    setActionMessage(null)
    try {
      const result: GitFileActionResult = await window.electronAPI.git.stageFile(activeCwd, selectedFile.filename)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.stageFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.keepStaged') : t('gitDiff.action.staged')
        setActionMessage({ type: 'success', text: message })
        await loadDiff()
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: t('gitDiff.error.stageFailedWithReason', { error: String(error) }) })
    } finally {
      setActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [selectedFile, activeCwd, getFileKey, loadDiff, t])

  const handleDeny = useCallback(async () => {
    if (!selectedFile || !activeCwd) return
    if (selectedFile.changeType === 'untracked') {
      const confirmed = window.confirm(t('gitDiff.confirm.deleteUntracked', { fileName: selectedFile.filename }))
      if (!confirmed) return
    }
    const fileKey = getFileKey(selectedFile)
    setActionState({ type: 'deny', fileKey })
    setActionMessage(null)
    try {
      const result: GitFileActionResult = await window.electronAPI.git.discardFile(activeCwd, {
        filename: selectedFile.filename,
        changeType: selectedFile.changeType,
        status: selectedFile.status
      })
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.discardFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.unstaged') : t('gitDiff.action.discarded')
        setActionMessage({ type: 'success', text: message })
        await loadDiff()
      }
    } catch (error) {
      setActionMessage({ type: 'error', text: t('gitDiff.error.discardFailedWithReason', { error: String(error) }) })
    } finally {
      setActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [selectedFile, activeCwd, getFileKey, loadDiff, t])

  useEffect(() => {
    if (editMessageTimerRef.current) {
      window.clearTimeout(editMessageTimerRef.current)
      editMessageTimerRef.current = 0
    }
    setEditMessage(null)
    setLineMessage(null)
  }, [selectedFileKey])

  useEffect(() => {
    if (isDraftDirty) {
      setSelectedLineRange(null)
      originalDecorationsRef.current?.clear()
      modifiedDecorationsRef.current?.clear()
    }
  }, [isDraftDirty])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (canSaveDraft) {
          e.preventDefault()
          handleSaveDraft()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, canSaveDraft, handleSaveDraft])

  const requestClose = useCallback(() => {
    if (!isOpen) return
    if (!confirmCloseWithDraft()) return
    captureDiffView()
    setDiffRestoreNotice(null)
    onClose()
  }, [captureDiffView, confirmCloseWithDraft, isOpen, onClose])

  const handleOpenHistory = useCallback(() => {
    if (!terminalId) return
    if (!confirmCloseWithDraft()) return
    onClose()
    window.dispatchEvent(new CustomEvent('git-history:open', { detail: { terminalId } }))
  }, [terminalId, confirmCloseWithDraft, onClose])

  useSubpageEscape({ isOpen, onEscape: requestClose })
  const lineSelectionInfo = useMemo<LineSelectionInfo | null>(() => {
    if (!selectedLineRange) return null
    const side = (selectedLineRange.side ?? 'additions') as SelectionSide
    const endSide = (selectedLineRange.endSide ?? side) as SelectionSide
    const count = Math.abs(selectedLineRange.end - selectedLineRange.start) + 1
    if (side !== endSide) {
      return {
        valid: false,
        side,
        count,
        message: t('gitDiff.line.invalid.crossSide')
      }
    }
    const start = Math.min(selectedLineRange.start, selectedLineRange.end)
    const end = Math.max(selectedLineRange.start, selectedLineRange.end)
    return {
      valid: true,
      side,
      start,
      end,
      count
    }
  }, [selectedLineRange, t])
  const lineActionStatus = useMemo(() => {
    if (!selectedLineRange) {
      return {
        hasSelection: false,
        valid: false,
        label: t('gitDiff.line.noneSelected')
      }
    }
    if (!lineSelectionInfo) {
      return {
        hasSelection: false,
        valid: false,
        label: t('gitDiff.line.noneSelected')
      }
    }
    if (!lineSelectionInfo.valid) {
      return {
        hasSelection: true,
        valid: false,
        label: lineSelectionInfo.message
      }
    }
    return {
      hasSelection: true,
      valid: true,
      label: t('gitDiff.line.selectedCount', { count: lineSelectionInfo.count })
    }
  }, [selectedLineRange, lineSelectionInfo, t])
  const runLineAction = useCallback(async (action: 'keep' | 'deny') => {
    if (!selectedFile || !activeCwd || !selectedFileState) return
    if (!lineSelectionInfo) return
    if (!lineSelectionInfo.valid) {
      setLineMessage({ type: 'error', text: lineSelectionInfo.message })
      return
    }
    if (selectedFile.changeType === 'untracked') {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.untracked') })
      return
    }
    if (selectedFile.status === 'D') {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.deleted') })
      return
    }
    if (selectedFileState.isBinary) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.binary') })
      return
    }

    if (selectedFile.changeType === 'staged' && action === 'keep') {
      setLineMessage({ type: 'success', text: t('gitDiff.line.action.keepStagedSelection') })
      clearLineSelection()
      return
    }

    const fileKey = getFileKey(selectedFile)
    setLineActionState({ type: action, fileKey })
    setLineMessage(null)
    try {
      const baseContent = selectedFileState.originalContent
      const newContent = selectedFileState.modifiedContent
      let diff: FileDiffMetadata
      try {
        diff = parseDiffFromFile(
          { name: selectedFile.originalFilename || selectedFile.filename, contents: baseContent },
          { name: selectedFile.filename, contents: newContent }
        )
      } catch (error) {
        setLineMessage({ type: 'error', text: t('gitDiff.line.error.parseFailed', { error: String(error) }) })
        return
      }

      const selectedLines = new Set<number>()
      for (let i = lineSelectionInfo.start; i <= lineSelectionInfo.end; i += 1) {
        selectedLines.add(i)
      }

      const applySelected = action === 'keep'
      const nextContent = buildContentWithSelection(
        diff,
        lineSelectionInfo.side,
        selectedLines,
        applySelected,
        baseContent,
        newContent
      )

      if (selectedFile.changeType === 'unstaged' && action === 'deny') {
        const saveResult = await window.electronAPI.git.saveFileContent(activeCwd, selectedFile.filename, nextContent)
        if (!saveResult.success) {
          setLineMessage({ type: 'error', text: saveResult.error || t('gitDiff.line.error.discardSelectionFailed') })
          return
        }
        setLineMessage({ type: 'success', text: t('gitDiff.line.action.discardedSelection') })
        clearLineSelection()
        await loadDiff({ reset: true })
        return
      }

      const updateResult = await window.electronAPI.git.updateIndexContent(activeCwd, selectedFile.filename, nextContent)
      if (!updateResult.success) {
        setLineMessage({ type: 'error', text: updateResult.error || t('gitDiff.line.error.updateIndexFailed') })
        return
      }

      const message = selectedFile.changeType === 'staged'
        ? t('gitDiff.line.action.unstagedSelection')
        : t('gitDiff.line.action.stagedSelection')
      setLineMessage({ type: 'success', text: message })
      clearLineSelection()
      await loadDiff({ reset: true })
    } catch (error) {
      setLineMessage({ type: 'error', text: t('gitDiff.line.error.actionFailed', { error: String(error) }) })
    } finally {
      setLineActionState((prev) => (prev?.fileKey === fileKey ? null : prev))
    }
  }, [
    selectedFile,
    activeCwd,
    selectedFileState,
    lineSelectionInfo,
    getFileKey,
    loadDiff,
    clearLineSelection,
    t
  ])

  const handleLineKeep = useCallback(() => {
    runLineAction('keep')
  }, [runLineAction])

  const handleLineDeny = useCallback(() => {
    runLineAction('deny')
  }, [runLineAction])
  const isActionPending = !!selectedFileKey && actionState?.fileKey === selectedFileKey
  const isKeepPending = isActionPending && actionState?.type === 'keep'
  const isDenyPending = isActionPending && actionState?.type === 'deny'
  const isLineActionPending = !!selectedFileKey && lineActionState?.fileKey === selectedFileKey
  const isLineKeepPending = isLineActionPending && lineActionState?.type === 'keep'
  const isLineDenyPending = isLineActionPending && lineActionState?.type === 'deny'
  const canUseLineActions = !!selectedFile &&
    !!selectedFileState &&
    !selectedFileState.loading &&
    !selectedFileState.error &&
    !selectedFileState.isBinary &&
    !isDraftDirty &&
    selectedFile.changeType !== 'untracked' &&
    selectedFile.status !== 'D'
  const diffFontSize = settings?.terminalStyles[terminalId]?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  const diffEditorOptions = useMemo(() => ({
    renderSideBySide: true,
    readOnly: !canEditFile,
    originalEditable: false,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    diffWordWrap: 'on' as const,
    fontSize: diffFontSize,
    lineHeight: Math.round(diffFontSize * 1.5),
    automaticLayout: true,
    scrollBeyondLastLine: false,
    hideUnchangedRegions: {
      enabled: true,
      minimumLineCount: 3,
      contextLineCount: 3,
      revealLineCount: 20
    }
  }), [diffFontSize, canEditFile])

  // Make sure the readOnly switch takes effect immediately
  useEffect(() => {
    diffEditorRef.current?.getModifiedEditor().updateOptions({ readOnly: !canEditFile })
  }, [canEditFile])

  // Ensure diffWordWrap is always synced to DiffEditor
  useEffect(() => {
    diffEditorRef.current?.updateOptions({ diffWordWrap: 'on' } as any)
  }, [diffEditorOptions])

  const language = useMemo(() => {
    if (!selectedFile) return 'plaintext'
    const parts = selectedFile.filename.split('.')
    const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
    switch (ext) {
      case 'ts':
      case 'tsx':
        return 'typescript'
      case 'js':
      case 'jsx':
        return 'javascript'
      case 'json':
        return 'json'
      case 'css':
        return 'css'
      case 'scss':
        return 'scss'
      case 'less':
        return 'less'
      case 'html':
      case 'htm':
        return 'html'
      case 'md':
      case 'mdx':
        return 'markdown'
      case 'yml':
      case 'yaml':
        return 'yaml'
      default:
        return 'plaintext'
    }
  }, [selectedFile])

  const diffView = useMemo(() => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.diffViewBuild += 1
    }
    if (!selectedFile || !selectedFileState) return null
    if (selectedFileState.loading || selectedFileState.error || selectedFileState.isBinary) return null
    return (
      <DiffEditor
        key={selectedFileKey || 'empty'}
        original={selectedFileState.originalContent}
        modified={effectiveModifiedContent}
        language={language}
        theme="vs-dark"
        options={diffEditorOptions}
        onMount={handleEditorDidMount}
        className="git-diff-monaco"
        height="100%"
      />
    )
  }, [selectedFile, selectedFileState, selectedFileKey, language, diffEditorOptions, handleEditorDidMount, effectiveModifiedContent])

  const fileGroups = useMemo(() => {
    const groups: Record<GitFileStatus['changeType'], GitFileStatus[]> = {
      unstaged: [],
      staged: [],
      untracked: []
    }
    if (!diffResult) return groups
    diffResult.files.forEach((file) => {
      groups[file.changeType].push(file)
    })
    return groups
  }, [diffResult])

  const groupedFileList = useMemo(() => {
    const groups = [
      { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: fileGroups.unstaged },
      { key: 'staged', label: t('gitDiff.changeType.staged'), files: fileGroups.staged },
      { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: fileGroups.untracked }
    ]
    return groups.filter(group => group.files.length > 0)
  }, [fileGroups, t])

  useEffect(() => {
    if (!DEBUG_GIT_DIFF) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      perfCountersRef.current.renders = 0
      perfCountersRef.current.loadDiff = 0
      perfCountersRef.current.diffViewBuild = 0
      const hasActivity = Object.values(snapshot).some(count => count > 0)
      if (hasActivity) {
        debugLog('perf:1s', {
          ...snapshot,
          selectedFile: selectedFileRef.current?.filename ?? null,
          cwd: activeCwd ?? null
        })
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [activeCwd])

  if (!isOpen) return null

  // Render Git not installed prompt
  const renderGitNotInstalled = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#e2c08d"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.gitMissing.title')}</h3>
      <p className="git-diff-warning-text">{t('gitDiff.warning.gitMissing.message')}</p>
      <div className="git-diff-install-guide">
        <p className="git-diff-guide-title">{t('gitDiff.installGuide')}</p>
        <ul className="git-diff-guide-list">
          <li><code>macOS:</code> brew install git</li>
          <li><code>Linux:</code> sudo apt install git</li>
          <li><code>Windows:</code> <a href="https://git-scm.com/download/win" target="_blank" rel="noopener noreferrer">https://git-scm.com/download/win</a></li>
        </ul>
      </div>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  // Render non-Git repository prompts
  const renderNotGitRepo = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#858585"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.notRepo.title')}</h3>
      <p className="git-diff-warning-text">{diffResult?.error || t('gitDiff.warning.notRepo.message')}</p>
      <p className="git-diff-cwd">{diffResult?.cwd}</p>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  // Rendering without change prompt
  const renderNoChanges = () => (
    <div className="git-diff-not-installed">
      <div className="git-diff-warning-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
          <path
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            stroke="#89d185"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h3 className="git-diff-warning-title">{t('gitDiff.warning.noChanges.title')}</h3>
      <p className="git-diff-warning-text">{t('gitDiff.warning.noChanges.message')}</p>
      <p className="git-diff-cwd">{diffResult?.cwd}</p>
      <button className="git-diff-close-btn" onClick={requestClose}>
        {t('gitDiff.returnToTerminal')}
      </button>
    </div>
  )

  const renderDiffDetail = () => {
    if (!selectedFile) {
      return (
        <div className="git-diff-no-selection">
          {t('gitDiff.selectFile')}
        </div>
      )
    }

    const fileState = selectedFileState
    const headerTitle = selectedFile.originalFilename && (selectedFile.status === 'R' || selectedFile.status === 'C')
      ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
      : selectedFile.filename
    return (
      <>
        {diffRestoreNotice && (
          <div className="git-diff-restore-banner">
            <div className="git-diff-restore-text">
              {diffRestoreNotice.message}
            </div>
            <div className="git-diff-restore-actions">
              <button
                className="git-diff-restore-btn primary"
                onClick={() => {
                  scrollToFirstChange()
                }}
              >
                {t('gitDiff.restore.jumpToChange')}
              </button>
              <button
                className="git-diff-restore-btn"
                onClick={() => {
                  scrollToTop()
                }}
              >
                {t('gitDiff.restore.backToTop')}
              </button>
              <button
                className="git-diff-restore-btn ghost"
                onClick={() => setDiffRestoreNotice(null)}
              >
                {t('gitDiff.restore.close')}
              </button>
            </div>
          </div>
        )}
        <div className="git-diff-detail-header">
          <div className="git-diff-detail-info">
            <span
              className="git-diff-file-status"
              style={{ color: statusColors[selectedFile.status] }}
            >
              [{statusText[selectedFile.status]}]
            </span>
            <span className="git-diff-change-type">
              {changeTypeText[selectedFile.changeType]}
            </span>
            <span
              className="git-diff-detail-filename"
              title={t('gitDiff.filenameCopyHint')}
              onDoubleClick={handleFilenameDblClick}
            >
              {headerTitle}
            </span>
            {isDraftDirty && (
              <span className="git-diff-file-dirty">{t('gitDiff.unsaved')}</span>
            )}
            {copyMessage && (
              <span className={`git-diff-toast-message git-diff-copy-message ${copyMessage.type}`}>
                {copyMessage.text}
              </span>
            )}
          </div>
          <div className="git-diff-detail-actions-row">
            <div className="git-diff-action-panel line">
              <span className="git-diff-action-label line">{t('gitDiff.line.title')}</span>
              <span className="git-diff-action-hint">
                {isDraftDirty ? t('gitDiff.line.hintDisabled') : t('gitDiff.line.hint')}
              </span>
              <div className="git-diff-action-meta">
                {lineMessage && (
                  <span className={`git-diff-toast-message ${lineMessage.type}`}>
                    {lineMessage.text}
                  </span>
                )}
                <span className={`git-diff-line-count ${lineActionStatus.valid ? '' : 'invalid'}`}>
                  {lineActionStatus.label}
                </span>
              </div>
              <div className="git-diff-action-buttons">
                <button
                  className="git-diff-line-keep-btn"
                  onClick={handleLineKeep}
                  disabled={!canUseLineActions || !lineActionStatus.valid || isLineActionPending}
                  title={t('gitDiff.line.keepTitle')}
                >
                  {isLineKeepPending ? t('gitDiff.processing') : 'Keep'}
                </button>
                <button
                  className="git-diff-line-deny-btn"
                  onClick={handleLineDeny}
                  disabled={!canUseLineActions || !lineActionStatus.valid || isLineActionPending}
                  title={t('gitDiff.line.denyTitle')}
                >
                  {isLineDenyPending ? t('gitDiff.processing') : 'Deny'}
                </button>
                <button
                  className="git-diff-line-clear-btn"
                  onClick={clearLineSelection}
                  disabled={!lineActionStatus.hasSelection || isLineActionPending}
                  title={t('gitDiff.line.clear')}
                >
                  {t('gitDiff.line.clear')}
                </button>
              </div>
            </div>
            <div className="git-diff-action-panel file">
              <span className="git-diff-action-label file">{t('gitDiff.fileActions.title')}</span>
              <span className="git-diff-action-hint">
                {isDraftDirty ? t('gitDiff.fileActions.hintDisabled') : t('gitDiff.fileActions.hint')}
              </span>
              <div className="git-diff-action-meta">
                {actionMessage && (
                  <span className={`git-diff-toast-message ${actionMessage.type}`}>
                    {actionMessage.text}
                  </span>
                )}
              </div>
              <div className="git-diff-action-buttons">
                <button
                  className="git-diff-keep-btn"
                  onClick={handleKeep}
                  disabled={!selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty}
                  title={selectedFile.changeType === 'staged' ? t('gitDiff.fileActions.keepStagedTitle') : t('gitDiff.fileActions.keepTitle')}
                >
                  {isKeepPending ? t('gitDiff.processing') : 'Keep'}
                </button>
                <button
                  className="git-diff-deny-btn"
                  onClick={handleDeny}
                  disabled={!selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty}
                  title={selectedFile.changeType === 'staged' ? t('gitDiff.fileActions.unstageTitle') : t('gitDiff.fileActions.denyTitle')}
                >
                  {isDenyPending ? t('gitDiff.processing') : 'Deny'}
                </button>
              </div>
            </div>
            {(isDraftDirty || editMessage) && (
              <div className="git-diff-action-panel edit">
                <div className="git-diff-action-meta">
                  {editMessage && (
                    <span className={`git-diff-toast-message ${editMessage.type}`}>
                      {editMessage.text}
                    </span>
                  )}
                  {isDraftDirty && (
                    <span className="git-diff-unsaved">{t('gitDiff.unsaved')}</span>
                  )}
                </div>
                {isDraftDirty && (
                  <div className="git-diff-action-buttons">
                    <button
                      className="git-diff-save-btn"
                      onClick={handleSaveDraft}
                      disabled={!canSaveDraft}
                    >
                      {isSavingEdit ? t('gitDiff.saving') : t('gitDiff.saveFile')}
                    </button>
                    <button
                      className="git-diff-discard-btn"
                      onClick={discardDraft}
                      disabled={!isDraftDirty || isSavingEdit}
                    >
                      {t('gitDiff.discardDraft')}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="git-diff-detail-content">
          {(!fileState || fileState.loading) && (
            <div className="git-diff-loading">
              <div className="git-diff-spinner" />
              <span>{t('gitDiff.loadingFile')}</span>
            </div>
          )}
          {fileState && !fileState.loading && fileState.error && (
            <div className="git-diff-no-content">
              {fileState.error}
            </div>
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isBinary && (
            <div className="git-diff-no-content">
              {t('gitDiff.binaryUnsupported')}
            </div>
          )}
          {fileState && !fileState.loading && !fileState.error && !fileState.isBinary && (
            <div className="git-diff-editor-container">
              {diffView}
            </div>
          )}
        </div>
      </>
    )
  }

  // Main content rendering
  const renderContent = () => {
    if (!diffResult) {
      return (
        <div className="git-diff-loading">
          <div className="git-diff-spinner" />
          <span>{t('gitDiff.loading')}</span>
        </div>
      )
    }

    if (!diffResult.gitInstalled) {
      return renderGitNotInstalled()
    }

    if (!diffResult.isGitRepo) {
      return renderNotGitRepo()
    }

    if (!diffResult.success || diffResult.files.length === 0) {
      return renderNoChanges()
    }

    return (
      <div className="git-diff-main">
        {/* file list */}
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          <div className="git-diff-file-list-header">
            {t('gitDiff.fileList', { count: diffResult.files.length })}
          </div>
          <div className="git-diff-file-list-content">
            {groupedFileList.map((group) => (
              <div key={group.key} className="git-diff-file-group">
                <div className="git-diff-file-group-title">
                  {group.label} ({group.files.length})
                </div>
                {group.files.map((file) => {
                  const fileKey = diffResult?.cwd ? buildFileKey(diffResult.cwd, file) : file.filename
                  const isSelected = selectedFileKey === fileKey
                  const fileState = fileContents[fileKey]
                  const isDirty = fileState?.draftContent !== undefined &&
                    fileState.draftContent !== fileState.modifiedContent
                  return (
                    <div
                      key={fileKey}
                      className={`git-diff-file-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleFileSelect(file)}
                      onContextMenu={(e) => handleFileContextMenu(e, file)}
                    >
                      <span
                        className="git-diff-file-status"
                        style={{ color: statusColors[file.status] }}
                        title={statusText[file.status]}
                      >
                        {file.status}
                      </span>
                      <span
                        className="git-diff-file-name"
                        title={file.originalFilename && (file.status === 'R' || file.status === 'C')
                          ? `${file.originalFilename} → ${file.filename}`
                          : file.filename}
                      >
                      {file.filename}
                      </span>
                      {isDirty && (
                        <span className="git-diff-file-dirty">{t('gitDiff.unsaved')}</span>
                      )}
                      <span className="git-diff-file-stats">
                        {file.additions > 0 && (
                          <span className="git-diff-stat-add">+{file.additions}</span>
                        )}
                        {file.deletions > 0 && (
                          <span className="git-diff-stat-del">-{file.deletions}</span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Width adjustment drag bar */}
          <div
            className="git-diff-resizer"
            onMouseDown={handleResizeMouseDown}
          />
        </div>

        {/* Diff content */}
        <div className="git-diff-detail">
          {renderDiffDetail()}
        </div>
      </div>
    )
  }

  const overlayClassName = `git-diff-overlay ${isPanel ? 'panel' : ''}`
  const modalClassName = `git-diff-modal ${isPanel ? 'panel' : ''}`
  const modalStyle = isPanel ? { width: '100%', height: '100%' } : { width: modalSize.width, height: modalSize.height }

  return (
    <div className={overlayClassName} onClick={isPanel ? undefined : requestClose}>
      <div
        className={modalClassName}
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {!isPanel && (
          <>
            {/* Pop-up window size adjustment handle */}
            <div className="git-diff-modal-resize-n" onMouseDown={(e) => handleModalResizeMouseDown(e, 'n')} />
            <div className="git-diff-modal-resize-s" onMouseDown={(e) => handleModalResizeMouseDown(e, 's')} />
            <div className="git-diff-modal-resize-e" onMouseDown={(e) => handleModalResizeMouseDown(e, 'e')} />
            <div className="git-diff-modal-resize-w" onMouseDown={(e) => handleModalResizeMouseDown(e, 'w')} />
            <div className="git-diff-modal-resize-ne" onMouseDown={(e) => handleModalResizeMouseDown(e, 'ne')} />
            <div className="git-diff-modal-resize-nw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'nw')} />
            <div className="git-diff-modal-resize-se" onMouseDown={(e) => handleModalResizeMouseDown(e, 'se')} />
            <div className="git-diff-modal-resize-sw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'sw')} />
          </>
        )}

        {/* Header */}
        <div className="git-diff-header">
          <h2 className="git-diff-title">{t('gitDiff.title')}</h2>
          <div className="git-diff-header-actions">
            <button className="git-diff-history" onClick={handleOpenHistory} title={t('gitDiff.openHistory')}>
              {t('gitDiff.openHistory')}
            </button>
            <button className="git-diff-close" onClick={requestClose} title={t('gitDiff.returnToTerminal')}>
              {t('gitDiff.returnToTerminal')}
            </button>
          </div>
        </div>

        {/* working directory */}
        {diffResult?.cwd && diffResult.isGitRepo && (
          <div className="git-diff-cwd-bar">
            <span className="git-diff-cwd-label">{t('gitDiff.workingDirectory')}</span>
            <span className="git-diff-cwd-path">{diffResult.cwd}</span>
          </div>
        )}

        {/* Body */}
        <div className="git-diff-body">
          {renderContent()}
        </div>

        {/* right click menu */}
        {contextMenu && (
          <div
            className="git-diff-context-menu"
            style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'name')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
              <span>{t('common.name')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'relative')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
              <span>{t('common.relativePath')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'absolute')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
              <span>{t('common.absolutePath')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
