/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { PatchDiff } from '@pierre/diffs/react'
import { parsePatchFiles } from '@pierre/diffs'
import type {
  GitHistoryResult,
  GitCommitInfo,
  GitHistoryFile,
  GitHistoryDiffResult,
  GitHistoryFileContentResult,
  GitRepoContext
} from '../../types/electron'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
import { useAppState } from '../../hooks/useAppState'
import type { ProjectEditorOpenEventDetail, SubpageId, SubpageNavigateEventDetail } from '../../types/subpage'
import { SubpagePanelButton, SubpagePanelShell, SubpageSwitcher, type SubpagePanelShellState } from '../SubpageSwitcher'
import {
  GitImagePreview,
  IMAGE_COMPARE_MODE_STORAGE_KEY,
  IMAGE_DISPLAY_MODE_STORAGE_KEY,
  type GitImagePreviewFileState,
  type ImageCompareMode,
  type ImageDisplayMode,
  type SvgViewMode
} from '../GitImagePreview/GitImagePreview'
import './GitHistoryViewer.css'

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const HISTORY_PAGE_SIZE = 50

const STORAGE_KEY_FILE_LIST_WIDTH = 'git-history-file-list-width'
const STORAGE_KEY_HIDE_WHITESPACE = 'git-history-hide-whitespace'
const STORAGE_KEY_DIFF_STYLE = 'git-history-diff-style'
const STORAGE_KEY_STATE_PREFIX = 'git-history-state'

const DEFAULT_FILE_LIST_WIDTH = 260
const MIN_FILE_LIST_WIDTH = 180
const MAX_FILE_LIST_WIDTH = 520

const STORAGE_KEY_SUMMARY_HEIGHT = 'git-history-summary-height'
const DEFAULT_SUMMARY_HEIGHT = 120
const MIN_SUMMARY_HEIGHT = 48
const MIN_DETAIL_BODY_HEIGHT = 120

interface GitHistoryViewerProps {
  isOpen: boolean
  onClose: () => void
  terminalId: string
  cwd: string | null
  displayMode?: 'modal' | 'panel'
  panelShellMode?: 'internal' | 'external'
  onPanelShellStateChange?: (state: SubpagePanelShellState | null) => void
  taskTitle?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatRelativeTime(dateText: string, locale: string) {
  const date = new Date(dateText)
  if (Number.isNaN(date.getTime())) return dateText
  const diffMs = Date.now() - date.getTime()
  const seconds = Math.round(diffMs / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const absSeconds = Math.abs(seconds)
  let relative: string
  if (absSeconds < 60) {
    relative = rtf.format(-seconds, 'second')
  } else {
    const minutes = Math.round(seconds / 60)
    if (Math.abs(minutes) < 60) {
      relative = rtf.format(-minutes, 'minute')
    } else {
      const hours = Math.round(minutes / 60)
      if (Math.abs(hours) < 24) {
        relative = rtf.format(-hours, 'hour')
      } else {
        const days = Math.round(hours / 24)
        if (Math.abs(days) < 30) {
          relative = rtf.format(-days, 'day')
        } else {
          const months = Math.round(days / 30)
          if (Math.abs(months) < 12) {
            relative = rtf.format(-months, 'month')
          } else {
            relative = rtf.format(-Math.round(months / 12), 'year')
          }
        }
      }
    }
  }
  const wrappedRelative = locale.startsWith('zh')
    ? `（${relative}）`
    : ` (${relative})`
  return `${formatAbsoluteTime(dateText, locale)}${wrappedRelative}`
}

function formatAbsoluteTime(dateText: string, locale: string) {
  const date = new Date(dateText)
  if (Number.isNaN(date.getTime())) return dateText
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

interface RefBadge {
  label: string
  type: 'head' | 'local-branch' | 'remote-branch' | 'tag'
}

function parseRefs(refs?: string): RefBadge[] {
  if (!refs || !refs.trim()) return []
  return refs.split(',').map(r => r.trim()).filter(Boolean).map(ref => {
    if (ref === 'HEAD') {
      return { label: 'HEAD', type: 'head' as const }
    }
    if (ref.startsWith('HEAD -> ')) {
      return { label: ref.replace('HEAD -> ', ''), type: 'head' as const }
    }
    if (ref.startsWith('tag: ')) {
      return { label: ref.replace('tag: ', ''), type: 'tag' as const }
    }
    if (ref.includes('/')) {
      return { label: ref, type: 'remote-branch' as const }
    }
    return { label: ref, type: 'local-branch' as const }
  })
}

function buildRangeKey(base: string, head: string, hideWhitespace: boolean) {
  return `${base}..${head}::${hideWhitespace ? 'w' : 'n'}`
}

function buildPatchKey(base: string, head: string, filePath: string, hideWhitespace: boolean) {
  return `${base}..${head}::${filePath}::${hideWhitespace ? 'w' : 'n'}`
}

function buildFileContentKey(base: string, head: string, file: GitHistoryFile) {
  return `${base}..${head}::${file.status}::${file.originalFilename ?? ''}::${file.filename}`
}

export function GitHistoryViewer({
  isOpen,
  onClose,
  terminalId: _terminalId,
  cwd,
  displayMode = 'modal',
  panelShellMode = 'internal',
  onPanelShellStateChange,
  taskTitle
}: GitHistoryViewerProps) {
  const isPanel = displayMode === 'panel'
  const { settings } = useSettings()
  const { locale, t } = useI18n()
  const { getUIPreferences, updateUIPreferences } = useAppState()

  const [loading, setLoading] = useState(false)
  const [historyResult, setHistoryResult] = useState<GitHistoryResult | null>(null)
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [selectedShas, setSelectedShas] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [files, setFiles] = useState<GitHistoryFile[]>([])
  const [selectedFile, setSelectedFile] = useState<GitHistoryFile | null>(null)
  const [diffPatch, setDiffPatch] = useState('')
  const [selectedFileContent, setSelectedFileContent] = useState<GitHistoryFileContentResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)

  const [hideWhitespace, setHideWhitespace] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistoryHideWhitespace !== undefined) return prefs.gitHistoryHideWhitespace
    const saved = localStorage.getItem(STORAGE_KEY_HIDE_WHITESPACE)
    return saved === 'true'
  })
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistoryDiffStyle === 'unified' || prefs.gitHistoryDiffStyle === 'split') return prefs.gitHistoryDiffStyle
    const saved = localStorage.getItem(STORAGE_KEY_DIFF_STYLE)
    return saved === 'unified' ? 'unified' : 'split'
  })
  const [imageDisplayMode, setImageDisplayMode] = useState<ImageDisplayMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageDisplayMode
    if (p === 'original' || p === 'fit') return p
    const saved = localStorage.getItem(IMAGE_DISPLAY_MODE_STORAGE_KEY)
    return saved === 'original' || saved === 'fit' ? saved : 'fit'
  })
  const [imageCompareMode, setImageCompareMode] = useState<ImageCompareMode>(() => {
    const prefs = getUIPreferences()
    const p = prefs.gitDiffImageCompareMode
    if (p === '2up' || p === 'swipe' || p === 'onion') return p
    const saved = localStorage.getItem(IMAGE_COMPARE_MODE_STORAGE_KEY)
    return saved === '2up' || saved === 'swipe' || saved === 'onion' ? saved : '2up'
  })
  const [svgViewMode, setSvgViewMode] = useState<SvgViewMode>('visual')
  const [diffOptionsOpen, setDiffOptionsOpen] = useState(false)
  const diffOptionsRef = useRef<HTMLDivElement | null>(null)

  const [fileListWidth, setFileListWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistoryFileListWidth !== undefined) return prefs.gitHistoryFileListWidth
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const fileListWidthRef = useRef(fileListWidth)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  // Summary / detail-body vertical resizer
  const [summaryHeight, setSummaryHeight] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitHistorySummaryHeight !== undefined) return prefs.gitHistorySummaryHeight
    const saved = localStorage.getItem(STORAGE_KEY_SUMMARY_HEIGHT)
    return saved ? parseInt(saved, 10) : DEFAULT_SUMMARY_HEIGHT
  })
  const summaryHeightRef = useRef(summaryHeight)
  const isVDraggingRef = useRef(false)
  const vDragStartYRef = useRef(0)
  const vDragStartHeightRef = useRef(0)
  const detailContainerRef = useRef<HTMLDivElement | null>(null)

  const loadTokenRef = useRef(0)
  const filesTokenRef = useRef(0)
  const patchTokenRef = useRef(0)
  const fileCacheRef = useRef(new Map<string, GitHistoryFile[]>())
  const patchCacheRef = useRef(new Map<string, string>())
  const fileContentCacheRef = useRef(new Map<string, GitHistoryFileContentResult>())
  const commitsRef = useRef<GitCommitInfo[]>([])
  const loadingRef = useRef(false)
  const fileContentTokenRef = useRef(0)
  const didRestoreRef = useRef(false)
  const pendingScrollRef = useRef<{ commit: number; file: number; diff: number } | null>(null)
  const commitListRef = useRef<HTMLDivElement | null>(null)
  const fileListRef = useRef<HTMLDivElement | null>(null)
  const diffScrollRef = useRef<HTMLDivElement | null>(null)
  const commitScrollTopRef = useRef(0)
  const fileScrollTopRef = useRef(0)
  const diffScrollTopRef = useRef(0)
  const selectionRef = useRef<{ selectedShas: string[]; selectionAnchor: string | null; selectedFile: string | null }>({
    selectedShas: [],
    selectionAnchor: null,
    selectedFile: null
  })
  const persistTimerRef = useRef<number | null>(null)
  const [selectedRepoRoot, setSelectedRepoRoot] = useState<string | null>(null)
  const selectedRepoRootRef = useRef<string | null>(selectedRepoRoot)
  const skipRepoReloadRef = useRef(true)
  const [repoSearch, setRepoSearch] = useState('')
  const [cachedRepos, setCachedRepos] = useState<GitHistoryResult['repos']>(undefined)
  const [cachedParentCwd, setCachedParentCwd] = useState<string | null>(null)
  const cachedParentCwdRef = useRef<string | null>(cachedParentCwd)
  const activeCwd = selectedRepoRoot || historyResult?.cwd || cachedParentCwd || cwd
  const activeCwdRef = useRef(activeCwd)
  const cwdRef = useRef(cwd)
  useEffect(() => {
    activeCwdRef.current = activeCwd
  }, [activeCwd])
  useEffect(() => {
    cwdRef.current = cwd
  }, [cwd])
  const terminalId = _terminalId
  const historyStateKey = activeCwd ? `${STORAGE_KEY_STATE_PREFIX}:${activeCwd}` : null
  const historyStateKeyRef = useRef(historyStateKey)
  useEffect(() => {
    historyStateKeyRef.current = historyStateKey
  }, [historyStateKey])
  const isSwitchingRepoRef = useRef(false)
  useEffect(() => {
    selectedRepoRootRef.current = selectedRepoRoot
  }, [selectedRepoRoot])
  useEffect(() => {
    cachedParentCwdRef.current = cachedParentCwd
  }, [cachedParentCwd])

  const commitIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    commits.forEach((commit, index) => {
      map.set(commit.sha, index)
    })
    return map
  }, [commits])

  useEffect(() => {
    fileListWidthRef.current = fileListWidth
  }, [fileListWidth])

  useEffect(() => {
    commitsRef.current = commits
  }, [commits])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  useEffect(() => {
    selectionRef.current = {
      selectedShas,
      selectionAnchor,
      selectedFile: selectedFile?.filename ?? null
    }
  }, [selectedShas, selectionAnchor, selectedFile])

  const selectionInfo = useMemo(() => {
    if (selectedShas.length === 0) {
      return {
        isContiguous: false,
        head: null as string | null,
        base: null as string | null,
        selectedCommits: [] as GitCommitInfo[]
      }
    }
    const indices = selectedShas
      .map(sha => commitIndexMap.get(sha))
      .filter((index): index is number => typeof index === 'number')
      .sort((a, b) => a - b)
    if (indices.length === 0) {
      return {
        isContiguous: false,
        head: null,
        base: null,
        selectedCommits: [] as GitCommitInfo[]
      }
    }
    const minIndex = indices[0]
    const maxIndex = indices[indices.length - 1]
    const isContiguous = maxIndex - minIndex + 1 === indices.length
    const head = commits[minIndex]?.sha ?? null
    const base = commits[maxIndex]?.parents?.[0] ?? EMPTY_TREE_HASH
    const selectedCommits = indices
      .map(index => commits[index])
      .filter(Boolean)
    return {
      isContiguous,
      head,
      base,
      selectedCommits
    }
  }, [selectedShas, commitIndexMap, commits])

  const selectedCommit = selectionInfo.selectedCommits[0] ?? null
  const oldestCommit = selectionInfo.selectedCommits[selectionInfo.selectedCommits.length - 1] ?? null

  const diffFontSize = settings?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  const diffOptions = useMemo(() => ({
    diffStyle,
    diffIndicators: 'classic' as const,
    lineDiffType: 'word' as const,
    overflow: 'wrap' as const,
    disableFileHeader: true,
    theme: 'pierre-dark' as const,
    themeType: 'dark' as const
  }), [diffStyle])
  const imageTextDiffOptions = useMemo(() => ({
    renderSideBySide: true,
    readOnly: true,
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
  }), [diffFontSize])
  const toggleImageDisplayMode = useCallback((mode: ImageDisplayMode) => {
    setImageDisplayMode(mode)
    localStorage.setItem(IMAGE_DISPLAY_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageDisplayMode: mode })
  }, [updateUIPreferences])
  const toggleImageCompareMode = useCallback((mode: ImageCompareMode) => {
    setImageCompareMode(mode)
    localStorage.setItem(IMAGE_COMPARE_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageCompareMode: mode })
  }, [])

  const resetState = useCallback(() => {
    setHistoryResult(null)
    setCommits([])
    setHasMore(true)
    setSelectedShas([])
    setSelectionAnchor(null)
    setFiles([])
    setSelectedFile(null)
    setDiffPatch('')
    setSelectedFileContent(null)
    setDiffError(null)
    setDiffLoading(false)
    setFilesLoading(false)
    fileCacheRef.current.clear()
    patchCacheRef.current.clear()
    fileContentCacheRef.current.clear()
    ++filesTokenRef.current
    ++patchTokenRef.current
    ++fileContentTokenRef.current
    didRestoreRef.current = false
    pendingScrollRef.current = null
    selectedRepoRootRef.current = null
    cachedParentCwdRef.current = null
    setSelectedRepoRoot(null)
    setCachedRepos(undefined)
    setCachedParentCwd(null)
    setRepoSearch('')
    skipRepoReloadRef.current = true
  }, [])

  const loadHistory = useCallback(async (reset = false) => {
    const targetRepoRoot = selectedRepoRootRef.current
    const targetParentCwd = cachedParentCwdRef.current
    const targetCwd = targetRepoRoot || targetParentCwd || cwdRef.current
    if (!targetCwd) return
    if (loadingRef.current) return
    loadingRef.current = true
    const isSwitching = isSwitchingRepoRef.current
    setLoading(true)
    const token = ++loadTokenRef.current
    const skip = reset ? 0 : commitsRef.current.length
    try {
      const result = await window.electronAPI.git.getHistory(targetCwd, {
        limit: HISTORY_PAGE_SIZE,
        skip
      })
      if (token !== loadTokenRef.current) return
      setHistoryResult(result)
      if (!targetRepoRoot && result.repos && result.repos.length > 1) {
        cachedParentCwdRef.current = result.cwd
        setCachedRepos(result.repos)
        setCachedParentCwd(result.cwd)
      }
      if (!result.success) {
        setCommits([])
        setHasMore(false)
        return
      }
      const nextCommits = reset ? result.commits : [...commitsRef.current, ...result.commits]
      commitsRef.current = nextCommits
      setCommits(nextCommits)
      const total = result.totalCount ?? null
      const nextCount = nextCommits.length
      const hasMoreNext = total === null
        ? result.commits.length >= HISTORY_PAGE_SIZE
        : nextCount < total
      setHasMore(hasMoreNext)
      if (isSwitching) {
        setSelectedShas([])
        setSelectionAnchor(null)
        setFiles([])
        setSelectedFile(null)
        setDiffPatch('')
        setDiffError(null)
      }
    } finally {
      isSwitchingRepoRef.current = false
      if (token === loadTokenRef.current) {
        setLoading(false)
      }
      loadingRef.current = false
    }
  }, [])

  const loadFilesForRange = useCallback(async (base: string, head: string) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildRangeKey(base, head, hideWhitespace)
    if (fileCacheRef.current.has(cacheKey)) {
      const cached = fileCacheRef.current.get(cacheKey) || []
      setFiles(cached)
      return
    }
    const token = ++filesTokenRef.current
    setFilesLoading(true)
    setDiffError(null)
    try {
      const result = await window.electronAPI.git.getHistoryDiff(cwdToUse, {
        base,
        head,
        includeFiles: true,
        hideWhitespace
      })
      if (token !== filesTokenRef.current) return
      if (!result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        setFiles([])
        return
      }
      fileCacheRef.current.set(cacheKey, result.files)
      setFiles(result.files)
    } finally {
      if (token === filesTokenRef.current) {
        setFilesLoading(false)
      }
    }
  }, [hideWhitespace, t])

  const loadPatchForFile = useCallback(async (base: string, head: string, file: GitHistoryFile) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildPatchKey(base, head, file.filename, hideWhitespace)
    if (patchCacheRef.current.has(cacheKey)) {
      setDiffPatch(patchCacheRef.current.get(cacheKey) || '')
      return
    }
    const token = ++patchTokenRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const result: GitHistoryDiffResult = await window.electronAPI.git.getHistoryDiff(cwdToUse, {
        base,
        head,
        filePath: file.filename,
        includeFiles: false,
        hideWhitespace
      })
      if (token !== patchTokenRef.current) return
      if (!result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        setDiffPatch('')
        return
      }
      patchCacheRef.current.set(cacheKey, result.patch)
      setDiffPatch(result.patch)
    } finally {
      if (token === patchTokenRef.current) {
        setDiffLoading(false)
      }
    }
  }, [hideWhitespace, t])

  const loadFileContentForHistory = useCallback(async (base: string, head: string, file: GitHistoryFile) => {
    const cwdToUse = activeCwdRef.current
    if (!cwdToUse) return
    const cacheKey = buildFileContentKey(base, head, file)
    if (fileContentCacheRef.current.has(cacheKey)) {
      setSelectedFileContent(fileContentCacheRef.current.get(cacheKey) || null)
      return
    }
    const token = ++fileContentTokenRef.current
    setDiffLoading(true)
    setDiffError(null)
    try {
      const result = await window.electronAPI.git.getHistoryFileContent(cwdToUse, {
        base,
        head,
        file: {
          filename: file.filename,
          originalFilename: file.originalFilename,
          status: file.status
        }
      })
      if (token !== fileContentTokenRef.current) return
      if (!result.success) {
        setDiffError(result.error || t('gitHistory.error.loadDiff'))
        setSelectedFileContent(null)
        return
      }
      fileContentCacheRef.current.set(cacheKey, result)
      setSelectedFileContent(result)
    } finally {
      if (token === fileContentTokenRef.current) {
        setDiffLoading(false)
      }
    }
  }, [t])

  const switchRepo = useCallback((repoRoot: string | null) => {
    isSwitchingRepoRef.current = true
    fileCacheRef.current.clear()
    patchCacheRef.current.clear()
    fileContentCacheRef.current.clear()
    ++patchTokenRef.current
    ++fileContentTokenRef.current
    setDiffPatch('')
    setSelectedFileContent(null)
    didRestoreRef.current = false
    selectedRepoRootRef.current = repoRoot
    setSelectedRepoRoot(repoRoot)
  }, [])

  const persistState = useCallback(() => {
    if (!historyStateKey) return
    const payload = {
      selectedShas: selectionRef.current.selectedShas,
      selectionAnchor: selectionRef.current.selectionAnchor,
      selectedFile: selectionRef.current.selectedFile,
      commitScrollTop: commitScrollTopRef.current,
      fileScrollTop: fileScrollTopRef.current,
      diffScrollTop: diffScrollTopRef.current
    }
    localStorage.setItem(historyStateKey, JSON.stringify(payload))
    updateUIPreferences({
      gitHistoryStates: { ...(getUIPreferences().gitHistoryStates ?? {}), [historyStateKey]: payload }
    })
  }, [historyStateKey, getUIPreferences, updateUIPreferences])

  const persistStateRef = useRef(persistState)
  useEffect(() => {
    persistStateRef.current = persistState
  }, [persistState])

  const schedulePersist = useCallback(() => {
    if (!historyStateKeyRef.current) return
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current)
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistStateRef.current()
    }, 200)
  }, [])

  useEffect(() => {
    if (!isOpen) {
      persistStateRef.current()
      resetState()
      return
    }
    resetState()
    void loadHistory(true)
  }, [cwd, isOpen, loadHistory, resetState, terminalId])

  useEffect(() => {
    if (!isOpen) return
    if (skipRepoReloadRef.current) {
      skipRepoReloadRef.current = false
      return
    }
    void loadHistory(true)
  }, [isOpen, loadHistory, selectedRepoRoot])

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    schedulePersist()
  }, [isOpen, selectedShas, selectionAnchor, selectedFile, schedulePersist])

  useEffect(() => {
    if (!isOpen) return
    if (commits.length > 0 && selectedShas.length === 0) {
      setSelectedShas([commits[0].sha])
      setSelectionAnchor(commits[0].sha)
    }
  }, [isOpen, commits, selectedShas.length])

  useEffect(() => {
    if (!isOpen) return
    if (!historyStateKey) return
    if (didRestoreRef.current) return
    if (!historyResult || !historyResult.success) return
    if (commits.length === 0) return

    didRestoreRef.current = true
    const prefs = getUIPreferences()
    const raw = localStorage.getItem(historyStateKey)
      || (prefs.gitHistoryStates?.[historyStateKey] ? JSON.stringify(prefs.gitHistoryStates[historyStateKey]) : null)
    if (!raw) return
    try {
      const stored = JSON.parse(raw) as {
        selectedShas?: string[]
        selectionAnchor?: string | null
        selectedFile?: string | null
        commitScrollTop?: number
        fileScrollTop?: number
        diffScrollTop?: number
      }
      const available = new Set(commits.map(commit => commit.sha))
      const nextSelected = (stored.selectedShas ?? []).filter(sha => available.has(sha))
      if (nextSelected.length > 0) {
        setSelectedShas(nextSelected)
        setSelectionAnchor(stored.selectionAnchor && available.has(stored.selectionAnchor) ? stored.selectionAnchor : nextSelected[0])
      }
      pendingScrollRef.current = {
        commit: stored.commitScrollTop ?? 0,
        file: stored.fileScrollTop ?? 0,
        diff: stored.diffScrollTop ?? 0
      }
      requestAnimationFrame(() => {
        if (commitListRef.current && pendingScrollRef.current) {
          commitListRef.current.scrollTop = pendingScrollRef.current.commit
          commitScrollTopRef.current = pendingScrollRef.current.commit
        }
      })
    } catch {
      // ignore corrupted storage
    }
  }, [isOpen, historyStateKey, historyResult, commits])

  useEffect(() => {
    if (!isOpen) return
    if (!selectionInfo.head || !selectionInfo.base) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      setFiles([])
      setSelectedFile(null)
      setDiffPatch('')
      setSelectedFileContent(null)
      return
    }
    if (!selectionInfo.isContiguous) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      setFiles([])
      setSelectedFile(null)
      setDiffPatch('')
      setSelectedFileContent(null)
      return
    }
    void loadFilesForRange(selectionInfo.base, selectionInfo.head)
  }, [isOpen, selectionInfo.head, selectionInfo.base, selectionInfo.isContiguous, loadFilesForRange])

  useEffect(() => {
    if (!isOpen) return
    if (!selectionInfo.isContiguous || !selectionInfo.head || !selectionInfo.base) return
    if (files.length === 0) {
      setSelectedFile(null)
      setDiffPatch('')
      return
    }
    setSelectedFile((prev) => {
      if (prev && files.some(file => file.filename === prev.filename)) {
        return prev
      }
      const storedFile = selectionRef.current.selectedFile
      if (storedFile) {
        const match = files.find(file => file.filename === storedFile)
        if (match) return match
      }
      return files[0]
    })
  }, [files, selectionInfo.isContiguous, selectionInfo.head, selectionInfo.base, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (!selectionInfo.isContiguous || !selectionInfo.head || !selectionInfo.base) return
    if (!selectedFile) {
      ++patchTokenRef.current
      ++fileContentTokenRef.current
      setDiffPatch('')
      setSelectedFileContent(null)
      return
    }
    if (selectedFile.isImage) {
      ++patchTokenRef.current
      setDiffPatch('')
      setSelectedFileContent(null)
      void loadFileContentForHistory(selectionInfo.base, selectionInfo.head, selectedFile)
      return
    }
    ++fileContentTokenRef.current
    setSelectedFileContent(null)
    void loadPatchForFile(selectionInfo.base, selectionInfo.head, selectedFile)
  }, [selectedFile, selectionInfo.isContiguous, selectionInfo.base, selectionInfo.head, loadFileContentForHistory, loadPatchForFile, isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (!pendingScrollRef.current) return
    if (fileListRef.current) {
      fileListRef.current.scrollTop = pendingScrollRef.current.file
      fileScrollTopRef.current = pendingScrollRef.current.file
    }
    if (diffScrollRef.current) {
      diffScrollRef.current.scrollTop = pendingScrollRef.current.diff
      diffScrollTopRef.current = pendingScrollRef.current.diff
    }
    pendingScrollRef.current = null
  }, [files.length, diffPatch, selectedFileContent?.filename, isOpen])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (diffOptionsRef.current && !diffOptionsRef.current.contains(event.target as Node)) {
        setDiffOptionsOpen(false)
      }
    }
    if (diffOptionsOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
      }
    }
  }, [diffOptionsOpen])

  // Debug API (only exposed in automated testing mode)
  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const mapInjectedRepos = (repos?: Array<{
      root: string
      label: string
      isSubmodule?: boolean
      depth?: number
      changeCount?: number
    }>): GitRepoContext[] | undefined => {
      if (!repos) return undefined
      return repos.map(repo => ({
        root: repo.root,
        label: repo.label,
        isSubmodule: repo.isSubmodule ?? true,
        depth: repo.depth ?? 1,
        changeCount: repo.changeCount ?? 0
      }))
    }
    const api = {
      isOpen: () => isOpen,
      getCommitCount: () => commits.length,
      getSelectedShas: () => selectedShas,
      getFiles: () => files.map(f => ({ filename: f.filename, status: f.status })),
      getSelectedFile: () => selectedFile ? { filename: selectedFile.filename } : null,
      getImagePreviewState: () => {
        if (!selectedFile?.isImage) return null
        return {
          isImage: true,
          isSvg: Boolean(selectedFileContent?.isSvg),
          hasOriginalUrl: Boolean(selectedFileContent?.originalImageUrl),
          hasModifiedUrl: Boolean(selectedFileContent?.modifiedImageUrl),
          compareMode: imageCompareMode,
          displayMode: imageDisplayMode,
          svgViewMode,
          loading: diffLoading
        }
      },
      setImageCompareMode: (mode: ImageCompareMode) => {
        toggleImageCompareMode(mode)
      },
      setImageDisplayMode: (mode: ImageDisplayMode) => {
        toggleImageDisplayMode(mode)
      },
      setSvgViewMode: (mode: SvgViewMode) => {
        setSvgViewMode(mode)
      },
      isLoading: () => loading || filesLoading || diffLoading,
      getActiveCwd: () => activeCwdRef.current ?? null,
      getRepoState: () => ({
        selectedRepoRoot,
        cachedParentCwd,
        repoSearch,
        cachedRepoCount: cachedRepos?.length ?? 0
      }),
      switchRepo: (repoRoot: string | null) => {
        switchRepo(repoRoot)
      },
      injectRepoState: (state: {
        selectedRepoRoot: string | null
        cachedParentCwd: string | null
        repoSearch?: string
        cachedRepos?: Array<{
          root: string
          label: string
          isSubmodule?: boolean
          depth?: number
          changeCount?: number
        }>
      }) => {
        skipRepoReloadRef.current = true
        selectedRepoRootRef.current = state.selectedRepoRoot
        cachedParentCwdRef.current = state.cachedParentCwd
        setSelectedRepoRoot(state.selectedRepoRoot)
        setCachedParentCwd(state.cachedParentCwd)
        setRepoSearch(state.repoSearch ?? '')
        setCachedRepos(mapInjectedRepos(state.cachedRepos))
        return true
      },
      selectCommitByIndex: (index: number) => {
        if (index < 0 || index >= commits.length) return false
        const commit = commits[index]
        setSelectedShas([commit.sha])
        setSelectionAnchor(commit.sha)
        return true
      },
      selectFileByIndex: (index: number) => {
        if (index < 0 || index >= files.length) return false
        setSelectedFile(files[index])
        return true
      },
      getDiffStyle: () => diffStyle,
      setDiffStyle: (style: 'split' | 'unified') => {
        setDiffStyle(style)
        localStorage.setItem(STORAGE_KEY_DIFF_STYLE, style)
        updateUIPreferences({ gitHistoryDiffStyle: style })
      },
      getHideWhitespace: () => hideWhitespace,
      setHideWhitespace: (value: boolean) => {
        setHideWhitespace(value)
        localStorage.setItem(STORAGE_KEY_HIDE_WHITESPACE, String(value))
        updateUIPreferences({ gitHistoryHideWhitespace: value })
      }
    }
    ;(window as any).__onwardGitHistoryDebug = api
    return () => {
      if ((window as any).__onwardGitHistoryDebug === api) {
        delete (window as any).__onwardGitHistoryDebug
      }
    }
  }, [isOpen, commits, selectedShas, files, selectedFile, selectedFileContent, loading, filesLoading, diffLoading, diffStyle, hideWhitespace, imageCompareMode, imageDisplayMode, svgViewMode, selectedRepoRoot, cachedParentCwd, repoSearch, cachedRepos, toggleImageCompareMode, toggleImageDisplayMode, switchRepo])

  useSubpageEscape({ isOpen, onEscape: onClose })

  const handleCommitClick = useCallback((commit: GitCommitInfo, event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const index = commitIndexMap.get(commit.sha)
    if (index === undefined) return
    if (event.shiftKey && selectionAnchor) {
      const anchorIndex = commitIndexMap.get(selectionAnchor)
      if (anchorIndex === undefined) {
        setSelectedShas([commit.sha])
        setSelectionAnchor(commit.sha)
        return
      }
      const start = Math.min(anchorIndex, index)
      const end = Math.max(anchorIndex, index)
      const range = commits.slice(start, end + 1).map(item => item.sha)
      setSelectedShas(range)
      return
    }
    const isMeta = event.metaKey || event.ctrlKey
    if (isMeta) {
      setSelectedShas((prev) => {
        if (prev.includes(commit.sha)) {
          return prev.filter(sha => sha !== commit.sha)
        }
        return [...prev, commit.sha]
      })
      setSelectionAnchor(commit.sha)
      return
    }
    setSelectedShas([commit.sha])
    setSelectionAnchor(commit.sha)
  }, [commitIndexMap, selectionAnchor, commits])

  const handleCommitListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    commitScrollTopRef.current = target.scrollTop
    schedulePersist()
    if (!hasMore || loading) return
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 120) {
      void loadHistory(false)
    }
  }, [hasMore, loading, loadHistory, schedulePersist])

  const handleFileListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    fileScrollTopRef.current = event.currentTarget.scrollTop
    schedulePersist()
  }, [schedulePersist])

  const handleDiffScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    diffScrollTopRef.current = event.currentTarget.scrollTop
    schedulePersist()
  }, [schedulePersist])

  // Sync summary height ref
  useEffect(() => {
    summaryHeightRef.current = summaryHeight
  }, [summaryHeight])

  // Vertical resizer between summary and detail-body
  const handleSummaryResizerMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isVDraggingRef.current = true
    vDragStartYRef.current = event.clientY
    vDragStartHeightRef.current = summaryHeightRef.current
    document.body.classList.add('git-history-v-resizing')

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isVDraggingRef.current) return
      const delta = moveEvent.clientY - vDragStartYRef.current
      const containerHeight = detailContainerRef.current?.clientHeight ?? 600
      const maxHeight = containerHeight - MIN_DETAIL_BODY_HEIGHT
      const nextHeight = clamp(vDragStartHeightRef.current + delta, MIN_SUMMARY_HEIGHT, maxHeight)
      setSummaryHeight(nextHeight)
    }

    const handleMouseUp = () => {
      isVDraggingRef.current = false
      document.body.classList.remove('git-history-v-resizing')
      localStorage.setItem(STORAGE_KEY_SUMMARY_HEIGHT, `${summaryHeightRef.current}`)
      updateUIPreferences({ gitHistorySummaryHeight: summaryHeightRef.current })
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [updateUIPreferences])

  const handleFileResizerMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    isDraggingRef.current = true
    dragStartXRef.current = event.clientX
    dragStartWidthRef.current = fileListWidth
    document.body.classList.add('git-history-resizing')

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = moveEvent.clientX - dragStartXRef.current
      const nextWidth = clamp(dragStartWidthRef.current + delta, MIN_FILE_LIST_WIDTH, MAX_FILE_LIST_WIDTH)
      setFileListWidth(nextWidth)
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      document.body.classList.remove('git-history-resizing')
      localStorage.setItem(STORAGE_KEY_FILE_LIST_WIDTH, `${fileListWidthRef.current}`)
      updateUIPreferences({ gitHistoryFileListWidth: fileListWidthRef.current })
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileListWidth])

  const handleToggleWhitespace = useCallback((value: boolean) => {
    setHideWhitespace(value)
    localStorage.setItem(STORAGE_KEY_HIDE_WHITESPACE, value ? 'true' : 'false')
    updateUIPreferences({ gitHistoryHideWhitespace: value })
  }, [updateUIPreferences])

  const handleDiffStyleChange = useCallback((style: 'split' | 'unified') => {
    setDiffStyle(style)
    localStorage.setItem(STORAGE_KEY_DIFF_STYLE, style)
    updateUIPreferences({ gitHistoryDiffStyle: style })
  }, [updateUIPreferences])

  const handleJumpToDiff = useCallback(() => {
    if (!terminalId) return
    const detail: SubpageNavigateEventDetail = { terminalId, target: 'diff' }
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [terminalId])

  const handleOpenEditor = useCallback(() => {
    if (!terminalId) return
    const detail: ProjectEditorOpenEventDetail = {
      terminalId,
      filePath: selectedFile?.filename ?? null,
      repoRoot: activeCwd || null
    }
    window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
      detail: {
        terminalId: detail.terminalId,
        target: 'editor',
        filePath: detail.filePath,
        repoRoot: detail.repoRoot
      }
    }))
  }, [activeCwd, selectedFile, terminalId])

  const handleSelectSubpage = useCallback((target: SubpageId) => {
    if (target === 'diff') {
      handleJumpToDiff()
      return
    }
    if (target === 'editor') {
      // SubpageSwitcher is a view switch — let Editor restore its own state
      // rather than overriding it with History's selected file.
      if (!terminalId) return
      window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
        detail: { terminalId, target: 'editor' }
      }))
    }
  }, [handleJumpToDiff, terminalId])

  const renderCommitSummary = () => {
    if (selectionInfo.selectedCommits.length === 0) {
      return (
        <div className="git-history-summary empty">
          {t('gitHistory.summary.noneSelected')}
        </div>
      )
    }
    if (selectionInfo.selectedCommits.length > 1) {
      const count = selectionInfo.selectedCommits.length
      return (
        <div className="git-history-summary">
          <div className="git-history-summary-title">
            {t('gitHistory.summary.selectedCount', { count })}
          </div>
          <div className="git-history-summary-meta">
            <span>{t('gitHistory.summary.range')}</span>
            <span className="git-history-summary-meta-value">
              {oldestCommit?.shortSha} → {selectedCommit?.shortSha}
            </span>
          </div>
          <div className="git-history-summary-meta">
            <span>{t('gitHistory.summary.time')}</span>
            <span className="git-history-summary-meta-value">
              {oldestCommit ? formatAbsoluteTime(oldestCommit.authorDate, locale) : '-'}
              {' '}~{' '}
              {selectedCommit ? formatAbsoluteTime(selectedCommit.authorDate, locale) : '-'}
            </span>
          </div>
        </div>
      )
    }
    if (!selectedCommit) return null
    return (
      <div className="git-history-summary">
        <div className={`git-history-summary-title ${selectedCommit.summary ? '' : 'empty'}`}>
          {selectedCommit.summary || t('gitHistory.summary.emptyMessage')}
        </div>
        {selectedCommit.body && (
          <div className="git-history-summary-body">
            {selectedCommit.body}
          </div>
        )}
        <div className="git-history-summary-meta">
          <span>{t('gitHistory.summary.author')}</span>
          <span className="git-history-summary-meta-value">{selectedCommit.authorName}</span>
        </div>
        <div className="git-history-summary-meta">
          <span>{t('gitHistory.summary.time')}</span>
          <span className="git-history-summary-meta-value">{formatAbsoluteTime(selectedCommit.authorDate, locale)}</span>
        </div>
        <div className="git-history-summary-meta">
          <span>{t('gitHistory.summary.commit')}</span>
          <span className="git-history-summary-meta-value">{selectedCommit.sha}</span>
        </div>
      </div>
    )
  }

  const renderCommitList = () => {
    if (!historyResult) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (!historyResult.gitInstalled) {
      return (
        <div className="git-history-warning">
          <div className="git-history-warning-title">{t('gitHistory.warning.gitMissing.title')}</div>
          <div className="git-history-warning-text">{t('gitHistory.warning.gitMissing.message')}</div>
        </div>
      )
    }
    if (!historyResult.isGitRepo) {
      return (
        <div className="git-history-warning">
          <div className="git-history-warning-title">{t('gitHistory.warning.notRepo.title')}</div>
          <div className="git-history-warning-text">{historyResult.error || t('gitHistory.warning.notRepo.message')}</div>
        </div>
      )
    }
    if (!historyResult.success || commits.length === 0) {
      return (
        <div className="git-history-warning">
          <div className="git-history-warning-title">{t('gitHistory.warning.noHistory.title')}</div>
          <div className="git-history-warning-text">{t('gitHistory.warning.noHistory.message')}</div>
        </div>
      )
    }
    return (
      <div
        className="git-history-commit-list-content"
        onScroll={handleCommitListScroll}
        ref={commitListRef}
      >
        {commits.map((commit) => {
          const isSelected = selectedShas.includes(commit.sha)
          return (
            <div
              key={commit.sha}
              className={`git-history-commit-item ${isSelected ? 'selected' : ''}`}
              onClick={(event) => handleCommitClick(commit, event)}
              title={`${commit.summary || t('gitHistory.summary.emptyMessage')} · ${commit.authorName}`}
            >
              <div className="git-history-commit-info">
                {(() => {
                  const badges = parseRefs(commit.refs)
                  if (badges.length === 0) return null
                  return (
                    <div className="git-history-ref-badges">
                      {badges.map((badge, i) => (
                        <span key={i} className={`git-history-ref-badge ${badge.type}`} title={badge.label}>
                          {badge.label}
                        </span>
                      ))}
                    </div>
                  )
                })()}
                <div className={`git-history-commit-summary ${commit.summary ? '' : 'empty'}`}>
                  {commit.summary || t('gitHistory.summary.emptyMessage')}
                </div>
                <div className="git-history-commit-meta">
                  <span className="git-history-commit-author">{commit.authorName}</span>
                  <span className="git-history-commit-time">{formatRelativeTime(commit.authorDate, locale)}</span>
                </div>
              </div>
              <div className="git-history-commit-sha">{commit.shortSha}</div>
            </div>
          )
        })}
        {loading && (
          <div className="git-history-loading-more">{t('gitHistory.loading')}</div>
        )}
        {!hasMore && commits.length > 0 && (
          <div className="git-history-loading-more done">{t('gitHistory.endReached')}</div>
        )}
      </div>
    )
  }

  const renderFileList = () => {
    if (!selectionInfo.isContiguous && selectionInfo.selectedCommits.length > 1) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.nonContiguous')}
        </div>
      )
    }
    if (filesLoading) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (files.length === 0) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.files.empty')}
        </div>
      )
    }
    return (
      <div
        className="git-history-file-list-content"
        onScroll={handleFileListScroll}
        ref={fileListRef}
      >
        {files.map((file) => {
          const isSelected = selectedFile?.filename === file.filename
          const statusClass = `status-${file.status}`
          const renameText = file.originalFilename
            ? `${file.originalFilename} → ${file.filename}`
            : file.filename
          return (
            <div
              key={`${file.filename}-${file.status}`}
              className={`git-history-file-item ${isSelected ? 'selected' : ''}`}
              onClick={() => setSelectedFile(file)}
              title={renameText}
            >
              <span className={`git-history-file-status ${statusClass}`}>
                {file.status}
              </span>
              <span className="git-history-file-name">
                {renameText}
              </span>
              <span className="git-history-file-stats">
                <span className="git-history-file-add">+{file.additions}</span>
                <span className="git-history-file-del">-{file.deletions}</span>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  const renderSvgDiffEditor = useCallback((fileState: GitHistoryFileContentResult) => {
    const originalPath = (selectedFile?.originalFilename || fileState.filename)
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    const modifiedPath = fileState.filename
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    const baseSegment = encodeURIComponent(selectionInfo.base || 'base')
    const headSegment = encodeURIComponent(selectionInfo.head || 'head')
    return (
      <div className="git-diff-editor-container">
        <DiffEditor
          key={`git-history-svg-text-${selectionInfo.base}-${selectionInfo.head}-${fileState.filename}`}
          original={fileState.originalContent}
          modified={fileState.modifiedContent}
          language="xml"
          originalModelPath={`inmemory://model/onward-git-history/${baseSegment}/original/${originalPath}`}
          modifiedModelPath={`inmemory://model/onward-git-history/${headSegment}/modified/${modifiedPath}`}
          keepCurrentOriginalModel={true}
          keepCurrentModifiedModel={true}
          theme="vs-dark"
          options={imageTextDiffOptions}
          className="git-diff-monaco"
          height="100%"
        />
      </div>
    )
  }, [imageTextDiffOptions, selectedFile, selectionInfo.base, selectionInfo.head])

  const renderImagePreview = useCallback((fileState: GitHistoryFileContentResult, file: GitHistoryFile) => {
    const status = file.status === 'A' || file.status === '?'
      ? 'added'
      : file.status === 'D'
        ? 'deleted'
        : 'modified'
    return (
      <GitImagePreview
        fileState={fileState as GitImagePreviewFileState}
        status={status}
        labels={{
          statusAdded: t('gitDiff.image.status.added'),
          statusDeleted: t('gitDiff.image.status.deleted'),
          statusModified: t('gitDiff.image.status.modified'),
          svg: t('gitDiff.image.svg'),
          viewVisual: t('gitDiff.image.view.visual'),
          viewText: t('gitDiff.image.view.text'),
          compareTwoUp: t('gitDiff.image.compare.twoUp'),
          compareSwipe: t('gitDiff.image.compare.swipe'),
          compareOnion: t('gitDiff.image.compare.onion'),
          displayOriginal: t('gitDiff.image.display.original'),
          displayFit: t('gitDiff.image.display.fit'),
          labelOriginal: t('gitDiff.image.label.original'),
          labelAdded: t('gitDiff.image.label.added'),
          labelModified: t('gitDiff.image.label.modified'),
          opacity: t('gitDiff.image.opacity')
        }}
        imageDisplayMode={imageDisplayMode}
        imageCompareMode={imageCompareMode}
        svgViewMode={svgViewMode}
        onImageDisplayModeChange={toggleImageDisplayMode}
        onImageCompareModeChange={toggleImageCompareMode}
        onSvgViewModeChange={setSvgViewMode}
        renderSvgDiffEditor={(state) => renderSvgDiffEditor(state as GitHistoryFileContentResult)}
      />
    )
  }, [imageCompareMode, imageDisplayMode, renderSvgDiffEditor, svgViewMode, t, toggleImageCompareMode, toggleImageDisplayMode])

  const renderDiffOptions = () => {
    return (
      <div className="git-history-diff-options" ref={diffOptionsRef}>
        <button
          className="git-history-diff-options-trigger"
          onClick={() => setDiffOptionsOpen(prev => !prev)}
          title={t('gitHistory.options.title')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14,12.94a7.43,7.43,0,0,0,.05-.94,7.43,7.43,0,0,0-.05-.94l2.11-1.65a.5.5,0,0,0,.12-.64l-2-3.46a.5.5,0,0,0-.6-.22l-2.49,1a7.28,7.28,0,0,0-1.63-.94l-.38-2.65A.5.5,0,0,0,13.8,1H10.2a.5.5,0,0,0-.49.41L9.33,4.06a7.28,7.28,0,0,0-1.63.94l-2.49-1a.5.5,0,0,0-.6.22l-2,3.46a.5.5,0,0,0,.12.64L4.86,11.06a7.43,7.43,0,0,0-.05.94,7.43,7.43,0,0,0,.05.94L2.75,14.59a.5.5,0,0,0-.12.64l2,3.46a.5.5,0,0,0,.6.22l2.49-1a7.28,7.28,0,0,0,1.63.94l.38,2.65a.5.5,0,0,0,.49.41h3.6a.5.5,0,0,0,.49-.41l.38-2.65a7.28,7.28,0,0,0,1.63-.94l2.49,1a.5.5,0,0,0,.6-.22l2-3.46a.5.5,0,0,0-.12-.64ZM12,15.5A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z" />
          </svg>
          <span>{t('gitHistory.options.title')}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {diffOptionsOpen && (
          <div className="git-history-diff-options-popover">
            <div className="git-history-diff-options-title">{t('gitHistory.options.title')}</div>
            <div className="git-history-diff-options-group">
              <div className="git-history-diff-options-label">{t('gitHistory.options.displayMode')}</div>
              <div className="git-history-diff-options-buttons">
                <button
                  className={`git-history-option-btn ${diffStyle === 'unified' ? 'active' : ''}`}
                  onClick={() => handleDiffStyleChange('unified')}
                >
                  {t('gitHistory.options.unified')}
                </button>
                <button
                  className={`git-history-option-btn ${diffStyle === 'split' ? 'active' : ''}`}
                  onClick={() => handleDiffStyleChange('split')}
                >
                  {t('gitHistory.options.split')}
                </button>
              </div>
            </div>
            <div className="git-history-diff-options-group">
              <div className="git-history-diff-options-label">{t('gitHistory.options.whitespace')}</div>
              <label className="git-history-checkbox">
                <input
                  type="checkbox"
                  checked={hideWhitespace}
                  onChange={(e) => handleToggleWhitespace(e.target.checked)}
                />
                <span>{t('gitHistory.options.hideWhitespace')}</span>
              </label>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderDiff = () => {
    if (!selectionInfo.isContiguous && selectionInfo.selectedCommits.length > 1) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.nonContiguous')}
        </div>
      )
    }
    if (!selectedFile) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.noFileSelected')}
        </div>
      )
    }
    if (diffError) {
      return (
        <div className="git-history-no-selection">
          {diffError}
        </div>
      )
    }
    if (diffLoading) {
      return (
        <div className="git-history-loading">
          <div className="git-history-spinner" />
        </div>
      )
    }
    if (selectedFile.isImage) {
      if (!selectedFileContent) {
        return (
          <div className="git-history-no-selection">
            {t('gitHistory.diff.empty')}
          </div>
        )
      }
      return renderImagePreview(selectedFileContent, selectedFile)
    }
    if (!diffPatch) {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.empty')}
        </div>
      )
    }
    try {
      const parsed = parsePatchFiles(diffPatch)
      if (parsed.length === 0 || parsed[0].files.length === 0) {
        return (
          <div className="git-history-no-selection">
            {t('gitHistory.diff.empty')}
          </div>
        )
      }
    } catch {
      return (
        <div className="git-history-no-selection">
          {t('gitHistory.diff.parseError')}
        </div>
      )
    }
    return (
      <div className="git-history-diff-view" style={{ fontSize: `${diffFontSize}px` }}>
        <div className="git-history-diff-scroll" onScroll={handleDiffScroll} ref={diffScrollRef}>
          <PatchDiff
            patch={diffPatch}
            options={diffOptions}
            className="git-history-patch"
            style={{
              fontSize: `${diffFontSize}px`,
              lineHeight: `${Math.round(diffFontSize * 1.5)}px`
            }}
          />
        </div>
      </div>
    )
  }

  const overlayClassName = `git-history-overlay ${isPanel ? 'panel' : ''}`
  const modalClassName = `git-history-modal ${isPanel ? 'panel' : ''}`
  const useSharedPanelHeader = isPanel && panelShellMode === 'internal'
  const keepMountedInPanel = isPanel
  const historyWorkingDirectory = historyResult?.cwd && historyResult.isGitRepo
    ? (cachedParentCwd || historyResult.cwd)
    : null
  const externalPanelActions = useMemo(() => (
    <SubpagePanelButton className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
      {t('gitHistory.returnToTerminal')}
    </SubpagePanelButton>
  ), [onClose, t])
  const externalPanelShellState = useMemo<SubpagePanelShellState>(() => ({
    current: 'history',
    onSelect: handleSelectSubpage,
    workingDirectoryLabel: t('gitHistory.cwd'),
    workingDirectoryPath: historyWorkingDirectory,
    actions: externalPanelActions
  }), [externalPanelActions, handleSelectSubpage, historyWorkingDirectory, t])
  const historyBody = (
    <>
      {historyResult?.superprojectRoot && !selectedRepoRoot && (
        <div
          className="git-history-superproject-hint"
          onClick={() => switchRepo(historyResult.superprojectRoot!)}
        >
          <span>{t('gitHistory.repo.inSubmodule')}</span>
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>{t('gitHistory.repo.viewParent')}</span>
        </div>
      )}
      <div className="git-history-body">
        {cachedRepos && cachedRepos.length > 1 && (() => {
          const parentCwd = cachedParentCwd || historyResult?.cwd || ''
          const sorted = [...cachedRepos].sort((a, b) => a.label.localeCompare(b.label))
          const query = repoSearch.toLowerCase()
          const filtered = query
            ? sorted.filter((repo) => repo.label.toLowerCase().includes(query))
            : sorted
          return (
            <div className="git-history-repo-sidebar">
              <div className="git-history-repo-sidebar-header">{t('gitHistory.repo.title')}</div>
              {sorted.length > 6 && (
                <div className="git-history-repo-search-wrap">
                  <input
                    className="git-history-repo-search"
                    type="text"
                    placeholder={t('gitHistory.repo.search')}
                    value={repoSearch}
                    onChange={(event) => setRepoSearch(event.target.value)}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                  {repoSearch && (
                    <span
                      className="git-history-repo-search-clear"
                      onClick={() => setRepoSearch('')}
                    >×</span>
                  )}
                </div>
              )}
              <div className="git-history-repo-list">
                <div
                  className={`git-history-repo-item${!selectedRepoRoot ? ' active' : ''}`}
                  onClick={() => switchRepo(null)}
                  title={parentCwd}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
                    <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5z" />
                  </svg>
                  <span className="git-history-repo-item-label">{t('gitHistory.repo.all')}</span>
                </div>
                <div className="git-history-repo-divider" />
                {filtered.map((repo) => {
                  if (repo.root === parentCwd) return null
                  return (
                    <div
                      key={repo.root}
                      className={`git-history-repo-item${selectedRepoRoot === repo.root ? ' active' : ''}`}
                      onClick={() => switchRepo(repo.root)}
                      title={repo.root}
                    >
                      <span className="git-history-repo-item-label">{repo.label}</span>
                    </div>
                  )
                })}
                {filtered.length === 0 && (
                  <div className="git-history-repo-empty">{t('gitHistory.repo.noMatch')}</div>
                )}
              </div>
            </div>
          )
        })()}
        <div className="git-history-main">
          <div className="git-history-commit-list">
            <div className="git-history-commit-list-header">
              {t('gitHistory.commitList.title')} {historyResult?.totalCount ? `(${historyResult.totalCount})` : ''}
            </div>
            {renderCommitList()}
          </div>
          <div className="git-history-detail" ref={detailContainerRef}>
            <div className="git-history-summary-wrapper" style={{ height: summaryHeight }}>
              {renderCommitSummary()}
            </div>
            <div
              className="git-history-summary-resizer"
              onMouseDown={handleSummaryResizerMouseDown}
            />
            <div className="git-history-detail-body">
              <div className="git-history-file-list" style={{ width: fileListWidth }}>
                <div className="git-history-file-list-header">
                  {t('gitHistory.fileList.title')} {files.length ? `(${files.length})` : ''}
                </div>
                {renderFileList()}
              </div>
              <div
                className="git-history-file-resizer"
                onMouseDown={handleFileResizerMouseDown}
              />
              <div className="git-history-diff">
                <div className="git-history-diff-header">
                  <div className="git-history-diff-file">
                    {selectedFile && (
                      <>
                        <span className={`git-history-file-status status-${selectedFile.status}`}>
                          {selectedFile.status}
                        </span>
                        <span className="git-history-diff-file-name">
                          {selectedFile.originalFilename
                            ? `${selectedFile.originalFilename} → ${selectedFile.filename}`
                            : selectedFile.filename}
                        </span>
                      </>
                    )}
                  </div>
                  {!selectedFile?.isImage && renderDiffOptions()}
                </div>
                <div className="git-history-diff-content">
                  {renderDiff()}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )

  useLayoutEffect(() => {
    if (!isPanel || panelShellMode !== 'external' || !onPanelShellStateChange) return
    if (!isOpen) {
      onPanelShellStateChange(null)
      return
    }
    onPanelShellStateChange(externalPanelShellState)
    return () => {
      onPanelShellStateChange(null)
    }
  }, [
    externalPanelActions,
    externalPanelShellState,
    isOpen,
    isPanel,
    onPanelShellStateChange,
    panelShellMode
  ])

  if (!isOpen && !keepMountedInPanel) return null

  return (
    <div className={`${overlayClassName} ${isOpen ? 'is-open' : 'is-hidden'}`} aria-hidden={!isOpen}>
      <div className={modalClassName}>
        {useSharedPanelHeader ? (
          <SubpagePanelShell
            current="history"
            onSelect={handleSelectSubpage}
            workingDirectoryLabel={t('gitHistory.cwd')}
            workingDirectoryPath={historyWorkingDirectory}
            actions={(
              <>
                <SubpagePanelButton className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
                  {t('gitHistory.returnToTerminal')}
                </SubpagePanelButton>
              </>
            )}
          >
            {historyBody}
          </SubpagePanelShell>
        ) : panelShellMode === 'external' && isPanel ? (
          historyBody
        ) : (
          <>
            <div className="git-history-header">
              <div className="git-history-header-main">
                <h2 className="git-history-title">{t('gitHistory.title')}{taskTitle && <span className="git-history-task-label"> &middot; {taskTitle}</span>}</h2>
                <SubpageSwitcher current="history" onSelect={handleSelectSubpage} />
              </div>
              <div className="git-history-header-actions">
                <SubpagePanelButton className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
                  {t('gitHistory.returnToTerminal')}
                </SubpagePanelButton>
              </div>
            </div>
            {historyWorkingDirectory && (
              <div className="git-history-cwd-bar">
                <span className="git-history-cwd-label">{t('gitHistory.cwd')}</span>
                <span className="git-history-cwd-path">{historyWorkingDirectory}</span>
              </div>
            )}
            {historyBody}
          </>
        )}
      </div>
    </div>
  )
}
