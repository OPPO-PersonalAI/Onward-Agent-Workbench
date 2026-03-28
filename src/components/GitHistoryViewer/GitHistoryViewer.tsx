/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { parsePatchFiles } from '@pierre/diffs'
import type {
  GitHistoryResult,
  GitCommitInfo,
  GitHistoryFile,
  GitHistoryDiffResult
} from '../../types/electron'
import { useSettings } from '../../contexts/SettingsContext'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import type { TerminalGitStatus } from '../../types/electron'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
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

export function GitHistoryViewer({
  isOpen,
  onClose,
  terminalId: _terminalId,
  cwd,
  displayMode = 'modal'
}: GitHistoryViewerProps) {
  const isPanel = displayMode === 'panel'
  const { settings } = useSettings()
  const { locale, t } = useI18n()

  const [loading, setLoading] = useState(false)
  const [historyResult, setHistoryResult] = useState<GitHistoryResult | null>(null)
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [selectedShas, setSelectedShas] = useState<string[]>([])
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null)
  const [files, setFiles] = useState<GitHistoryFile[]>([])
  const [selectedFile, setSelectedFile] = useState<GitHistoryFile | null>(null)
  const [diffPatch, setDiffPatch] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)
  const [worktreeStatus, setWorktreeStatus] = useState<TerminalGitStatus | null>(null)

  const [hideWhitespace, setHideWhitespace] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_HIDE_WHITESPACE)
    return saved === 'true'
  })
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_DIFF_STYLE)
    return saved === 'unified' ? 'unified' : 'split'
  })
  const [diffOptionsOpen, setDiffOptionsOpen] = useState(false)
  const diffOptionsRef = useRef<HTMLDivElement | null>(null)

  const [fileListWidth, setFileListWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const fileListWidthRef = useRef(fileListWidth)
  const isDraggingRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartWidthRef = useRef(0)

  // Summary / detail-body vertical resizer
  const [summaryHeight, setSummaryHeight] = useState(() => {
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
  const commitsRef = useRef<GitCommitInfo[]>([])
  const loadingRef = useRef(false)
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
  const [repoSearch, setRepoSearch] = useState('')
  const [cachedRepos, setCachedRepos] = useState<GitHistoryResult['repos']>(undefined)
  const [cachedParentCwd, setCachedParentCwd] = useState<string | null>(null)
  const activeCwd = selectedRepoRoot || historyResult?.cwd || cachedParentCwd || cwd
  const activeCwdRef = useRef(activeCwd)
  useEffect(() => {
    activeCwdRef.current = activeCwd
  }, [activeCwd])
  const terminalId = _terminalId
  const historyStateKey = activeCwd ? `${STORAGE_KEY_STATE_PREFIX}:${activeCwd}` : null
  const historyStateKeyRef = useRef(historyStateKey)
  useEffect(() => {
    historyStateKeyRef.current = historyStateKey
  }, [historyStateKey])
  const isSwitchingRepoRef = useRef(false)

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

  const resetState = useCallback(() => {
    setHistoryResult(null)
    setCommits([])
    setHasMore(true)
    setSelectedShas([])
    setSelectionAnchor(null)
    setFiles([])
    setSelectedFile(null)
    setDiffPatch('')
    setDiffError(null)
    setDiffLoading(false)
    setFilesLoading(false)
    fileCacheRef.current.clear()
    patchCacheRef.current.clear()
    ++filesTokenRef.current
    ++patchTokenRef.current
    didRestoreRef.current = false
    pendingScrollRef.current = null
  }, [])

  const loadHistory = useCallback(async (reset = false) => {
    const targetCwd = selectedRepoRoot || cachedParentCwd || cwd
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
      if (result.repos && result.repos.length > 1) {
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
  }, [cachedParentCwd, cwd, selectedRepoRoot])

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

  const switchRepo = useCallback((repoRoot: string | null) => {
    isSwitchingRepoRef.current = true
    fileCacheRef.current.clear()
    patchCacheRef.current.clear()
    didRestoreRef.current = false
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
  }, [historyStateKey])

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
    if (isOpen) {
      resetState()
      void loadHistory(true)
    } else {
      persistStateRef.current()
      resetState()
      setSelectedRepoRoot(null)
      setRepoSearch('')
    }
  }, [isOpen, loadHistory, resetState])

  useEffect(() => {
    if (!isOpen) return
    if (!isSwitchingRepoRef.current) return
    void loadHistory(true)
  }, [cachedParentCwd, isOpen, loadHistory, selectedRepoRoot])

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
    if (!isOpen || !terminalId) return
    let cancelled = false
    const loadStatus = async () => {
      try {
        const info = await window.electronAPI.git.getTerminalInfo(terminalId)
        if (cancelled) return
        setWorktreeStatus(info.status)
      } catch {
        if (cancelled) return
        setWorktreeStatus(null)
      }
    }
    void loadStatus()
    const timer = window.setInterval(loadStatus, 5000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [isOpen, terminalId])

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
    const raw = localStorage.getItem(historyStateKey)
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
      setFiles([])
      setSelectedFile(null)
      setDiffPatch('')
      return
    }
    if (!selectionInfo.isContiguous) {
      setFiles([])
      setSelectedFile(null)
      setDiffPatch('')
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
      setDiffPatch('')
      return
    }
    void loadPatchForFile(selectionInfo.base, selectionInfo.head, selectedFile)
  }, [selectedFile, selectionInfo.isContiguous, selectionInfo.base, selectionInfo.head, loadPatchForFile, isOpen])

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
  }, [files.length, diffPatch, isOpen])

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
    const api = {
      isOpen: () => isOpen,
      getCommitCount: () => commits.length,
      getSelectedShas: () => selectedShas,
      getFiles: () => files.map(f => ({ filename: f.filename, status: f.status })),
      getSelectedFile: () => selectedFile ? { filename: selectedFile.filename } : null,
      isLoading: () => loading || filesLoading || diffLoading,
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
      },
      getHideWhitespace: () => hideWhitespace,
      setHideWhitespace: (value: boolean) => {
        setHideWhitespace(value)
        localStorage.setItem(STORAGE_KEY_HIDE_WHITESPACE, String(value))
      }
    }
    ;(window as any).__onwardGitHistoryDebug = api
    return () => {
      if ((window as any).__onwardGitHistoryDebug === api) {
        delete (window as any).__onwardGitHistoryDebug
      }
    }
  }, [isOpen, commits, selectedShas, files, selectedFile, loading, filesLoading, diffLoading, diffStyle, hideWhitespace])

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
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [])

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
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileListWidth])

  const handleToggleWhitespace = useCallback((value: boolean) => {
    setHideWhitespace(value)
    localStorage.setItem(STORAGE_KEY_HIDE_WHITESPACE, value ? 'true' : 'false')
  }, [])

  const handleDiffStyleChange = useCallback((style: 'split' | 'unified') => {
    setDiffStyle(style)
    localStorage.setItem(STORAGE_KEY_DIFF_STYLE, style)
  }, [])

  const handleJumpToDiff = useCallback(() => {
    if (!terminalId) return
    window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    onClose()
  }, [terminalId, onClose])

  const renderWorktreeStatus = () => {
    if (!worktreeStatus) {
      return null
    }
    const isDirty = worktreeStatus === 'modified' || worktreeStatus === 'added'
    const label = isDirty ? t('gitHistory.worktree.dirty') : t('gitHistory.worktree.clean')
    return (
      <div className={`git-history-worktree ${isDirty ? 'dirty' : 'clean'}`}>
        <span className="git-history-worktree-label">{label}</span>
        {isDirty && (
          <button className="git-history-worktree-btn" onClick={handleJumpToDiff}>
            {t('gitHistory.worktree.viewDiff')}
          </button>
        )}
      </div>
    )
  }

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

  if (!isOpen) return null

  const overlayClassName = `git-history-overlay ${isPanel ? 'panel' : ''}`
  const modalClassName = `git-history-modal ${isPanel ? 'panel' : ''}`

  return (
    <div className={overlayClassName}>
      <div className={modalClassName}>
        <div className="git-history-header">
          <h2 className="git-history-title">Git History</h2>
          <div className="git-history-header-actions">
            {renderWorktreeStatus()}
            <button className="git-history-close" onClick={onClose} title={t('gitHistory.returnToTerminal')}>
              {t('gitHistory.returnToTerminal')}
            </button>
          </div>
        </div>
        {historyResult?.cwd && historyResult.isGitRepo && (
          <div className="git-history-cwd-bar">
            <span className="git-history-cwd-label">{t('gitHistory.cwd')}</span>
            <span className="git-history-cwd-path">{cachedParentCwd || historyResult.cwd}</span>
          </div>
        )}
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
                    {renderDiffOptions()}
                  </div>
                  <div className="git-history-diff-content">
                    {renderDiff()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
