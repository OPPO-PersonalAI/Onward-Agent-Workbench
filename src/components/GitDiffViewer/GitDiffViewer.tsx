/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { parseDiffFromFile, SPLIT_WITH_NEWLINES } from '@pierre/diffs'
import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from '@pierre/diffs'
import type * as monacoTypes from 'monaco-editor'
import type { GitDiffResult, GitFileStatus, GitFileContentResult, GitFileActionResult, GitRepoContext } from '../../types/electron'
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
import { GitPdfCompare, type GitPdfStatus } from '../GitPdfCompare/GitPdfCompare'
import { GitEpubCompare, type GitEpubStatus } from '../GitEpubCompare/GitEpubCompare'
import { usePathCopy } from '../../hooks/usePathCopy'
import { useGitDiffFileWatch } from './useGitDiffFileWatch'
import '../../styles/path-copy-toast.css'
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
const STORAGE_KEY_DIFF_SPLIT_RATIO = 'git-diff-split-view-ratio'

// File list width limit
const DEFAULT_FILE_LIST_WIDTH = 280
const MIN_FILE_LIST_WIDTH = 150
const MAX_FILE_LIST_WIDTH = 600

const DEFAULT_DIFF_SPLIT_RATIO = 0.5
const MIN_DIFF_SPLIT_RATIO = 0.1
const MAX_DIFF_SPLIT_RATIO = 0.9
const DIFF_SPLIT_RATIO_EPSILON = 0.002

// Monaco theme aligned with @pierre/diffs' pierre-dark palette so Git Diff
// reads as the same visual family as the Git History viewer.
const PIERRE_LIKE_MONACO_THEME = 'onward-pierre-dark'
const PIERRE_LIKE_MONACO_FONT = "'SF Mono', Monaco, Consolas, 'Ubuntu Mono', 'Liberation Mono', 'Courier New', monospace"
let pierreLikeMonacoThemeRegistered = false

function ensurePierreLikeMonacoTheme(monaco: typeof monacoTypes) {
  if (pierreLikeMonacoThemeRegistered) return
  monaco.editor.defineTheme(PIERRE_LIKE_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#070707',
      'editor.foreground': '#fbfbfb',
      'editorLineNumber.foreground': '#84848a',
      'editorLineNumber.activeForeground': '#adadb1',
      'editorGutter.background': '#070707',
      'editor.lineHighlightBackground': '#101010',
      'editor.lineHighlightBorder': '#00000000',
      'editorIndentGuide.background': '#1a1a1a',
      'editorIndentGuide.activeBackground': '#2a2a2a',
      'editorIndentGuide.background1': '#1a1a1a',
      'editorIndentGuide.activeBackground1': '#2a2a2a',
      'editor.selectionBackground': '#2a2a2a',
      'editor.inactiveSelectionBackground': '#1a1a1a',
      'editorWhitespace.foreground': '#2a2a2a',
      'diffEditor.insertedLineBackground': '#00cab11a',
      'diffEditor.insertedTextBackground': '#00cab140',
      'diffEditor.removedLineBackground': '#ff2e3f1a',
      'diffEditor.removedTextBackground': '#ff2e3f40',
      'diffEditor.diagonalFill': '#14141400',
      'diffEditor.border': '#1a1a1a',
      'diffEditor.unchangedRegionBackground': '#0a0a0a',
      'diffEditor.unchangedRegionForeground': '#79797f',
      'diffEditor.unchangedCodeBackground': '#0a0a0a',
      'diffEditorGutter.insertedLineBackground': '#00cab11a',
      'diffEditorGutter.removedLineBackground': '#ff2e3f1a',
      'diffEditorOverview.insertedForeground': '#00cab1',
      'diffEditorOverview.removedForeground': '#ff2e3f',
      'scrollbarSlider.background': '#1f1f1f80',
      'scrollbarSlider.hoverBackground': '#2f2f2fa0',
      'scrollbarSlider.activeBackground': '#3f3f3fc0'
    }
  })
  pierreLikeMonacoThemeRegistered = true
}

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
  cwdPending?: boolean
  openRequestedAt?: number | null
  cwdReadyAt?: number | null
  displayMode?: 'modal' | 'panel'
  panelShellMode?: 'internal' | 'external'
  onPanelShellStateChange?: (state: SubpagePanelShellState | null) => void
  taskTitle?: string
}

type GitDiffTimingSnapshot = {
  openRequestedAt: number | null
  shellShownAt: number | null
  cwdReadyAt: number | null
  diffLoadedAt: number | null
}

type DiffSplitLayout = {
  ratio: number
  originalWidth: number
  modifiedWidth: number
  originalLeft: number
  modifiedLeft: number
  gap: number
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
  isImage?: boolean
  isSvg?: boolean
  isPdf?: boolean
  isEpub?: boolean
  originalImageUrl?: string
  modifiedImageUrl?: string
  originalImageSize?: number
  modifiedImageSize?: number
  originalPreviewData?: string
  modifiedPreviewData?: string
  originalPreviewSize?: number
  modifiedPreviewSize?: number
  error?: string
}

type DiffViewAnchor = {
  line: number | null        // Modify the first visible line number in the editor
  scrollTop: number          // Editor scroll position
}

// Render-then-reveal state machine for eliminating diff scroll flash.
// Mirrors the PreviewRestorePhase pattern used by Markdown preview.
type DiffRevealPhase = 'idle' | 'waiting-diff' | 'restoring-scroll'

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

type RestoredAnchor = {
  line: number | null
  scrollTop: number
}

type CompareStatus = 'added' | 'deleted' | 'modified' | null
type ChapterKind = 'added' | 'deleted' | 'modified' | 'unchanged'

function resolveCompareStatus(container: Element | null): CompareStatus {
  if (!container) return null
  if (container.querySelector('.git-pdf-compare-status-added, .git-epub-compare-status-added')) return 'added'
  if (container.querySelector('.git-pdf-compare-status-deleted, .git-epub-compare-status-deleted')) return 'deleted'
  return 'modified'
}

// Shared DOM inspection helpers used by both GitDiffViewer and GitHistoryViewer
// debug APIs. Querying the DOM keeps these decoupled from React state and lets
// autotests verify what the user actually sees.
export function inspectPdfCompareDom() {
  const root = document.querySelector('.git-pdf-compare')
  if (!root) return { visible: false, status: null, originalSrc: null, modifiedSrc: null, originalHasEmpty: false, modifiedHasEmpty: false }
  const panes = Array.from(root.querySelectorAll('.git-pdf-compare-pane')) as HTMLElement[]
  const [leftPane, rightPane] = [panes[0] ?? null, panes[1] ?? null]
  const readSrc = (pane: HTMLElement | null) =>
    (pane?.querySelector('iframe.git-pdf-compare-frame') as HTMLIFrameElement | null)?.src ?? null
  return {
    visible: true,
    status: resolveCompareStatus(root),
    originalSrc: readSrc(leftPane),
    modifiedSrc: readSrc(rightPane),
    originalHasEmpty: Boolean(leftPane?.querySelector('.git-pdf-compare-empty')),
    modifiedHasEmpty: Boolean(rightPane?.querySelector('.git-pdf-compare-empty'))
  }
}

export function inspectEpubCompareDom() {
  const root = document.querySelector('.git-epub-compare')
  if (!root) {
    return { visible: false, status: null, chapterCount: 0, selectedHref: null, chapterBadges: [], diffCounts: null }
  }
  const chapterButtons = Array.from(root.querySelectorAll('.git-epub-compare-chapter-list > li .git-epub-compare-chapter-item')) as HTMLElement[]
  const chapterBadges = chapterButtons.map(btn => {
    const label = btn.querySelector('.git-epub-compare-chapter-label')?.textContent?.trim() ?? ''
    const cls = btn.className
    let kind: ChapterKind = 'unchanged'
    if (cls.includes('git-epub-compare-chapter-added')) kind = 'added'
    else if (cls.includes('git-epub-compare-chapter-deleted')) kind = 'deleted'
    else if (cls.includes('git-epub-compare-chapter-modified')) kind = 'modified'
    const href = btn.dataset?.href ?? ''
    return { href, label, kind }
  })
  const active = chapterButtons.find(btn => btn.classList.contains('active')) ?? null
  const selectedHref = active?.dataset?.href ?? null
  // Count diff lines in the currently visible panes. These come from the
  // annotateLines helper: .git-epub-compare-line-add / -del / -same.
  const countClass = (cls: string) => root.querySelectorAll(`.${cls}`).length
  const diffCounts = chapterButtons.length > 0
    ? { add: countClass('git-epub-compare-line-add'), del: countClass('git-epub-compare-line-del'), same: countClass('git-epub-compare-line-same') }
    : null
  return {
    visible: true,
    status: resolveCompareStatus(root),
    chapterCount: chapterButtons.length,
    selectedHref,
    chapterBadges,
    diffCounts
  }
}

type GitDiffDebugApi = {
  isOpen: () => boolean
  getFileList: () => GitFileStatus[]
  getVisibleFileList: () => GitFileStatus[]
  getRepoList: () => GitRepoContext[]
  getVisibleRepoItems: () => RepoFilterTreeItem[]
  setRepoExpanded: (repoRoot: string, expanded: boolean) => boolean
  setRepoFilter: (repoRoot: string | null) => boolean
  getSelectedFile: () => {
    filename: string
    originalFilename?: string
    status: GitFileStatus['status']
    changeType: GitFileStatus['changeType']
  } | null
  selectFileByPath: (path: string) => boolean
  selectFileByIndex: (index: number) => boolean
  isSelectedReady: () => boolean
  getRestoreNotice: () => { type: 'changed'; message: string; fileName?: string } | null
  getScrollTop: () => number
  getFirstVisibleLine: () => number
  scrollToFraction: (fraction: number) => boolean
  scrollToLine: (line: number) => boolean
  getDiffFontSize: () => number
  getCwd: () => string | null
  getRepoRoot: () => string | null
  isSubmodulesLoading: () => boolean
  getTiming: () => {
    openRequestedAt: number | null
    shellShownAt: number | null
    cwdReadyAt: number | null
    diffLoadedAt: number | null
    openToShellMs: number | null
    openToCwdReadyMs: number | null
    openToDiffLoadedMs: number | null
    cwdReadyToDiffLoadedMs: number | null
  }
  getSplitViewState: () => {
    ratio: number | null
    originalWidth: number
    modifiedWidth: number
  } | null
  setSplitViewRatio: (ratio: number) => boolean
  dragSplitViewRatio: (ratio: number) => Promise<boolean>
  getImagePreviewState: () => {
    isImage: boolean
    isSvg: boolean
    isBinary: boolean
    hasOriginalUrl: boolean
    hasModifiedUrl: boolean
    compareMode: ImageCompareMode
    displayMode: ImageDisplayMode
    loading: boolean
  } | null
  getFileActionState: () => {
    fileActionsVisible: boolean
    lineActionsVisible: boolean
    keepDisabled: boolean
    denyDisabled: boolean
    pending: boolean
  } | null
  triggerFileAction: (action: 'keep' | 'deny') => Promise<boolean>
  getPdfCompareState: () => ReturnType<typeof inspectPdfCompareDom>
  getEpubCompareState: () => ReturnType<typeof inspectEpubCompareDom>
}

function clampDiffSplitRatio(value: number): number {
  return Math.max(MIN_DIFF_SPLIT_RATIO, Math.min(MAX_DIFF_SPLIT_RATIO, value))
}

function readStoredDiffSplitRatio(): number {
  const saved = localStorage.getItem(STORAGE_KEY_DIFF_SPLIT_RATIO)
  if (!saved) return DEFAULT_DIFF_SPLIT_RATIO
  const parsed = Number(saved)
  if (!Number.isFinite(parsed)) return DEFAULT_DIFF_SPLIT_RATIO
  return clampDiffSplitRatio(parsed)
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

// Rough line-level diff stats via multiset symmetric difference. Used to keep
// the sidebar +/- counters in sync after a local save without re-fetching the
// whole repo diff. Not intended to match git's diff algorithm exactly —
// accuracy is secondary to avoiding a full refresh.
function quickLineDiffStats(original: string, modified: string): { additions: number; deletions: number } {
  if (original === modified) return { additions: 0, deletions: 0 }
  // An empty file has zero lines, not one empty line — otherwise the multiset
  // treats the single empty-string entry as a phantom add/delete pair.
  const splitLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))
  const originalLines = splitLines(original)
  const modifiedLines = splitLines(modified)
  const counts = new Map<string, number>()
  for (const line of originalLines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let additions = 0
  for (const line of modifiedLines) {
    const c = counts.get(line) ?? 0
    if (c > 0) counts.set(line, c - 1)
    else additions += 1
  }
  let deletions = 0
  for (const c of counts.values()) deletions += c
  return { additions, deletions }
}

function sortRepoContexts(a: GitRepoContext, b: GitRepoContext): number {
  if (a.isSubmodule !== b.isSubmodule) {
    return a.isSubmodule ? 1 : -1
  }
  if (a.depth !== b.depth) {
    return a.depth - b.depth
  }
  return a.label.localeCompare(b.label)
}

interface RepoFilterTreeItem extends GitRepoContext {
  treeDepth: number
  hasChildren: boolean
  expanded: boolean
  isCurrent: boolean
  displayLabel: string
}

function normalizeRepoRoot(root: string | null | undefined): string {
  return (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function getRepoTreeDepth(repo: GitRepoContext): number {
  return repo.isSubmodule ? repo.depth + 1 : 0
}

function getRepoLeafLabel(label: string): string {
  const normalized = label.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || label
}

function buildRepoFilterTreeItems(
  repos: GitRepoContext[] | undefined,
  expandedRoots: Set<string>,
  currentRoot: string | null,
  currentLabel: string,
  includeRepo: (repo: GitRepoContext) => boolean
): RepoFilterTreeItem[] {
  if (!repos || repos.length === 0) return []
  const normalizedCurrent = normalizeRepoRoot(currentRoot)
  const childrenByParent = new Map<string, GitRepoContext[]>()
  const rootRepos: GitRepoContext[] = []
  const includedRoots = new Set<string>()

  for (const repo of repos) {
    const parentRoot = normalizeRepoRoot(repo.parentRoot)
    if (repo.isSubmodule && parentRoot) {
      const existing = childrenByParent.get(parentRoot) ?? []
      existing.push(repo)
      childrenByParent.set(parentRoot, existing)
    } else {
      rootRepos.push(repo)
    }
  }

  const markIncludedWithAncestors = (repo: GitRepoContext) => {
    if (!includeRepo(repo)) return
    includedRoots.add(normalizeRepoRoot(repo.root))
    let parentRoot = normalizeRepoRoot(repo.parentRoot)
    while (parentRoot) {
      includedRoots.add(parentRoot)
      const parent = repos.find((candidate) => normalizeRepoRoot(candidate.root) === parentRoot)
      parentRoot = normalizeRepoRoot(parent?.parentRoot)
    }
  }
  repos.forEach(markIncludedWithAncestors)

  const output: RepoFilterTreeItem[] = []
  const visit = (repo: GitRepoContext) => {
    const root = normalizeRepoRoot(repo.root)
    if (!includedRoots.has(root)) return
    const children = [...(childrenByParent.get(root) ?? [])].sort(sortRepoContexts)
    const visibleChildren = children.filter((child) => includedRoots.has(normalizeRepoRoot(child.root)))
    const hasChildren = visibleChildren.length > 0
    const expanded = expandedRoots.has(root)
    const displayLabel = repo.isSubmodule ? getRepoLeafLabel(repo.label) : currentLabel
    output.push({
      ...repo,
      treeDepth: getRepoTreeDepth(repo),
      hasChildren,
      expanded,
      isCurrent: root === normalizedCurrent,
      displayLabel
    })
    if (expanded) {
      visibleChildren.forEach(visit)
    }
  }

  rootRepos.sort(sortRepoContexts).forEach(visit)
  return output
}

function getDiffPaneElement(
  editor: monacoTypes.editor.IStandaloneDiffEditor,
  side: 'original' | 'modified'
): HTMLElement | null {
  const privateElements = (editor as monacoTypes.editor.IStandaloneDiffEditor & {
    elements?: Partial<Record<'root' | 'original' | 'modified', HTMLElement>>
  }).elements
  const privatePane = privateElements?.[side]
  if (privatePane instanceof HTMLElement) {
    return privatePane
  }
  const container = editor.getContainerDomNode()
  const diffRoot = container.classList.contains('monaco-diff-editor')
    ? container
    : container.querySelector<HTMLElement>('.monaco-diff-editor')
  if (!diffRoot) return null
  for (const child of Array.from(diffRoot.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (!child.classList.contains('editor')) continue
    if (!child.classList.contains(side)) continue
    return child
  }
  return null
}

const SIGNATURE_SAMPLE_SIZE = 256
const SCROLL_RESTORE_TOLERANCE = 64

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
  cwdPending = false,
  openRequestedAt = null,
  cwdReadyAt = null,
  displayMode = 'modal',
  panelShellMode = 'internal',
  onPanelShellStateChange,
  taskTitle
}: GitDiffViewerProps) {
  const isPanel = displayMode === 'panel'
  const { getTerminalStyle } = useSettings()
  const { t } = useI18n()
  const { getUIPreferences, updateUIPreferences } = useAppState()
  const perfCountersRef = useRef({
    renders: 0,
    loadDiff: 0,
    diffViewBuild: 0
  })
  const perfIntervalRef = useRef<number | null>(null)
  const timingRef = useRef<GitDiffTimingSnapshot>({
    openRequestedAt: null,
    shellShownAt: null,
    cwdReadyAt: null,
    diffLoadedAt: null
  })
  const diffMemoryRef = useRef<Record<string, DiffViewMemory>>({})
  const diffRestoreCycleRef = useRef(0)
  const diffRestoreAppliedRef = useRef<{ cycle: number; fileKey: string | null }>({ cycle: 0, fileKey: null })
  const restoredAnchorRef = useRef<Record<string, RestoredAnchor>>({})
  const diffScrollCaptureTimerRef = useRef<number | null>(null)
  const suppressScrollCaptureRef = useRef(false)
  const [diffRestoreNotice, setDiffRestoreNotice] = useState<{
    type: 'changed'
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
  const diffSplitRatioRef = useRef<number>((() => {
    const prefs = getUIPreferences()
    if (prefs.gitDiffSplitViewRatio !== undefined) return prefs.gitDiffSplitViewRatio
    return readStoredDiffSplitRatio()
  })())
  const [diffEditorResetNonce] = useState(0)
  const [svgViewMode, setSvgViewMode] = useState<SvgViewMode>('visual')
  const [pdfViewerUrl, setPdfViewerUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const url = await window.electronAPI.appInfo?.getPdfViewerUrl?.()
        if (!cancelled && typeof url === 'string') setPdfViewerUrl(url)
      } catch {
        /* ignore — PDF diff will show a fallback message if URL unavailable */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const diffEditorRef = useRef<monacoTypes.editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof monacoTypes | null>(null)
  const diffEditorBindingDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const diffSplitMeasureFrameRef = useRef<number | null>(null)
  const isDraftDirtyRef = useRef(false)
  const autoRefreshInFlightRef = useRef(false)
  const autoRefreshQueuedRef = useRef(false)
  const selfSaveSuppressUntilRef = useRef(0)
  const originalDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const modifiedDecorationsRef = useRef<monacoTypes.editor.IEditorDecorationsCollection | null>(null)
  const selectedFileRef = useRef<GitFileStatus | null>(null)
  const lastSelectedFileRef = useRef<GitFileStatus | null>(null)
  const [diffRevealPhase, setDiffRevealPhase] = useState<DiffRevealPhase>('idle')
  const diffRevealPhaseRef = useRef<DiffRevealPhase>('idle')
  const diffRevealTimeoutRef = useRef<number | null>(null)
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const repoFilterRef = useRef<string | null>(null)
  const [expandedRepoRoots, setExpandedRepoRoots] = useState<Set<string>>(() => new Set())
  const activeCwd = useMemo(() => diffResult?.cwd || cwd, [diffResult?.cwd, cwd])
  const getFileKey = useCallback((file: GitFileStatus, repoRoot = activeCwd || '') => {
    return buildFileKey(file.repoRoot || repoRoot, file)
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
  // Keep diffRevealPhase ref in sync with state
  useEffect(() => { diffRevealPhaseRef.current = diffRevealPhase }, [diffRevealPhase])
  const cancelDiffRevealTimeout = useCallback(() => {
    if (diffRevealTimeoutRef.current !== null) {
      window.clearTimeout(diffRevealTimeoutRef.current)
      diffRevealTimeoutRef.current = null
    }
  }, [])
  const enterDiffWaiting = useCallback(() => {
    cancelDiffRevealTimeout()
    setDiffRevealPhase('waiting-diff')
    diffRevealPhaseRef.current = 'waiting-diff'
    // Safety timeout: if onDidUpdateDiff never fires (large file, Monaco stall),
    // trigger restoring-scroll so the useLayoutEffect still runs scroll restoration
    // before revealing. 2000ms accommodates large diffs on slower machines.
    diffRevealTimeoutRef.current = window.setTimeout(() => {
      if (diffRevealPhaseRef.current === 'waiting-diff') {
        setDiffRevealPhase('restoring-scroll')
        diffRevealPhaseRef.current = 'restoring-scroll'
      }
    }, 2000)
  }, [cancelDiffRevealTimeout])

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
    if (selectedFile.isSubmoduleEntry) return t('gitDiff.editDisabled.submodule')
    if (selectedFile.status === 'D') return t('gitDiff.editDisabled.deleted')
    if (selectedFile.changeType === 'staged') return t('gitDiff.editDisabled.staged')
    return ''
  }, [selectedFile, selectedFileState, t])
  const canEditFile = editDisabledReason.length === 0
  const canSaveDraft = canEditFile && isDraftDirty && !isSavingEdit
  const hasMultipleRepos = Boolean(diffResult?.repos && diffResult.repos.length > 1)
  useEffect(() => {
    const repos = diffResult?.repos ?? []
    if (repos.length === 0) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      for (const repo of repos) {
        next.add(normalizeRepoRoot(repo.root))
        if (repo.parentRoot) {
          next.add(normalizeRepoRoot(repo.parentRoot))
        }
      }
      return next
    })
  }, [diffResult?.repos])
  const visibleFileList = useMemo(() => {
    const files = diffResult?.files ?? []
    return repoFilter ? files.filter((file) => file.repoRoot === repoFilter) : files
  }, [diffResult?.files, repoFilter])
  const visibleRepoItems = useMemo(() => buildRepoFilterTreeItems(
    diffResult?.repos,
    expandedRepoRoots,
    diffResult?.cwd || cwd || null,
    t('gitDiff.repo.current'),
    (repo) => repo.changeCount > 0 || Boolean(repo.loading) || !repo.isSubmodule
  ), [cwd, diffResult?.cwd, diffResult?.repos, expandedRepoRoots, t])
  const setRepoExpanded = useCallback((repoRoot: string, expanded: boolean) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return false
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (expanded) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return next
    })
    return true
  }, [])
  const toggleRepoExpanded = useCallback((repoRoot: string) => {
    const key = normalizeRepoRoot(repoRoot)
    if (!key) return
    setExpandedRepoRoots((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])
  const updateRepoFilter = useCallback((repoRoot: string | null) => {
    repoFilterRef.current = repoRoot
    setRepoFilter(repoRoot)
    return true
  }, [])
  const confirmCloseWithDraft = useCallback(() => {
    if (!hasAnyUnsavedDraft) return true
    return window.confirm(t('gitDiff.confirm.closeWithDraft'))
  }, [hasAnyUnsavedDraft, t])
  const toggleImageDisplayMode = useCallback((mode: ImageDisplayMode) => {
    setImageDisplayMode(mode)
    localStorage.setItem(IMAGE_DISPLAY_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageDisplayMode: mode })
  }, [updateUIPreferences])
  const toggleImageCompareMode = useCallback((mode: ImageCompareMode) => {
    setImageCompareMode(mode)
    localStorage.setItem(IMAGE_COMPARE_MODE_STORAGE_KEY, mode)
    updateUIPreferences({ gitDiffImageCompareMode: mode })
  }, [updateUIPreferences])

  const persistDiffSplitRatio = useCallback((nextRatio: number) => {
    const normalized = clampDiffSplitRatio(nextRatio)
    const prev = diffSplitRatioRef.current
    if (Math.abs(prev - normalized) <= DIFF_SPLIT_RATIO_EPSILON) return prev
    diffSplitRatioRef.current = normalized
    localStorage.setItem(STORAGE_KEY_DIFF_SPLIT_RATIO, String(normalized))
    updateUIPreferences({ gitDiffSplitViewRatio: normalized })
    return normalized
  }, [updateUIPreferences])

  // --- Path copy (shared hook) ---
  const { copyMessage, copyToClipboard, flashCopyFeedback } = usePathCopy(t, 'gitDiff.copyFailed')

  const handleFilenameDblClick = useCallback(async (e: React.MouseEvent) => {
    if (!selectedFile) return
    const target = e.currentTarget as HTMLElement
    const rootCwd = selectedFile.repoRoot || activeCwd || ''
    const isAbsolute = e.altKey
    const relativePath = selectedFile.filename
    const pathToCopy = isAbsolute ? `${rootCwd}/${relativePath}` : relativePath
    const label = isAbsolute ? t('common.absolutePath') : t('common.relativePath')
    const ok = await copyToClipboard(pathToCopy, label)
    if (ok) flashCopyFeedback(target)
  }, [selectedFile, activeCwd, copyToClipboard, flashCopyFeedback, t])

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: GitFileStatus) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, targetFile: file })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const copyContextMenuPath = useCallback(async (file: GitFileStatus, kind: 'name' | 'relative' | 'absolute') => {
    const rootCwd = file.repoRoot || activeCwd || ''
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

  // File list width (read from uiPreferences, fallback to localStorage)
  const [fileListWidth, setFileListWidth] = useState(() => {
    const prefs = getUIPreferences()
    if (prefs.gitDiffFileListWidth !== undefined) return prefs.gitDiffFileListWidth
    const saved = localStorage.getItem(STORAGE_KEY_FILE_LIST_WIDTH)
    return saved ? parseInt(saved, 10) : DEFAULT_FILE_LIST_WIDTH
  })
  const isDraggingRef = useRef(false)

  // Pop-up window size (read from uiPreferences, fallback to localStorage)
  const [modalSize, setModalSize] = useState(() => {
    if (isPanel) {
      return { width: DEFAULT_MODAL_WIDTH, height: DEFAULT_MODAL_HEIGHT }
    }
    const prefs = getUIPreferences()
    if (prefs.gitDiffModalSize) {
      return { width: prefs.gitDiffModalSize.width || DEFAULT_MODAL_WIDTH, height: prefs.gitDiffModalSize.height || DEFAULT_MODAL_HEIGHT }
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

  const disposeDiffEditorBindings = useCallback(() => {
    if (diffSplitMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(diffSplitMeasureFrameRef.current)
      diffSplitMeasureFrameRef.current = null
    }
    for (const disposable of diffEditorBindingDisposablesRef.current) {
      try {
        disposable.dispose()
      } catch (error) {
        debugLog('editor:dispose-binding:error', { error: String(error) })
      }
    }
    diffEditorBindingDisposablesRef.current = []
  }, [])

  const measureDiffSplitState = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ): { ratio: number; originalWidth: number; modifiedWidth: number } | null => {
    const editor = editorOverride ?? diffEditorRef.current
    if (!editor) return null
    const originalLayoutWidth = editor.getOriginalEditor().getLayoutInfo().width
    const modifiedLayoutWidth = editor.getModifiedEditor().getLayoutInfo().width
    const layoutWidth = originalLayoutWidth + modifiedLayoutWidth
    if (layoutWidth > 0) {
      return {
        ratio: clampDiffSplitRatio(originalLayoutWidth / layoutWidth),
        originalWidth: Math.max(0, Math.round(originalLayoutWidth)),
        modifiedWidth: Math.max(0, Math.round(modifiedLayoutWidth))
      }
    }
    const layout = (() => {
      const privateElements = (editor as monacoTypes.editor.IStandaloneDiffEditor & {
        elements?: Partial<Record<'root' | 'original' | 'modified', HTMLElement>>
      }).elements
      const container = editor.getContainerDomNode()
      const diffRoot = privateElements?.root ?? (
        container.classList.contains('monaco-diff-editor')
          ? container
          : container.querySelector<HTMLElement>('.monaco-diff-editor')
      )
      const originalPane = getDiffPaneElement(editor, 'original')
      const modifiedPane = getDiffPaneElement(editor, 'modified')
      if (!diffRoot || !originalPane || !modifiedPane) return null
      const rootRect = diffRoot.getBoundingClientRect()
      const originalRect = originalPane.getBoundingClientRect()
      const modifiedRect = modifiedPane.getBoundingClientRect()
      const originalWidth = originalRect.width
      const modifiedWidth = modifiedRect.width
      const gap = Math.max(0, modifiedRect.left - originalRect.right)
      const splitLeft = originalWidth + gap
      const contentWidth = splitLeft + modifiedWidth
      if (contentWidth <= 0) return null
      return {
        ratio: clampDiffSplitRatio(splitLeft / contentWidth),
        originalWidth,
        modifiedWidth,
        originalLeft: Math.max(0, originalRect.left - rootRect.left),
        modifiedLeft: Math.max(0, modifiedRect.left - rootRect.left),
        gap
      } satisfies DiffSplitLayout
    })()
    if (!layout) return null
    return {
      ratio: layout.ratio,
      originalWidth: Math.max(0, Math.round(layout.originalWidth)),
      modifiedWidth: Math.max(0, Math.round(layout.modifiedWidth))
    }
  }, [])

  const scheduleDiffSplitMeasurement = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ) => {
    if (diffSplitMeasureFrameRef.current !== null) {
      window.cancelAnimationFrame(diffSplitMeasureFrameRef.current)
    }
    diffSplitMeasureFrameRef.current = window.requestAnimationFrame(() => {
      diffSplitMeasureFrameRef.current = null
      const measurement = measureDiffSplitState(editorOverride)
      if (!measurement) return
      persistDiffSplitRatio(measurement.ratio)
    })
  }, [measureDiffSplitState, persistDiffSplitRatio])

  const persistCurrentDiffSplitRatio = useCallback((
    editorOverride?: monacoTypes.editor.IStandaloneDiffEditor | null
  ) => {
    const measurement = measureDiffSplitState(editorOverride)
    if (!measurement) return null
    return persistDiffSplitRatio(measurement.ratio)
  }, [measureDiffSplitState, persistDiffSplitRatio])

  const dragDiffSplitRatio = useCallback(async (nextRatio: number) => {
    const editor = diffEditorRef.current
    if (!editor) return false
    const container = editor.getContainerDomNode()
    const diffRoot = container.classList.contains('monaco-diff-editor')
      ? container
      : container.querySelector<HTMLElement>('.monaco-diff-editor')
    const sash = diffRoot?.querySelector<HTMLElement>('.monaco-sash') ?? null
    const originalPane = getDiffPaneElement(editor, 'original')
    const modifiedPane = getDiffPaneElement(editor, 'modified')
    if (!diffRoot || !sash || !originalPane || !modifiedPane) return false

    const originalRect = originalPane.getBoundingClientRect()
    const modifiedRect = modifiedPane.getBoundingClientRect()
    const sashRect = sash.getBoundingClientRect()
    const contentLeft = originalRect.left
    const contentWidth = modifiedRect.right - originalRect.left
    if (contentWidth <= 0) return false

    const targetRatio = clampDiffSplitRatio(nextRatio)
    const startX = sashRect.left + (sashRect.width / 2)
    const targetX = contentLeft + (contentWidth * targetRatio)
    const clientY = sashRect.top + (sashRect.height / 2)
    const waitForFrame = () => new Promise<void>((resolve) => {
      window.setTimeout(resolve, 16)
    })
    const dispatchMouseEvent = (
      target: EventTarget,
      type: 'mousedown' | 'mousemove' | 'mouseup',
      clientX: number
    ) => {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1
      }))
    }
    const dispatchPointerEvent = (
      target: EventTarget,
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      clientX: number
    ) => {
      if (typeof window.PointerEvent !== 'function') return
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      }))
    }

    const steps = 8
    dispatchPointerEvent(sash, 'pointerdown', startX)
    dispatchMouseEvent(sash, 'mousedown', startX)
    await waitForFrame()

    for (let step = 1; step <= steps; step += 1) {
      const nextX = startX + (((targetX - startX) * step) / steps)
      dispatchPointerEvent(document, 'pointermove', nextX)
      dispatchMouseEvent(document, 'mousemove', nextX)
      await waitForFrame()
    }

    dispatchPointerEvent(document, 'pointerup', targetX)
    dispatchMouseEvent(document, 'mouseup', targetX)
    dispatchPointerEvent(window, 'pointerup', targetX)
    dispatchMouseEvent(window, 'mouseup', targetX)
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 150)
    })

    const measurement = measureDiffSplitState(editor)
    return Boolean(measurement && Math.abs(measurement.ratio - targetRatio) <= 0.08)
  }, [measureDiffSplitState])

  const detachDiffEditor = useCallback(() => {
    disposeDiffEditorBindings()
    const editor = diffEditorRef.current
    const modelUrisToDispose = new Set<string>()
    if (editor) {
      const model = editor.getModel()
      if (model?.original) modelUrisToDispose.add(model.original.uri.toString())
      if (model?.modified) modelUrisToDispose.add(model.modified.uri.toString())
      try {
        editor.setModel(null)
      } catch (error) {
        debugLog('editor:detach:error', { error: String(error) })
      }
      try {
        editor.dispose()
      } catch (error) {
        debugLog('editor:dispose:error', { error: String(error) })
      }
    }
    const monaco = monacoRef.current
    if (monaco && modelUrisToDispose.size > 0) {
      window.setTimeout(() => {
        for (const model of monaco.editor.getModels()) {
          if (!model.uri.toString().startsWith('inmemory://model/onward-git-diff/')) continue
          if (!modelUrisToDispose.has(model.uri.toString())) continue
          try {
            model.dispose()
          } catch (error) {
            debugLog('editor:model-dispose:error', { error: String(error), uri: model.uri.toString() })
          }
        }
      }, 100)
    }
    originalDecorationsRef.current?.clear()
    modifiedDecorationsRef.current?.clear()
    originalDecorationsRef.current = null
    modifiedDecorationsRef.current = null
    diffEditorRef.current = null
    monacoRef.current = null
  }, [disposeDiffEditorBindings])

  // Load Git Diff data
  const resetViewerState = useCallback(() => {
    setDiffResult(null)
    setSelectedFile(null)
    setFileContents({})
    repoFilterRef.current = null
    setRepoFilter(null)
    setExpandedRepoRoots(new Set())
    setActionMessage(null)
    setLineMessage(null)
    setSelectedLineRange(null)
    setLineActionState(null)
    setEditMessage(null)
    setIsSavingEdit(false)
    detachDiffEditor()
  }, [detachDiffEditor])

  const applyLoadedDiffResult = useCallback((
    result: GitDiffResult,
    sourceCwd: string,
    previousSelection: GitFileStatus | null
  ) => {
    setDiffResult(result)
    lastDiffRef.current = {
      cwd: result.cwd || sourceCwd,
      originalCwd: sourceCwd,
      at: Date.now(),
      result
    }

    const repoRoot = result.cwd || sourceCwd
    const nextKeys = new Set(result.files.map((file) => buildFileKey(file.repoRoot || repoRoot, file)))
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

    setFileContents((prev) => {
      const next: Record<string, FileContentState> = {}
      for (const key of nextKeys) {
        if (prev[key]) {
          next[key] = prev[key]
        }
      }
      return next
    })

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
          ? result.files.find((file) => buildFileKey(file.repoRoot || repoRoot, file) === memorySelectedKey)
          : null)
      const previous = previousSelection
      const matched = memoryMatched || (previous
        ? result.files.find((file) => file.filename === previous.filename && file.changeType === previous.changeType)
        : null)
      const fallback = (!matched && previous)
        ? result.files.find((file) => file.filename === previous.filename &&
          (file.originalFilename ?? '') === (previous.originalFilename ?? ''))
        : null
      // Guard: skip setSelectedFile when the same file is already selected
      // (e.g., submodule stage-2 load arriving with unchanged file selection).
      // This prevents unnecessary Monaco editor remount and visual flash.
      const nextFile = matched || fallback || result.files[0]
      const currentKey = selectedFileRef.current ? getFileKey(selectedFileRef.current) : null
      const nextKey = nextFile ? buildFileKey(nextFile.repoRoot || repoRoot, nextFile) : null
      if (nextKey !== currentKey) {
        setSelectedFile(nextFile)
      } else if (nextFile) {
        selectedFileRef.current = nextFile
      }
    } else {
      setSelectedFile(null)
    }
    const currentRepoFilter = repoFilterRef.current
    if (result.files.length > 0 && currentRepoFilter && !result.files.some((file) => file.repoRoot === currentRepoFilter)) {
      repoFilterRef.current = null
      setRepoFilter(null)
    }
  }, [getMemoryKey, t])

  const loadDiff = useCallback(async (options?: { reset?: boolean; silent?: boolean; force?: boolean }) => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.loadDiff += 1
    }
    const previousSelection = lastSelectedFileRef.current || selectedFileRef.current
    if (!cwd) {
      if (cwdPending) {
        setDiffResult(null)
        return
      }
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
        if (age < 800 && !cached.result.submodulesLoading) {
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
      const stagedLoad = Boolean(options?.reset)
      const initialScope = stagedLoad ? 'root-only' : 'full'
      const initialResult = await window.electronAPI.git.getDiff(cwd, { scope: initialScope })
      if (loadTokenRef.current !== currentToken) return

      // When submodules are still loading, defer UI update to avoid an
      // intermediate flash (placeholder → root-only list → full list).
      // Instead, show placeholder until the full result arrives.
      const deferForSubmodules = stagedLoad && initialResult.success && initialResult.submodulesLoading
      if (!deferForSubmodules) {
        applyLoadedDiffResult(initialResult, cwd, previousSelection)
      } else {
        // Expose the nested repository outline while suppressing the partial
        // root-only file list until the full recursive diff is ready.
        setDiffResult({ ...initialResult, files: [] })
      }
      debugLog('diff:load:done', {
        cwd: initialResult.cwd || cwd,
        token: currentToken,
        stage: initialScope,
        success: initialResult.success,
        fileCount: initialResult.files?.length ?? 0,
        duration: Math.round(performance.now() - start),
        submodulesLoading: Boolean(initialResult.submodulesLoading),
        deferred: deferForSubmodules
      })

      if (!deferForSubmodules && timingRef.current.diffLoadedAt === null) {
        timingRef.current = {
          ...timingRef.current,
          diffLoadedAt: performance.now()
        }
      }

      if (deferForSubmodules) {
        const fullResult = await window.electronAPI.git.getDiff(cwd, { scope: 'full' })
        if (loadTokenRef.current !== currentToken) return
        applyLoadedDiffResult(
          fullResult,
          cwd,
          previousSelection
        )
        if (timingRef.current.diffLoadedAt === null) {
          timingRef.current = {
            ...timingRef.current,
            diffLoadedAt: performance.now()
          }
        }
        debugLog('diff:load:done', {
          cwd: fullResult.cwd || cwd,
          token: currentToken,
          stage: 'full',
          success: fullResult.success,
          fileCount: fullResult.files?.length ?? 0,
          duration: Math.round(performance.now() - start),
          submodulesLoading: Boolean(fullResult.submodulesLoading)
        })
      }
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
  }, [applyLoadedDiffResult, cwd, cwdPending, resetViewerState, t])

  const loadDiffFromRoot = useCallback(async (rootPath: string) => {
    if (!rootPath) return
    repoFilterRef.current = null
    setRepoFilter(null)
    resetViewerState()
    const result = await window.electronAPI.git.getDiff(rootPath)
    setDiffResult(result)
    lastDiffRef.current = {
      cwd: result.cwd || rootPath,
      originalCwd: rootPath,
      at: Date.now(),
      result
    }
    if (result.success && result.files.length > 0) {
      setSelectedFile(result.files[0])
    } else {
      setSelectedFile(null)
    }
  }, [resetViewerState])

  // Synchronously clear stale state before paint to prevent old diff flash
  useLayoutEffect(() => {
    if (isOpen) {
      timingRef.current = {
        openRequestedAt,
        shellShownAt: performance.now(),
        cwdReadyAt,
        diffLoadedAt: null
      }
      resetViewerState()
    }
  }, [cwdReadyAt, isOpen, openRequestedAt, resetViewerState])

  useEffect(() => {
    if (!isOpen) return
    timingRef.current = {
      ...timingRef.current,
      openRequestedAt,
      cwdReadyAt
    }
  }, [cwdReadyAt, isOpen, openRequestedAt])

  // Load data when opening (async, after paint)
  useEffect(() => {
    if (isOpen) {
      loadDiff({ reset: true })
    }
  }, [isOpen, loadDiff])

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
        updateUIPreferences({ gitDiffFileListWidth: fileListWidth })
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
        updateUIPreferences({ gitDiffModalSize: modalSizeRef.current })
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
      updateUIPreferences({ gitDiffModalSize: modalSize })
    }
  }, [isPanel, modalSize, updateUIPreferences])

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
          changeType: file.changeType,
          isSubmoduleEntry: file.isSubmoduleEntry
        }, file.repoRoot)

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
              isBinary: false,
              isImage: false,
              isSvg: false,
              originalImageUrl: undefined,
              modifiedImageUrl: undefined,
              originalImageSize: undefined,
              modifiedImageSize: undefined
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
              isBinary: result.isBinary,
              isImage: result.isImage,
              isSvg: result.isSvg,
              isPdf: result.isPdf,
              isEpub: result.isEpub,
              originalImageUrl: result.originalImageUrl,
              modifiedImageUrl: result.modifiedImageUrl,
              originalImageSize: result.originalImageSize,
              modifiedImageSize: result.modifiedImageSize,
              originalPreviewData: result.originalPreviewData,
              modifiedPreviewData: result.modifiedPreviewData,
              originalPreviewSize: result.originalPreviewSize,
              modifiedPreviewSize: result.modifiedPreviewSize
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
            isBinary: false,
            isImage: false,
            isSvg: false,
            originalImageUrl: undefined,
            modifiedImageUrl: undefined,
            originalImageSize: undefined,
            modifiedImageSize: undefined
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

  // --- Auto-refresh when the working-tree file changes externally ---
  const handleAutoRefresh = useCallback(async (changeType: 'changed' | 'deleted') => {
    if (!activeCwd) return

    // File deleted externally — refresh the diff list so the sidebar
    // reflects the removal. No content reload needed.
    if (changeType === 'deleted') {
      debugLog('auto-refresh:file-deleted')
      void loadDiff({ silent: true, force: true })
      return
    }

    // changeType === 'changed'
    if (!selectedFile) return

    // Don't overwrite unsaved user edits.
    if (isDraftDirtyRef.current) {
      debugLog('auto-refresh:skip:draft-dirty')
      return
    }

    // Skip watcher-driven refresh for a short window after a local save —
    // the save path already updates state in place, and letting the watcher
    // through would cause the exact full-refresh flicker we're avoiding.
    if (Date.now() < selfSaveSuppressUntilRef.current) {
      debugLog('auto-refresh:skip:self-save')
      return
    }

    if (autoRefreshInFlightRef.current) {
      autoRefreshQueuedRef.current = true
      return
    }

    autoRefreshInFlightRef.current = true
    suppressScrollCaptureRef.current = true
    debugLog('auto-refresh:start', selectedFile.filename)

    try {
      // Capture current scroll position before reload.
      const editor = diffEditorRef.current
      const scrollTop = editor?.getModifiedEditor().getScrollTop() ?? 0

      // Force-reload original + modified content from git.
      await ensureFileContent(selectedFile, true)

      // Update the signature in the memory store so the reveal phase
      // does not show "content changed completely".
      const memory = getMemoryStore()
      const fileKey = selectedFileKey
      if (memory && fileKey) {
        const entry = memory.entries[fileKey]
        const fileState = fileContentsRef.current[fileKey]
        if (entry && fileState && !fileState.isBinary) {
          entry.signature = buildDiffSignature(
            fileState.originalContent ?? '',
            fileState.draftContent ?? fileState.modifiedContent ?? ''
          )
          entry.scrollTop = scrollTop
        }
      }

      // Restore scroll position after Monaco processes the new content.
      requestAnimationFrame(() => {
        const currentEditor = diffEditorRef.current?.getModifiedEditor()
        if (currentEditor && scrollTop > 0) {
          currentEditor.setScrollTop(scrollTop)
        }
        suppressScrollCaptureRef.current = false
      })

      // Also refresh the diff file list so sidebar stats (+/- counts)
      // stay up-to-date with the actual content.
      void loadDiff({ silent: true, force: true })

      debugLog('auto-refresh:done', selectedFile.filename)
    } finally {
      autoRefreshInFlightRef.current = false
      if (autoRefreshQueuedRef.current) {
        autoRefreshQueuedRef.current = false
        setTimeout(() => void handleAutoRefresh('changed'), 0)
      }
    }
  }, [selectedFile, selectedFileKey, activeCwd, ensureFileContent, getMemoryStore, loadDiff])

  useGitDiffFileWatch({
    isOpen,
    selectedFile,
    repoRoot: selectedFile?.repoRoot || activeCwd || null,
    onFileChanged: handleAutoRefresh
  })

  const handleFileSelect = useCallback((file: GitFileStatus) => {
    const nextKey = getFileKey(file)
    const memory = getMemoryStore()
    if (selectedFileKey && nextKey !== selectedFileKey) {
      captureDiffView(selectedFileKey)
      setDiffRestoreNotice(null)
    }
    if (selectedFileKey && nextKey !== selectedFileKey && isDraftDirty) {
      const confirmed = window.confirm(t('gitDiff.confirm.switchFileWithDraft'))
      if (!confirmed) return
    }
    if (selectedFileKey && nextKey !== selectedFileKey) {
      const editor = diffEditorRef.current
      if (editor) {
        suppressScrollCaptureRef.current = true
        originalDecorationsRef.current?.clear()
        modifiedDecorationsRef.current?.clear()
        window.setTimeout(() => {
          suppressScrollCaptureRef.current = false
        }, 0)
      }
      // Begin render-then-reveal cycle for the new file
      enterDiffWaiting()
    }
    if (memory) {
      const previousEntry = memory.entries[nextKey]
      memory.entries[nextKey] = {
        fileKey: nextKey,
        filePath: file.filename,
        originalFilename: file.originalFilename,
        anchor: previousEntry?.anchor ?? null,
        scrollTop: previousEntry?.scrollTop ?? 0,
        signature: previousEntry?.signature ?? null,
        updatedAt: Date.now()
      }
      memory.selectedFileKey = nextKey
    }
    setSelectedFile(file)
  }, [captureDiffView, enterDiffWaiting, getFileKey, getMemoryStore, isDraftDirty, selectedFileKey, t])

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

  const scheduleDiffRestore = useCallback((editor: monacoTypes.editor.IStandaloneDiffEditor) => {
    suppressScrollCaptureRef.current = true
    window.setTimeout(() => {
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

      const modifiedEditor = editor.getModifiedEditor()
      const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 0
      let targetLine = entry.anchor?.line ?? null
      if (targetLine !== null) {
        if (lineCount <= 0) {
          window.setTimeout(() => {
            scheduleDiffRestore(editor)
          }, 40)
          return
        }
        targetLine = Math.max(1, Math.min(targetLine, lineCount))
      }

      restoredAnchorRef.current[fileKey] = {
        line: targetLine,
        scrollTop: entry.scrollTop
      }

      if (targetLine) {
        debugLog('restore:line', { fileKey, line: targetLine })
      }

      if (entry.scrollTop > 0) {
        const applyScrollTop = (attempt: number) => {
          const currentEditor = diffEditorRef.current?.getModifiedEditor()
          if (!currentEditor) return
          currentEditor.setScrollTop(entry.scrollTop)
          if (attempt < 2 && Math.abs(currentEditor.getScrollTop() - entry.scrollTop) > 1) {
            window.requestAnimationFrame(() => applyScrollTop(attempt + 1))
            return
          }
          debugLog('restore:scrollTop-adjust', {
            fileKey,
            scrollTop: entry.scrollTop,
            actualScrollTop: currentEditor.getScrollTop(),
            attempts: attempt + 1
          })
        }
        window.requestAnimationFrame(() => applyScrollTop(0))
        window.setTimeout(() => applyScrollTop(0), 120)
      } else if (targetLine) {
        modifiedEditor.revealLineNearTop(targetLine)
      } else if (entry.scrollTop > 0) {
        modifiedEditor.setScrollTop(entry.scrollTop)
        debugLog('restore:scrollTop', { fileKey, scrollTop: entry.scrollTop })
      }
      diffRestoreAppliedRef.current = { cycle: currentCycle, fileKey }
      setDiffRestoreNotice(null)
      window.setTimeout(() => {
        suppressScrollCaptureRef.current = false
      }, 200)
    }, 80)
  }, [findMemoryEntry, getFileKey, getMemoryStore, t])

  const handleEditorDidMount = useCallback(
    (editor: monacoTypes.editor.IStandaloneDiffEditor, monaco: typeof monacoTypes) => {
      disposeDiffEditorBindings()
      diffEditorRef.current = editor
      monacoRef.current = monaco

      // Apply persisted split ratio once at mount. Do NOT keep it in
      // diffEditorOptions — otherwise any options-identity change would
      // re-apply the initial ratio and reset the user's drag.
      editor.updateOptions({ splitViewDefaultRatio: diffSplitRatioRef.current })

      // Begin render-then-reveal cycle: editor just mounted, hide until diff is computed
      enterDiffWaiting()

      // Transition from waiting-diff to restoring-scroll when Monaco finishes computing changes
      diffEditorBindingDisposablesRef.current.push(editor.onDidUpdateDiff(() => {
        if (diffRevealPhaseRef.current === 'waiting-diff') {
          setDiffRevealPhase('restoring-scroll')
          diffRevealPhaseRef.current = 'restoring-scroll'
        }
      }))

      // Reset decoration refs (the old editor was destroyed, the old collection is no longer valid)
      originalDecorationsRef.current = null
      modifiedDecorationsRef.current = null

      const originalEditor = editor.getOriginalEditor()
      const modifiedEditor = editor.getModifiedEditor()

      // Monitor content changes in the editor on the right (direct editing, automatic draft maintenance)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeModelContent(() => {
        const value = modifiedEditor.getValue()
        handleDraftChange(value)
      }))

      // Auxiliary: Convert editor selection to row selection range
      const handleCursorSelection = (
        side: SelectionSide,
        selection: monacoTypes.Selection
      ) => {
        // Skip row selection when there are unsaved drafts to avoid confusion between editing text and row-level operation status
        if (isDraftDirtyRef.current) return

        const targetEditor = side === 'deletions' ? originalEditor : modifiedEditor
        const lineCount = targetEditor.getModel()?.getLineCount() ?? 0
        if (lineCount <= 0) {
          setSelectedLineRange(null)
          originalDecorationsRef.current?.clear()
          modifiedDecorationsRef.current?.clear()
          return
        }

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

        const start = Math.max(1, Math.min(Math.min(startLine, endLine), lineCount))
        const end = Math.max(start, Math.min(Math.max(startLine, endLine), lineCount))

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
      diffEditorBindingDisposablesRef.current.push(originalEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('deletions', e.selection)
      }))

      // Register selection changes in the modification editor (right = additions)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidChangeCursorSelection((e) => {
        if (e.reason === monaco.editor.CursorChangeReason.RecoverFromMarkers) return
        handleCursorSelection('additions', e.selection)
      }))

      // Scroll capture (replacing DOM scroll monitoring)
      diffEditorBindingDisposablesRef.current.push(modifiedEditor.onDidScrollChange(() => {
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
      }))

      const handlePointerRelease = () => {
        scheduleDiffSplitMeasurement(editor)
      }
      window.addEventListener('mouseup', handlePointerRelease)
      window.addEventListener('pointerup', handlePointerRelease)
      diffEditorBindingDisposablesRef.current.push({
        dispose: () => {
          window.removeEventListener('mouseup', handlePointerRelease)
          window.removeEventListener('pointerup', handlePointerRelease)
        }
      })

      // Scroll restoration is now handled by the DiffRevealPhase useLayoutEffect
      // when onDidUpdateDiff fires → restoring-scroll → synchronous scroll + reveal.
    },
    [disposeDiffEditorBindings, enterDiffWaiting, handleDraftChange, scheduleDiffSplitMeasurement]
  )

  // When the selected file changes (not draft edits), enter waiting-diff so the
  // onDidUpdateDiff → restoring-scroll → reveal cycle can proceed.
  // Intentionally depends only on selectedFileKey (not selectedFileState) to avoid
  // re-entering the reveal cycle on every draft keystroke.
  useEffect(() => {
    if (!isOpen || !selectedFileKey) return
    const editor = diffEditorRef.current
    if (!editor) return
    if (diffRevealPhaseRef.current === 'idle') {
      enterDiffWaiting()
    }
  }, [isOpen, enterDiffWaiting, selectedFileKey])

  // Render-then-reveal: restore scroll position synchronously before paint,
  // then transition to idle so CSS fade-in reveals the content.
  useLayoutEffect(() => {
    if (diffRevealPhase !== 'restoring-scroll') return

    const editor = diffEditorRef.current
    if (!editor) {
      setDiffRevealPhase('idle')
      diffRevealPhaseRef.current = 'idle'
      return
    }

    suppressScrollCaptureRef.current = true

    const file = selectedFileRef.current
    const fileKey = file ? getFileKey(file) : null
    const memory = getMemoryStore()
    let scrollApplied = false

    if (file && fileKey && memory) {
      const entry = findMemoryEntry(memory, file, fileKey)
      if (entry) {
        const headerTitle = file.originalFilename && (file.status === 'R' || file.status === 'C')
          ? `${file.originalFilename} → ${file.filename}`
          : file.filename

        if (file.status === 'D') {
          diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
        } else {
          // Check signature to detect content changes
          const currentFileState = fileContentsRef.current[fileKey]
          if (entry.signature && currentFileState && !currentFileState.isBinary) {
            const currentSignature = buildDiffSignature(
              currentFileState.originalContent ?? '',
              currentFileState.draftContent ?? currentFileState.modifiedContent ?? ''
            )
            if (currentSignature !== entry.signature) {
              diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
              setDiffRestoreNotice({
                type: 'changed',
                message: t('gitDiff.restore.changedLocation', { fileName: headerTitle }),
                fileName: headerTitle
              })
              // Content changed — abort scroll restoration, let user land at first change
              cancelDiffRevealTimeout()
              setDiffRevealPhase('idle')
              diffRevealPhaseRef.current = 'idle'
              window.setTimeout(() => { suppressScrollCaptureRef.current = false }, 200)
              return
            }
          }

          // Apply saved scroll position
          if (entry.scrollTop > 0) {
            const modifiedEditor = editor.getModifiedEditor()
            modifiedEditor.setScrollTop(entry.scrollTop)
            restoredAnchorRef.current[fileKey] = {
              line: entry.anchor?.line ?? null,
              scrollTop: entry.scrollTop
            }
            scrollApplied = true
          } else if (entry.anchor?.line) {
            const modifiedEditor = editor.getModifiedEditor()
            const lineCount = modifiedEditor.getModel()?.getLineCount() ?? 0
            const targetLine = Math.max(1, Math.min(entry.anchor.line, lineCount || 1))
            modifiedEditor.revealLineNearTop(targetLine)
            restoredAnchorRef.current[fileKey] = {
              line: targetLine,
              scrollTop: 0
            }
            scrollApplied = true
          }

          diffRestoreAppliedRef.current = { cycle: diffRestoreCycleRef.current, fileKey }
          setDiffRestoreNotice(null)
        }
      }
    }

    if (!scrollApplied) {
      // No saved position: jump to first change
      const changes = editor.getLineChanges()
      if (changes && changes.length > 0) {
        const firstChange = changes[0]
        const targetLine = firstChange.modifiedStartLineNumber || firstChange.originalStartLineNumber || 1
        editor.getModifiedEditor().revealLineNearTop(targetLine)
      }
    }

    // Transition to idle — CSS fade-in reveals content
    cancelDiffRevealTimeout()
    setDiffRevealPhase('idle')
    diffRevealPhaseRef.current = 'idle'

    // Release scroll capture suppression after a brief delay
    window.setTimeout(() => {
      suppressScrollCaptureRef.current = false
    }, 200)
  }, [diffRevealPhase, cancelDiffRevealTimeout, findMemoryEntry, getFileKey, getMemoryStore, t])

  useEffect(() => {
    return () => {
      disposeDiffEditorBindings()
      cancelDiffRevealTimeout()
    }
  }, [disposeDiffEditorBindings, cancelDiffRevealTimeout])

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
      // Suppress the upcoming file-watch 'changed' event triggered by our own
      // save. The main-process watcher already calls suppressNext on this path,
      // but timing is platform-dependent — this client-side window is a belt
      // and braces against races.
      selfSaveSuppressUntilRef.current = Date.now() + 800
      const originalContent = selectedFileState.originalContent ?? ''
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
      // Patch sidebar +/- stats locally — avoid the full loadDiff({force:true})
      // round-trip which otherwise re-builds diffResult, re-keys fileContents,
      // and causes the whole UI to flicker on save. VS Code-style minimal update.
      const { additions, deletions } = quickLineDiffStats(originalContent, draft)
      if (additions === 0 && deletions === 0) {
        // Save brought the file back to its original content — git no longer
        // considers it a change, so the entry should leave the sidebar. Let
        // the authoritative diff refresh remove it; our suppress window
        // continues to short-circuit the concurrent file-watcher path.
        await loadDiff({ silent: true, force: true })
      } else {
        setDiffResult((prev) => {
          if (!prev) return prev
          let mutated = false
          const files = prev.files.map((f) => {
            const key = buildFileKey(f.repoRoot || prev.cwd || '', f)
            if (key !== selectedFileKey) return f
            if (f.additions === additions && f.deletions === deletions) return f
            mutated = true
            return { ...f, additions, deletions }
          })
          return mutated ? { ...prev, files } : prev
        })
      }
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
      const result: GitFileActionResult = await window.electronAPI.git.stageFile(activeCwd, selectedFile.filename, selectedFile.repoRoot)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.stageFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.keepStaged') : t('gitDiff.action.staged')
        setActionMessage({ type: 'success', text: message })
        await loadDiff({ force: true })
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
        status: selectedFile.status,
        isSubmoduleEntry: selectedFile.isSubmoduleEntry
      }, selectedFile.repoRoot)
      if (!result.success) {
        setActionMessage({ type: 'error', text: result.error || t('gitDiff.error.discardFailed') })
      } else {
        const message = selectedFile.changeType === 'staged' ? t('gitDiff.action.unstaged') : t('gitDiff.action.discarded')
        setActionMessage({ type: 'success', text: message })
        await loadDiff({ force: true })
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
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    onClose()
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, isOpen, onClose, persistCurrentDiffSplitRatio])

  useEffect(() => {
    const handleCloseEvent = (event: Event) => {
      const customEvent = event as CustomEvent<{ terminalId?: string }>
      if (!customEvent.detail?.terminalId) return
      if (customEvent.detail.terminalId !== terminalId) return
      requestClose()
    }

    window.addEventListener('git-diff:close', handleCloseEvent as EventListener)
    return () => {
      window.removeEventListener('git-diff:close', handleCloseEvent as EventListener)
    }
  }, [requestClose, terminalId])

  const handleOpenHistory = useCallback(() => {
    if (!terminalId) return
    if (!confirmCloseWithDraft()) return
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    const detail: SubpageNavigateEventDetail = { terminalId, target: 'history' }
    window.dispatchEvent(new CustomEvent('subpage:navigate', { detail }))
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, persistCurrentDiffSplitRatio, terminalId])

  const handleOpenEditor = useCallback(() => {
    if (!terminalId) return
    if (!confirmCloseWithDraft()) return
    const activeFile = selectedFileRef.current ?? selectedFile
    const detail: ProjectEditorOpenEventDetail = {
      terminalId,
      filePath: activeFile?.filename ?? null,
      repoRoot: activeFile?.repoRoot || diffResult?.cwd || activeCwd || null
    }
    persistCurrentDiffSplitRatio()
    captureDiffView()
    detachDiffEditor()
    setDiffRestoreNotice(null)
    window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
      detail: {
        terminalId: detail.terminalId,
        target: 'editor',
        filePath: detail.filePath,
        repoRoot: detail.repoRoot
      }
    }))
  }, [
    activeCwd,
    captureDiffView,
    confirmCloseWithDraft,
    detachDiffEditor,
    diffResult?.cwd,
    persistCurrentDiffSplitRatio,
    selectedFile,
    terminalId
  ])

  const handleSelectSubpage = useCallback((target: SubpageId) => {
    if (target === 'editor') {
      // SubpageSwitcher is a view switch — let Editor restore its own state
      // rather than overriding it with the Diff's selected file.
      if (!terminalId) return
      if (!confirmCloseWithDraft()) return
      persistCurrentDiffSplitRatio()
      captureDiffView()
      detachDiffEditor()
      setDiffRestoreNotice(null)
      window.dispatchEvent(new CustomEvent<SubpageNavigateEventDetail>('subpage:navigate', {
        detail: { terminalId, target: 'editor' }
      }))
      return
    }
    if (target === 'history') {
      handleOpenHistory()
    }
  }, [captureDiffView, confirmCloseWithDraft, detachDiffEditor, handleOpenHistory, persistCurrentDiffSplitRatio, terminalId])

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
  const isImageVisualPreview = Boolean(selectedFileState?.isImage && (selectedFileState.isBinary || (selectedFileState.isSvg && svgViewMode === 'visual')))
  const canUseLineActions = !!selectedFile &&
    !!selectedFileState &&
    !selectedFileState.loading &&
    !selectedFileState.error &&
    !selectedFileState.isBinary &&
    (!selectedFile.repoRoot || selectedFile.repoRoot === diffResult?.cwd) &&
    !isDraftDirty &&
    selectedFile.changeType !== 'untracked' &&
    selectedFile.status !== 'D'
  const canShowLineActionPanel = Boolean(selectedFile && !isImageVisualPreview && !selectedFile.isSubmoduleEntry)
  const canShowFileActionPanel = Boolean(selectedFile)
  const canShowEditActionPanel = Boolean(!isImageVisualPreview && (isDraftDirty || editMessage))
  const diffFontSize = getTerminalStyle(terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE
  const diffEditorOptions = useMemo(() => ({
    renderSideBySide: true,
    useInlineViewWhenSpaceIsLimited: false,
    enableSplitViewResizing: true,
    readOnly: !canEditFile,
    originalEditable: false,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    diffWordWrap: 'on' as const,
    fontFamily: PIERRE_LIKE_MONACO_FONT,
    fontSize: diffFontSize,
    lineHeight: Math.round(diffFontSize * 1.5),
    renderIndicators: true,
    renderMarginRevertIcon: false,
    diffAlgorithm: 'advanced' as const,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    hideUnchangedRegions: {
      enabled: true,
      minimumLineCount: 3,
      contextLineCount: 3,
      revealLineCount: 20
    }
  }), [diffFontSize, canEditFile])

  useEffect(() => {
    if (!window.electronAPI?.debug?.autotest) return
    if (!isOpen) {
      if ((window as any).__onwardGitDiffDebugTerminalId === terminalId) {
        delete (window as any).__onwardGitDiffDebug
        delete (window as any).__onwardGitDiffDebugTerminalId
      }
      return
    }
    const api: GitDiffDebugApi = {
      isOpen: () => isOpen,
      getFileList: () => diffResult?.files ?? [],
      getVisibleFileList: () => visibleFileList,
      getRepoList: () => diffResult?.repos ?? [],
      getVisibleRepoItems: () => visibleRepoItems,
      setRepoExpanded,
      setRepoFilter: updateRepoFilter,
      getSelectedFile: () => (selectedFile ? {
        filename: selectedFile.filename,
        originalFilename: selectedFile.originalFilename,
        status: selectedFile.status,
        changeType: selectedFile.changeType
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
        const file = selectedFileRef.current
        const fileKey = file ? getFileKey(file) : null
        const restoredAnchor = fileKey ? restoredAnchorRef.current[fileKey] : null
        const currentScrollTop = editor.getModifiedEditor().getScrollTop()
        if (restoredAnchor?.line && Math.abs(currentScrollTop - restoredAnchor.scrollTop) <= SCROLL_RESTORE_TOLERANCE) {
          return restoredAnchor.line
        }
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
      getDiffFontSize: () => getTerminalStyle(terminalId)?.gitDiffFontSize ?? DEFAULT_GIT_DIFF_FONT_SIZE,
      getCwd: () => activeCwd || null,
      getRepoRoot: () => diffResult?.cwd || null,
      isSubmodulesLoading: () => Boolean(diffResult?.submodulesLoading),
      getTiming: () => {
        const timing = timingRef.current
        return {
          openRequestedAt: timing.openRequestedAt,
          shellShownAt: timing.shellShownAt,
          cwdReadyAt: timing.cwdReadyAt,
          diffLoadedAt: timing.diffLoadedAt,
          openToShellMs: timing.openRequestedAt !== null && timing.shellShownAt !== null
            ? Math.round(timing.shellShownAt - timing.openRequestedAt)
            : null,
          openToCwdReadyMs: timing.openRequestedAt !== null && timing.cwdReadyAt !== null
            ? Math.round(timing.cwdReadyAt - timing.openRequestedAt)
            : null,
          openToDiffLoadedMs: timing.openRequestedAt !== null && timing.diffLoadedAt !== null
            ? Math.round(timing.diffLoadedAt - timing.openRequestedAt)
            : null,
          cwdReadyToDiffLoadedMs: timing.cwdReadyAt !== null && timing.diffLoadedAt !== null
            ? Math.round(timing.diffLoadedAt - timing.cwdReadyAt)
            : null
        }
      },
      getSplitViewState: () => measureDiffSplitState(),
      setSplitViewRatio: (ratio: number) => {
        if (!Number.isFinite(ratio)) return false
        const editor = diffEditorRef.current
        if (!editor) return false
        const normalized = persistDiffSplitRatio(ratio)
        editor.updateOptions({ splitViewDefaultRatio: normalized })
        return true
      },
      dragSplitViewRatio: async (ratio: number) => dragDiffSplitRatio(ratio),
      getImagePreviewState: () => {
        const key = selectedFileKey
        if (!key) return null
        const state = fileContentsRef.current[key]
        if (!state) return null
        return {
          isImage: Boolean(state.isImage),
          isSvg: Boolean(state.isSvg),
          isBinary: state.isBinary,
          hasOriginalUrl: Boolean(state.originalImageUrl),
          hasModifiedUrl: Boolean(state.modifiedImageUrl),
          compareMode: imageCompareMode,
          displayMode: imageDisplayMode,
          loading: state.loading
        }
      },
      getFileActionState: () => {
        if (!selectedFile) return null
        return {
          fileActionsVisible: canShowFileActionPanel,
          lineActionsVisible: canShowLineActionPanel,
          keepDisabled: !selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty,
          denyDisabled: !selectedFileState || selectedFileState.loading || isActionPending || isDraftDirty,
          pending: isActionPending
        }
      },
      triggerFileAction: async (action: 'keep' | 'deny') => {
        if (!selectedFile) return false
        if (action === 'keep') {
          await handleKeep()
          return true
        }
        await handleDeny()
        return true
      },
      getPdfCompareState: () => inspectPdfCompareDom(),
      getEpubCompareState: () => inspectEpubCompareDom()
    }
    ;(window as any).__onwardGitDiffDebug = api
    ;(window as any).__onwardGitDiffDebugTerminalId = terminalId
    return () => {
      if ((window as any).__onwardGitDiffDebug === api) {
        delete (window as any).__onwardGitDiffDebug
        delete (window as any).__onwardGitDiffDebugTerminalId
      }
    }
  }, [
    activeCwd,
    diffRestoreNotice,
    diffResult,
    visibleFileList,
    visibleRepoItems,
    dragDiffSplitRatio,
    measureDiffSplitState,
    handleDeny,
    handleFileSelect,
    handleKeep,
    imageCompareMode,
    imageDisplayMode,
    isActionPending,
    isDraftDirty,
    isOpen,
    canShowFileActionPanel,
    canShowLineActionPanel,
    persistDiffSplitRatio,
    setRepoExpanded,
    selectedFile,
    selectedFileKey,
    selectedFileState,
    terminalId,
    updateRepoFilter
  ])

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

  const originalModelPath = useMemo(() => {
    if (!selectedFile) return undefined
    const repoSegment = hashString(selectedFile.repoRoot || activeCwd || 'repo')
    const originalPath = (selectedFile.originalFilename || selectedFile.filename)
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    return `inmemory://model/onward-git-diff/${repoSegment}/original/${originalPath}`
  }, [activeCwd, selectedFile])

  const modifiedModelPath = useMemo(() => {
    if (!selectedFile) return undefined
    const repoSegment = hashString(selectedFile.repoRoot || activeCwd || 'repo')
    const filePath = selectedFile.filename
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    return `inmemory://model/onward-git-diff/${repoSegment}/modified/${filePath}`
  }, [activeCwd, selectedFile])

  const diffView = useMemo(() => {
    if (DEBUG_GIT_DIFF) {
      perfCountersRef.current.diffViewBuild += 1
    }
    if (!selectedFile || !selectedFileState) return null
    if (selectedFileState.loading || selectedFileState.error || selectedFileState.isBinary || selectedFileState.isSvg) return null
    return (
      <DiffEditor
        original={selectedFileState.originalContent}
        modified={effectiveModifiedContent}
        language={language}
        originalModelPath={originalModelPath}
        modifiedModelPath={modifiedModelPath}
        keepCurrentOriginalModel={true}
        keepCurrentModifiedModel={true}
        theme={PIERRE_LIKE_MONACO_THEME}
        beforeMount={ensurePierreLikeMonacoTheme}
        options={diffEditorOptions}
        onMount={handleEditorDidMount}
        className="git-diff-monaco"
        key={`${selectedFileKey || 'empty'}::${diffEditorResetNonce}`}
        height="100%"
      />
    )
  }, [selectedFile, selectedFileState, language, diffEditorOptions, effectiveModifiedContent, handleEditorDidMount, modifiedModelPath, originalModelPath, selectedFileKey, diffEditorResetNonce])

  const fileGroups = useMemo(() => {
    const groups: Record<GitFileStatus['changeType'], GitFileStatus[]> = {
      unstaged: [],
      staged: [],
      untracked: []
    }
    visibleFileList.forEach((file) => {
      groups[file.changeType].push(file)
    })
    return groups
  }, [visibleFileList])

  const groupedFileList = useMemo(() => {
    const groups = [
      { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: fileGroups.unstaged },
      { key: 'staged', label: t('gitDiff.changeType.staged'), files: fileGroups.staged },
      { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: fileGroups.untracked }
    ]
    return groups.filter(group => group.files.length > 0)
  }, [fileGroups, t])

  // Multi-repo layout: group by project first, then by change type. Keeps the
  // sidebar readable when several repos (e.g. submodules) share the workspace
  // instead of squeezing a truncated repo badge onto every file row.
  const repoSections = useMemo(() => {
    if (!hasMultipleRepos || !diffResult) return null
    type Section = {
      repoRoot: string
      repoLabel: string
      isSubmodule: boolean
      depth: number
      unstaged: GitFileStatus[]
      staged: GitFileStatus[]
      untracked: GitFileStatus[]
    }
    const map = new Map<string, Section>()
    const ensureSection = (root: string, label: string, isSubmodule: boolean, depth: number) => {
      const existing = map.get(root)
      if (existing) return existing
      const section: Section = {
        repoRoot: root,
        repoLabel: label,
        isSubmodule,
        depth,
        unstaged: [],
        staged: [],
        untracked: []
      }
      map.set(root, section)
      return section
    }
    for (const repo of diffResult.repos ?? []) {
      ensureSection(repo.root, repo.label, repo.isSubmodule, repo.depth)
    }
    const fallbackCwd = diffResult.cwd || ''
    for (const file of diffResult.files) {
      if (repoFilter && file.repoRoot !== repoFilter) continue
      const root = file.repoRoot || fallbackCwd
      const label = file.repoLabel || root.split('/').pop() || root
      const section = ensureSection(root, label, Boolean(file.isSubmoduleEntry), 0)
      section[file.changeType].push(file)
    }
    return Array.from(map.values())
      .map((section) => ({
        repoRoot: section.repoRoot,
        repoLabel: section.repoLabel,
        isSubmodule: section.isSubmodule,
        depth: section.depth,
        totalCount: section.unstaged.length + section.staged.length + section.untracked.length,
        groups: [
          { key: 'unstaged', label: t('gitDiff.changeType.unstaged'), files: section.unstaged },
          { key: 'staged', label: t('gitDiff.changeType.staged'), files: section.staged },
          { key: 'untracked', label: t('gitDiff.changeType.untracked'), files: section.untracked }
        ].filter((group) => group.files.length > 0)
      }))
      .filter((section) => section.totalCount > 0)
      .sort((a, b) => {
        if (a.isSubmodule !== b.isSubmodule) return a.isSubmodule ? 1 : -1
        if (a.depth !== b.depth) return a.depth - b.depth
        return a.repoLabel.localeCompare(b.repoLabel)
      })
  }, [diffResult, hasMultipleRepos, repoFilter, t])

  useEffect(() => {
    if (!repoFilter || !selectedFile) return
    if (selectedFile.repoRoot === repoFilter) return
    const nextFile = groupedFileList.flatMap((group) => group.files)[0]
    if (nextFile) {
      setSelectedFile(nextFile)
    }
  }, [groupedFileList, repoFilter, selectedFile])

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

  const renderSvgDiffEditor = useCallback((fileState: FileContentState) => {
    return (
      <div className="git-diff-editor-container">
        <DiffEditor
          key={`svg-text-${selectedFileKey || 'empty'}::${diffEditorResetNonce}`}
          original={fileState.originalContent}
          modified={effectiveModifiedContent}
          language="xml"
          theme="vs-dark"
          options={diffEditorOptions}
          onMount={handleEditorDidMount}
          className="git-diff-monaco"
          height="100%"
        />
      </div>
    )
  }, [diffEditorOptions, effectiveModifiedContent, handleEditorDidMount, selectedFileKey, diffEditorResetNonce])

  const renderImagePreview = useCallback((fileState: FileContentState, file: GitFileStatus) => {
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
        renderSvgDiffEditor={(state) => renderSvgDiffEditor(state as FileContentState)}
      />
    )
  }, [
    imageCompareMode,
    imageDisplayMode,
    renderSvgDiffEditor,
    t,
    toggleImageCompareMode,
    toggleImageDisplayMode,
    svgViewMode
  ])

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
            {selectedFile.isSubmoduleEntry && (
              <span className="git-diff-submodule-badge" title={t('gitDiff.status.submodule')}>S</span>
            )}
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
              <span className={`path-copy-toast ${copyMessage.type}`}>
                {copyMessage.text}
              </span>
            )}
          </div>
          {(canShowLineActionPanel || canShowFileActionPanel || canShowEditActionPanel) && (
            <div className="git-diff-detail-actions-row">
              {canShowLineActionPanel && (
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
              )}
              {canShowFileActionPanel && (
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
              )}
              {canShowEditActionPanel && (
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
          )}
        </div>
        <div className={`git-diff-detail-content${diffRevealPhase !== 'idle' ? ` diff-phase-${diffRevealPhase}` : ''}`}>
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
          {fileState && !fileState.loading && !fileState.error && fileState.isImage && (fileState.isBinary || fileState.isSvg) && (
            renderImagePreview(fileState, selectedFile)
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isPdf && (
            <GitPdfCompare
              status={
                (selectedFile?.status === 'A' || selectedFile?.status === '?') ? 'added'
                  : selectedFile?.status === 'D' ? 'deleted'
                    : 'modified' as GitPdfStatus
              }
              originalPreviewData={fileState.originalPreviewData}
              modifiedPreviewData={fileState.modifiedPreviewData}
              originalSize={fileState.originalPreviewSize}
              modifiedSize={fileState.modifiedPreviewSize}
              filename={selectedFile?.filename ?? ''}
              viewerUrl={pdfViewerUrl}
              labels={{
                statusAdded: t('gitDiff.pdfCompare.statusAdded'),
                statusDeleted: t('gitDiff.pdfCompare.statusDeleted'),
                statusModified: t('gitDiff.pdfCompare.statusModified'),
                labelOriginal: t('gitDiff.pdfCompare.labelOriginal'),
                labelAdded: t('gitDiff.pdfCompare.labelAdded'),
                labelModified: t('gitDiff.pdfCompare.labelModified'),
                noOriginal: t('gitDiff.pdfCompare.noOriginal'),
                noModified: t('gitDiff.pdfCompare.noModified')
              }}
            />
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isEpub && (
            <GitEpubCompare
              status={
                (selectedFile?.status === 'A' || selectedFile?.status === '?') ? 'added'
                  : selectedFile?.status === 'D' ? 'deleted'
                    : 'modified' as GitEpubStatus
              }
              originalPreviewData={fileState.originalPreviewData}
              modifiedPreviewData={fileState.modifiedPreviewData}
              originalSize={fileState.originalPreviewSize}
              modifiedSize={fileState.modifiedPreviewSize}
              filename={selectedFile?.filename ?? ''}
              labels={{
                statusAdded: t('gitDiff.epubCompare.statusAdded'),
                statusDeleted: t('gitDiff.epubCompare.statusDeleted'),
                statusModified: t('gitDiff.epubCompare.statusModified'),
                chapterAdded: t('gitDiff.epubCompare.chapterAdded'),
                chapterDeleted: t('gitDiff.epubCompare.chapterDeleted'),
                chapterModified: t('gitDiff.epubCompare.chapterModified'),
                chapterUnchanged: t('gitDiff.epubCompare.chapterUnchanged'),
                labelOriginal: t('gitDiff.epubCompare.labelOriginal'),
                labelModified: t('gitDiff.epubCompare.labelModified'),
                noOriginal: t('gitDiff.epubCompare.noOriginal'),
                noModified: t('gitDiff.epubCompare.noModified'),
                loading: t('gitDiff.epubCompare.loading'),
                error: t('gitDiff.epubCompare.error'),
                chapters: t('gitDiff.epubCompare.chapters'),
                resources: t('gitDiff.epubCompare.resources'),
                noResourceChanges: t('gitDiff.epubCompare.noResourceChanges'),
                resourceAdded: t('gitDiff.epubCompare.resourceAdded'),
                resourceDeleted: t('gitDiff.epubCompare.resourceDeleted'),
                resourceModified: t('gitDiff.epubCompare.resourceModified')
              }}
            />
          )}
          {fileState && !fileState.loading && !fileState.error && fileState.isBinary && !fileState.isImage && !fileState.isPdf && !fileState.isEpub && (
            <div className="git-diff-no-content">
              {t('gitDiff.binaryUnsupported')}
            </div>
          )}
          {fileState && !fileState.loading && !fileState.error && !fileState.isBinary && !fileState.isSvg && (
            <div className="git-diff-editor-container">
              {diffView}
            </div>
          )}
        </div>
      </>
    )
  }

  const renderLoadingShell = (message: string, repoContexts?: GitRepoContext[]) => {
    const loadingRepos = [...(repoContexts ?? [])]
      .filter((repo) => repo.isSubmodule || repo.loading)
      .sort(sortRepoContexts)

    return (
      <div className="git-diff-main git-diff-main-loading">
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          {loadingRepos.length > 0 && (
            <div className="git-diff-repo-filter">
              <div className="git-diff-repo-filter-item active loading">
                <span className="git-diff-repo-filter-label">{t('gitDiff.repo.all')}</span>
                <span className="git-diff-repo-filter-count loading">...</span>
              </div>
              {loadingRepos.map((repo) => (
                <div
                  key={repo.root}
                  className="git-diff-repo-filter-item loading"
                  title={repo.root}
                >
                  <span className="git-diff-repo-filter-label">{repo.label}</span>
                  <span className="git-diff-repo-filter-count loading">...</span>
                </div>
              ))}
            </div>
          )}
          <div className="git-diff-file-list-header">
            {t('gitDiff.fileList', { count: 0 })}
          </div>
          <div className="git-diff-file-list-content git-diff-file-list-content-loading">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={`git-diff-skeleton-${index}`}
                className={`git-diff-file-skeleton${index % 3 === 0 ? ' short' : index % 3 === 1 ? ' medium' : ''}`}
              >
                <span className="git-diff-file-skeleton-status" />
                <span className="git-diff-file-skeleton-line" />
                <span className="git-diff-file-skeleton-stats" />
              </div>
            ))}
          </div>
          <div className="git-diff-resizer" />
        </div>

        <div className="git-diff-detail git-diff-detail-loading">
          <div className="git-diff-loading">
            <div className="git-diff-spinner" />
            <span>{message}</span>
          </div>
        </div>
      </div>
    )
  }

  // Main content rendering
  const renderContent = () => {
    if (!diffResult) {
      return renderLoadingShell(t('gitDiff.loading'))
    }

    if (!diffResult.gitInstalled) {
      return renderGitNotInstalled()
    }

    if (!diffResult.isGitRepo) {
      return renderNotGitRepo()
    }

    if (diffResult.success && diffResult.files.length === 0 && diffResult.submodulesLoading) {
      return renderLoadingShell(t('gitDiff.loadingSubmodules'), diffResult.repos)
    }

    if (!diffResult.success || diffResult.files.length === 0) {
      return renderNoChanges()
    }

    const filteredFileCount = visibleFileList.length

    return (
      <div className="git-diff-main">
        <div className="git-diff-file-list" style={{ width: fileListWidth }}>
          {diffResult.superprojectRoot && (
            <div
              className="git-diff-superproject-hint"
              onClick={() => {
                void loadDiffFromRoot(diffResult.superprojectRoot!)
              }}
            >
              <span>{t('gitDiff.repo.inSubmodule')}</span>
              <span style={{ color: 'var(--accent)', cursor: 'pointer' }}>{t('gitDiff.repo.viewParent')}</span>
            </div>
          )}
          {diffResult.submodulesLoading && (
            <div className="git-diff-loading" style={{ minHeight: 'auto', justifyContent: 'flex-start', padding: '8px 12px', gap: '8px' }}>
              <div className="git-diff-spinner" />
              <span>{t('gitDiff.loadingSubmodules')}</span>
            </div>
          )}
          {hasMultipleRepos && diffResult.repos && (
            <div className="git-diff-repo-filter">
              <div
                className={`git-diff-repo-filter-item${repoFilter === null ? ' active' : ''}`}
                onClick={() => updateRepoFilter(null)}
              >
                <span className="git-diff-repo-filter-label">{t('gitDiff.repo.all')}</span>
                <span className="git-diff-repo-filter-count">{diffResult.files.length}</span>
              </div>
              {visibleRepoItems.map((repo) => {
                const canSelectRepo = !repo.loading && repo.changeCount > 0
                return (
                  <div
                    key={repo.root}
                    className={`git-diff-repo-filter-item${repoFilter === repo.root ? ' active' : ''}${repo.loading ? ' loading' : ''}`}
                    style={{ paddingLeft: `${12 + (repo.treeDepth * 14)}px` }}
                    onClick={() => {
                      if (canSelectRepo) {
                        updateRepoFilter(repo.root)
                      }
                    }}
                    title={repo.root}
                  >
                    <button
                      type="button"
                      className={`git-diff-repo-toggle${repo.hasChildren ? '' : ' hidden'}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleRepoExpanded(repo.root)
                      }}
                      aria-label={repo.expanded ? t('gitDiff.repo.collapse') : t('gitDiff.repo.expand')}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <path d={repo.expanded ? 'M4 6l4 4 4-4H4z' : 'M6 4l4 4-4 4V4z'} />
                      </svg>
                    </button>
                    <span className="git-diff-repo-filter-label">{repo.displayLabel}</span>
                    <span className={`git-diff-repo-filter-count${repo.loading ? ' loading' : ''}`}>
                      {repo.loading ? '...' : repo.changeCount}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="git-diff-file-list-header">
            {t('gitDiff.fileList', { count: filteredFileCount })}
          </div>
          <div className="git-diff-file-list-content">
            {(() => {
              const renderFileItem = (file: GitFileStatus) => {
                const fileKey = diffResult?.cwd ? buildFileKey(file.repoRoot || diffResult.cwd, file) : file.filename
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
                    {file.isSubmoduleEntry && (
                      <span
                        className="git-diff-submodule-badge"
                        title={t('gitDiff.status.submodule')}
                      >
                        S
                      </span>
                    )}
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
              }
              const renderGroup = (group: { key: string; label: string; files: GitFileStatus[] }) => (
                <div key={group.key} className="git-diff-file-group">
                  <div className="git-diff-file-group-title">
                    {group.label} ({group.files.length})
                  </div>
                  {group.files.map(renderFileItem)}
                </div>
              )
              if (repoSections) {
                return repoSections.map((section) => (
                  <div key={section.repoRoot} className="git-diff-repo-section">
                    <div className="git-diff-repo-header" title={section.repoRoot}>
                      <span className="git-diff-repo-name">{section.repoLabel}</span>
                      <span className="git-diff-repo-count">{section.totalCount}</span>
                    </div>
                    {section.groups.map(renderGroup)}
                  </div>
                ))
              }
              return groupedFileList.map(renderGroup)
            })()}
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
  const displayedCwd = diffResult?.cwd || (!cwdPending ? cwd : null)
  const useSharedPanelHeader = isPanel && panelShellMode === 'internal'
  const keepMountedInPanel = isPanel
  const externalPanelActions = useMemo(() => (
        <SubpagePanelButton className="git-diff-close" onClick={requestClose} title={t('gitDiff.returnToTerminal')}>
          {t('gitDiff.returnToTerminal')}
        </SubpagePanelButton>
  ), [requestClose, t])
  const externalPanelShellState = useMemo<SubpagePanelShellState>(() => ({
    current: 'diff',
    onSelect: handleSelectSubpage,
    workingDirectoryLabel: t('gitDiff.workingDirectory'),
    workingDirectoryPath: displayedCwd && (!diffResult || diffResult.isGitRepo) ? displayedCwd : null,
    actions: externalPanelActions,
    taskTitle
  }), [diffResult, displayedCwd, externalPanelActions, handleSelectSubpage, t, taskTitle])

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
    externalPanelShellState,
    isOpen,
    isPanel,
    onPanelShellStateChange,
    panelShellMode
  ])

  if (!isOpen && !keepMountedInPanel) return null

  return (
    <div
      className={`${overlayClassName} ${isOpen ? 'is-open' : 'is-hidden'}`}
      onClick={isPanel ? undefined : requestClose}
      aria-hidden={!isOpen}
    >
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

        {useSharedPanelHeader ? (
          <SubpagePanelShell
            current="diff"
            onSelect={handleSelectSubpage}
            workingDirectoryLabel={t('gitDiff.workingDirectory')}
            workingDirectoryPath={displayedCwd && (!diffResult || diffResult.isGitRepo) ? displayedCwd : null}
            taskTitle={taskTitle}
            actions={(
              <SubpagePanelButton className="git-diff-close" onClick={requestClose} title={t('gitDiff.returnToTerminal')}>
                {t('gitDiff.returnToTerminal')}
              </SubpagePanelButton>
            )}
          >
            <div className="git-diff-body">
              {renderContent()}
            </div>
          </SubpagePanelShell>
        ) : panelShellMode === 'external' && isPanel ? (
          <div className="git-diff-body">
            {renderContent()}
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="git-diff-header">
              <div className="git-diff-header-main">
                <h2 className="git-diff-title">
                  <span className="git-diff-title-main">{t('gitDiff.title')}</span>
                  {taskTitle ? (
                    <span className="git-diff-task-label subpage-task-source" title={taskTitle}>
                      <span className="subpage-task-source-name">{taskTitle}</span>
                    </span>
                  ) : null}
                </h2>
                <SubpageSwitcher current="diff" onSelect={handleSelectSubpage} />
              </div>
              <div className="git-diff-header-actions">
                <SubpagePanelButton className="git-diff-close" onClick={requestClose} title={t('gitDiff.returnToTerminal')}>
                  {t('gitDiff.returnToTerminal')}
                </SubpagePanelButton>
              </div>
            </div>

            {/* working directory */}
            {displayedCwd && (!diffResult || diffResult.isGitRepo) && (
              <div className="git-diff-cwd-bar">
                <span className="git-diff-cwd-label">{t('gitDiff.workingDirectory')}</span>
                <span className="git-diff-cwd-path">{displayedCwd}</span>
              </div>
            )}

            {/* Body */}
            <div className="git-diff-body">
              {renderContent()}
            </div>
          </>
        )}

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
              <span>{t('common.copyName')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'relative')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><circle cx="5" cy="11.5" r="1" /><path d="M7 10a.5.5 0 0 1 .354.146l2 2a.5.5 0 0 1-.708.708L7 11.207l-1.646 1.647a.5.5 0 0 1-.708-.708l2-2A.5.5 0 0 1 7 10z" /></svg>
              <span>{t('common.copyRelativePath')}</span>
            </button>
            <button
              className="git-diff-context-item"
              onClick={() => void copyContextMenuPath(contextMenu.targetFile, 'absolute')}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6h-4a1 1 0 0 1-1-1V1zm1 0v4h4L10 1z" /><path d="M8.5 9a.5.5 0 0 0-.894-.447l-2 4a.5.5 0 1 0 .894.447l2-4z" /></svg>
              <span>{t('common.copyAbsolutePath')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
