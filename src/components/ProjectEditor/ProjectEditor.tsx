/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Editor } from '@monaco-editor/react'
import DOMPurify from 'dompurify'
import type { ProjectEntry } from '../../types/electron'
import type { ProjectEditorState } from '../../types/tab.d.ts'
import { useSettings } from '../../contexts/SettingsContext'
import { useAppState } from '../../hooks/useAppState'
import { DEFAULT_GIT_DIFF_FONT_SIZE } from '../../constants/gitDiff'
import { useSubpageEscape } from '../../hooks/useSubpageEscape'
import { useI18n } from '../../i18n/useI18n'
import { runAllTests } from '../../autotest/autotest-runner'
import type { AutotestContext, CpuSummary, ProjectEditorDebugApi, TestResult } from '../../autotest/types'
import 'katex/dist/katex.min.css'
import {
  buildMissingFileNotice,
  buildPendingCursor,
  clampCursorPosition,
  resolveStoredProjectEditorState,
  shouldKeepPendingRestoreState
} from './projectEditorRestoreUtils'
import { OutlinePanel, type OutlineTarget } from './Outline/OutlinePanel'
import { countSymbols } from './Outline/outlineParser'
import { useOutlineSymbols } from './Outline/useOutlineSymbols'
import { SearchPanel } from './GlobalSearch/SearchPanel'
import { PreviewSearchBar } from './PreviewSearch/PreviewSearchBar'
import { SqliteViewer } from './SqliteViewer'
import './ProjectEditor.css'

interface ProjectEditorProps {
  isOpen: boolean
  terminalId: string | null
  cwd: string | null
  onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
  displayMode?: 'modal' | 'panel'
}

interface TreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  isExpanded?: boolean
  isLoading?: boolean
  children?: TreeNode[]
}

type DialogState =
  | {
    type: 'confirm'
    title: string
    message: string
    confirmText?: string
    cancelText?: string
  }
  | {
    type: 'prompt'
    title: string
    message: string
    placeholder?: string
    defaultValue?: string
    confirmText?: string
    cancelText?: string
  }

type ConfirmOptions = {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
}

type PromptOptions = {
  title: string
  message: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
  cancelText?: string
}

type ContextMenuState = {
  x: number
  y: number
  targetPath: string | null
  targetType: 'file' | 'dir' | null
  source: 'tree' | 'quick-recent' | 'quick-pin'
}

type SaveSource = 'toolbar' | 'global-shortcut' | 'editor-shortcut' | 'debug-toolbar'
type PreviewRestorePhase = 'idle' | 'waiting-html' | 'restoring-layout' | 'revealing'

const STORAGE_KEY_FILE_TREE_WIDTH = 'project-editor-file-tree-width'
const STORAGE_KEY_MODAL_SIZE = 'project-editor-modal-size'
const STORAGE_KEY_MARKDOWN_PREVIEW_RATIO = 'project-editor-markdown-preview-ratio'
const STORAGE_KEY_MARKDOWN_PREVIEW_WIDTH = 'project-editor-markdown-preview-width'
const STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE = 'project-editor-markdown-editor-visible'
const STORAGE_KEY_OUTLINE_VISIBLE = 'project-editor-outline-visible'
const STORAGE_KEY_OUTLINE_WIDTH = 'project-editor-outline-width'
const STORAGE_KEY_OUTLINE_TARGET = 'project-editor-outline-target'

const DEFAULT_FILE_TREE_WIDTH = 260
const MIN_FILE_TREE_WIDTH = 180
const MAX_FILE_TREE_WIDTH = 520

const DEFAULT_MODAL_WIDTH = 1200
const DEFAULT_MODAL_HEIGHT = 720
const MIN_MODAL_WIDTH = 720
const MIN_MODAL_HEIGHT = 420
const MAX_MODAL_WIDTH_PERCENT = 95
const MAX_MODAL_HEIGHT_PERCENT = 95

const MIN_MARKDOWN_PREVIEW_RATIO = 0.2
const MAX_MARKDOWN_PREVIEW_RATIO = 0.8

const DEFAULT_MARKDOWN_PREVIEW_WIDTH = 480
const MIN_MARKDOWN_PREVIEW_WIDTH = 240
const MAX_MARKDOWN_PREVIEW_WIDTH = 800

const DEFAULT_OUTLINE_WIDTH = 220
const MIN_OUTLINE_WIDTH = 160
const MARKDOWN_RENDER_DEBOUNCE_MS = 300
const MARKDOWN_RENDER_MAX_DEBOUNCE_MS = 1200
const PROJECT_STATE_SAVE_DEBOUNCE_MS = 1200
const MAX_PINNED_FILES = 5
const MAX_RECENT_FILES = 5
const QUICK_FILE_DRAG_MIME = 'application/x-onward-quick-file'

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

const DOMPURIFY_URI_POLICY = /^(?:(?:https?|mailto|tel|sms|cid|xmpp|file|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
const DEBUG_PROJECT_EDITOR = Boolean(window.electronAPI?.debug?.enabled)

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

function normalizeQuickFilePaths(paths: readonly string[] | null | undefined, maxCount: number): string[] {
  if (!Array.isArray(paths) || maxCount <= 0) return []
  const results: string[] = []
  const dedupe = new Set<string>()
  for (const item of paths) {
    const normalized = normalizePath(String(item || '').trim())
    if (!normalized || dedupe.has(normalized)) continue
    dedupe.add(normalized)
    results.push(normalized)
    if (results.length >= maxCount) break
  }
  return results
}

function prependRecentFile(paths: readonly string[], path: string, maxCount: number): string[] {
  const normalizedPath = normalizePath(path.trim())
  if (!normalizedPath) return normalizeQuickFilePaths(paths, maxCount)
  const normalized = normalizeQuickFilePaths(paths, maxCount)
  return [normalizedPath, ...normalized.filter(item => item !== normalizedPath)].slice(0, maxCount)
}

function replaceQuickFilePath(paths: readonly string[], sourcePath: string, nextPath: string, maxCount: number): string[] {
  const normalizedSource = normalizePath(sourcePath.trim())
  const normalizedNext = normalizePath(nextPath.trim())
  if (!normalizedSource || !normalizedNext) return normalizeQuickFilePaths(paths, maxCount)
  const mapped = paths.map((item) => {
    if (item === normalizedSource) return normalizedNext
    if (item.startsWith(`${normalizedSource}/`)) {
      return `${normalizedNext}${item.slice(normalizedSource.length)}`
    }
    return item
  })
  return normalizeQuickFilePaths(mapped, maxCount)
}

function removeQuickFilePath(paths: readonly string[], targetPath: string, maxCount: number): string[] {
  const normalizedTarget = normalizePath(targetPath.trim())
  if (!normalizedTarget) return normalizeQuickFilePaths(paths, maxCount)
  return normalizeQuickFilePaths(
    paths.filter(item => item !== normalizedTarget && !item.startsWith(`${normalizedTarget}/`)),
    maxCount
  )
}

function moveQuickFile(paths: readonly string[], dragPath: string, targetPath: string, maxCount: number): string[] {
  const normalized = normalizeQuickFilePaths(paths, maxCount)
  const fromIndex = normalized.indexOf(dragPath)
  const toIndex = normalized.indexOf(targetPath)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return normalized
  const next = [...normalized]
  const [moved] = next.splice(fromIndex, 1)
  const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex
  next.splice(insertIndex, 0, moved)
  return next
}

function buildQuickFileLabels(paths: readonly string[], rootLabel: string): Record<string, string> {
  const labels: Record<string, string> = {}
  paths.forEach((path) => {
    const base = getBaseName(path)
    const parent = getParentPath(path)
    labels[path] = `${base} · ${parent || rootLabel}`
  })
  return labels
}

function decodeQuickFileDragPayload(raw: string): { path: string; source: 'pinned' | 'recent' } | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; source?: unknown }
    const path = typeof parsed.path === 'string' ? normalizePath(parsed.path.trim()) : ''
    const source = parsed.source === 'pinned' || parsed.source === 'recent' ? parsed.source : null
    if (!path || !source) return null
    return { path, source }
  } catch {
    return null
  }
}

type ProjectEditorScope = {
  terminalId: string
  cwd: string | null
}

type PreviewScrollMemory = {
  scrollRatio: number
  nearestHeadingSlug: string | null
  headingOffsetY: number
  scrollTop: number
}

function normalizeScopeCwd(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return normalizePath(trimmed)
}

function buildProjectEditorScope(terminalId: string | null, cwd: string | null): ProjectEditorScope | null {
  if (!terminalId) return null
  return {
    terminalId,
    cwd: normalizeScopeCwd(cwd)
  }
}

function isSameProjectEditorScope(a: ProjectEditorScope | null, b: ProjectEditorScope | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.terminalId === b.terminalId && normalizeScopeCwd(a.cwd) === normalizeScopeCwd(b.cwd)
}

function getFileScrollKey(scope: ProjectEditorScope | null, filePath: string | null): string | null {
  if (!scope || !filePath) return null
  return JSON.stringify([scope.terminalId, scope.cwd, filePath])
}

/** Scroll position memory — scope key (for file tree) */
function getScrollScopeKey(scope: ProjectEditorScope | null): string | null {
  if (!scope) return null
  return JSON.stringify([scope.terminalId, scope.cwd])
}

function debugLog(...args: unknown[]) {
  if (!DEBUG_PROJECT_EDITOR) return
  console.log('[ProjectEditor]', ...args)
  try {
    const [message, ...data] = args
    window.electronAPI.debug.log(String(message ?? ''), data.length > 0 ? data : undefined)
  } catch {
    // ignore debug logging failures
  }
}

function isMarkdownPath(path: string | null): boolean {
  if (!path) return false
  const parts = path.split('.')
  if (parts.length < 2) return false
  const ext = parts[parts.length - 1].toLowerCase()
  return MARKDOWN_EXTENSIONS.has(ext)
}

function getMarkdownRenderDelay(contentLength: number, lastDuration: number): number {
  let delay = MARKDOWN_RENDER_DEBOUNCE_MS
  if (contentLength > 200_000) {
    delay = 900
  } else if (contentLength > 100_000) {
    delay = 700
  } else if (contentLength > 50_000) {
    delay = 500
  } else if (contentLength > 20_000) {
    delay = 380
  }

  if (lastDuration > 80) {
    delay = Math.max(delay, Math.min(MARKDOWN_RENDER_MAX_DEBOUNCE_MS, Math.round(lastDuration * 3)))
  }

  return delay
}

function collectExpandedPaths(nodes: TreeNode[]): string[] {
  const results: string[] = []
  const walk = (items: TreeNode[]) => {
    items.forEach((node) => {
      if (node.type === 'dir' && node.isExpanded) {
        if (node.path) {
          results.push(node.path)
        }
        if (node.children) {
          walk(node.children)
        }
      } else if (node.type === 'dir' && node.children) {
        walk(node.children)
      }
    })
  }
  walk(nodes)
  return results
}

function collectFirstFilePaths(nodes: TreeNode[], limit = 2): string[] {
  const results: string[] = []
  const walk = (items: TreeNode[]) => {
    for (const node of items) {
      if (results.length >= limit) return
      if (node.type === 'file') {
        results.push(node.path)
        if (results.length >= limit) return
      }
      if (node.type === 'dir' && node.children) {
        walk(node.children)
        if (results.length >= limit) return
      }
    }
  }
  walk(nodes)
  return results
}

function buildNodes(entries: ProjectEntry[]): TreeNode[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.path,
    type: entry.type
  }))
}

function mergeChildren(prevChildren: TreeNode[] | undefined, nextChildren: TreeNode[]): TreeNode[] {
  if (!prevChildren) return nextChildren

  return nextChildren.map((child) => {
    if (child.type !== 'dir') return child
    const previous = prevChildren.find(prev => prev.path === child.path)
    if (!previous) return child
    return {
      ...child,
      isExpanded: previous.isExpanded,
      isLoading: false,
      children: previous.children
    }
  })
}

function updateTree(nodes: TreeNode[], targetPath: string, updater: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return updater(node)
    }
    if (node.type === 'dir' && node.children) {
      return {
        ...node,
        children: updateTree(node.children, targetPath, updater)
      }
    }
    return node
  })
}

function findNode(nodes: TreeNode[], targetPath: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === targetPath) return node
    if (node.type === 'dir' && node.children) {
      const found = findNode(node.children, targetPath)
      if (found) return found
    }
  }
  return null
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name
  return `${parent}/${name}`
}

function getParentPath(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

function getBaseName(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || ''
}

function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0
  let score = 0
  let lastIndex = -1
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i]
    let found = false
    for (let j = lastIndex + 1; j < target.length; j += 1) {
      if (target[j] === ch) {
        score += j === lastIndex + 1 ? 3 : 1
        lastIndex = j
        found = true
        break
      }
    }
    if (!found) return null
  }
  score += Math.max(0, 20 - (target.length - query.length))
  return score
}

function buildFuzzyResults(query: string, items: string[], limit = 50): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return items.slice(0, limit)

  const scored = items.map((item) => {
    const lower = item.toLowerCase()
    const base = getBaseName(lower)
    const baseScore = fuzzyScore(normalized, base)
    const pathScore = fuzzyScore(normalized, lower)
    if (baseScore === null && pathScore === null) return null
    const score = (baseScore ?? 0) * 2 + (pathScore ?? 0)
    return { item, score }
  }).filter(Boolean) as Array<{ item: string; score: number }>

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.item.length - b.item.length
  })

  return scored.slice(0, limit).map(entry => entry.item)
}

function resolveMonacoLanguage(filePath: string | null): string {
  if (!filePath) return 'plaintext'
  const normalized = normalizePath(filePath).toLowerCase()
  const baseName = getBaseName(normalized)
  if (baseName === 'dockerfile') return 'dockerfile'
  if (baseName === 'makefile') return 'makefile'

  const parts = baseName.split('.')
  const ext = parts.length > 1 ? parts[parts.length - 1] : ''
  const languageByExtension: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    cxx: 'cpp',
    cc: 'cpp',
    c: 'c',
    h: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    sql: 'sql',
    vue: 'html',
    svelte: 'html'
  }
  return languageByExtension[ext] ?? 'plaintext'
}

export function ProjectEditor({
  isOpen,
  terminalId: _terminalId,
  cwd,
  onClose,
  onDirtyChange,
  displayMode = 'modal'
}: ProjectEditorProps) {
  const isPanel = displayMode === 'panel'
  const { getTerminalStyle } = useSettings()
  const { locale, t } = useI18n()
  const { getProjectEditorState, setProjectEditorState } = useAppState()
  const perfCountersRef = useRef({
    renders: 0,
    editorChange: 0,
    editorScroll: 0,
    editorCursor: 0,
    previewScroll: 0,
    previewSync: 0,
    scheduleRender: 0,
    workerSend: 0,
    workerApply: 0,
    projectStateSave: 0
  })
  const perfIntervalRef = useRef<number | null>(null)

  if (DEBUG_PROJECT_EDITOR) {
    perfCountersRef.current.renders += 1
  }
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const rootRef = useRef<string | null>(null)
  const gitDiffOpenRef = useRef(false)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const [pinnedFiles, setPinnedFiles] = useState<string[]>([])
  const [recentFiles, setRecentFiles] = useState<string[]>([])
  const [draggingPinnedPath, setDraggingPinnedPath] = useState<string | null>(null)
  const [draggingQuickPath, setDraggingQuickPath] = useState<string | null>(null)
  const [draggingQuickSource, setDraggingQuickSource] = useState<'pinned' | 'recent' | null>(null)
  const [dragOverPinnedPath, setDragOverPinnedPath] = useState<string | null>(null)
  const [dragOverRecentPath, setDragOverRecentPath] = useState<string | null>(null)
  const [quickTooltip, setQuickTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [fileContent, setFileContent] = useState('')
  const fileContentRef = useRef('')
  const [isBinary, setIsBinary] = useState(false)
  const [isImage, setIsImage] = useState(false)
  const [isSqlite, setIsSqlite] = useState(false)
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)
  const [isMarkdownPreviewOpen, setIsMarkdownPreviewOpen] = useState(true)
  const isMarkdownPreviewOpenRef = useRef(true)
  const [isMarkdownEditorVisible, setIsMarkdownEditorVisible] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE)
    return saved === null ? true : saved === 'true'
  })
  const isMarkdownEditorVisibleRef = useRef(isMarkdownEditorVisible)
  const [isMarkdownRenderEnabled, setIsMarkdownRenderEnabled] = useState(false)
  const [isDirty, setIsDirty] = useState(false)
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarMode, setSidebarMode] = useState<'files' | 'search'>('files')
  const [initialSearchType, setInitialSearchType] = useState<'content' | 'filename'>('content')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [searchActiveIndex, setSearchActiveIndex] = useState(0)
  const [isIndexing, setIsIndexing] = useState(false)
  const isIndexingRef = useRef(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [previewSearchOpen, setPreviewSearchOpen] = useState(false)
  const previewSearchOpenRef = useRef(false)
  const [markdownImageMap, setMarkdownImageMap] = useState<Record<string, string>>({})
  const [markdownRenderSource, setMarkdownRenderSource] = useState('')
  const [markdownRenderPending, setMarkdownRenderPending] = useState(false)
  const markdownRenderPendingRef = useRef(false)
  const [markdownRenderedHtml, setMarkdownRenderedHtml] = useState('')
  const markdownRenderedHtmlRef = useRef('')
  const [markdownImagePaths, setMarkdownImagePaths] = useState<string[]>([])
  const markdownRenderDurationRef = useRef(0)
  const markdownApplyRequestIdRef = useRef(0)
  const markdownPendingPayloadRef = useRef<{ html: string; imagePaths: string[] } | null>(null)
  const markdownIdleHandleRef = useRef<number | null>(null)
  const markdownWorkerInFlightRef = useRef(false)
  const markdownWorkerQueuedRef = useRef(false)
  const markdownRenderSourceRef = useRef('')
  const markdownRootPathRef = useRef('')
  const markdownBaseDirRef = useRef('')
  const markdownImageMapRef = useRef<Record<string, string>>({})
  const markdownRenderAllowedRef = useRef(false)
  const markdownWorkerLogCountRef = useRef(0)
  const markdownPurifyLogCountRef = useRef(0)
  const profileRunRef = useRef(false)
  const autotestRunRef = useRef(false)
  const openGitDiffRef = useRef<(source?: 'user' | 'debug') => Promise<void>>(async () => {})

  const originalContentRef = useRef('')
  const originalModelVersionRef = useRef<number | null>(null)
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const fileIndexRef = useRef<string[]>([])
  const indexTokenRef = useRef(0)

  const modalRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const previewLayoutRef = useRef<HTMLDivElement>(null)
  const imagePreviewRef = useRef<HTMLImageElement | null>(null)

  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [dialogInput, setDialogInput] = useState('')
  const dialogResolveRef = useRef<((value: boolean | string | null) => void) | null>(null)
  const dialogInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const globalSearchInputRef = useRef<HTMLInputElement>(null)

  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const editorScrollDisposableRef = useRef<import('monaco-editor').IDisposable | null>(null)
  const editorCursorDisposableRef = useRef<import('monaco-editor').IDisposable | null>(null)
  const editorModelDisposableRef = useRef<import('monaco-editor').IDisposable | null>(null)
  const previewVisibleRef = useRef(false)
  const scrollRafRef = useRef<number | null>(null)
  const suppressNextEditorScrollRef = useRef(false)
  const suppressNextPreviewScrollRef = useRef(false)
  const markdownRenderTimerRef = useRef<number | null>(null)
  const markdownWorkerRef = useRef<Worker | null>(null)
  const markdownWorkerRequestIdRef = useRef(0)
  const markdownWorkerLatestIdRef = useRef(0)
  const markdownWorkerOwnerRef = useRef<string | null>(null)
  const openFileTokenRef = useRef(0)
  const activeFilePathRef = useRef<string | null>(null)
  const isBinaryRef = useRef(false)
  const isImageRef = useRef(false)
  const isSqliteRef = useRef(false)
  const editorSaveCommandIdRef = useRef<string | null>(null)
  const debugAutoOpenRef = useRef(false)
  const pendingViewStateRef = useRef<import('monaco-editor').editor.ICodeEditorViewState | null>(null)
  const pendingViewStatePathRef = useRef<string | null>(null)
  const pendingViewStateFallbackRef = useRef<{ path: string; line: number } | null>(null)
  const pendingCursorRef = useRef<{ lineNumber: number; column: number } | null>(null)
  const fileFirstVisibleLineRef = useRef<Map<string, number>>(new Map())
  const projectStateSaveTimerRef = useRef<number | null>(null)
  const hasRestoredStateRef = useRef(false)
  const restoringStateRef = useRef(false)
  const restoredStateRef = useRef<ProjectEditorState | null>(null)
  const lastEditorScopeRef = useRef<ProjectEditorScope | null>(null)
  const wasOpenRef = useRef(false)
  const skipClosePersistRef = useRef(false)
  const previewActiveSlugRef = useRef<string | null>(null)
  const [previewActiveSlug, setPreviewActiveSlug] = useState<string | null>(null)
  const previewScrollMemoryRef = useRef<Map<string, PreviewScrollMemory>>(new Map())
  const capturePreviewScrollMemoryRef = useRef<() => void>(() => {})
  const suppressPreviewSyncOnRestoreRef = useRef(false)
  const [previewRestorePhase, setPreviewRestorePhase] = useState<PreviewRestorePhase>('idle')
  const previewRestorePhaseRef = useRef<PreviewRestorePhase>('idle')
  const previewRevealFrameRef = useRef<number | null>(null)
  const previewRevealSettleFrameRef = useRef<number | null>(null)

  const [fileTreeWidth, setFileTreeWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_FILE_TREE_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_TREE_WIDTH
  })
  const fileTreeWidthRef = useRef(fileTreeWidth)
  const fileTreeContainerRef = useRef<HTMLDivElement | null>(null)
  const fileTreeScrollTopRef = useRef<Map<string, number>>(new Map())
  const outlineScrollTopRef = useRef<Map<string, number>>(new Map())
  const isDraggingRef = useRef(false)

  const [modalSize, setModalSize] = useState(() => {
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

  const [markdownPreviewWidth, setMarkdownPreviewWidth] = useState(() => {
    const savedWidth = localStorage.getItem(STORAGE_KEY_MARKDOWN_PREVIEW_WIDTH)
    if (savedWidth) {
      const w = parseInt(savedWidth, 10)
      if (Number.isFinite(w)) {
        return Math.min(MAX_MARKDOWN_PREVIEW_WIDTH, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, w))
      }
    }
    // One-time migration from old ratio system
    const savedRatio = localStorage.getItem(STORAGE_KEY_MARKDOWN_PREVIEW_RATIO)
    if (savedRatio) {
      const ratio = parseFloat(savedRatio)
      if (Number.isFinite(ratio) && ratio >= MIN_MARKDOWN_PREVIEW_RATIO && ratio <= MAX_MARKDOWN_PREVIEW_RATIO) {
        const migrated = Math.round(ratio * DEFAULT_MODAL_WIDTH)
        return Math.min(MAX_MARKDOWN_PREVIEW_WIDTH, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, migrated))
      }
    }
    return DEFAULT_MARKDOWN_PREVIEW_WIDTH
  })
  const markdownPreviewWidthRef = useRef(markdownPreviewWidth)
  const isPreviewDraggingRef = useRef(false)

  const [isOutlineVisible, setIsOutlineVisible] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_OUTLINE_VISIBLE)
    return saved === null ? true : saved === 'true'
  })
  const isOutlineVisibleRef = useRef(isOutlineVisible)
  const [outlineWidth, setOutlineWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY_OUTLINE_WIDTH)
    const w = saved ? parseInt(saved, 10) : DEFAULT_OUTLINE_WIDTH
    if (!Number.isFinite(w)) return DEFAULT_OUTLINE_WIDTH
    return Math.max(MIN_OUTLINE_WIDTH, w)
  })
  const outlineWidthRef = useRef(outlineWidth)
  const isOutlineDraggingRef = useRef(false)
  const [outlineTarget, setOutlineTarget] = useState<OutlineTarget>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_OUTLINE_TARGET)
    return saved === 'preview' ? 'preview' : 'editor'
  })
  const outlineTargetRef = useRef<OutlineTarget>(outlineTarget)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)

  const restoreTokenRef = useRef(0)
  const fileViewStateRef = useRef<Map<string, import('monaco-editor').editor.ICodeEditorViewState | null>>(new Map())
  const [missingFileNotice, setMissingFileNotice] = useState<{
    path: string
    message: string
  } | null>(null)
  const missingFileNoticeRef = useRef<typeof missingFileNotice>(null)
  const isOpenRef = useRef(isOpen)

  useEffect(() => {
    missingFileNoticeRef.current = missingFileNotice
  }, [missingFileNotice])

  useEffect(() => {
    isOpenRef.current = isOpen
  }, [isOpen])

  useEffect(() => {
    previewRestorePhaseRef.current = previewRestorePhase
  }, [previewRestorePhase])

  const cancelPreviewRevealFrames = useCallback(() => {
    if (previewRevealFrameRef.current !== null) {
      window.cancelAnimationFrame(previewRevealFrameRef.current)
      previewRevealFrameRef.current = null
    }
    if (previewRevealSettleFrameRef.current !== null) {
      window.cancelAnimationFrame(previewRevealSettleFrameRef.current)
      previewRevealSettleFrameRef.current = null
    }
  }, [])

  const resetPreviewRestoreState = useCallback(() => {
    cancelPreviewRevealFrames()
    suppressPreviewSyncOnRestoreRef.current = false
    setPreviewRestorePhase('idle')
  }, [cancelPreviewRevealFrames])

  const beginPreviewRestore = useCallback(() => {
    cancelPreviewRevealFrames()
    suppressPreviewSyncOnRestoreRef.current = true
    setPreviewRestorePhase('waiting-html')
  }, [cancelPreviewRevealFrames])

  const queuePreviewReveal = useCallback(() => {
    cancelPreviewRevealFrames()
    setPreviewRestorePhase('idle')
  }, [cancelPreviewRevealFrames])

  useEffect(() => {
    isMarkdownPreviewOpenRef.current = isMarkdownPreviewOpen
  }, [isMarkdownPreviewOpen])

  useEffect(() => {
    isMarkdownEditorVisibleRef.current = isMarkdownEditorVisible
  }, [isMarkdownEditorVisible])

  useEffect(() => {
    previewSearchOpenRef.current = previewSearchOpen
  }, [previewSearchOpen])

  useEffect(() => {
    isOutlineVisibleRef.current = isOutlineVisible
  }, [isOutlineVisible])

  useEffect(() => {
    outlineTargetRef.current = outlineTarget
  }, [outlineTarget])

  useEffect(() => {
    fileTreeWidthRef.current = fileTreeWidth
  }, [fileTreeWidth])

  const editorFontSize = useMemo(() => {
    if (!_terminalId) return DEFAULT_GIT_DIFF_FONT_SIZE
    return getTerminalStyle(_terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  }, [getTerminalStyle, _terminalId])

  const isMarkdownFile = useMemo(() => isMarkdownPath(activeFilePath), [activeFilePath])
  const editorLanguage = useMemo(() => resolveMonacoLanguage(activeFilePath), [activeFilePath])
  const isMarkdownPreviewVisible = isMarkdownFile && isMarkdownPreviewOpen && !isBinary && !isImage && !isSqlite
  const isMarkdownRenderAllowed = isMarkdownPreviewVisible && isMarkdownRenderEnabled
  const isPreviewContentVisible =
    isMarkdownRenderAllowed &&
    (previewRestorePhase === 'idle' || previewRestorePhase === 'revealing')
  const markdownRootPath = useMemo(() => (rootPath ? normalizePath(rootPath) : ''), [rootPath])
  const markdownBaseRelativeDir = useMemo(() => {
    if (!activeFilePath) return ''
    const normalized = normalizePath(activeFilePath)
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
  }, [activeFilePath])

  const handlePreviewCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const selectedText = window.getSelection()?.toString()
    if (!selectedText) return
    event.clipboardData.setData('text/plain', selectedText)
    event.preventDefault()
  }, [])

  const scanPreviewNearestSlug = useCallback((): string | null => {
    const preview = previewRef.current
    if (!preview) return null
    let nearestSlug: string | null = null
    const headings = preview.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')
    const containerRect = preview.getBoundingClientRect()
    for (const heading of headings) {
      const rect = (heading as HTMLElement).getBoundingClientRect()
      if (rect.top - containerRect.top <= 10) {
        nearestSlug = (heading as HTMLElement).id
      }
    }
    return nearestSlug
  }, [])

  const updatePreviewActiveSlug = useCallback((slug: string | null) => {
    if (slug === previewActiveSlugRef.current) return
    previewActiveSlugRef.current = slug
    setPreviewActiveSlug(slug)
  }, [])

  const isPreviewContentVisibleNow = useCallback(() => {
    const phase = previewRestorePhaseRef.current
    if (phase !== 'idle' && phase !== 'revealing') return false
    return Boolean(
      activeFilePathRef.current &&
      isMarkdownPath(activeFilePathRef.current) &&
      isMarkdownPreviewOpenRef.current &&
      !isBinaryRef.current &&
      !isImageRef.current &&
      !isSqliteRef.current &&
      previewRef.current
    )
  }, [])

  const editorPaneStyle = useMemo(() => ({ flex: '1 1 0%' }), [])

  const previewPaneStyle = useMemo(() => {
    if (!isMarkdownEditorVisible) {
      return { flex: '1 1 0%' }
    }
    return {
      flex: `0 1 ${markdownPreviewWidth}px`,
      minWidth: MIN_MARKDOWN_PREVIEW_WIDTH
    }
  }, [isMarkdownEditorVisible, markdownPreviewWidth])

  const outlinePaneStyle = useMemo(() => {
    return {
      flex: `0 1 ${outlineWidth}px`,
      minWidth: MIN_OUTLINE_WIDTH
    }
  }, [outlineWidth])

  const outlineShowInSplit = isOutlineVisible && !isBinary && !isImage && !isSqlite && !!activeFilePath
  const outlineShowInSplitRef = useRef(outlineShowInSplit)
  useEffect(() => {
    outlineShowInSplitRef.current = outlineShowInSplit
  }, [outlineShowInSplit])

  const { symbols: outlineSymbols, activeItem: outlineActiveItem, isLoading: outlineLoading } =
    useOutlineSymbols({
      editor: editorRef.current,
      filePath: activeFilePath,
      content: fileContent,
      isVisible: outlineShowInSplit,
    })
  const outlineSymbolsRef = useRef(outlineSymbols)
  useEffect(() => {
    outlineSymbolsRef.current = outlineSymbols
  }, [outlineSymbols])
  const outlineActiveItemRef = useRef(outlineActiveItem)
  useEffect(() => {
    outlineActiveItemRef.current = outlineActiveItem
  }, [outlineActiveItem])

  const expandedDirs = useMemo(() => collectExpandedPaths(tree), [tree])
  const quickFileLabels = useMemo(() => {
    return buildQuickFileLabels([...pinnedFiles, ...recentFiles], t('projectEditor.rootDirectory'))
  }, [pinnedFiles, recentFiles, t])

  const isMissingFileError = useCallback((error?: string) => {
    if (!error) return false
    const lower = error.toLowerCase()
    return (
      error.includes('ENOENT') ||
      lower.includes('no such file') ||
      lower.includes('cannot find the file') ||
      lower.includes('the system cannot find the file')
    )
  }, [])

  const getViewStateKey = useCallback((path: string) => {
    const scope = lastEditorScopeRef.current
    if (!scope) {
      const root = rootRef.current ?? rootPath ?? ''
      return `${root}::${path}`
    }
    return JSON.stringify([scope.terminalId, scope.cwd, path])
  }, [rootPath])

  const resolveEditorScope = useCallback((scopeOverride?: ProjectEditorScope | null): ProjectEditorScope | null => {
    if (scopeOverride) {
      return {
        terminalId: scopeOverride.terminalId,
        cwd: normalizeScopeCwd(scopeOverride.cwd)
      }
    }
    return buildProjectEditorScope(_terminalId, rootRef.current ?? rootPath ?? cwd ?? null)
  }, [_terminalId, cwd, rootPath])

  const persistProjectEditorState = useCallback((scopeOverride?: ProjectEditorScope | null) => {
    const scope = resolveEditorScope(scopeOverride)
    if (!scope) return
    const currentRootPath = rootRef.current ?? rootPath ?? null
    const currentActiveFilePath = activeFilePathRef.current
    const currentIsBinary = isBinaryRef.current
    const currentIsImage = isImageRef.current
    const currentIsSqlite = isSqliteRef.current
    const normalizedRootPath = currentRootPath ? normalizePath(currentRootPath) : null
    const editor = editorRef.current
    const viewState = (!currentIsBinary && !currentIsImage && !currentIsSqlite && currentActiveFilePath)
      ? (editor?.saveViewState() ?? null)
      : null
    const cursorPosition = (!currentIsBinary && !currentIsImage && !currentIsSqlite && currentActiveFilePath)
      ? (editor?.getPosition() ?? null)
      : null
    if (currentActiveFilePath && viewState) {
      fileViewStateRef.current.set(getViewStateKey(currentActiveFilePath), viewState)
    }
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('project-state:persist', {
        terminalId: scope.terminalId,
        cwd: scope.cwd,
        rootPath: normalizedRootPath,
        activeFilePath: currentActiveFilePath ?? null,
        hasViewState: Boolean(viewState),
        cursorLine: cursorPosition?.lineNumber ?? null,
        cursorColumn: cursorPosition?.column ?? null,
        expandedCount: expandedDirs.length,
        pinnedCount: pinnedFiles.length,
        recentCount: recentFiles.length
      })
    }
    // Capture scroll positions before saving
    const treeKey = getScrollScopeKey(scope)
    const currentFileTreeScrollTop = treeKey ? fileTreeScrollTopRef.current.get(treeKey) : undefined
    const previewKey = getFileScrollKey(scope, currentActiveFilePath)
    const previewMem = previewKey ? previewScrollMemoryRef.current.get(previewKey) : undefined
    const outlineKey = getFileScrollKey(scope, currentActiveFilePath)
    const currentOutlineScrollTop = outlineKey ? outlineScrollTopRef.current.get(outlineKey) : undefined
    setProjectEditorState(scope, {
      rootPath: normalizedRootPath,
      activeFilePath: currentActiveFilePath ?? null,
      expandedDirs,
      pinnedFiles,
      recentFiles,
      editorViewState: viewState ?? undefined,
      cursorLine: cursorPosition?.lineNumber,
      cursorColumn: cursorPosition?.column,
      savedAt: Date.now(),
      // UI layout state
      isPreviewOpen: isMarkdownPreviewOpenRef.current,
      isEditorVisible: isMarkdownEditorVisibleRef.current,
      isOutlineVisible: isOutlineVisibleRef.current,
      outlineTarget: outlineTargetRef.current,
      fileTreeWidth: fileTreeWidthRef.current,
      previewWidth: markdownPreviewWidthRef.current,
      outlineWidth: outlineWidthRef.current,
      modalWidth: modalSizeRef.current.width,
      modalHeight: modalSizeRef.current.height,
      // Scroll positions
      previewScrollAnchor: previewMem
        ? { slug: previewMem.nearestHeadingSlug, ratio: previewMem.scrollRatio }
        : undefined,
      fileTreeScrollTop: currentFileTreeScrollTop,
      outlineScrollTop: currentOutlineScrollTop
    })
  }, [expandedDirs, getViewStateKey, pinnedFiles, recentFiles, resolveEditorScope, rootPath, setProjectEditorState])

  const scheduleProjectStateSave = useCallback((scopeOverride?: ProjectEditorScope | null) => {
    const scope = resolveEditorScope(scopeOverride)
    if (!scope || !isOpen) return
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.projectStateSave += 1
    }
    if (projectStateSaveTimerRef.current) {
      window.clearTimeout(projectStateSaveTimerRef.current)
    }
    projectStateSaveTimerRef.current = window.setTimeout(() => {
      projectStateSaveTimerRef.current = null
      persistProjectEditorState(scope)
    }, PROJECT_STATE_SAVE_DEBOUNCE_MS)
  }, [isOpen, persistProjectEditorState, resolveEditorScope])

  const cancelMarkdownIdle = useCallback(() => {
    if (markdownIdleHandleRef.current === null) return
    const cancelIdle = (window as Window & { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
    if (cancelIdle) {
      cancelIdle(markdownIdleHandleRef.current)
    } else {
      window.clearTimeout(markdownIdleHandleRef.current)
    }
    markdownIdleHandleRef.current = null
  }, [])

  const applyPendingCursorPosition = useCallback((options?: { reveal?: boolean }) => {
    if (!pendingCursorRef.current) return true
    const editor = editorRef.current
    if (!editor) return false
    const model = editor.getModel()
    if (!model) return false
    const { lineNumber, column } = clampCursorPosition({
      lineNumber: pendingCursorRef.current.lineNumber,
      column: pendingCursorRef.current.column,
      lineCount: model.getLineCount(),
      getLineMaxColumn: (line) => model.getLineMaxColumn(line)
    })
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('restore:cursor', { line: lineNumber, column })
    }
    const currentPosition = editor.getPosition()
    const cursorChanged = !currentPosition
      || currentPosition.lineNumber !== lineNumber
      || currentPosition.column !== column
    if (cursorChanged) {
      editor.setPosition({ lineNumber, column })
    }
    if (options?.reveal !== false && cursorChanged) {
      editor.revealLineInCenter(lineNumber)
    }
    pendingCursorRef.current = null
    return true
  }, [])

  const isEditorModelMatchingPath = useCallback((path: string | null) => {
    if (!path) return false
    const modelPath = editorRef.current?.getModel()?.uri.path
    if (!modelPath) return false
    const normalizedModelPath = normalizePath(decodeURIComponent(modelPath))
    const normalizedTargetPath = normalizePath(path)
    const root = rootRef.current ? normalizePath(rootRef.current) : null
    const absoluteTargetPath = root
      ? normalizePath(`${root}/${normalizedTargetPath}`)
      : normalizedTargetPath
    if (normalizedModelPath === absoluteTargetPath) return true
    return normalizedModelPath.endsWith(`/${normalizedTargetPath}`)
  }, [])

  const applyPendingViewState = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return false
    const model = editor.getModel()
    if (!model) return false
    const pendingPath = pendingViewStatePathRef.current
    if (pendingPath && !isEditorModelMatchingPath(pendingPath)) {
      return false
    }
    const hadViewState = Boolean(pendingViewStateRef.current)
    if (pendingViewStateRef.current) {
      editor.restoreViewState(pendingViewStateRef.current)
      pendingViewStateRef.current = null
    }
    const cursorApplied = applyPendingCursorPosition({ reveal: !hadViewState })
    if (!cursorApplied) return false
    const fallback = pendingViewStateFallbackRef.current
    if (
      hadViewState &&
      pendingPath &&
      fallback &&
      fallback.path === pendingPath &&
      fallback.line > 1
    ) {
      const currentFirstVisibleLine = editor.getVisibleRanges()?.[0]?.startLineNumber ?? 1
      if (currentFirstVisibleLine <= 1) {
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(fallback.line)))
        editor.setScrollTop(editor.getTopForLineNumber(safeLine))
      }
    }
    editor.focus()
    if (!pendingViewStateRef.current && !pendingCursorRef.current) {
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
    }
    return true
  }, [applyPendingCursorPosition, isEditorModelMatchingPath])

  const resetActiveFileState = useCallback(() => {
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('reset:begin', {
        activeFilePath: activeFilePathRef.current,
        isMarkdownRenderAllowed: markdownRenderAllowedRef.current,
        markdownRenderPending: markdownRenderPendingRef.current,
        isIndexing: isIndexingRef.current,
        hasWorker: Boolean(markdownWorkerRef.current),
        workerInFlight: markdownWorkerInFlightRef.current,
        hasRenderTimer: Boolean(markdownRenderTimerRef.current),
        hasIdleTask: markdownIdleHandleRef.current !== null
      })
    }
    if (projectStateSaveTimerRef.current) {
      window.clearTimeout(projectStateSaveTimerRef.current)
      projectStateSaveTimerRef.current = null
    }
    if (markdownRenderTimerRef.current) {
      window.clearTimeout(markdownRenderTimerRef.current)
      markdownRenderTimerRef.current = null
    }
    cancelMarkdownIdle()
    if (markdownWorkerRef.current) {
      markdownWorkerRef.current.terminate()
      markdownWorkerRef.current = null
    }
    markdownWorkerOwnerRef.current = null
    markdownWorkerLatestIdRef.current = 0
    markdownWorkerRequestIdRef.current = 0
    markdownWorkerInFlightRef.current = false
    markdownWorkerQueuedRef.current = false
    resetPreviewRestoreState()
    markdownApplyRequestIdRef.current += 1
    markdownPendingPayloadRef.current = null
    indexTokenRef.current += 1
    setIsIndexing(false)
    editorScrollDisposableRef.current?.dispose()
    editorScrollDisposableRef.current = null
    editorCursorDisposableRef.current?.dispose()
    editorCursorDisposableRef.current = null
    editorModelDisposableRef.current?.dispose()
    editorModelDisposableRef.current = null
    pendingViewStateRef.current = null
    pendingViewStatePathRef.current = null
    pendingViewStateFallbackRef.current = null
    pendingCursorRef.current = null
    fileFirstVisibleLineRef.current.clear()
    originalContentRef.current = ''
    originalModelVersionRef.current = null
    fileContentRef.current = ''
    openFileTokenRef.current += 1
    activeFilePathRef.current = null
    isBinaryRef.current = false
    isImageRef.current = false
    isSqliteRef.current = false
    editorSaveCommandIdRef.current = null
    markdownWorkerInFlightRef.current = false
    markdownWorkerQueuedRef.current = false
    setSelectedPath(null)
    setActiveFilePath(null)
    setPinnedFiles([])
    setRecentFiles([])
    setDraggingPinnedPath(null)
    setDraggingQuickPath(null)
    setDraggingQuickSource(null)
    setDragOverPinnedPath(null)
    setDragOverRecentPath(null)
    setFileContent('')
    setIsBinary(false)
    setIsImage(false)
    setIsSqlite(false)
    setImagePreviewUrl(null)
    setIsDirty(false)
    setIsLoadingFile(false)
    setIsMarkdownRenderEnabled(false)
    setMarkdownImageMap({})
    setMarkdownImagePaths([])
    setMarkdownRenderedHtml('')
    setMarkdownRenderPending(false)
    setMarkdownRenderSource('')
    setMissingFileNotice(null)
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('reset:done', { activeFilePath: null })
    }
  }, [cancelMarkdownIdle, resetPreviewRestoreState])

  const scheduleMarkdownApply = useCallback((payload: { html: string; imagePaths: string[] }) => {
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.workerApply += 1
    }
    markdownPendingPayloadRef.current = payload
    const applyId = markdownApplyRequestIdRef.current + 1
    markdownApplyRequestIdRef.current = applyId
    cancelMarkdownIdle()

    const run = () => {
      if (applyId !== markdownApplyRequestIdRef.current) return
      if (!previewVisibleRef.current) return
      if (markdownWorkerOwnerRef.current !== activeFilePath) return
      const pending = markdownPendingPayloadRef.current
      if (!pending) return
      const start = performance.now()
      const safeHtml = DOMPurify.sanitize(pending.html || '', { ALLOWED_URI_REGEXP: DOMPURIFY_URI_POLICY })
      if (applyId !== markdownApplyRequestIdRef.current) return
      setMarkdownRenderedHtml(safeHtml)
      setMarkdownImagePaths(Array.isArray(pending.imagePaths) ? pending.imagePaths : [])
      setMarkdownRenderPending(false)
      const duration = performance.now() - start
      markdownRenderDurationRef.current = duration
      if (DEBUG_PROJECT_EDITOR && (duration > 5 || markdownPurifyLogCountRef.current < 5)) {
        if (markdownPurifyLogCountRef.current < 5) {
          markdownPurifyLogCountRef.current += 1
        }
        debugLog('markdown:dompurify', {
          duration: Math.round(duration),
          htmlLength: safeHtml.length
        })
      }
    }

    const requestIdle = (window as Window & {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number
    }).requestIdleCallback
    if (requestIdle) {
      markdownIdleHandleRef.current = requestIdle(() => {
        markdownIdleHandleRef.current = null
        run()
      }, { timeout: 500 })
    } else {
      markdownIdleHandleRef.current = window.setTimeout(() => {
        markdownIdleHandleRef.current = null
        run()
      }, 0)
    }
  }, [activeFilePath, cancelMarkdownIdle])

  const sendMarkdownRenderRequest = useCallback(() => {
    if (!markdownRenderAllowedRef.current) return
    const worker = markdownWorkerRef.current
    if (!worker) return
    if (markdownWorkerOwnerRef.current !== activeFilePathRef.current) return
    const rootPath = markdownRootPathRef.current
    if (!rootPath) return
    const content = markdownRenderSourceRef.current
    const baseDir = markdownBaseDirRef.current
    const imageMap = markdownImageMapRef.current

    const nextId = markdownWorkerRequestIdRef.current + 1
    markdownWorkerRequestIdRef.current = nextId
    markdownWorkerLatestIdRef.current = nextId
    markdownWorkerInFlightRef.current = true
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.workerSend += 1
    }
    setMarkdownRenderPending(true)
    worker.postMessage({
      id: nextId,
      content,
      rootPath,
      baseDir,
      imageMap,
      profile: DEBUG_PROJECT_EDITOR
    })
  }, [])

  const scheduleMarkdownRender = useCallback(() => {
    if (!markdownRenderAllowedRef.current) return
    const content = fileContentRef.current
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.scheduleRender += 1
    }
    if (content === markdownRenderSourceRef.current && !markdownWorkerInFlightRef.current) {
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
        markdownRenderTimerRef.current = null
      }
      if (markdownRenderPendingRef.current) {
        setMarkdownRenderPending(false)
      }
      return
    }
    if (!markdownRenderPendingRef.current) {
      setMarkdownRenderPending(true)
    }
    if (markdownRenderTimerRef.current) {
      window.clearTimeout(markdownRenderTimerRef.current)
    }
    const delay = getMarkdownRenderDelay(content.length, markdownRenderDurationRef.current)
    markdownRenderTimerRef.current = window.setTimeout(() => {
      markdownRenderTimerRef.current = null
      setMarkdownRenderSource(content)
    }, delay)
  }, [])



  useEffect(() => {
    modalSizeRef.current = modalSize
  }, [modalSize])

  useEffect(() => {
    dirtyRef.current = isDirty
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(() => {
    if (!dialog || dialog.type !== 'prompt') return
    setTimeout(() => dialogInputRef.current?.focus(), 0)
  }, [dialog])

  useEffect(() => {
    if (dialog || searchOpen) {
      setContextMenu(null)
    }
  }, [dialog, searchOpen])

  useEffect(() => {
    if (!isDraggingRef.current) {
      localStorage.setItem(STORAGE_KEY_FILE_TREE_WIDTH, String(fileTreeWidth))
    }
  }, [fileTreeWidth])

  useEffect(() => {
    if (!isResizingModalRef.current) {
      localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSize))
    }
  }, [modalSize])

  useEffect(() => {
    markdownPreviewWidthRef.current = markdownPreviewWidth
  }, [markdownPreviewWidth])

  useEffect(() => {
    outlineWidthRef.current = outlineWidth
  }, [outlineWidth])

  useEffect(() => {
    previewVisibleRef.current = isMarkdownRenderAllowed
  }, [isMarkdownRenderAllowed])

  useEffect(() => {
    isIndexingRef.current = isIndexing
  }, [isIndexing])

  useEffect(() => {
    markdownRenderPendingRef.current = markdownRenderPending
  }, [markdownRenderPending])

  useEffect(() => {
    markdownRenderedHtmlRef.current = markdownRenderedHtml
  }, [markdownRenderedHtml])

  useEffect(() => {
    if (!isMarkdownPreviewVisible) {
      setPreviewSearchOpen(false)
      updatePreviewActiveSlug(null)
    }
  }, [isMarkdownPreviewVisible, updatePreviewActiveSlug])

  useEffect(() => {
    fileContentRef.current = fileContent
  }, [fileContent])

  useEffect(() => {
    markdownRenderSourceRef.current = markdownRenderSource
  }, [markdownRenderSource])

  useEffect(() => {
    markdownRootPathRef.current = markdownRootPath
  }, [markdownRootPath])

  useEffect(() => {
    markdownBaseDirRef.current = markdownBaseRelativeDir
  }, [markdownBaseRelativeDir])

  useEffect(() => {
    markdownImageMapRef.current = markdownImageMap
  }, [markdownImageMap])

  useEffect(() => {
    markdownRenderAllowedRef.current = isMarkdownRenderAllowed
  }, [isMarkdownRenderAllowed])

  useEffect(() => {
    activeFilePathRef.current = activeFilePath
  }, [activeFilePath])

  useEffect(() => {
    isBinaryRef.current = isBinary
  }, [isBinary])

  useEffect(() => {
    isImageRef.current = isImage
  }, [isImage])

  useEffect(() => {
    isSqliteRef.current = isSqlite
  }, [isSqlite])

  const getImageFilePreviewState = useCallback(() => {
    if (!activeFilePathRef.current || !isImageRef.current) return null
    const image = imagePreviewRef.current
    return {
      visible: Boolean(imagePreviewUrl),
      loaded: Boolean(image && image.complete && image.naturalWidth > 0),
      broken: Boolean(image && image.complete && image.naturalWidth === 0),
      src: image?.currentSrc || image?.src || imagePreviewUrl || ''
    }
  }, [imagePreviewUrl])

  useEffect(() => {
    if (!isMarkdownRenderAllowed) {
      resetPreviewRestoreState()
      if (markdownWorkerRef.current) {
        markdownWorkerRef.current.terminate()
        markdownWorkerRef.current = null
      }
      markdownWorkerOwnerRef.current = null
      markdownWorkerLatestIdRef.current = 0
      markdownWorkerRequestIdRef.current = 0
      markdownWorkerInFlightRef.current = false
      markdownWorkerQueuedRef.current = false
      markdownApplyRequestIdRef.current += 1
      markdownPendingPayloadRef.current = null
      cancelMarkdownIdle()
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
        markdownRenderTimerRef.current = null
      }
      setMarkdownRenderedHtml('')
      setMarkdownImagePaths([])
      setMarkdownRenderPending(false)
      const currentContent = fileContentRef.current
      markdownRenderSourceRef.current = currentContent
      setMarkdownRenderSource(currentContent)
      return
    }

    const nextOwner = activeFilePath ?? null
    if (markdownWorkerOwnerRef.current !== nextOwner) {
      if (markdownWorkerRef.current) {
        markdownWorkerRef.current.terminate()
        markdownWorkerRef.current = null
      }
      markdownWorkerOwnerRef.current = nextOwner
      markdownWorkerLatestIdRef.current = 0
      markdownWorkerRequestIdRef.current = 0
      markdownWorkerInFlightRef.current = false
      markdownWorkerQueuedRef.current = false
      markdownPendingPayloadRef.current = null
      cancelMarkdownIdle()
      setMarkdownRenderedHtml('')
      setMarkdownImagePaths([])
      setMarkdownRenderPending(false)
    }

    if (!markdownWorkerRef.current) {
      const worker = new Worker(new URL('../../workers/markdownPreviewWorker.ts', import.meta.url), {
        type: 'module'
      })
      worker.onmessage = (event) => {
        const payload = event.data as {
          id: number
          html: string
          imagePaths: string[]
          renderDuration?: number
          contentLength?: number
        }
        if (!payload || typeof payload.id !== 'number') return
        if (payload.id !== markdownWorkerLatestIdRef.current) return
        markdownWorkerInFlightRef.current = false
        if (
          DEBUG_PROJECT_EDITOR &&
          typeof payload.renderDuration === 'number' &&
          (payload.renderDuration > 5 || markdownWorkerLogCountRef.current < 5)
        ) {
          if (markdownWorkerLogCountRef.current < 5) {
            markdownWorkerLogCountRef.current += 1
          }
          debugLog('markdown:worker', {
            duration: Math.round(payload.renderDuration),
            contentLength: payload.contentLength ?? 0
          })
        }
        scheduleMarkdownApply({
          html: payload.html || '',
          imagePaths: Array.isArray(payload.imagePaths) ? payload.imagePaths : []
        })
        if (markdownWorkerQueuedRef.current) {
          markdownWorkerQueuedRef.current = false
          sendMarkdownRenderRequest()
        }
      }
      worker.onerror = () => {
        markdownWorkerInFlightRef.current = false
        if (markdownWorkerQueuedRef.current) {
          markdownWorkerQueuedRef.current = false
          sendMarkdownRenderRequest()
        }
        setMarkdownRenderPending(false)
      }
      markdownWorkerRef.current = worker
    }
  }, [
    activeFilePath,
    cancelMarkdownIdle,
    isMarkdownRenderAllowed,
    resetPreviewRestoreState,
    scheduleMarkdownApply,
    sendMarkdownRenderRequest
  ])

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) {
        window.cancelAnimationFrame(scrollRafRef.current)
      }
      cancelPreviewRevealFrames()
      editorScrollDisposableRef.current?.dispose()
      editorCursorDisposableRef.current?.dispose()
      editorModelDisposableRef.current?.dispose()
      if (projectStateSaveTimerRef.current) {
        window.clearTimeout(projectStateSaveTimerRef.current)
      }
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
      }
      cancelMarkdownIdle()
      if (markdownWorkerRef.current) {
        markdownWorkerRef.current.terminate()
        markdownWorkerRef.current = null
      }
      editorSaveCommandIdRef.current = null
    }
  }, [cancelMarkdownIdle, cancelPreviewRevealFrames])

  useEffect(() => {
    resetPreviewRestoreState()
    setMarkdownImageMap({})
    setMarkdownImagePaths([])
    setMarkdownRenderedHtml('')
  }, [resetPreviewRestoreState, rootPath])

  useEffect(() => {
    if (!isMarkdownRenderAllowed) {
      if (markdownRenderTimerRef.current) {
        window.clearTimeout(markdownRenderTimerRef.current)
      }
      setMarkdownRenderSource('')
      setMarkdownRenderPending(false)
      return
    }

    scheduleMarkdownRender()
  }, [activeFilePath, isMarkdownRenderAllowed, scheduleMarkdownRender])

  useEffect(() => {
    if (!isMarkdownRenderAllowed || !markdownRootPath) return
    const worker = markdownWorkerRef.current
    if (!worker) return
    if (markdownWorkerOwnerRef.current !== activeFilePath) return
    if (markdownWorkerInFlightRef.current) {
      markdownWorkerQueuedRef.current = true
      return
    }
    sendMarkdownRenderRequest()
  }, [
    isMarkdownRenderAllowed,
    activeFilePath,
    markdownRenderSource,
    markdownRootPath,
    sendMarkdownRenderRequest
  ])

  useEffect(() => {
    if (!isMarkdownRenderAllowed || !rootPath) return
    const pending = markdownImagePaths.filter((path) => !markdownImageMap[path])
    if (pending.length === 0) return
    let cancelled = false

    const loadImages = async () => {
      const updates: Record<string, string> = {}
      await Promise.all(pending.map(async (relativePath) => {
        const result = await window.electronAPI.project.readFile(rootPath, relativePath)
        if (result.success && result.isImage && result.previewUrl) {
          updates[relativePath] = result.previewUrl
        }
      }))
      if (cancelled) return
      if (Object.keys(updates).length > 0) {
        const nextMap = { ...markdownImageMapRef.current, ...updates }
        markdownImageMapRef.current = nextMap
        setMarkdownImageMap(nextMap)
        sendMarkdownRenderRequest()
      }
    }

    void loadImages()
    return () => {
      cancelled = true
    }
  }, [isMarkdownRenderAllowed, markdownImageMap, markdownImagePaths, rootPath, sendMarkdownRenderRequest])


  const showStatus = useCallback((type: 'success' | 'error', text: string) => {
    setStatusMessage({ type, text })
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      setStatusMessage(null)
    }, 2000)
  }, [])

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showStatus('success', t('common.copied', { label, text }))
      return true
    } catch {
      showStatus('error', t('projectEditor.copyFailed'))
      return false
    }
  }, [showStatus, t])

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!activeFilePath || !rootPath) return
    const isAbsolute = e.altKey
    const pathToCopy = isAbsolute ? `${rootPath}/${activeFilePath}` : activeFilePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    await copyToClipboard(pathToCopy, label)
  }, [activeFilePath, copyToClipboard, rootPath, t])

  const resolveAbsolutePath = useCallback((relativePath: string): string | null => {
    const root = rootRef.current ?? rootPath
    if (!root) return null
    const normalizedRoot = normalizePath(root).replace(/\/+$/, '')
    if (!relativePath) return normalizedRoot
    return `${normalizedRoot}/${relativePath}`
  }, [rootPath])

  const copyContextMenuPath = useCallback(async (
    targetPath: string,
    kind: 'name' | 'relative' | 'absolute'
  ) => {
    if (kind === 'name') {
      const root = rootRef.current ?? rootPath
      const text = targetPath
        ? getBaseName(targetPath)
        : (root ? getBaseName(normalizePath(root)) : '')
      if (!text) {
        showStatus('error', t('projectEditor.copyFailed'))
        return
      }
      await copyToClipboard(text, t('common.name'))
      return
    }

    if (kind === 'relative') {
      const text = targetPath || '.'
      await copyToClipboard(text, t('common.relativePath'))
      return
    }

    const absolutePath = resolveAbsolutePath(targetPath)
    if (!absolutePath) {
      showStatus('error', t('projectEditor.absolutePathUnavailable'))
      return
    }
    await copyToClipboard(absolutePath, t('common.absolutePath'))
  }, [copyToClipboard, resolveAbsolutePath, rootPath, showStatus, t])

  const touchRecentFile = useCallback((path: string) => {
    setRecentFiles((prev) => prependRecentFile(prev, path, MAX_RECENT_FILES))
  }, [])

  const removeQuickFileEntries = useCallback((targetPath: string) => {
    setPinnedFiles((prev) => removeQuickFilePath(prev, targetPath, MAX_PINNED_FILES))
    setRecentFiles((prev) => removeQuickFilePath(prev, targetPath, MAX_RECENT_FILES))
  }, [])

  const replaceQuickFileEntries = useCallback((sourcePath: string, nextPath: string) => {
    setPinnedFiles((prev) => replaceQuickFilePath(prev, sourcePath, nextPath, MAX_PINNED_FILES))
    setRecentFiles((prev) => replaceQuickFilePath(prev, sourcePath, nextPath, MAX_RECENT_FILES))
  }, [])

  const validateQuickFileEntries = useCallback(async (
    root: string,
    source?: { pinned: string[]; recent: string[] }
  ) => {
    const pinnedSource = normalizeQuickFilePaths(source?.pinned ?? pinnedFiles, MAX_PINNED_FILES)
    const recentSource = normalizeQuickFilePaths(source?.recent ?? recentFiles, MAX_RECENT_FILES)
    const candidates = Array.from(new Set([...pinnedSource, ...recentSource]))
    if (candidates.length === 0) {
      setPinnedFiles(pinnedSource)
      setRecentFiles(recentSource)
      return
    }

    const existing = await Promise.all(candidates.map(async (path) => {
      const result = await window.electronAPI.project.readFile(root, path)
      if (result.success) return path
      if (!isMissingFileError(result.error || '')) return path
      return null
    }))

    if (normalizePath(rootRef.current ?? '') !== normalizePath(root)) {
      return
    }

    const existingSet = new Set(existing.filter((path): path is string => Boolean(path)))
    setPinnedFiles(
      normalizeQuickFilePaths(
        pinnedSource.filter(path => existingSet.has(path)),
        MAX_PINNED_FILES
      )
    )
    setRecentFiles(
      normalizeQuickFilePaths(
        recentSource.filter(path => existingSet.has(path)),
        MAX_RECENT_FILES
      )
    )
  }, [isMissingFileError, pinnedFiles, recentFiles])

  const togglePinnedFile = useCallback((path: string) => {
    const normalizedPath = normalizePath(path)
    if (!normalizedPath) return
    if (pinnedFiles.includes(normalizedPath)) {
      setPinnedFiles((prev) => prev.filter(item => item !== normalizedPath))
      return
    }
    if (pinnedFiles.length >= MAX_PINNED_FILES) {
      showStatus('error', t('projectEditor.maxPinnedFiles', { count: MAX_PINNED_FILES }))
      return
    }
    setPinnedFiles((prev) => [normalizedPath, ...prev])
  }, [pinnedFiles, showStatus, t])

  const clearRecentFiles = useCallback(() => {
    setRecentFiles([])
    setDraggingPinnedPath(null)
    setDraggingQuickPath(null)
    setDraggingQuickSource(null)
    setDragOverPinnedPath(null)
    setDragOverRecentPath(null)
    showStatus('success', t('projectEditor.recentCleared'))
  }, [showStatus, t])

  const setQuickDragPayload = useCallback((
    event: React.DragEvent<HTMLElement>,
    path: string,
    source: 'pinned' | 'recent'
  ) => {
    const payload = JSON.stringify({ path, source })
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(QUICK_FILE_DRAG_MIME, payload)
    event.dataTransfer.setData('text/plain', path)
  }, [])

  const resolveQuickDragPayload = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (draggingQuickPath && draggingQuickSource) {
      return {
        path: draggingQuickPath,
        source: draggingQuickSource
      } as const
    }
    const mimeData = event.dataTransfer.getData(QUICK_FILE_DRAG_MIME)
    const decodedByMime = decodeQuickFileDragPayload(mimeData)
    if (decodedByMime) return decodedByMime
    const plain = normalizePath(event.dataTransfer.getData('text/plain') || '')
    if (!plain) return null
    return {
      path: plain,
      source: pinnedFiles.includes(plain) ? 'pinned' : 'recent'
    } as const
  }, [draggingQuickPath, draggingQuickSource, pinnedFiles])

  const handleQuickTooltipEnter = useCallback((e: React.MouseEvent, path: string) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setQuickTooltip({ text: path, x: rect.left, y: rect.bottom + 4 })
  }, [])

  const handleQuickTooltipLeave = useCallback(() => {
    setQuickTooltip(null)
  }, [])

  const handlePinnedDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    setDraggingPinnedPath(path)
    setDraggingQuickPath(path)
    setDraggingQuickSource('pinned')
    setDragOverPinnedPath(null)
    setDragOverRecentPath(null)
    setQuickTooltip(null)
    setQuickDragPayload(event, path, 'pinned')
  }, [setQuickDragPayload])

  const handleRecentDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    setDraggingPinnedPath(null)
    setDraggingQuickPath(path)
    setDraggingQuickSource('recent')
    setDragOverPinnedPath(null)
    setDragOverRecentPath(null)
    setQuickTooltip(null)
    setQuickDragPayload(event, path, 'recent')
  }, [setQuickDragPayload])

  const resetQuickDragState = useCallback(() => {
    setDraggingPinnedPath(null)
    setDraggingQuickPath(null)
    setDraggingQuickSource(null)
    setDragOverPinnedPath(null)
    setDragOverRecentPath(null)
  }, [])

  const handlePinnedDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    event.preventDefault()
    if (!draggingQuickPath || draggingQuickPath === path) return
    setDragOverPinnedPath(path)
    setDragOverRecentPath(null)
    event.dataTransfer.dropEffect = 'move'
  }, [draggingQuickPath])

  const handlePinnedDrop = useCallback((event: React.DragEvent<HTMLButtonElement>, targetPath: string) => {
    event.preventDefault()
    event.stopPropagation()

    const dragData = resolveQuickDragPayload(event)
    if (!dragData || !targetPath) {
      resetQuickDragState()
      return
    }

    if (dragData.source === 'pinned') {
      if (dragData.path !== targetPath) {
        setPinnedFiles((prev) => moveQuickFile(prev, dragData.path, targetPath, MAX_PINNED_FILES))
      }
      resetQuickDragState()
      return
    }

    if (!pinnedFiles.includes(dragData.path) && pinnedFiles.length >= MAX_PINNED_FILES) {
      showStatus('error', t('projectEditor.maxPinnedFiles', { count: MAX_PINNED_FILES }))
      resetQuickDragState()
      return
    }

    setPinnedFiles((prev) => {
      const normalized = normalizeQuickFilePaths(prev, MAX_PINNED_FILES)
      if (normalized.includes(dragData.path)) {
        return moveQuickFile(normalized, dragData.path, targetPath, MAX_PINNED_FILES)
      }
      const targetIndex = normalized.indexOf(targetPath)
      if (targetIndex < 0) {
        return normalizeQuickFilePaths([dragData.path, ...normalized], MAX_PINNED_FILES)
      }
      const next = [...normalized]
      next.splice(targetIndex, 0, dragData.path)
      return normalizeQuickFilePaths(next, MAX_PINNED_FILES)
    })

    resetQuickDragState()
  }, [pinnedFiles, resolveQuickDragPayload, resetQuickDragState, showStatus, t])

  const handlePinnedDragEnd = useCallback(() => {
    resetQuickDragState()
  }, [resetQuickDragState])

  const handlePinnedListDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const handlePinnedListDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const dragData = resolveQuickDragPayload(event)
    if (!dragData) {
      resetQuickDragState()
      return
    }

    if (dragData.source === 'recent' && !pinnedFiles.includes(dragData.path) && pinnedFiles.length >= MAX_PINNED_FILES) {
      showStatus('error', t('projectEditor.maxPinnedFiles', { count: MAX_PINNED_FILES }))
      resetQuickDragState()
      return
    }

    setPinnedFiles((prev) => {
      const normalized = normalizeQuickFilePaths(prev, MAX_PINNED_FILES)
      const currentIndex = normalized.indexOf(dragData.path)
      if (currentIndex >= 0) {
        const next = [...normalized]
        const [moved] = next.splice(currentIndex, 1)
        next.push(moved)
        return next
      }
      return normalizeQuickFilePaths([...normalized, dragData.path], MAX_PINNED_FILES)
    })
    resetQuickDragState()
  }, [pinnedFiles, resolveQuickDragPayload, resetQuickDragState, showStatus, t])

  const handleRecentDragOver = useCallback((event: React.DragEvent<HTMLButtonElement>, path: string) => {
    if (draggingQuickSource !== 'recent') return
    event.preventDefault()
    if (!draggingQuickPath || draggingQuickPath === path) return
    setDragOverPinnedPath(null)
    setDragOverRecentPath(path)
    event.dataTransfer.dropEffect = 'move'
  }, [draggingQuickPath, draggingQuickSource])

  const handleRecentDrop = useCallback((event: React.DragEvent<HTMLButtonElement>, targetPath: string) => {
    event.preventDefault()
    event.stopPropagation()
    const dragData = resolveQuickDragPayload(event)
    if (!dragData || dragData.source !== 'recent' || !targetPath) {
      resetQuickDragState()
      return
    }

    if (dragData.path !== targetPath) {
      setRecentFiles((prev) => moveQuickFile(prev, dragData.path, targetPath, MAX_RECENT_FILES))
    }
    resetQuickDragState()
  }, [resolveQuickDragPayload, resetQuickDragState])

  const handleRecentListDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (draggingQuickSource !== 'recent') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [draggingQuickSource])

  const handleRecentListDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const dragData = resolveQuickDragPayload(event)
    if (!dragData || dragData.source !== 'recent') {
      resetQuickDragState()
      return
    }
    setRecentFiles((prev) => {
      const normalized = normalizeQuickFilePaths(prev, MAX_RECENT_FILES)
      const currentIndex = normalized.indexOf(dragData.path)
      if (currentIndex < 0 || currentIndex === normalized.length - 1) {
        return normalized
      }
      const next = [...normalized]
      const [moved] = next.splice(currentIndex, 1)
      next.push(moved)
      return next
    })
    resetQuickDragState()
  }, [resolveQuickDragPayload, resetQuickDragState])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const handleMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return
      setContextMenu(null)
    }
    const handleScroll = () => {
      setContextMenu(null)
    }
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [contextMenu])

  const requestConfirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      dialogResolveRef.current = resolve as (value: boolean | string | null) => void
      setDialog({
        type: 'confirm',
        title: options.title,
        message: options.message,
        confirmText: options.confirmText,
        cancelText: options.cancelText
      })
    })
  }, [])

  const requestPrompt = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      dialogResolveRef.current = resolve as (value: boolean | string | null) => void
      setDialog({
        type: 'prompt',
        title: options.title,
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        confirmText: options.confirmText,
        cancelText: options.cancelText
      })
      setDialogInput(options.defaultValue || '')
    })
  }, [])

  const handleDialogCancel = useCallback(() => {
    if (dialogResolveRef.current) {
      dialogResolveRef.current(dialog?.type === 'confirm' ? false : null)
      dialogResolveRef.current = null
    }
    setDialog(null)
  }, [dialog])

  const handleDialogConfirm = useCallback(() => {
    if (dialogResolveRef.current) {
      const value = dialog?.type === 'confirm' ? true : dialogInput.trim()
      dialogResolveRef.current(value)
      dialogResolveRef.current = null
    }
    setDialog(null)
  }, [dialog, dialogInput])

  const confirmDiscardChanges = useCallback(async () => {
    if (!dirtyRef.current) return true
    return await requestConfirm({
      title: t('projectEditor.confirm.unsaved.title'),
      message: t('projectEditor.confirm.unsaved.message'),
      confirmText: t('projectEditor.confirm.unsaved.confirm'),
      cancelText: t('projectEditor.confirm.unsaved.cancel')
    })
  }, [requestConfirm, t])

  const syncOriginalVersion = useCallback(() => {
    const sync = (attempt: number) => {
      const editor = editorRef.current
      const model = editor?.getModel()
      if (!model) {
        if (attempt < 2) {
          window.setTimeout(() => sync(attempt + 1), 0)
        }
        return
      }
      if (model.getValue() !== fileContentRef.current) {
        if (attempt < 2) {
          window.setTimeout(() => sync(attempt + 1), 0)
        }
        return
      }
      originalModelVersionRef.current = model.getAlternativeVersionId()
    }
    sync(0)
  }, [])

  const waitForEditorModelReady = useCallback(async (targetPath: string, timeoutMs = 2000) => {
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (activeFilePathRef.current !== targetPath) return false
      const editor = editorRef.current
      if (editor?.getModel()) return true
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 16)
      })
    }
    return false
  }, [])

  const openFile = useCallback(async (
    path: string,
    source: 'user' | 'restore' | 'debug' = 'user',
    options?: { trackRecent?: boolean; cursorPosition?: { lineNumber: number; column?: number } | null }
  ) => {
    const currentActiveFilePath = activeFilePathRef.current
    if (source === 'user') {
      // User manual navigation has the highest priority, canceling any ongoing recovery process to avoid being "pulled back to old files".
      restoreTokenRef.current += 1
      hasRestoredStateRef.current = true
      restoringStateRef.current = false
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      pendingCursorRef.current = null
      if (options?.cursorPosition) {
        pendingViewStatePathRef.current = path
        pendingCursorRef.current = {
          lineNumber: options.cursorPosition.lineNumber,
          column: options.cursorPosition.column ?? 1
        }
      }
    }

    if (currentActiveFilePath === path) {
      setSelectedPath(path)
      if (options?.cursorPosition) {
        pendingViewStateRef.current = null
        pendingViewStatePathRef.current = path
        pendingCursorRef.current = {
          lineNumber: options.cursorPosition.lineNumber,
          column: options.cursorPosition.column ?? 1
        }
        applyPendingCursorPosition()
        scheduleProjectStateSave()
      }
      return
    }

    if (currentActiveFilePath) {
      const currentViewState = editorRef.current?.saveViewState() ?? null
      if (currentViewState) {
        fileViewStateRef.current.set(getViewStateKey(currentActiveFilePath), currentViewState)
      }
    }

    debugLog('openFile:start', {
      path,
      activeFilePath: currentActiveFilePath,
      isDirty: dirtyRef.current
    })
    const shouldConfirm = source !== 'debug'
    const canProceed = shouldConfirm ? await confirmDiscardChanges() : true
    debugLog('openFile:confirm', { path, canProceed })
    if (!canProceed) {
      debugLog('openFile:cancelled', { path })
      return
    }

    const root = rootRef.current
    if (!root) {
      debugLog('openFile:missing-root', { path })
      return
    }

    const openToken = openFileTokenRef.current + 1
    openFileTokenRef.current = openToken
    setIsLoadingFile(true)
    debugLog('openFile:readFile', { path, token: openToken })
    const result = await window.electronAPI.project.readFile(root, path)
    if (openToken !== openFileTokenRef.current) {
      debugLog('openFile:stale', { path, token: openToken, current: openFileTokenRef.current })
      return
    }
    setIsLoadingFile(false)

    if (!result.success) {
      const errorMessage = result.error || t('projectEditor.error.readFile')
      if (isMissingFileError(errorMessage)) {
        const missingNotice = buildMissingFileNotice(path, source, locale)
        setMissingFileNotice({
          path,
          message: missingNotice.notice
        })
        setActiveFilePath(path)
        activeFilePathRef.current = path
        setSelectedPath(path)
        setIsBinary(false)
        isBinaryRef.current = false
        setIsImage(false)
        isImageRef.current = false
        setIsSqlite(false)
        isSqliteRef.current = false
        setImagePreviewUrl(null)
        setFileContent('')
        fileContentRef.current = ''
        originalContentRef.current = ''
        originalModelVersionRef.current = null
        setIsDirty(false)
        setIsMarkdownRenderEnabled(false)
        pendingViewStateRef.current = null
        pendingViewStatePathRef.current = null
        pendingViewStateFallbackRef.current = null
        removeQuickFileEntries(path)
        showStatus('error', missingNotice.status)
        debugLog('openFile:missing', { path, error: errorMessage })
        return
      }
      showStatus('error', errorMessage)
      debugLog('openFile:failed', { path, error: errorMessage })
      return
    }

    debugLog('openFile:success', {
      path,
      isBinary: result.isBinary,
      isImage: result.isImage,
      isSqlite: result.isSqlite,
      size: result.content?.length ?? 0
    })
    setMissingFileNotice(null)
    setActiveFilePath(path)
    activeFilePathRef.current = path
    setSelectedPath(path)
    if (source === 'user' && options?.trackRecent) {
      touchRecentFile(path)
    }
    const sqliteFile = Boolean(result.isSqlite)
    const binaryFile = Boolean(result.isBinary) && !sqliteFile
    setIsBinary(binaryFile)
    isBinaryRef.current = binaryFile
    setIsImage(result.isImage)
    isImageRef.current = result.isImage
    setIsSqlite(sqliteFile)
    isSqliteRef.current = sqliteFile
    setImagePreviewUrl(result.previewUrl ?? null)
    const shouldEnableMarkdown = (source === 'user' || source === 'debug' || source === 'restore') && isMarkdownPath(path) && !sqliteFile
    if (shouldEnableMarkdown && isMarkdownPreviewOpenRef.current) {
      capturePreviewScrollMemoryRef.current()
      beginPreviewRestore()
    } else {
      resetPreviewRestoreState()
    }
    setIsMarkdownRenderEnabled(shouldEnableMarkdown && isMarkdownPreviewOpenRef.current)
    const keepPendingRestoreState = shouldKeepPendingRestoreState({
      source,
      path,
      pendingPath: pendingViewStatePathRef.current,
      hasPendingViewState: pendingViewStateRef.current !== null,
      hasPendingCursor: pendingCursorRef.current !== null
    })
    if (!keepPendingRestoreState) {
      const storedViewState = fileViewStateRef.current.get(getViewStateKey(path)) ?? null
      pendingViewStateRef.current = storedViewState
      pendingViewStatePathRef.current = storedViewState ? path : null
      pendingCursorRef.current = null
      if (storedViewState) {
        const fallbackLine = fileFirstVisibleLineRef.current.get(getViewStateKey(path))
        if (typeof fallbackLine === 'number' && fallbackLine > 1) {
          pendingViewStateFallbackRef.current = { path, line: fallbackLine }
        } else {
          pendingViewStateFallbackRef.current = null
        }
      } else {
        pendingViewStateFallbackRef.current = null
      }
    }

    if (sqliteFile) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      return
    }

    if (result.isImage) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      return
    }

    if (result.isBinary) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingViewStateFallbackRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsDirty(false)
      setIsMarkdownRenderEnabled(false)
      return
    }

    setFileContent(result.content)
    fileContentRef.current = result.content
    originalContentRef.current = result.content
    originalModelVersionRef.current = null
    setIsDirty(false)
    syncOriginalVersion()
    const applyPendingAfterModelReady = async () => {
      const ready = await waitForEditorModelReady(path)
      if (!ready) return false
      if (
        (pendingViewStateRef.current || pendingCursorRef.current) &&
        pendingViewStatePathRef.current === path
      ) {
        applyPendingViewState()
      }
      return true
    }
    if (source === 'debug') {
      const ready = await applyPendingAfterModelReady()
      if (!ready) {
        debugLog('openFile:debug-model-timeout', { path })
      }
    } else {
      void applyPendingAfterModelReady()
    }
  }, [
    applyPendingCursorPosition,
    applyPendingViewState,
    beginPreviewRestore,
    confirmDiscardChanges,
    getViewStateKey,
    isMarkdownPreviewOpen,
    removeQuickFileEntries,
    resetPreviewRestoreState,
    scheduleProjectStateSave,
    showStatus,
    syncOriginalVersion,
    touchRecentFile,
    waitForEditorModelReady,
    t
  ])

  const openFileRef = useRef(openFile)
  useEffect(() => {
    openFileRef.current = openFile
  }, [openFile])

  const invalidateFileIndex = useCallback(() => {
    fileIndexRef.current = []
  }, [])

  const getFileIndex = useCallback(() => {
    return fileIndexRef.current
  }, [])

  const buildFileIndex = useCallback(async () => {
    const root = rootRef.current
    if (!root) return []
    const token = ++indexTokenRef.current
    const start = performance.now()
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('index:build:start', { root, token })
    }
    setIsIndexing(true)
    const results: string[] = []
    const queue: string[] = ['']

    while (queue.length > 0) {
      const current = queue.shift() ?? ''
      const res = await window.electronAPI.project.listDirectory(root, current)
      if (token !== indexTokenRef.current) {
        setIsIndexing(false)
        if (DEBUG_PROJECT_EDITOR) {
          debugLog('index:build:cancelled', { root, token })
        }
        return []
      }
      if (!res.success) {
        if (DEBUG_PROJECT_EDITOR) {
          debugLog('index:build:entry-error', { root, token, path: current, error: res.error })
        }
        continue
      }
      for (const entry of res.entries) {
        if (entry.type === 'dir') {
          queue.push(entry.path)
        } else {
          results.push(entry.path)
        }
      }
    }

    if (token === indexTokenRef.current) {
      fileIndexRef.current = results
      setIsIndexing(false)
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('index:build:done', {
          root,
          token,
          total: results.length,
          duration: Math.round(performance.now() - start)
        })
      }
      return results
    }

    setIsIndexing(false)
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('index:build:stale', { root, token })
    }
    return []
  }, [])

  const handleOpenSearch = useCallback(async () => {
    setSearchOpen(true)
    setSearchQuery('')
    setSearchActiveIndex(0)
    let index = fileIndexRef.current
    if (index.length === 0) {
      index = await buildFileIndex()
    }
    setSearchResults(buildFuzzyResults('', index))
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [buildFileIndex])

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    setSearchResults([])
    setSearchActiveIndex(0)
  }, [])

  // (sidebar search is now controlled by sidebarMode state, no overlay needed)


  const loadRoot = useCallback(async (root: string) => {
    const start = performance.now()
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('root:load:start', { root })
    }
    const result = await window.electronAPI.project.listDirectory(root, '')
    if (!result.success) {
      setRootError(result.error || t('projectEditor.error.readDirectory'))
      setTree([])
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('root:load:error', { root, error: result.error })
      }
      return
    }
    setTree(buildNodes(result.entries))
    invalidateFileIndex()
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('root:load:done', {
        root,
        entries: result.entries?.length ?? 0,
        duration: Math.round(performance.now() - start)
      })
    }
  }, [t])

  useEffect(() => {
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('root:effect', { isOpen, cwd })
    }
    if (!isOpen) {
      gitDiffOpenRef.current = false
      debugAutoOpenRef.current = false
      restoringStateRef.current = false
      setTree([])
      setSelectedPath(null)
      setActiveFilePath(null)
      setPinnedFiles([])
      setRecentFiles([])
      setDraggingPinnedPath(null)
      setDraggingQuickPath(null)
      setDraggingQuickSource(null)
      setDragOverPinnedPath(null)
      setDragOverRecentPath(null)
      activeFilePathRef.current = null
      setFileContent('')
      fileContentRef.current = ''
      setIsBinary(false)
      isBinaryRef.current = false
      setIsImage(false)
      isImageRef.current = false
      setIsSqlite(false)
      isSqliteRef.current = false
      setImagePreviewUrl(null)
      setIsMarkdownPreviewOpen(true)
      setIsDirty(false)
      originalContentRef.current = ''
      originalModelVersionRef.current = null
      setIsLoadingFile(false)
      setRootPath(null)
      setRootError(null)
      setSearchOpen(false)
      setSidebarMode('files')
      setInitialSearchType('content')
      setSearchQuery('')
      setSearchResults([])
      setSearchActiveIndex(0)
      setContextMenu(null)
      setPreviewSearchOpen(false)
      previewSearchOpenRef.current = false
      setDialog(null)
      setDialogInput('')
      setMarkdownImageMap({})
      rootRef.current = null
      fileIndexRef.current = []
      editorSaveCommandIdRef.current = null
      return
    }

    if (!cwd) {
      setRootError(t('projectEditor.error.noWorkingDirectory'))
      setRootPath(null)
      setPinnedFiles([])
      setRecentFiles([])
      rootRef.current = null
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('root:missing-cwd', { isOpen })
      }
      return
    }

    const normalizedCwd = normalizePath(cwd)
    const previousRoot = rootRef.current ? normalizePath(rootRef.current) : null
    if (previousRoot && previousRoot !== normalizedCwd) {
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('root:changed', { previousRoot, nextRoot: normalizedCwd })
      }
      restoreTokenRef.current += 1
      hasRestoredStateRef.current = false
      restoringStateRef.current = false
      resetActiveFileState()
      setTree([])
      setContextMenu(null)
      setSearchOpen(false)
      setSidebarMode('files')
      setSearchQuery('')
      setSearchResults([])
      setSearchActiveIndex(0)
      fileIndexRef.current = []
    }

    setRootError(null)
    gitDiffOpenRef.current = false
    setRootPath(cwd)
    rootRef.current = cwd
    fileIndexRef.current = []
    setSearchResults([])
    void loadRoot(cwd)
  }, [cwd, isOpen, loadRoot, resetActiveFileState, t])

  useEffect(() => {
    const currentScope = buildProjectEditorScope(_terminalId, cwd ?? rootRef.current ?? null)
    if (!isOpen) {
      if (wasOpenRef.current && lastEditorScopeRef.current) {
        if (skipClosePersistRef.current) {
          skipClosePersistRef.current = false
        } else {
          persistProjectEditorState(lastEditorScopeRef.current)
        }
      }
      lastEditorScopeRef.current = null
      wasOpenRef.current = false
      return
    }

    if (currentScope) {
      const previousScope = lastEditorScopeRef.current
      if (previousScope && !isSameProjectEditorScope(previousScope, currentScope)) {
        persistProjectEditorState(previousScope)
      }
      const scopeChanged = !isSameProjectEditorScope(previousScope, currentScope)
      lastEditorScopeRef.current = currentScope
      if (scopeChanged || !wasOpenRef.current) {
        restoredStateRef.current = getProjectEditorState(currentScope)
        hasRestoredStateRef.current = false
        restoringStateRef.current = false
        fileViewStateRef.current.clear()
        fileFirstVisibleLineRef.current.clear()
        const storedState = restoredStateRef.current
        if (storedState?.activeFilePath && isMarkdownPath(storedState.activeFilePath)) {
          beginPreviewRestore()
        } else {
          resetPreviewRestoreState()
        }
      }
    }
    wasOpenRef.current = true
  }, [beginPreviewRestore, cwd, getProjectEditorState, isOpen, persistProjectEditorState, resetPreviewRestoreState, _terminalId])

  useEffect(() => {
    if (!isOpen) return
    if (restoringStateRef.current) return
    if (!hasRestoredStateRef.current && !activeFilePath && pinnedFiles.length === 0 && recentFiles.length === 0) return
    scheduleProjectStateSave()
  }, [activeFilePath, isOpen, pinnedFiles, recentFiles, rootPath, scheduleProjectStateSave, tree])

  useEffect(() => {
    if (!searchOpen || isIndexing) return
    const results = buildFuzzyResults(searchQuery, fileIndexRef.current)
    setSearchResults(results)
    setSearchActiveIndex(0)
  }, [searchOpen, searchQuery, isIndexing])

  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current || !modalRef.current) return
    const menuRect = contextMenuRef.current.getBoundingClientRect()
    const modalRect = modalRef.current.getBoundingClientRect()
    const padding = 8
    let nextX = contextMenu.x
    let nextY = contextMenu.y
    const maxX = modalRect.width - menuRect.width - padding
    const maxY = modalRect.height - menuRect.height - padding

    if (nextX > maxX) nextX = Math.max(padding, maxX)
    if (nextY > maxY) nextY = Math.max(padding, maxY)
    if (nextX < padding) nextX = padding
    if (nextY < padding) nextY = padding

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev))
    }
  }, [contextMenu])

  const refreshDirectory = useCallback(async (path: string) => {
    const root = rootRef.current
    if (!root) return

    const result = await window.electronAPI.project.listDirectory(root, path)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.readDirectory'))
      return
    }

    const nextChildren = buildNodes(result.entries)

    if (!path) {
      setTree((prev) => mergeChildren(prev, nextChildren))
      return
    }

    setTree((prev) => updateTree(prev, path, (node) => ({
      ...node,
      isExpanded: true,
      isLoading: false,
      children: mergeChildren(node.children, nextChildren)
    })))
  }, [showStatus, t])

  const applyExpandedDirectories = useCallback(async (paths: string[], token: number) => {
    if (paths.length === 0) return
    const unique = Array.from(new Set(paths.filter(Boolean)))
    unique.sort((a, b) => a.split('/').length - b.split('/').length)
    for (const path of unique) {
      if (token !== restoreTokenRef.current) return
      await refreshDirectory(path)
      if (token !== restoreTokenRef.current) return
    }
  }, [refreshDirectory])

  const toggleDirectory = useCallback(async (node: TreeNode) => {
    setSelectedPath(node.path)
    if (node.isExpanded) {
      setTree((prev) => updateTree(prev, node.path, (target) => ({
        ...target,
        isExpanded: false
      })))
      return
    }

    setTree((prev) => updateTree(prev, node.path, (target) => ({
      ...target,
      isExpanded: true,
      isLoading: !target.children
    })))

    if (node.children) return

    const root = rootRef.current
    if (!root) return

    const result = await window.electronAPI.project.listDirectory(root, node.path)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.readDirectory'))
      setTree((prev) => updateTree(prev, node.path, (target) => ({
        ...target,
        isLoading: false
      })))
      return
    }

    setTree((prev) => updateTree(prev, node.path, (target) => ({
      ...target,
      isExpanded: true,
      isLoading: false,
      children: mergeChildren(target.children, buildNodes(result.entries))
    })))
  }, [showStatus, t])

  useEffect(() => {
    if (!isOpen || !rootPath || rootError) return
    if (hasRestoredStateRef.current) return
    if (restoringStateRef.current) return
    if (tree.length === 0) return
    if (window.electronAPI.debug.profile) return
    debugLog('restore:trigger', { rootPath, treeLength: tree.length })

    const terminalStored = restoredStateRef.current
    const stored = resolveStoredProjectEditorState(rootPath, terminalStored, null)
    const restoredPinnedFiles = normalizeQuickFilePaths(stored?.pinnedFiles, MAX_PINNED_FILES)
    const restoredRecentFiles = normalizeQuickFilePaths(stored?.recentFiles, MAX_RECENT_FILES)
    setPinnedFiles(restoredPinnedFiles)
    setRecentFiles(restoredRecentFiles)
    if (rootRef.current && (restoredPinnedFiles.length > 0 || restoredRecentFiles.length > 0)) {
      void validateQuickFileEntries(rootRef.current, {
        pinned: restoredPinnedFiles,
        recent: restoredRecentFiles
      })
    }
    if (!stored) {
      hasRestoredStateRef.current = true
      restoringStateRef.current = false
      return
    }

    // Restore UI layout state (apply immediately after tree loads)
    if (stored.isPreviewOpen !== undefined) {
      setIsMarkdownPreviewOpen(stored.isPreviewOpen)
      isMarkdownPreviewOpenRef.current = stored.isPreviewOpen
    }
    if (stored.isEditorVisible !== undefined) {
      setIsMarkdownEditorVisible(stored.isEditorVisible)
      isMarkdownEditorVisibleRef.current = stored.isEditorVisible
    }
    if (stored.isOutlineVisible !== undefined) {
      setIsOutlineVisible(stored.isOutlineVisible)
      isOutlineVisibleRef.current = stored.isOutlineVisible
    }
    if (stored.outlineTarget !== undefined) {
      setOutlineTarget(stored.outlineTarget)
      outlineTargetRef.current = stored.outlineTarget
    }
    if (typeof stored.fileTreeWidth === 'number') {
      setFileTreeWidth(stored.fileTreeWidth)
      fileTreeWidthRef.current = stored.fileTreeWidth
    }
    if (typeof stored.previewWidth === 'number') {
      setMarkdownPreviewWidth(stored.previewWidth)
      markdownPreviewWidthRef.current = stored.previewWidth
    }
    if (typeof stored.outlineWidth === 'number') {
      setOutlineWidth(stored.outlineWidth)
      outlineWidthRef.current = stored.outlineWidth
    }
    if (typeof stored.modalWidth === 'number' && typeof stored.modalHeight === 'number') {
      const size = { width: stored.modalWidth, height: stored.modalHeight }
      setModalSize(size)
      modalSizeRef.current = size
    }
    // Write persisted scroll positions into memory refs for later application
    const restoreScope = lastEditorScopeRef.current
    if (stored.previewScrollAnchor && stored.activeFilePath) {
      const pKey = getFileScrollKey(restoreScope, stored.activeFilePath)
      if (pKey) {
        previewScrollMemoryRef.current.set(pKey, {
          scrollRatio: stored.previewScrollAnchor.ratio,
          nearestHeadingSlug: stored.previewScrollAnchor.slug,
          headingOffsetY: 0,
          scrollTop: 0
        })
      }
    }
    if (typeof stored.outlineScrollTop === 'number' && stored.activeFilePath) {
      const oKey = getFileScrollKey(restoreScope, stored.activeFilePath)
      if (oKey) outlineScrollTopRef.current.set(oKey, stored.outlineScrollTop)
    }
    if (typeof stored.fileTreeScrollTop === 'number') {
      const tKey = getScrollScopeKey(restoreScope)
      if (tKey) fileTreeScrollTopRef.current.set(tKey, stored.fileTreeScrollTop)
    }

    // The recovery process is only triggered once; subsequent operations are directed by the user to prevent asynchronous recovery from preempting clicks.
    hasRestoredStateRef.current = true
    restoringStateRef.current = true

    const apply = async (token: number) => {
      try {
        await applyExpandedDirectories(stored.expandedDirs ?? [], token)
        if (token !== restoreTokenRef.current) return
        const currentActive = activeFilePathRef.current
        debugLog('restore:apply', {
          storedActive: stored.activeFilePath,
          currentActive,
          expanded: stored.expandedDirs?.length ?? 0,
          storedCursorLine: stored.cursorLine ?? null,
          storedCursorColumn: stored.cursorColumn ?? null
        })
        if (stored.activeFilePath) {
          pendingViewStateRef.current = stored.editorViewState as import('monaco-editor').editor.ICodeEditorViewState | null
          pendingViewStatePathRef.current = stored.activeFilePath
          pendingCursorRef.current = buildPendingCursor(stored.cursorLine, stored.cursorColumn)
          if (typeof stored.cursorLine === 'number' && stored.cursorLine > 1) {
            pendingViewStateFallbackRef.current = {
              path: stored.activeFilePath,
              line: stored.cursorLine
            }
          } else {
            pendingViewStateFallbackRef.current = null
          }
          if (currentActive !== stored.activeFilePath) {
            await openFile(stored.activeFilePath, 'restore')
            if (token !== restoreTokenRef.current) return
          } else {
            applyPendingViewState()
          }
        }
      } finally {
        if (token === restoreTokenRef.current) {
          restoringStateRef.current = false
        }
      }
    }
    const token = restoreTokenRef.current + 1
    restoreTokenRef.current = token
    void apply(token)
  }, [
    activeFilePath,
    applyExpandedDirectories,
    applyPendingViewState,
    isOpen,
    openFile,
    rootError,
    rootPath,
    tree.length,
    validateQuickFileEntries
  ])

  useEffect(() => {
    if (!pendingViewStateRef.current && !pendingCursorRef.current) return
    if (!activeFilePath || activeFilePath !== pendingViewStatePathRef.current) return
    if (isBinary || isImage || isSqlite) {
      pendingViewStateRef.current = null
      pendingViewStatePathRef.current = null
      pendingCursorRef.current = null
      return
    }
    applyPendingViewState()
  }, [activeFilePath, applyPendingViewState, fileContent, isBinary, isImage, isSqlite])

  useEffect(() => {
    if (!DEBUG_PROJECT_EDITOR) return
    if (window.electronAPI.debug.profile) return
    if (window.electronAPI.debug.autotest) return
    if (!isOpen || !rootPath || rootError) return
    if (debugAutoOpenRef.current) return
    if (tree.length === 0) return
    debugAutoOpenRef.current = true
    const run = async () => {
      const targetCount = 5
      let files = collectFirstFilePaths(tree, 20)
      let markdownFiles = files.filter((path) => isMarkdownPath(path))
      if (markdownFiles.length < targetCount) {
        const indexed = await buildFileIndex()
        markdownFiles = indexed.filter((path) => isMarkdownPath(path))
        files = indexed
      }
      const targetFiles = (markdownFiles.length >= targetCount ? markdownFiles : files).slice(0, targetCount)
      debugLog('debug:autoOpen', { targetFiles, markdownCount: markdownFiles.length })
      targetFiles.forEach((file, index) => {
        const delay = index * 150
        window.setTimeout(() => {
          debugLog('debug:autoOpen:open', { file, delay })
          void openFile(file, 'debug')
        }, delay)
      })
    }
    void run()
  }, [buildFileIndex, isOpen, openFile, rootError, rootPath, tree])

  const handleSearchSelect = useCallback(async (path: string) => {
    handleCloseSearch()
    await openFile(path, 'user', { trackRecent: true })
  }, [handleCloseSearch, openFile])

  const handleSearchNavigate = useCallback(async (
    file: string,
    line: number,
    column: number,
    matchLength: number
  ) => {
    // Pass cursorPosition through openFile to avoid race with saved editor state
    await openFile(file, 'user', {
      trackRecent: true,
      cursorPosition: { lineNumber: line, column }
    })
    // Wait for the editor model to be ready before applying highlight decoration
    if (activeFilePathRef.current === file) {
      await waitForEditorModelReady(file)
    }
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.revealLineInCenter(line)
      editor.focus()
      if (matchLength > 0 && monacoRef.current) {
        try {
          const deco = editor.createDecorationsCollection([{
            range: new monacoRef.current.Range(line, column, line, column + matchLength),
            options: {
              className: 'global-search-editor-highlight',
              isWholeLine: false
            }
          }])
          setTimeout(() => deco.clear(), 2000)
        } catch {
          // Decoration is nice-to-have, not critical
        }
      }
    })
  }, [openFile, waitForEditorModelReady])

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSearchActiveIndex((prev) => Math.min(prev + 1, Math.max(searchResults.length - 1, 0)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSearchActiveIndex((prev) => Math.max(prev - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = searchResults[searchActiveIndex]
      if (target) {
        void handleSearchSelect(target)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      handleCloseSearch()
    }
  }, [handleCloseSearch, handleSearchSelect, searchActiveIndex, searchResults])

  const syncPreviewScroll = useCallback(() => {
    if (!previewVisibleRef.current) return
    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return
    const editorScrollTop = editor.getScrollTop()
    const editorScrollHeight = editor.getScrollHeight()
    const editorHeight = editor.getLayoutInfo().height
    const maxEditorScroll = Math.max(1, editorScrollHeight - editorHeight)
    const ratio = editorScrollTop / maxEditorScroll
    const previewMaxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    suppressNextPreviewScrollRef.current = true
    preview.scrollTop = ratio * previewMaxScroll
    updatePreviewActiveSlug(scanPreviewNearestSlug())
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  const schedulePreviewSync = useCallback(() => {
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.previewSync += 1
    }
    if (scrollRafRef.current) {
      window.cancelAnimationFrame(scrollRafRef.current)
    }
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null
      syncPreviewScroll()
    })
  }, [syncPreviewScroll])

  const capturePreviewScrollMemory = useCallback(() => {
    const preview = previewRef.current
    if (!preview) return

    const nearestSlug = scanPreviewNearestSlug()
    updatePreviewActiveSlug(nearestSlug)

    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    if (!key) return

    const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    let headingOffsetY = 0
    if (nearestSlug) {
      try {
        const heading = preview.querySelector(`#${CSS.escape(nearestSlug)}`) as HTMLElement | null
        if (heading) {
          headingOffsetY = heading.getBoundingClientRect().top - preview.getBoundingClientRect().top
        }
      } catch {
        // Ignore invalid CSS escapes from malformed heading ids.
      }
    }

    previewScrollMemoryRef.current.set(key, {
      scrollRatio: preview.scrollTop / maxScroll,
      nearestHeadingSlug: nearestSlug,
      headingOffsetY,
      scrollTop: preview.scrollTop
    })
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  useEffect(() => {
    capturePreviewScrollMemoryRef.current = capturePreviewScrollMemory
  }, [capturePreviewScrollMemory])

  const restorePreviewFromMemory = useCallback((): boolean => {
    const preview = previewRef.current
    if (!preview) return false
    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    if (!key) return false
    const memory = previewScrollMemoryRef.current.get(key)
    if (!memory) return false

    const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    if (memory.nearestHeadingSlug) {
      try {
        const anchor = preview.querySelector(`#${CSS.escape(memory.nearestHeadingSlug)}`) as HTMLElement | null
        if (anchor) {
          const containerRect = preview.getBoundingClientRect()
          const anchorRect = anchor.getBoundingClientRect()
          suppressNextPreviewScrollRef.current = true
          preview.scrollTop = anchorRect.top - containerRect.top + preview.scrollTop - memory.headingOffsetY
          return true
        }
      } catch {
        // Fall back to ratio-based restore.
      }
    }

    suppressNextPreviewScrollRef.current = true
    preview.scrollTop = memory.scrollRatio * maxScroll
    return true
  }, [])

  const handlePreviewScroll = useCallback(() => {
    if (!previewVisibleRef.current) return
    if (suppressNextPreviewScrollRef.current) {
      suppressNextPreviewScrollRef.current = false
      updatePreviewActiveSlug(scanPreviewNearestSlug())
      return
    }
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.previewScroll += 1
    }
    const editor = editorRef.current
    const preview = previewRef.current
    if (!editor || !preview) return
    const previewMaxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
    const ratio = preview.scrollTop / previewMaxScroll
    const editorScrollHeight = editor.getScrollHeight()
    const editorHeight = editor.getLayoutInfo().height
    const maxEditorScroll = Math.max(1, editorScrollHeight - editorHeight)
    suppressNextEditorScrollRef.current = true
    editor.setScrollTop(ratio * maxEditorScroll)
    updatePreviewActiveSlug(scanPreviewNearestSlug())
  }, [scanPreviewNearestSlug, updatePreviewActiveSlug])

  const handleEditorChange = useCallback((value?: string) => {
    if (value === undefined) return
    if (DEBUG_PROJECT_EDITOR) {
      perfCountersRef.current.editorChange += 1
    }
    fileContentRef.current = value
    scheduleMarkdownRender()
    const model = editorRef.current?.getModel()
    if (model && originalModelVersionRef.current !== null) {
      const nextDirty = model.getAlternativeVersionId() !== originalModelVersionRef.current
      if (nextDirty !== dirtyRef.current) {
        setIsDirty(nextDirty)
      }
      return
    }
    if (!dirtyRef.current && value !== originalContentRef.current) {
      setIsDirty(true)
    }
  }, [scheduleMarkdownRender])

  useLayoutEffect(() => {
    if (!isMarkdownRenderAllowed) return
    if (!markdownRenderedHtml) return

    const isRestoreCycle = suppressPreviewSyncOnRestoreRef.current || previewRestorePhaseRef.current !== 'idle'
    if (isRestoreCycle) {
      if (previewRestorePhaseRef.current !== 'restoring-layout') {
        setPreviewRestorePhase('restoring-layout')
      }
      const restored = restorePreviewFromMemory()
      if (!restored) {
        syncPreviewScroll()
      }
      const hasMoreRenderWork =
        markdownRenderPending ||
        markdownWorkerInFlightRef.current ||
        markdownWorkerQueuedRef.current
      suppressPreviewSyncOnRestoreRef.current = hasMoreRenderWork
      if (!hasMoreRenderWork) {
        queuePreviewReveal()
      }
      return
    }

    schedulePreviewSync()
  }, [
    isMarkdownRenderAllowed,
    markdownRenderedHtml,
    markdownRenderPending,
    queuePreviewReveal,
    restorePreviewFromMemory,
    schedulePreviewSync,
    syncPreviewScroll
  ])

  useEffect(() => {
    if (!isMarkdownRenderAllowed) return
    const frame = window.requestAnimationFrame(() => {
      updatePreviewActiveSlug(scanPreviewNearestSlug())
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isMarkdownRenderAllowed, markdownRenderedHtml, scanPreviewNearestSlug, updatePreviewActiveSlug])

  useEffect(() => {
    if (!isMarkdownRenderAllowed) return
    const preview = previewRef.current
    if (!preview) return
    const handleScroll = () => {
      handlePreviewScroll()
      if (!suppressPreviewSyncOnRestoreRef.current) {
        capturePreviewScrollMemory()
      }
    }
    preview.addEventListener('scroll', handleScroll)
    return () => {
      preview.removeEventListener('scroll', handleScroll)
    }
  }, [capturePreviewScrollMemory, handlePreviewScroll, isMarkdownRenderAllowed])

  // File tree scroll position capture
  useEffect(() => {
    const treeEl = fileTreeContainerRef.current
    if (!treeEl || !isOpen) return
    const handler = () => {
      const key = getScrollScopeKey(lastEditorScopeRef.current)
      if (key) fileTreeScrollTopRef.current.set(key, treeEl.scrollTop)
    }
    treeEl.addEventListener('scroll', handler, { passive: true })
    return () => treeEl.removeEventListener('scroll', handler)
  }, [isOpen, tree.length])

  // Outline scroll position capture callback
  const handleOutlineScrollCapture = useCallback((scrollTop: number) => {
    const key = getFileScrollKey(lastEditorScopeRef.current, activeFilePathRef.current)
    if (key) outlineScrollTopRef.current.set(key, scrollTop)
  }, [])

  useEffect(() => {
    if (!DEBUG_PROJECT_EDITOR) return
    if (perfIntervalRef.current) return
    perfIntervalRef.current = window.setInterval(() => {
      const snapshot = { ...perfCountersRef.current }
      perfCountersRef.current.renders = 0
      perfCountersRef.current.editorChange = 0
      perfCountersRef.current.editorScroll = 0
      perfCountersRef.current.editorCursor = 0
      perfCountersRef.current.previewScroll = 0
      perfCountersRef.current.previewSync = 0
      perfCountersRef.current.scheduleRender = 0
      perfCountersRef.current.workerSend = 0
      perfCountersRef.current.workerApply = 0
      perfCountersRef.current.projectStateSave = 0
      const hasActivity = Object.values(snapshot).some(count => count > 0)
      if (hasActivity) {
        debugLog('perf:1s', {
          ...snapshot,
          activeFilePath: activeFilePathRef.current,
          renderAllowed: markdownRenderAllowedRef.current,
          renderPending: markdownRenderPendingRef.current,
          workerInFlight: markdownWorkerInFlightRef.current
        })
      }
    }, 1000)
    return () => {
      if (perfIntervalRef.current) {
        window.clearInterval(perfIntervalRef.current)
        perfIntervalRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const filePath = activeFilePath
    if (!root || !filePath || isBinary || isImage || isSqlite) return

    void window.electronAPI.project.watchFile(root, filePath)

    const unsubscribe = window.electronAPI.project.onFileChanged((fullPath, changeType, content) => {
      const currentPath = activeFilePathRef.current
      const currentRoot = rootRef.current
      if (!currentPath || !currentRoot) return

      const separator = currentRoot.includes('\\') ? '\\' : '/'
      const expectedPath = currentRoot.endsWith(separator)
        ? `${currentRoot}${currentPath}`
        : `${currentRoot}${separator}${currentPath}`
      const normalizeFullPath = (value: string) => value.replace(/[\\/]/g, '/')
      if (normalizeFullPath(fullPath) !== normalizeFullPath(expectedPath)) return

      if (changeType === 'changed' && content !== undefined) {
        if (content === fileContentRef.current) return

        const editor = editorRef.current
        const model = editor?.getModel()
        const cursorPosition = editor?.getPosition() ?? null
        const scrollTop = editor?.getScrollTop() ?? 0
        const scrollLeft = editor?.getScrollLeft() ?? 0

        if (model && editor) {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: content }],
            () => (cursorPosition ? [
              {
                range: {
                  startLineNumber: cursorPosition.lineNumber,
                  startColumn: cursorPosition.column,
                  endLineNumber: cursorPosition.lineNumber,
                  endColumn: cursorPosition.column
                }
              }
            ] as unknown as import('monaco-editor').Selection[] : [])
          )
        }

        setFileContent(content)
        fileContentRef.current = content
        originalContentRef.current = content
        originalModelVersionRef.current = null
        setIsDirty(false)
        syncOriginalVersion()

        if (cursorPosition && editor && model) {
          const lineCount = model.getLineCount()
          const safeLine = Math.min(cursorPosition.lineNumber, lineCount)
          const maxColumn = model.getLineMaxColumn(safeLine)
          const safeColumn = Math.min(cursorPosition.column, maxColumn)
          editor.setPosition({ lineNumber: safeLine, column: safeColumn })
        }
        if (editor) {
          editor.setScrollTop(scrollTop)
          editor.setScrollLeft(scrollLeft)
        }

        scheduleMarkdownRender()
        return
      }

      if (changeType === 'deleted') {
        showStatus('error', t('projectEditor.fileDeletedExternally'))
      }
    })

    return () => {
      unsubscribe()
      void window.electronAPI.project.unwatchFile(root, filePath)
    }
  }, [activeFilePath, isBinary, isImage, isSqlite, scheduleMarkdownRender, showStatus, syncOriginalVersion, t])

  const handleSave = useCallback(async (source: SaveSource = 'toolbar') => {
    const targetPath = activeFilePathRef.current
    const root = rootRef.current
    const binary = isBinaryRef.current
    const image = isImageRef.current
    const sqlite = isSqliteRef.current
    if (!targetPath || !root || binary || image || sqlite) {
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('save:skip', { source, targetPath, hasRoot: Boolean(root), binary, image, sqlite })
      }
      return null
    }
    const content = fileContentRef.current
    const result = await window.electronAPI.project.saveFile(root, targetPath, content)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.save'))
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('save:failed', { source, path: targetPath, error: result.error })
      }
      return result
    }
    originalContentRef.current = content
    syncOriginalVersion()
    setIsDirty(false)
    showStatus('success', t('projectEditor.saved'))
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('save:success', { source, path: targetPath, bytes: content.length })
    }
    if (_terminalId) {
      void window.electronAPI.git.notifyTerminalGitUpdate(_terminalId)
    }
    return result
  }, [_terminalId, showStatus, syncOriginalVersion, t])

  const handleSaveRef = useRef(handleSave)
  useEffect(() => {
    handleSaveRef.current = handleSave
  }, [handleSave])

  const handleRequestClose = useCallback(async () => {
    const canClose = await confirmDiscardChanges()
    if (!canClose) return
    // Capture all scroll positions before final persist
    const scope = lastEditorScopeRef.current
    if (scope) {
      const treeEl = fileTreeContainerRef.current
      const treeKey = getScrollScopeKey(scope)
      if (treeEl && treeKey) {
        fileTreeScrollTopRef.current.set(treeKey, treeEl.scrollTop)
      }
      capturePreviewScrollMemory()
      persistProjectEditorState(scope)
    }
    skipClosePersistRef.current = true
    resetActiveFileState()
    onClose()
  }, [capturePreviewScrollMemory, confirmDiscardChanges, onClose, persistProjectEditorState, resetActiveFileState])

  const handleEscape = useCallback(() => {
    if (dialog) {
      handleDialogCancel()
      return
    }
    if (searchOpen) {
      handleCloseSearch()
      return
    }
    if (previewSearchOpen) {
      setPreviewSearchOpen(false)
      return
    }
    if (sidebarMode === 'search') {
      setSidebarMode('files')
      return
    }
    void handleRequestClose()
  }, [dialog, handleDialogCancel, searchOpen, handleCloseSearch, previewSearchOpen, handleRequestClose, sidebarMode])

  const handleOpenGitDiff = useCallback(async (source: 'user' | 'debug' = 'user') => {
    if (!_terminalId) return
    if (gitDiffOpenRef.current) {
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('gitdiff:open:ignored', { source, terminalId: _terminalId })
      }
      return
    }
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('gitdiff:open:start', {
        source,
        terminalId: _terminalId,
        activeFilePath,
        isDirty: dirtyRef.current,
        isMarkdownRenderAllowed,
        markdownRenderPending,
        isIndexing
      })
    }
    const canClose = source === 'debug' || window.electronAPI.debug.profile ? true : await confirmDiscardChanges()
    if (!canClose) return
    if (lastEditorScopeRef.current) {
      persistProjectEditorState(lastEditorScopeRef.current)
    }
    skipClosePersistRef.current = true
    gitDiffOpenRef.current = true
    if (DEBUG_PROJECT_EDITOR) {
      debugLog('gitdiff:open:before-reset', {
        activeFilePath,
        hasWorker: Boolean(markdownWorkerRef.current),
        workerInFlight: markdownWorkerInFlightRef.current,
        hasRenderTimer: Boolean(markdownRenderTimerRef.current),
        hasIdleTask: markdownIdleHandleRef.current !== null
      })
    }
    resetActiveFileState()
    onClose()
    const terminalId = _terminalId
    window.setTimeout(() => {
      if (DEBUG_PROJECT_EDITOR) {
        debugLog('gitdiff:open:dispatch', { terminalId })
      }
      window.dispatchEvent(new CustomEvent('git-diff:open', { detail: { terminalId } }))
    }, 0)
  }, [
    _terminalId,
    activeFilePath,
    capturePreviewScrollMemory,
    confirmDiscardChanges,
    isIndexing,
    isMarkdownRenderAllowed,
    markdownRenderPending,
    onClose,
    persistProjectEditorState,
    resetActiveFileState
  ])

  useEffect(() => {
    openGitDiffRef.current = handleOpenGitDiff
  }, [handleOpenGitDiff])

  useEffect(() => {
    if (!window.electronAPI?.debug?.enabled) return

    const debugWindow = window as Window & { __onwardProjectEditorDebug?: ProjectEditorDebugApi }
    const api: ProjectEditorDebugApi = {
      isOpen: () => isOpenRef.current,
      getRootPath: () => rootRef.current,
      getActiveFilePath: () => activeFilePathRef.current,
      getEditorContent: () => fileContentRef.current,
      setEditorContent: (content: string) => {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || !model) return false
        editor.pushUndoStop()
        editor.executeEdits('debug-set-editor-content', [{ range: model.getFullModelRange(), text: content }])
        editor.pushUndoStop()
        return true
      },
      getEditorLineCount: () => {
        const model = editorRef.current?.getModel()
        return model ? model.getLineCount() : 0
      },
      isSqliteViewerVisible: () => {
        return Boolean(activeFilePathRef.current && isSqliteRef.current)
      },
      getImageFilePreviewState,
      isMarkdownEditorVisible: () => isMarkdownEditorVisibleRef.current,
      setMarkdownEditorVisible: (visible: boolean) => {
        setIsMarkdownEditorVisible(visible)
        isMarkdownEditorVisibleRef.current = visible
        localStorage.setItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE, String(visible))
        if (!visible && !isMarkdownPreviewOpenRef.current) {
          setIsMarkdownPreviewOpen(true)
          isMarkdownPreviewOpenRef.current = true
          setIsMarkdownRenderEnabled(true)
        }
      },
      isMarkdownPreviewVisible: () => previewVisibleRef.current,
      setPreviewSearchOpen: (open: boolean) => {
        setPreviewSearchOpen(open)
        previewSearchOpenRef.current = open
      },
      isPreviewSearchOpen: () => previewSearchOpenRef.current,
      isMarkdownRenderPending: () => markdownRenderPendingRef.current,
      getMarkdownRenderedHtml: () => markdownRenderedHtmlRef.current,
      getMarkdownPreviewImageState: () => {
        const preview = previewRef.current
        if (!preview) {
          return {
            count: 0,
            loadedCount: 0,
            brokenCount: 0,
            sources: []
          }
        }
        const images = Array.from(preview.querySelectorAll('img')) as HTMLImageElement[]
        return {
          count: images.length,
          loadedCount: images.filter((image) => image.complete && image.naturalWidth > 0).length,
          brokenCount: images.filter((image) => image.complete && image.naturalWidth === 0).length,
          sources: images.map((image) => image.currentSrc || image.src || '')
        }
      },
      isPreviewTransitioning: () => previewRestorePhaseRef.current !== 'idle',
      isPreviewContentVisible: () => isPreviewContentVisibleNow(),
      getPreviewRestorePhase: () => previewRestorePhaseRef.current,
      getOutlineTarget: () => outlineTargetRef.current,
      setOutlineTarget: (target: 'editor' | 'preview') => {
        setOutlineTarget(target)
        outlineTargetRef.current = target
        localStorage.setItem(STORAGE_KEY_OUTLINE_TARGET, target)
      },
      isOutlineVisible: () => outlineShowInSplitRef.current,
      getOutlineSymbolCount: () => countSymbols(outlineSymbolsRef.current),
      getOutlineActiveItemName: () => outlineActiveItemRef.current?.name ?? null,
      getPreviewActiveSlug: () => previewActiveSlugRef.current,
      scrollPreviewToFraction: (fraction: number) => {
        const preview = previewRef.current
        if (!preview) return false
        const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
        preview.scrollTop = fraction * maxScroll
        capturePreviewScrollMemory()
        updatePreviewActiveSlug(scanPreviewNearestSlug())
        return true
      },
      getPreviewScrollTop: () => previewRef.current?.scrollTop ?? 0,
      getPreviewScrollHeight: () => previewRef.current?.scrollHeight ?? 0,
      debugScanPreviewHeadings: () => ({ nearest: scanPreviewNearestSlug() }),
      runPreviewPositionTest: async (mdFilePath: string, otherFilePath: string) => {
        const sleep = (ms: number) => new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms)
        })
        const waitRender = async (timeoutMs = 8000) => {
          const startedAt = Date.now()
          while (Date.now() - startedAt < timeoutMs) {
            if (!markdownRenderPendingRef.current && markdownRenderedHtmlRef.current) {
              break
            }
            await sleep(100)
          }
          await sleep(500)
        }

        await openFileRef.current(mdFilePath, 'debug')
        await waitRender()

        const preview = previewRef.current
        if (!preview) return false

        const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
        preview.scrollTop = Math.round(maxScroll * 0.5)
        await sleep(300)
        const savedPosition = preview.scrollTop

        await openFileRef.current(otherFilePath, 'debug')
        await sleep(1500)
        await openFileRef.current(mdFilePath, 'debug')
        await waitRender()

        const restoredPosition = preview.scrollTop
        return Math.abs(restoredPosition - savedPosition) <= 30
      },
      openFileByPath: async (filePath: string) => {
        await openFileRef.current(filePath, 'debug')
      },
      triggerEditorSaveCommand: () => {
        const editor = editorRef.current
        const commandId = editorSaveCommandIdRef.current
        if (!editor || !commandId) return false
        editor.trigger('autotest', commandId, undefined)
        return true
      },
      triggerToolbarSave: async () => {
        const result = await handleSaveRef.current('debug-toolbar')
        return Boolean(result?.success)
      },
      getCursorPosition: () => {
        const position = editorRef.current?.getPosition()
        if (!position) return null
        return {
          lineNumber: position.lineNumber,
          column: position.column
        }
      },
      setCursorPosition: (lineNumber: number, column = 1) => {
        const editor = editorRef.current
        if (!editor) return false
        const model = editor.getModel()
        if (!model) return false
        if (!activeFilePathRef.current) return false
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(lineNumber)))
        const maxColumn = model.getLineMaxColumn(safeLine)
        const safeColumn = Math.max(1, Math.min(maxColumn, Math.floor(column)))
        editor.setPosition({ lineNumber: safeLine, column: safeColumn })
        editor.revealLineInCenter(safeLine)
        scheduleProjectStateSave()
        return true
      },
      getScrollTop: () => {
        const editor = editorRef.current
        if (!editor) return 0
        return editor.getScrollTop()
      },
      getFirstVisibleLine: () => {
        const editor = editorRef.current
        if (!editor) return 1
        const ranges = editor.getVisibleRanges()
        if (!ranges || ranges.length === 0) return 1
        return ranges[0]?.startLineNumber ?? 1
      },
      scrollToLine: (lineNumber: number) => {
        const editor = editorRef.current
        if (!editor) return false
        const model = editor.getModel()
        if (!model) return false
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(lineNumber)))
        editor.revealLineNearTop(safeLine)
        editor.setScrollTop(editor.getTopForLineNumber(safeLine))
        scheduleProjectStateSave()
        return true
      },
      getMissingFileNotice: () => {
        const current = missingFileNoticeRef.current
        if (!current) return null
        return {
          path: current.path,
          message: current.message
        }
      }
    }

    debugWindow.__onwardProjectEditorDebug = api
    return () => {
      if (debugWindow.__onwardProjectEditorDebug === api) {
        delete debugWindow.__onwardProjectEditorDebug
      }
    }
  }, [
    capturePreviewScrollMemory,
    getImageFilePreviewState,
    isPreviewContentVisibleNow,
    scanPreviewNearestSlug,
    scheduleProjectStateSave,
    updatePreviewActiveSlug
  ])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    const debugWindow = window as Window & { __onwardProjectEditorDebug?: ProjectEditorDebugApi }
    const api: ProjectEditorDebugApi = {
      isOpen: () => isOpenRef.current,
      getRootPath: () => rootRef.current,
      getActiveFilePath: () => activeFilePathRef.current,
      getEditorContent: () => fileContentRef.current,
      setEditorContent: (content: string) => {
        const editor = editorRef.current
        const model = editor?.getModel()
        if (!editor || !model) return false
        editor.pushUndoStop()
        editor.executeEdits('autotest-set-editor-content', [{ range: model.getFullModelRange(), text: content }])
        editor.pushUndoStop()
        return true
      },
      getEditorLineCount: () => {
        const model = editorRef.current?.getModel()
        return model ? model.getLineCount() : 0
      },
      getCursorPosition: () => {
        const position = editorRef.current?.getPosition()
        if (!position) return null
        return {
          lineNumber: position.lineNumber,
          column: position.column
        }
      },
      setCursorPosition: (lineNumber: number, column = 1) => {
        const editor = editorRef.current
        if (!editor) return false
        const model = editor.getModel()
        if (!model) return false
        if (!activeFilePathRef.current) return false
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(lineNumber)))
        const maxColumn = model.getLineMaxColumn(safeLine)
        const safeColumn = Math.max(1, Math.min(maxColumn, Math.floor(column)))
        editor.setPosition({ lineNumber: safeLine, column: safeColumn })
        editor.revealLineInCenter(safeLine)
        scheduleProjectStateSave()
        return true
      },
      getScrollTop: () => {
        const editor = editorRef.current
        if (!editor) return 0
        return editor.getScrollTop()
      },
      getFirstVisibleLine: () => {
        const editor = editorRef.current
        if (!editor) return 1
        const ranges = editor.getVisibleRanges()
        if (!ranges || ranges.length === 0) return 1
        return ranges[0]?.startLineNumber ?? 1
      },
      scrollToLine: (lineNumber: number) => {
        const editor = editorRef.current
        if (!editor) return false
        const model = editor.getModel()
        if (!model) return false
        const maxLine = model.getLineCount()
        const safeLine = Math.max(1, Math.min(maxLine, Math.floor(lineNumber)))
        editor.revealLineNearTop(safeLine)
        editor.setScrollTop(editor.getTopForLineNumber(safeLine))
        scheduleProjectStateSave()
        return true
      },
      getMissingFileNotice: () => {
        const current = missingFileNoticeRef.current
        if (!current) return null
        return {
          path: current.path,
          message: current.message
        }
      },
      openFileByPath: async (filePath: string) => {
        await openFileRef.current(filePath, 'debug')
      },
      triggerEditorSaveCommand: () => {
        const editor = editorRef.current
        const commandId = editorSaveCommandIdRef.current
        if (!editor || !commandId) return false
        editor.trigger('autotest', commandId, undefined)
        return true
      },
      triggerToolbarSave: async () => {
        const result = await handleSaveRef.current('debug-toolbar')
        return Boolean(result?.success)
      },
      isSqliteViewerVisible: () => {
        return Boolean(activeFilePathRef.current && isSqliteRef.current)
      },
      getImageFilePreviewState,
      isMarkdownEditorVisible: () => isMarkdownEditorVisibleRef.current,
      setMarkdownEditorVisible: (visible: boolean) => {
        setIsMarkdownEditorVisible(visible)
        isMarkdownEditorVisibleRef.current = visible
        localStorage.setItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE, String(visible))
        if (!visible && !isMarkdownPreviewOpenRef.current) {
          setIsMarkdownPreviewOpen(true)
          isMarkdownPreviewOpenRef.current = true
          setIsMarkdownRenderEnabled(true)
        }
      },
      isMarkdownPreviewVisible: () => previewVisibleRef.current,
      setPreviewSearchOpen: (open: boolean) => {
        setPreviewSearchOpen(open)
        previewSearchOpenRef.current = open
      },
      isPreviewSearchOpen: () => previewSearchOpenRef.current,
      isMarkdownRenderPending: () => markdownRenderPendingRef.current,
      getMarkdownRenderedHtml: () => markdownRenderedHtmlRef.current,
      getMarkdownPreviewImageState: () => {
        const preview = previewRef.current
        if (!preview) {
          return {
            count: 0,
            loadedCount: 0,
            brokenCount: 0,
            sources: []
          }
        }
        const images = Array.from(preview.querySelectorAll('img')) as HTMLImageElement[]
        return {
          count: images.length,
          loadedCount: images.filter((image) => image.complete && image.naturalWidth > 0).length,
          brokenCount: images.filter((image) => image.complete && image.naturalWidth === 0).length,
          sources: images.map((image) => image.currentSrc || image.src || '')
        }
      },
      isPreviewTransitioning: () => previewRestorePhaseRef.current !== 'idle',
      isPreviewContentVisible: () => isPreviewContentVisibleNow(),
      getPreviewRestorePhase: () => previewRestorePhaseRef.current,
      getOutlineTarget: () => outlineTargetRef.current,
      setOutlineTarget: (target: 'editor' | 'preview') => {
        setOutlineTarget(target)
        outlineTargetRef.current = target
        localStorage.setItem(STORAGE_KEY_OUTLINE_TARGET, target)
      },
      isOutlineVisible: () => outlineShowInSplitRef.current,
      getOutlineSymbolCount: () => countSymbols(outlineSymbolsRef.current),
      getOutlineActiveItemName: () => outlineActiveItemRef.current?.name ?? null,
      getPreviewActiveSlug: () => previewActiveSlugRef.current,
      scrollPreviewToFraction: (fraction: number) => {
        const preview = previewRef.current
        if (!preview) return false
        const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
        preview.scrollTop = fraction * maxScroll
        capturePreviewScrollMemory()
        updatePreviewActiveSlug(scanPreviewNearestSlug())
        return true
      },
      getPreviewScrollTop: () => previewRef.current?.scrollTop ?? 0,
      getPreviewScrollHeight: () => previewRef.current?.scrollHeight ?? 0,
      debugScanPreviewHeadings: () => ({ nearest: scanPreviewNearestSlug() }),
      runPreviewPositionTest: async (mdFilePath: string, otherFilePath: string) => {
        const sleep = (ms: number) => new Promise<void>((resolve) => {
          window.setTimeout(resolve, ms)
        })
        const waitRender = async (timeoutMs = 8000) => {
          const startedAt = Date.now()
          while (Date.now() - startedAt < timeoutMs) {
            if (!markdownRenderPendingRef.current && markdownRenderedHtmlRef.current) {
              break
            }
            await sleep(100)
          }
          await sleep(500)
        }

        await openFileRef.current(mdFilePath, 'debug')
        await waitRender()

        const preview = previewRef.current
        if (!preview) return false

        const maxScroll = Math.max(1, preview.scrollHeight - preview.clientHeight)
        preview.scrollTop = Math.round(maxScroll * 0.5)
        await sleep(300)
        const savedPosition = preview.scrollTop

        await openFileRef.current(otherFilePath, 'debug')
        await sleep(1500)
        await openFileRef.current(mdFilePath, 'debug')
        await waitRender()

        const restoredPosition = preview.scrollTop
        return Math.abs(restoredPosition - savedPosition) <= 30
      }
    }
    debugWindow.__onwardProjectEditorDebug = api
    return () => {
      if (debugWindow.__onwardProjectEditorDebug === api) {
        delete debugWindow.__onwardProjectEditorDebug
      }
    }
  }, [
    capturePreviewScrollMemory,
    getImageFilePreviewState,
    isPreviewContentVisibleNow,
    scanPreviewNearestSlug,
    scheduleProjectStateSave,
    updatePreviewActiveSlug
  ])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    if (!isOpen || !rootPath || rootError) return
    if (tree.length === 0) return
    if (autotestRunRef.current) return
    autotestRunRef.current = true

    const log = (message: string, data?: unknown) => {
      const prefix = '[AutoTest]'
      console.log(prefix, message, data ?? '')
      window.electronAPI.debug.log(`${prefix} ${message}`, data)
    }

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms)
    })

    const waitFor = async (
      label: string,
      predicate: () => boolean,
      timeoutMs = 6000,
      intervalMs = 80
    ) => {
      const start = performance.now()
      while (performance.now() - start < timeoutMs) {
        if (predicate()) return true
        await sleep(intervalMs)
      }
      log('timeout', { label, timeoutMs })
      return false
    }

    const reopenProjectEditorFn = async (label: string) => {
      if (!_terminalId) return false
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: _terminalId } }))
      const opened = await waitFor(
        `project-editor-open:${label}`,
        () => isOpenRef.current && Boolean(rootRef.current),
        8000
      )
      if (!opened) {
        log('project-editor-open-timeout', { label })
      }
      await sleep(400)
      return opened
    }

    const ensureProjectEditorRoot = async (label: string) => {
      if (rootRef.current) return true
      const reopened = await reopenProjectEditorFn(`ensure-root:${label}`)
      if (!reopened) return false
      return Boolean(rootRef.current)
    }

    let _cancelled = false
    let cpuTimer: number | null = null
    const cpuSummary: CpuSummary = {
      samples: 0, totalAvg: 0, totalMax: 0,
      rendererAvg: 0, rendererMax: 0, browserAvg: 0, browserMax: 0
    }

    const startCpuSampler = () => {
      cpuTimer = window.setInterval(async () => {
        try {
          const metrics = await window.electronAPI.debug.getAppMetrics()
          if (!Array.isArray(metrics)) return
          let total = 0, renderer = 0, browser = 0
          metrics.forEach((metric) => {
            const anyMetric = metric as Record<string, unknown>
            const cpu = (anyMetric.cpu as { percentCPUUsage?: number } | undefined)?.percentCPUUsage ?? 0
            total += cpu
            const type = String(anyMetric.type ?? '')
            if (type.toLowerCase() === 'renderer') renderer += cpu
            if (type.toLowerCase() === 'browser') browser += cpu
          })
          cpuSummary.samples += 1
          cpuSummary.totalAvg += total
          cpuSummary.rendererAvg += renderer
          cpuSummary.browserAvg += browser
          cpuSummary.totalMax = Math.max(cpuSummary.totalMax, total)
          cpuSummary.rendererMax = Math.max(cpuSummary.rendererMax, renderer)
          cpuSummary.browserMax = Math.max(cpuSummary.browserMax, browser)
        } catch {
          // ignore sampling errors
        }
      }, 1000)
    }

    const stopCpuSampler = (): CpuSummary => {
      if (cpuTimer) {
        window.clearInterval(cpuTimer)
        cpuTimer = null
      }
      if (cpuSummary.samples > 0) {
        cpuSummary.totalAvg = Math.round(cpuSummary.totalAvg / cpuSummary.samples)
        cpuSummary.rendererAvg = Math.round(cpuSummary.rendererAvg / cpuSummary.samples)
        cpuSummary.browserAvg = Math.round(cpuSummary.browserAvg / cpuSummary.samples)
      }
      const result = { ...cpuSummary }
      // Reset for next sampling
      cpuSummary.samples = 0
      cpuSummary.totalAvg = 0
      cpuSummary.totalMax = 0
      cpuSummary.rendererAvg = 0
      cpuSummary.rendererMax = 0
      cpuSummary.browserAvg = 0
      cpuSummary.browserMax = 0
      return result
    }

    const allTestResults: TestResult[] = []
    const assertFn = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
      allTestResults.push({ name, ok, detail })
      log(ok ? 'PASS' : 'FAIL', { test: name, ...detail })
    }

    const ctx: AutotestContext = {
      terminalId: _terminalId!,
      rootPath,
      log,
      sleep,
      waitFor,
      assert: assertFn,
      startCpuSampler,
      stopCpuSampler,
      cancelled: () => _cancelled,
      openFileInEditor: async (filePath: string) => {
        const ready = await ensureProjectEditorRoot(`open-file:${filePath}`)
        if (!ready) {
          log('open-file-skip-missing-root', { filePath })
          return
        }
        await openFileRef.current(filePath, 'debug')
      },
      reopenProjectEditor: reopenProjectEditorFn,
      buildFileIndex,
      isOpenRef,
      rootRef
    }

    const run = async () => {
      try {
        await runAllTests(ctx)

        log('cpu-summary', stopCpuSampler())
        log('done')

        if (window.electronAPI.debug.autotestExit) {
          await sleep(600)
          await window.electronAPI.debug.quit()
        }
      } catch (error) {
        stopCpuSampler()
        log('error', { error: String(error) })
        if (window.electronAPI.debug.autotestExit) {
          await sleep(600)
          await window.electronAPI.debug.quit()
        }
      }
    }

    void run()

    return () => {
      // Note: autotest needs to survive the ProjectEditor on/off cycle
      // Do not set _cancelled = true because autotestRunRef already prevents repeated runs
      // Stop CPU sampling only when component is completely unloaded
    }
  }, [buildFileIndex, isOpen, rootError, rootPath, tree.length, _terminalId])

  useEffect(() => {
    if (!window.electronAPI.debug.profile) return
    if (window.electronAPI.debug.autotest) return
    if (!isOpen || !rootPath || rootError) return
    if (tree.length === 0) return
    if (profileRunRef.current) return
    profileRunRef.current = true
    debugLog('profile:begin', { rootPath, treeLength: tree.length })

    let cancelled = false
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms)
    })

    const run = async () => {
      try {
        const indexed = await buildFileIndex()
        const markdownFiles = indexed.filter((path) => isMarkdownPath(path))
        const targets = (markdownFiles.length > 0 ? markdownFiles : indexed).slice(0, 8)
        debugLog('profile:targets', {
          total: indexed.length,
          markdown: markdownFiles.length,
          targets
        })
        const block = `\n\n## Profiling Update\n\n` +
          `- Time: ${new Date().toISOString()}\n` +
          `- Note: render stress test\n` +
          `- List: ${'- test item\n'.repeat(12)}`
        const heavyBlock = `\n\n## Profiling Heavy Update\n\n` +
          `- Time: ${new Date().toISOString()}\n` +
          `- Note: heavy render load\n` +
          `${'- reload item\n'.repeat(120)}`

        for (const [index, file] of targets.entries()) {
          if (cancelled) return
          debugLog('profile:open', { index, file })
          await openFileRef.current(file, 'debug')
          await sleep(160)

          const editor = editorRef.current
          const model = editor?.getModel()
          if (editor && model) {
            const isLast = index === targets.length - 1
            const iterations = isLast ? 6 : 2
            const payload = isLast ? heavyBlock : block
            for (let i = 0; i < iterations; i += 1) {
              if (cancelled) return
              const line = model.getLineCount()
              const column = model.getLineMaxColumn(line)
              editor.executeEdits('profile', [{
                range: {
                  startLineNumber: line,
                  startColumn: column,
                  endLineNumber: line,
                  endColumn: column
                },
                text: payload
              }])
              editor.setScrollTop(editor.getScrollHeight())
              await sleep(isLast ? 40 : 120)
            }
          }

          await sleep(180)
        }

        if (openGitDiffRef.current) {
          debugLog('profile:gitdiff', {
            terminalId: _terminalId,
            renderPending: markdownRenderPendingRef.current,
            workerInFlight: markdownWorkerInFlightRef.current
          })
          await openGitDiffRef.current('debug')
          window.setTimeout(() => {
            debugLog('profile:gitdiff:close', { terminalId: _terminalId })
            window.dispatchEvent(new CustomEvent('git-diff:close', { detail: { terminalId: _terminalId } }))
          }, 2200)
          window.setTimeout(() => {
            debugLog('profile:project-editor:reopen', { terminalId: _terminalId })
            window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId: _terminalId } }))
          }, 2800)
        }
      } catch (error) {
        debugLog('profile:error', { error: String(error) })
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [buildFileIndex, isOpen, rootError, rootPath, _terminalId, tree.length])

  const openContextMenu = useCallback((
    event: React.MouseEvent,
    options?: {
      path: string | null
      type: 'file' | 'dir' | null
      source?: 'tree' | 'quick-recent' | 'quick-pin'
      select?: boolean
    }
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = modalRef.current?.getBoundingClientRect()
    if (!rect) return
    setContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      targetPath: options?.path ?? null,
      targetType: options?.type ?? null,
      source: options?.source ?? 'tree'
    })
    if (options?.select && options.path) {
      setSelectedPath(options.path)
    }
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (dialog) return
      if (searchOpen) return

      // Cmd/Ctrl+Shift+F — global content search (sidebar)
      const isGlobalSearch = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f'
      if (isGlobalSearch) {
        event.preventDefault()
        event.stopPropagation()
        setContextMenu(null)
        setInitialSearchType('content')
        setSidebarMode('search')
        setTimeout(() => globalSearchInputRef.current?.focus(), 0)
        return
      }

      const isSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p'
      if (isSearch) {
        event.preventDefault()
        void handleOpenSearch()
        return
      }

      const isPreviewSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f'
      if (isPreviewSearch) {
        const target = event.target as HTMLElement | null
        const inEditor = Boolean(target?.closest('.monaco-editor'))
        if (!inEditor && isMarkdownPreviewVisible) {
          event.preventDefault()
          setPreviewSearchOpen(true)
        }
        return
      }

      const isSave = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's'
      if (isSave) {
        const target = event.target as HTMLElement | null
        const inEditor = !!target?.closest('.monaco-editor')
        if (inEditor) return
        event.preventDefault()
        void handleSaveRef.current('global-shortcut')
        return
      }

    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [dialog, handleOpenSearch, isMarkdownPreviewVisible, isOpen, searchOpen])

  useSubpageEscape({ isOpen, onEscape: handleEscape })

  const notifySqliteMutation = useCallback(() => {
    if (!_terminalId) return
    void window.electronAPI.git.notifyTerminalGitUpdate(_terminalId)
  }, [_terminalId])

  const handleNewFile = useCallback(async (baseDirOverride?: string) => {
    const root = rootRef.current
    if (!root) return

    const baseDir = baseDirOverride ?? (selectedPath
      ? (findNode(tree, selectedPath)?.type === 'dir'
        ? selectedPath
        : getParentPath(selectedPath))
      : '')

    const name = await requestPrompt({
      title: t('projectEditor.dialog.newFile.title'),
      message: t('projectEditor.dialog.newFile.message'),
      placeholder: t('projectEditor.dialog.newFile.placeholder')
    })

    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      showStatus('error', t('projectEditor.error.fileNameHasSeparator'))
      return
    }

    const targetPath = joinPath(baseDir, name)
    const result = await window.electronAPI.project.createFile(root, targetPath, '')
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.createFile'))
      return
    }

    await refreshDirectory(baseDir)
    invalidateFileIndex()
    await openFile(targetPath, 'user', { trackRecent: true })
    showStatus('success', t('projectEditor.fileCreated'))
  }, [invalidateFileIndex, openFile, refreshDirectory, requestPrompt, selectedPath, showStatus, t, tree])

  const handleNewFolder = useCallback(async (baseDirOverride?: string) => {
    const root = rootRef.current
    if (!root) return

    const baseDir = baseDirOverride ?? (selectedPath
      ? (findNode(tree, selectedPath)?.type === 'dir'
        ? selectedPath
        : getParentPath(selectedPath))
      : '')

    const name = await requestPrompt({
      title: t('projectEditor.dialog.newFolder.title'),
      message: t('projectEditor.dialog.newFolder.message'),
      placeholder: t('projectEditor.dialog.newFolder.placeholder')
    })

    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      showStatus('error', t('projectEditor.error.folderNameHasSeparator'))
      return
    }

    const targetPath = joinPath(baseDir, name)
    const result = await window.electronAPI.project.createFolder(root, targetPath)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.createFolder'))
      return
    }

    await refreshDirectory(baseDir)
    invalidateFileIndex()
    showStatus('success', t('projectEditor.folderCreated'))
  }, [invalidateFileIndex, refreshDirectory, requestPrompt, selectedPath, showStatus, t, tree])

  const handleRename = useCallback(async (targetPathOverride?: string) => {
    const root = rootRef.current
    const sourcePath = targetPathOverride ?? selectedPath
    if (!root || !sourcePath) return

    const node = findNode(tree, sourcePath)
    if (!node) return

    const name = await requestPrompt({
      title: t('projectEditor.dialog.rename.title'),
      message: t('projectEditor.dialog.rename.message'),
      defaultValue: getBaseName(sourcePath)
    })

    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      showStatus('error', t('projectEditor.error.nameHasSeparator'))
      return
    }

    const parentPath = getParentPath(sourcePath)
    const nextPath = joinPath(parentPath, name)

    if (nextPath === sourcePath) return

    const result = await window.electronAPI.project.renamePath(root, sourcePath, nextPath)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.rename'))
      return
    }

    setSelectedPath(nextPath)

    if (activeFilePath) {
      if (activeFilePath === sourcePath) {
        setActiveFilePath(nextPath)
        activeFilePathRef.current = nextPath
      } else if (activeFilePath.startsWith(`${sourcePath}/`)) {
        const replacedPath = activeFilePath.replace(sourcePath, nextPath)
        setActiveFilePath(replacedPath)
        activeFilePathRef.current = replacedPath
      }
    }
    replaceQuickFileEntries(sourcePath, nextPath)

    await refreshDirectory(parentPath)
    invalidateFileIndex()
    showStatus('success', t('projectEditor.renameSuccess'))
  }, [activeFilePath, invalidateFileIndex, refreshDirectory, replaceQuickFileEntries, requestPrompt, selectedPath, showStatus, t, tree])

  const handleDelete = useCallback(async (targetPathOverride?: string) => {
    const root = rootRef.current
    const targetPath = targetPathOverride ?? selectedPath
    if (!root || !targetPath) return

    const node = findNode(tree, targetPath)
    if (!node) return

    const confirmed = await requestConfirm({
      title: t('projectEditor.dialog.delete.title'),
      message: t('projectEditor.dialog.delete.message', {
        itemType: node.type === 'dir' ? t('projectEditor.itemType.folder') : t('projectEditor.itemType.file'),
        name: node.name,
      }),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel')
    })

    if (!confirmed) return

    const result = await window.electronAPI.project.deletePath(root, targetPath)
    if (!result.success) {
      showStatus('error', result.error || t('projectEditor.error.delete'))
      return
    }

    if (activeFilePath) {
      if (activeFilePath === targetPath || activeFilePath.startsWith(`${targetPath}/`)) {
        setActiveFilePath(null)
        activeFilePathRef.current = null
        setFileContent('')
        fileContentRef.current = ''
        setIsBinary(false)
        isBinaryRef.current = false
        setIsImage(false)
        isImageRef.current = false
        setIsSqlite(false)
        isSqliteRef.current = false
        setImagePreviewUrl(null)
        setIsDirty(false)
        originalContentRef.current = ''
        originalModelVersionRef.current = null
      }
    }
    removeQuickFileEntries(targetPath)

    const parentPath = getParentPath(targetPath)
    setSelectedPath(null)
    await refreshDirectory(parentPath)
    invalidateFileIndex()
    showStatus('success', t('projectEditor.deleteSuccess'))
  }, [activeFilePath, invalidateFileIndex, refreshDirectory, removeQuickFileEntries, requestConfirm, selectedPath, showStatus, t, tree])

  const handleResizeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    isDraggingRef.current = true
    const startX = event.clientX
    const startWidth = fileTreeWidth

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientX - startX
      const newWidth = Math.max(MIN_FILE_TREE_WIDTH, Math.min(MAX_FILE_TREE_WIDTH, startWidth + delta))
      setFileTreeWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false
        localStorage.setItem(STORAGE_KEY_FILE_TREE_WIDTH, String(fileTreeWidth))
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-resizing')
    }

    document.body.classList.add('project-editor-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [fileTreeWidth])

  const handlePreviewResizeMouseDown = useCallback((event: React.MouseEvent) => {
    if (!isMarkdownPreviewVisible) return
    event.preventDefault()
    isPreviewDraggingRef.current = true

    const startX = event.clientX
    const startWidth = markdownPreviewWidthRef.current

    // Dynamically calculate the maximum width of the preview: container width - editor minimum reservation (120px) - outline occupation - resizer width
    const containerWidth = previewLayoutRef.current?.clientWidth ?? 0
    const outlineOccupied = outlineShowInSplit ? (outlineWidthRef.current + 6) : 0
    const maxPreviewWidth = Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, containerWidth - 120 - outlineOccupied - 6)

    const handleMouseMove = (e: MouseEvent) => {
      if (!isPreviewDraggingRef.current) return
      const delta = startX - e.clientX  // Drag left → Preview becomes wider
      const nextWidth = Math.min(maxPreviewWidth, Math.max(MIN_MARKDOWN_PREVIEW_WIDTH, startWidth + delta))
      setMarkdownPreviewWidth(nextWidth)
    }

    const handleMouseUp = () => {
      if (isPreviewDraggingRef.current) {
        isPreviewDraggingRef.current = false
        localStorage.setItem(
          STORAGE_KEY_MARKDOWN_PREVIEW_WIDTH,
          String(markdownPreviewWidthRef.current)
        )
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-preview-resizing')
    }

    document.body.classList.add('project-editor-preview-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isMarkdownPreviewVisible])

  const handleOutlineResizeMouseDown = useCallback((event: React.MouseEvent) => {
    if (!outlineShowInSplit) return
    event.preventDefault()
    isOutlineDraggingRef.current = true

    const startX = event.clientX
    const startWidth = outlineWidthRef.current
    const containerWidth = previewLayoutRef.current?.clientWidth ?? 0
    // Non-Markdown: resizer to the right of outline, drag right → widen (direction = 1)
    // Markdown: resizer to the left of outline, drag left → widen (direction = -1)
    const direction = isMarkdownFile ? -1 : 1
    const previewOccupied = isMarkdownPreviewVisible && isMarkdownEditorVisibleRef.current
      ? (markdownPreviewWidthRef.current + 6)
      : 0
    const editorReservation = isMarkdownFile && !isMarkdownEditorVisibleRef.current ? 0 : 120
    const maxOutlineWidth = Math.max(MIN_OUTLINE_WIDTH, containerWidth - editorReservation - previewOccupied - 6)

    const handleMouseMove = (e: MouseEvent) => {
      if (!isOutlineDraggingRef.current) return
      const delta = (e.clientX - startX) * direction
      const nextWidth = Math.min(maxOutlineWidth, Math.max(MIN_OUTLINE_WIDTH, startWidth + delta))
      setOutlineWidth(nextWidth)
    }

    const handleMouseUp = () => {
      if (isOutlineDraggingRef.current) {
        isOutlineDraggingRef.current = false
        localStorage.setItem(STORAGE_KEY_OUTLINE_WIDTH, String(outlineWidthRef.current))
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-outline-resizing')
    }

    document.body.classList.add('project-editor-outline-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isMarkdownFile, isMarkdownPreviewVisible, outlineShowInSplit])

  const handleModalResizeMouseDown = useCallback((event: React.MouseEvent, direction: string) => {
    if (isPanel) return
    event.preventDefault()
    event.stopPropagation()
    isResizingModalRef.current = true
    resizeDirectionRef.current = direction

    const startX = event.clientX
    const startY = event.clientY
    const startWidth = modalSize.width
    const startHeight = modalSize.height

    const maxWidth = window.innerWidth * MAX_MODAL_WIDTH_PERCENT / 100
    const maxHeight = window.innerHeight * MAX_MODAL_HEIGHT_PERCENT / 100

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingModalRef.current) return

      let newWidth = startWidth
      let newHeight = startHeight
      const dir = resizeDirectionRef.current

      if (dir.includes('e')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth + (e.clientX - startX) * 2))
      } else if (dir.includes('w')) {
        newWidth = Math.max(MIN_MODAL_WIDTH, Math.min(maxWidth, startWidth - (e.clientX - startX) * 2))
      }

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
        localStorage.setItem(STORAGE_KEY_MODAL_SIZE, JSON.stringify(modalSizeRef.current))
      }
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.classList.remove('project-editor-modal-resizing')
    }

    document.body.classList.add('project-editor-modal-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [isPanel, modalSize])

  const editorPath = useMemo(() => {
    if (!activeFilePath) return undefined
    if (!rootRef.current) return activeFilePath
    return `${rootRef.current.replace(/\\/g, '/')}/${activeFilePath}`
  }, [activeFilePath])

  const rootLabel = useMemo(() => {
    if (!rootPath) return t('projectEditor.rootDirectory')
    const parts = rootPath.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || rootPath
  }, [rootPath, t])

  const modalStyle = useMemo(() => ({
    width: isPanel ? '100%' : modalSize.width,
    height: isPanel ? '100%' : modalSize.height,
    ['--project-editor-font-size' as string]: `${editorFontSize}px`
  }), [editorFontSize, isPanel, modalSize.height, modalSize.width])

  const renderTree = useCallback((nodes: TreeNode[], depth = 0) => {
    return nodes.map((node) => {
      const isSelected = selectedPath === node.path
      const itemClass = `project-editor-tree-item ${isSelected ? 'selected' : ''}`

      return (
        <div key={node.path}>
          <div
            className={itemClass}
            style={{ paddingLeft: `${12 + depth * 14}px` }}
            onContextMenu={(event) => openContextMenu(event, {
              path: node.path,
              type: node.type,
              select: true
            })}
            onClick={() => {
              if (node.type === 'dir') {
                void toggleDirectory(node)
              } else {
                setSelectedPath(node.path)
                void openFile(node.path, 'user', { trackRecent: true })
              }
            }}
          >
            <div className="project-editor-tree-main">
              {node.type === 'dir' ? (
                <span className={`project-editor-tree-toggle ${node.isExpanded ? 'open' : ''}`}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : (
                <span className="project-editor-tree-spacer" />
              )}
              <span className={`project-editor-tree-icon ${node.type}`}>
                {node.type === 'dir' ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M1.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75V5.5a.75.75 0 0 0-.75-.75H7.5a.75.75 0 0 1-.53-.22l-.97-.97A.75.75 0 0 0 5.47 3H1.75Z" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4.75 1.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h6.5a.75.75 0 0 0 .75-.75V5.5a.75.75 0 0 0-.22-.53l-2.75-2.75A.75.75 0 0 0 8.5 2h-3.75Z" />
                  </svg>
                )}
              </span>
              <span className="project-editor-tree-name" title={node.name}>{node.name}</span>
              {node.isLoading && <span className="project-editor-tree-loading">{t('projectEditor.loading')}</span>}
            </div>
          </div>
          {node.type === 'dir' && node.isExpanded && node.children && renderTree(node.children, depth + 1)}
        </div>
      )
    })
  }, [openContextMenu, openFile, selectedPath, setSelectedPath, t, toggleDirectory])

  const treeNodes = useMemo(() => {
    if (tree.length === 0) {
      return <div className="project-editor-empty">{t('projectEditor.empty.noFiles')}</div>
    }
    return renderTree(tree)
  }, [renderTree, t, tree])

  if (!isOpen) return null

  return (
    <div
      className={`project-editor-overlay ${isPanel ? 'panel' : ''}`}
      onClick={() => {
        if (!isPanel) {
          void handleRequestClose()
        }
      }}
    >
      <div
        className="project-editor-modal"
        ref={modalRef}
        style={modalStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {!isPanel && (
          <>
            <div className="project-editor-modal-resize-n" onMouseDown={(e) => handleModalResizeMouseDown(e, 'n')} />
            <div className="project-editor-modal-resize-s" onMouseDown={(e) => handleModalResizeMouseDown(e, 's')} />
            <div className="project-editor-modal-resize-e" onMouseDown={(e) => handleModalResizeMouseDown(e, 'e')} />
            <div className="project-editor-modal-resize-w" onMouseDown={(e) => handleModalResizeMouseDown(e, 'w')} />
            <div className="project-editor-modal-resize-ne" onMouseDown={(e) => handleModalResizeMouseDown(e, 'ne')} />
            <div className="project-editor-modal-resize-nw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'nw')} />
            <div className="project-editor-modal-resize-se" onMouseDown={(e) => handleModalResizeMouseDown(e, 'se')} />
            <div className="project-editor-modal-resize-sw" onMouseDown={(e) => handleModalResizeMouseDown(e, 'sw')} />
          </>
        )}

        <div className="project-editor-header">
          <div className="project-editor-title">{t('projectEditor.title')}</div>
          <div className="project-editor-header-actions">
            <button
              className="project-editor-secondary"
              onClick={() => void handleOpenGitDiff('user')}
              disabled={!_terminalId}
            >
              {t('projectEditor.openGitDiff')}
            </button>
            <button
              className="project-editor-save"
              onClick={() => void handleSaveRef.current('toolbar')}
              disabled={!activeFilePath || !isDirty || isBinary || isImage || isSqlite}
            >
              {t('common.save')}
            </button>
            <button
              className="project-editor-secondary"
              onClick={() => void handleRequestClose()}
              title={t('projectEditor.returnToTerminal')}
            >
              {t('projectEditor.returnToTerminal')}
            </button>
          </div>
        </div>

        <div className="project-editor-root">
          <span className="project-editor-root-label">{t('projectEditor.workingDirectory')}</span>
          <span className="project-editor-root-path" title={rootPath || ''}>{rootPath || '-'}</span>
          {(statusMessage || (markdownRenderPending && isMarkdownPreviewVisible)) && (
            <div className="project-editor-status-group">
              {markdownRenderPending && isMarkdownPreviewVisible && (
                <span className="project-editor-status pending">{t('projectEditor.rendering')}</span>
              )}
              {statusMessage && (
                <span className={`project-editor-status ${statusMessage.type}`}>
                  {statusMessage.text}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="project-editor-body">
          <div className="project-editor-sidebar" style={{ width: fileTreeWidth }}>
            <div className="project-editor-sidebar-mode-bar">
              <button
                className={`pe-mode-btn ${sidebarMode === 'files' ? 'active' : ''}`}
                onClick={() => setSidebarMode('files')}
                title={t('projectEditor.sidebarFilesTooltip')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5zM1 3.5a.5.5 0 0 1 .5-.5h4.07a.5.5 0 0 1 .43.24l.86 1.43a.5.5 0 0 0 .43.24H14.5a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-9z" />
                </svg>
                <span>{t('projectEditor.sidebarFiles')}</span>
              </button>
              <button
                className={`pe-mode-btn ${sidebarMode === 'search' ? 'active' : ''}`}
                onClick={() => {
                  setInitialSearchType('content')
                  setSidebarMode('search')
                  setTimeout(() => globalSearchInputRef.current?.focus(), 0)
                }}
                title={t('projectEditor.sidebarSearchTooltip', {
                  key: `${window.electronAPI.platform === 'darwin' ? '⌘' : 'Ctrl'}+Shift+F`
                })}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.44 1.16a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z" />
                </svg>
                <span>{t('projectEditor.sidebarSearch')}</span>
              </button>
            </div>
            {sidebarMode === 'files' ? (
              <>
                <div className="project-editor-sidebar-header">
                  <span className="project-editor-sidebar-title">{t('projectEditor.fileBrowser')}</span>
                </div>
                <div
                  className="project-editor-tree"
                  ref={fileTreeContainerRef}
                  onContextMenu={(event) => openContextMenu(event, { path: null, type: null })}
                >
                  {rootError ? (
                    <div className="project-editor-empty">
                      <p>{rootError}</p>
                      <button className="project-editor-action-btn" onClick={() => rootPath && void loadRoot(rootPath)}>
                        {t('projectEditor.reload')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div
                        className="project-editor-tree-root"
                        onContextMenu={(event) => openContextMenu(event, { path: '', type: 'dir' })}
                      >
                        <div className="project-editor-tree-root-label" title={rootPath || ''}>{rootLabel}</div>
                      </div>
                      {treeNodes}
                    </>
                  )}
                </div>
              </>
            ) : (
              <SearchPanel
                rootPath={rootPath}
                isActive={sidebarMode === 'search' && isOpen}
                initialSearchType={initialSearchType}
                onNavigate={handleSearchNavigate}
                onOpenFile={(filePath) => void openFile(filePath, 'user', { trackRecent: true })}
                onClose={() => setSidebarMode('files')}
                buildFileIndex={buildFileIndex}
                getFileIndex={getFileIndex}
                searchInputRef={globalSearchInputRef}
              />
            )}
            <div className="project-editor-file-tree-resizer" onMouseDown={handleResizeMouseDown} />
          </div>

          <div className="project-editor-editor">
            <div className="project-editor-quick-access">
              <div className="project-editor-quick-row pin">
                <div className="project-editor-quick-row-header">
                  <div className="project-editor-quick-row-title">
                    <span className="project-editor-quick-row-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M5.8 1.75h4.4l-.45 3.2 2.6 2.5v1h-3.1l-1.15 5.8-.95.2-.95-6H2.9v-1l2.6-2.5-.45-3.2Z" fill="currentColor" />
                      </svg>
                    </span>
                    <span>{t('projectEditor.pinnedFiles')}</span>
                    <span className="project-editor-quick-count">{pinnedFiles.length}/{MAX_PINNED_FILES}</span>
                  </div>
                </div>
                <div
                  className="project-editor-quick-list"
                  onDragOver={handlePinnedListDragOver}
                  onDrop={handlePinnedListDrop}
                >
                  {pinnedFiles.length === 0 ? (
                    <span className="project-editor-quick-empty">{t('projectEditor.empty.noPinnedFiles')}</span>
                  ) : (
                    pinnedFiles.map((path) => {
                      const label = quickFileLabels[path] ?? getBaseName(path)
                      const className = [
                        'project-editor-quick-item',
                        activeFilePath === path ? 'active' : '',
                        draggingPinnedPath === path ? 'dragging' : '',
                        dragOverPinnedPath === path ? 'drag-over' : ''
                      ].filter(Boolean).join(' ')
                      return (
                        <button
                          key={`pin:${path}`}
                          className={className}
                          draggable
                          onClick={() => void openFile(path, 'user', { trackRecent: true })}
                          onContextMenu={(event) => openContextMenu(event, {
                            path,
                            type: 'file',
                            source: 'quick-pin'
                          })}
                          onMouseEnter={(e) => handleQuickTooltipEnter(e, path)}
                          onMouseLeave={handleQuickTooltipLeave}
                          onDragStart={(event) => handlePinnedDragStart(event, path)}
                          onDragOver={(event) => handlePinnedDragOver(event, path)}
                          onDrop={(event) => handlePinnedDrop(event, path)}
                          onDragEnd={handlePinnedDragEnd}
                        >
                          {label}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>

              <div className="project-editor-quick-row recent">
                <div className="project-editor-quick-row-header">
                  <div className="project-editor-quick-row-title">
                    <span className="project-editor-quick-row-icon" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M8 2.25a5.75 5.75 0 1 1-4.53 2.21H1.75v-1h3.5v3h-1V5.39A4.75 4.75 0 1 0 8 3.25Z" fill="currentColor" />
                        <path d="M8 4.5h1v3.1l2.1 1.05-.45.9L7.5 7.95V4.5Z" fill="currentColor" />
                      </svg>
                    </span>
                    <span>{t('projectEditor.recentFiles')}</span>
                    <span className="project-editor-quick-count">{recentFiles.length}/{MAX_RECENT_FILES}</span>
                  </div>
                  <button
                    className="project-editor-quick-row-action"
                    disabled={recentFiles.length === 0}
                    onClick={clearRecentFiles}
                  >
                    {t('projectEditor.clearAll')}
                  </button>
                </div>
                <div
                  className="project-editor-quick-list"
                  onDragOver={handleRecentListDragOver}
                  onDrop={handleRecentListDrop}
                >
                  {recentFiles.length === 0 ? (
                    <span className="project-editor-quick-empty">{t('projectEditor.empty.noRecentFiles')}</span>
                  ) : (
                    recentFiles.map((path) => {
                      const label = quickFileLabels[path] ?? getBaseName(path)
                      const className = [
                        'project-editor-quick-item',
                        activeFilePath === path ? 'active' : '',
                        draggingQuickSource === 'recent' && draggingQuickPath === path ? 'dragging' : '',
                        dragOverRecentPath === path ? 'drag-over' : ''
                      ].filter(Boolean).join(' ')
                      return (
                        <button
                          key={`recent:${path}`}
                          className={className}
                          draggable
                          onClick={() => void openFile(path, 'user', { trackRecent: true })}
                          onContextMenu={(event) => openContextMenu(event, {
                            path,
                            type: 'file',
                            source: 'quick-recent'
                          })}
                          onMouseEnter={(e) => handleQuickTooltipEnter(e, path)}
                          onMouseLeave={handleQuickTooltipLeave}
                          onDragStart={(event) => handleRecentDragStart(event, path)}
                          onDragOver={(event) => handleRecentDragOver(event, path)}
                          onDrop={(event) => handleRecentDrop(event, path)}
                          onDragEnd={handlePinnedDragEnd}
                        >
                          {label}
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="project-editor-editor-header">
              <div className="project-editor-editor-title">
                {activeFilePath ? (
                  <>
                    <span
                      className={`project-editor-editor-filename ${isDirty ? 'dirty' : ''}`}
                      onDoubleClick={handleFilenameDblClick}
                      title={t('projectEditor.filenameCopyHint')}
                    >
                      {activeFilePath}
                    </span>
                    {isDirty && <span className="project-editor-editor-dirty">{t('projectEditor.unsaved')}</span>}
                  </>
                ) : (
                  <span className="project-editor-editor-placeholder">{t('projectEditor.selectFile')}</span>
                )}
              </div>
              <div className="project-editor-editor-controls">
                <div className="project-editor-editor-meta">
                  {isLoadingFile && <span className="project-editor-editor-loading">{t('projectEditor.loading')}</span>}
                  {isImage && <span className="project-editor-editor-binary">{t('projectEditor.imagePreview')}</span>}
                  {isSqlite && <span className="project-editor-editor-binary">{t('projectEditor.sqliteView')}</span>}
                  {!isImage && !isSqlite && isBinary && <span className="project-editor-editor-binary">{t('projectEditor.binaryReadonly')}</span>}
                </div>
                {activeFilePath && isMarkdownFile && !isBinary && !isImage && !isSqlite && (
                  <button
                    className="project-editor-action-btn project-editor-preview-toggle"
                    onClick={() => {
	                      setIsMarkdownPreviewOpen((prev) => {
	                        const next = !prev
	                        if (next && activeFilePath && isMarkdownFile) {
	                          beginPreviewRestore()
	                          setIsMarkdownRenderEnabled(true)
	                        }
                        if (!next) {
                          setIsMarkdownRenderEnabled(false)
                          if (!isMarkdownEditorVisibleRef.current) {
                            setIsMarkdownEditorVisible(true)
                            isMarkdownEditorVisibleRef.current = true
                            localStorage.setItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE, 'true')
                          }
                        }
                        isMarkdownPreviewOpenRef.current = next
                        return next
                      })
                    }}
                  >
                    {isMarkdownPreviewOpen ? t('projectEditor.closePreview') : t('projectEditor.openPreview')}
                  </button>
                )}
                {activeFilePath && isMarkdownFile && !isBinary && !isImage && !isSqlite && (
                  <button
                    className="project-editor-action-btn project-editor-preview-toggle"
                    onClick={() => {
                      setIsMarkdownEditorVisible((prev) => {
                        const next = !prev
                        isMarkdownEditorVisibleRef.current = next
                        localStorage.setItem(STORAGE_KEY_MARKDOWN_EDITOR_VISIBLE, String(next))
	                        if (!next && !isMarkdownPreviewOpenRef.current) {
	                          setIsMarkdownPreviewOpen(true)
	                          beginPreviewRestore()
	                          isMarkdownPreviewOpenRef.current = true
	                          setIsMarkdownRenderEnabled(true)
                        }
                        return next
                      })
                    }}
                  >
                    {isMarkdownEditorVisible ? t('projectEditor.closeEdit') : t('projectEditor.openEdit')}
                  </button>
                )}
                {activeFilePath && !isBinary && !isImage && !isSqlite && (
                  <button
                    className="project-editor-action-btn project-editor-preview-toggle"
                    onClick={() => {
                      setIsOutlineVisible((prev) => {
                        const next = !prev
                        isOutlineVisibleRef.current = next
                        localStorage.setItem(STORAGE_KEY_OUTLINE_VISIBLE, String(next))
                        return next
                      })
                    }}
                  >
                    {isOutlineVisible ? t('projectEditor.closeOutline') : t('projectEditor.openOutline')}
                  </button>
                )}
              </div>
            </div>

            <div className="project-editor-editor-body">
              {missingFileNotice && (
                <div className="project-editor-missing-banner">
                  <div className="project-editor-missing-text">
                    {missingFileNotice.message}
                  </div>
                  <div className="project-editor-missing-actions">
                    <button
                      className="project-editor-missing-btn primary"
                      onClick={() => {
                        setMissingFileNotice(null)
                        resetActiveFileState()
                      }}
                    >
                      {t('projectEditor.closeFile')}
                    </button>
                    <button
                      className="project-editor-missing-btn"
                      onClick={() => {
                        setMissingFileNotice(null)
                        void refreshDirectory('')
                        invalidateFileIndex()
                      }}
                    >
                      {t('projectEditor.refreshDirectory')}
                    </button>
                    <button
                      className="project-editor-missing-btn ghost"
                      onClick={() => setMissingFileNotice(null)}
                    >
                      {t('projectEditor.closeNotice')}
                    </button>
                  </div>
                </div>
              )}
              {activeFilePath && isImage && imagePreviewUrl ? (
                <div className="project-editor-image-preview">
                  <img ref={imagePreviewRef} src={imagePreviewUrl} alt={activeFilePath} />
                </div>
              ) : activeFilePath && isSqlite && (rootRef.current ?? rootPath) ? (
                <SqliteViewer
                  rootPath={(rootRef.current ?? rootPath) as string}
                  filePath={activeFilePath}
                  onNotifyGitChange={notifySqliteMutation}
                />
              ) : activeFilePath && !isBinary ? (
                <div className="project-editor-split" ref={previewLayoutRef}>
                  {/* Non-Markdown: Outline is on the left side of the editor (between the directory tree and the editor) */}
                  {outlineShowInSplit && !isMarkdownFile && (
                    <>
                      <div className="project-editor-outline-pane" style={outlinePaneStyle}>
                        <OutlinePanel
                          symbols={outlineSymbols}
                          activeItem={outlineActiveItem}
                          isLoading={outlineLoading}
                          filePath={activeFilePath}
                          editor={editorRef.current}
                          initialScrollTop={outlineScrollTopRef.current.get(getFileScrollKey(lastEditorScopeRef.current, activeFilePath) ?? '') ?? 0}
                          onScrollCapture={handleOutlineScrollCapture}
                        />
                      </div>
                      <div className="project-editor-outline-resizer" onMouseDown={handleOutlineResizeMouseDown} />
                    </>
                  )}

                  <div
                    className="project-editor-editor-pane"
                    style={{
                      ...editorPaneStyle,
                      ...(isMarkdownFile && !isMarkdownEditorVisible ? { display: 'none' } : {})
                    }}
                  >
                    <Editor
                      height="100%"
                      width="100%"
                      path={editorPath}
                      saveViewState={false}
                      language={editorLanguage}
                      theme="vs-dark"
                      value={fileContent}
                      onChange={handleEditorChange}
                      onMount={(editor, monaco) => {
                        editorRef.current = editor
                        monacoRef.current = monaco
                        editorScrollDisposableRef.current?.dispose()
                        editorScrollDisposableRef.current = editor.onDidScrollChange(() => {
                          if (DEBUG_PROJECT_EDITOR) {
                            perfCountersRef.current.editorScroll += 1
                          }
                          if (suppressNextEditorScrollRef.current) {
                            suppressNextEditorScrollRef.current = false
                            return
                          }
                          if (previewVisibleRef.current) {
                            schedulePreviewSync()
                          }
                          const currentPath = activeFilePathRef.current
                          const firstVisibleLine = editor.getVisibleRanges()?.[0]?.startLineNumber ?? null
                          if (currentPath && typeof firstVisibleLine === 'number' && firstVisibleLine > 0) {
                            fileFirstVisibleLineRef.current.set(getViewStateKey(currentPath), firstVisibleLine)
                          }
                          scheduleProjectStateSave()
                        })
                        editorCursorDisposableRef.current?.dispose()
                        editorCursorDisposableRef.current = editor.onDidChangeCursorPosition(() => {
                          if (DEBUG_PROJECT_EDITOR) {
                            perfCountersRef.current.editorCursor += 1
                          }
                          scheduleProjectStateSave()
                        })
                        editorModelDisposableRef.current?.dispose()
                        editorModelDisposableRef.current = editor.onDidChangeModel(() => {
                          if (
                            (pendingViewStateRef.current || pendingCursorRef.current) &&
                            pendingViewStatePathRef.current === activeFilePathRef.current
                          ) {
                            applyPendingViewState()
                          }
                          syncOriginalVersion()
                        })
                        editorSaveCommandIdRef.current = editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                          void handleSaveRef.current('editor-shortcut')
                        })
                        if ((pendingViewStateRef.current || pendingCursorRef.current) && pendingViewStatePathRef.current === activeFilePath) {
                          applyPendingViewState()
                        }
                        syncOriginalVersion()
                      }}
                      options={{
                        fontSize: editorFontSize,
                        minimap: { enabled: false },
                        wordWrap: 'on',
                        automaticLayout: true,
                        scrollBeyondLastLine: false,
                        padding: { top: 10, bottom: 10 }
                      }}
                    />
                  </div>

                  {isMarkdownPreviewVisible && (
                    <>
                      {isMarkdownEditorVisible && (
                        <div className="project-editor-preview-resizer" onMouseDown={handlePreviewResizeMouseDown} />
                      )}
                      <div className="project-editor-preview-pane" style={previewPaneStyle}>
                        <div className="project-editor-preview-header">
                          {t('projectEditor.livePreview')}
                          {markdownRenderPending && (
                            <span className="project-editor-preview-pending">{t('projectEditor.rendering')}</span>
                          )}
                        </div>
                        <PreviewSearchBar
                          previewRef={previewRef}
                          isOpen={previewSearchOpen}
                          onClose={() => setPreviewSearchOpen(false)}
                          renderedHtml={markdownRenderedHtml}
                        />
                        <div
                          className={`project-editor-preview-body preview-phase-${previewRestorePhase}`}
                          ref={previewRef}
                          onCopy={handlePreviewCopy}
                        >
                          <div className="project-editor-preview-transition-indicator" aria-hidden={isPreviewContentVisible}>
                            <div className="preview-loading-dots"><span /><span /><span /></div>
                          </div>
                          {isMarkdownRenderAllowed ? (
                            <div
                              className="project-editor-preview-content"
                              dangerouslySetInnerHTML={{ __html: markdownRenderedHtml }}
                            />
                          ) : (
                            <div className="project-editor-preview-placeholder">
                              {t('projectEditor.previewHint')}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  {/* Markdown: TOC is on the right side of the preview (far right) */}
                  {outlineShowInSplit && isMarkdownFile && (
                    <>
                      <div className="project-editor-outline-resizer" onMouseDown={handleOutlineResizeMouseDown} />
                      <div className="project-editor-outline-pane" style={outlinePaneStyle}>
                        <OutlinePanel
                          symbols={outlineSymbols}
                          activeItem={outlineActiveItem}
                          isLoading={outlineLoading}
                          filePath={activeFilePath}
                          editor={editorRef.current}
                          isMarkdown
                          previewRef={previewRef}
                          outlineTarget={outlineTarget}
                          previewActiveSlug={previewActiveSlug}
                          initialScrollTop={outlineScrollTopRef.current.get(getFileScrollKey(lastEditorScopeRef.current, activeFilePath) ?? '') ?? 0}
                          onScrollCapture={handleOutlineScrollCapture}
                          onOutlineTargetChange={(target) => {
                            setOutlineTarget(target)
                            outlineTargetRef.current = target
                            localStorage.setItem(STORAGE_KEY_OUTLINE_TARGET, target)
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="project-editor-empty">
                  {activeFilePath
                    ? (isBinary ? t('projectEditor.binaryCurrent') : t('projectEditor.empty.noContent'))
                    : t('projectEditor.selectFile')}
                </div>
              )}
            </div>
          </div>
        </div>

        {searchOpen && (
          <div className="project-editor-search-overlay" onClick={handleCloseSearch}>
            <div className="project-editor-search" onClick={(event) => event.stopPropagation()}>
              <input
                ref={searchInputRef}
                className="project-editor-search-input"
                value={searchQuery}
                placeholder={t('projectEditor.searchPlaceholder')}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              <div className="project-editor-search-results">
                {isIndexing && (
                  <div className="project-editor-search-empty">{t('projectEditor.searchIndexing')}</div>
                )}
                {!isIndexing && searchResults.length === 0 && (
                  <div className="project-editor-search-empty">{t('projectEditor.searchNoMatches')}</div>
                )}
                {!isIndexing && searchResults.map((item, index) => (
                  <div
                    key={item}
                    className={`project-editor-search-item ${index === searchActiveIndex ? 'active' : ''}`}
                    onClick={() => void handleSearchSelect(item)}
                  >
                    <span className="project-editor-search-item-name">{getBaseName(item)}</span>
                    <span className="project-editor-search-item-path">{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {dialog && (
          <div className="project-editor-dialog-overlay" onClick={handleDialogCancel}>
            <div className="project-editor-dialog" onClick={(event) => event.stopPropagation()}>
              <div className="project-editor-dialog-title">{dialog.title}</div>
              <div className="project-editor-dialog-message">{dialog.message}</div>
              {dialog.type === 'prompt' && (
                <input
                  ref={dialogInputRef}
                  className="project-editor-dialog-input"
                  value={dialogInput}
                  placeholder={dialog.placeholder}
                  onChange={(event) => setDialogInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleDialogConfirm()
                    }
                  }}
                />
              )}
              <div className="project-editor-dialog-actions">
                <button className="project-editor-dialog-btn" onClick={handleDialogCancel}>
                  {dialog.cancelText || t('common.cancel')}
                </button>
                <button className="project-editor-dialog-btn primary" onClick={handleDialogConfirm}>
                  {dialog.confirmText || t('common.confirm')}
                </button>
              </div>
            </div>
          </div>
        )}

        {contextMenu && (() => {
          const showDirGroup = contextMenu.targetType === 'dir' || contextMenu.targetType === null
          const showCopyGroup = contextMenu.targetType && contextMenu.targetPath !== null
          const showManageGroup = showCopyGroup && contextMenu.source === 'tree'
          return (
          <div
            className="project-editor-context-menu"
            ref={contextMenuRef}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            {showDirGroup && (
              <>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    const refreshTarget = contextMenu.targetType === 'dir'
                      ? (contextMenu.targetPath ?? '')
                      : ''
                    void refreshDirectory(refreshTarget)
                    invalidateFileIndex()
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-7.068 2H.534a.25.25 0 0 0-.192.41l1.966 2.36a.25.25 0 0 0 .384 0l1.966-2.36A.25.25 0 0 0 4.466 9z" /><path d="M8 3a5 5 0 0 1 4.546 2.914.5.5 0 1 0 .908-.428A6 6 0 0 0 2.11 5.84L1.58 4.39A.5.5 0 0 0 .64 4.61l1.2 3.6a.5.5 0 0 0 .638.316l3.6-1.2a.5.5 0 1 0-.316-.948L3.9 7.077A5 5 0 0 1 8 3zm6.42 5.39a.5.5 0 0 0-.638-.316l-3.6 1.2a.5.5 0 1 0 .316.948l1.862-.62A5 5 0 0 1 8 13a5 5 0 0 1-4.546-2.914.5.5 0 0 0-.908.428A6 6 0 0 0 13.89 10.16l.53 1.45a.5.5 0 1 0 .94-.22l-1.2-3.6a.5.5 0 0 0-.26-.28z" /></svg>
                  <span>{t('projectEditor.context.refresh')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void handleNewFile(contextMenu.targetType === 'dir' ? (contextMenu.targetPath ?? '') : '')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1zM8 8.75a.75.75 0 0 0-1.5 0V10H5.25a.75.75 0 0 0 0 1.5H6.5v1.25a.75.75 0 0 0 1.5 0V11.5h1.25a.75.75 0 0 0 0-1.5H8V8.75z" /></svg>
                  <span>{t('projectEditor.context.newFile')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void handleNewFolder(contextMenu.targetType === 'dir' ? (contextMenu.targetPath ?? '') : '')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H7.71L6.85 2.57A1.5 1.5 0 0 0 5.57 2H1.5zM8 7.75a.75.75 0 0 0-1.5 0V9H5.25a.75.75 0 0 0 0 1.5H6.5v1.25a.75.75 0 0 0 1.5 0V10.5h1.25a.75.75 0 0 0 0-1.5H8V7.75z" /></svg>
                  <span>{t('projectEditor.context.newFolder')}</span>
                </button>
              </>
            )}
            {showDirGroup && showCopyGroup && (
              <div className="project-editor-context-separator" />
            )}
            {showCopyGroup && (
              <>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void copyContextMenuPath(contextMenu.targetPath ?? '', 'name')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11zM5 5.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H8.5v7a.5.5 0 0 1-1 0V6H5.5a.5.5 0 0 1-.5-.5z" /></svg>
                  <span>{t('common.name')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void copyContextMenuPath(contextMenu.targetPath ?? '', 'relative')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
                  <span>{t('common.relativePath')}</span>
                </button>
                <button
                  className="project-editor-context-item"
                  onClick={() => {
                    closeContextMenu()
                    void copyContextMenuPath(contextMenu.targetPath ?? '', 'absolute')
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
                  <span>{t('common.absolutePath')}</span>
                </button>
                {contextMenu.targetType === 'file' && (
                  <button
                    className="project-editor-context-item"
                    onClick={() => {
                      closeContextMenu()
                      if (contextMenu.targetPath) {
                        togglePinnedFile(contextMenu.targetPath)
                      }
                    }}
                  >
                    {contextMenu.targetPath && pinnedFiles.includes(contextMenu.targetPath) ? (
                      <>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1.282a2 2 0 0 1 2.828 0l2.062 2.062a2 2 0 0 1 0 2.828L12.78 8.11a1 1 0 0 1-.293.207l-1.957.783.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.783 1.957a1 1 0 0 1-.207.293L6.54 14.35a2 2 0 0 1-2.828 0L1.65 12.288a2 2 0 0 1 0-2.828l1.94-1.94a1 1 0 0 1 .293-.207l1.957-.783-.97-.97a.75.75 0 0 1 1.06-1.06l.97.97.783-1.957a1 1 0 0 1 .207-.293l1.938-1.938zM1.47 14.53l13.06-13.06a.75.75 0 1 0-1.06-1.06L.41 13.47a.75.75 0 1 0 1.06 1.06z" /></svg>
                        <span>{t('projectEditor.context.unpin')}</span>
                      </>
                    ) : (
                      <>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828 1.282a2 2 0 0 1 2.828 0l2.062 2.062a2 2 0 0 1 0 2.828L12.78 8.11a1 1 0 0 1-.293.207l-1.957.783.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.783 1.957a1 1 0 0 1-.207.293L6.54 14.35a2 2 0 0 1-2.828 0L1.65 12.288a2 2 0 0 1 0-2.828l1.94-1.94a1 1 0 0 1 .293-.207l1.957-.783-.97-.97a.75.75 0 0 1 1.06-1.06l.97.97.783-1.957a1 1 0 0 1 .207-.293l1.938-1.938z" /></svg>
                        <span>{t('projectEditor.context.pin')}</span>
                      </>
                    )}
                  </button>
                )}
                {showManageGroup && (
                  <div className="project-editor-context-separator" />
                )}
                {contextMenu.source === 'tree' && (
                  <>
                    <button
                      className="project-editor-context-item"
                      onClick={() => {
                        closeContextMenu()
                        void handleRename(contextMenu.targetPath ?? undefined)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" /></svg>
                      <span>{t('projectEditor.context.rename')}</span>
                    </button>
                    <div className="project-editor-context-separator" />
                    <button
                      className="project-editor-context-item danger"
                      onClick={() => {
                        closeContextMenu()
                        void handleDelete(contextMenu.targetPath ?? undefined)
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" /><path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z" /></svg>
                      <span>{t('common.delete')}</span>
                    </button>
                  </>
                )}
              </>
            )}
          </div>
          )
        })()}

        {/* Instant Tooltip */}
        {quickTooltip && (
          <div
            className="project-editor-quick-tooltip"
            style={{ position: 'fixed', left: quickTooltip.x, top: quickTooltip.y }}
          >
            {quickTooltip.text}
          </div>
        )}
      </div>
    </div>
  )
}
