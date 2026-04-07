/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../../../i18n/useI18n'
import type { OutlineItem } from './types'
import { OutlineSymbolKind } from './types'
import { countSymbols } from './outlineParser'
import './OutlinePanel.css'

export type OutlineTarget = 'editor' | 'preview'

interface OutlinePanelProps {
  symbols: OutlineItem[]
  activeItem: OutlineItem | null
  isLoading: boolean
  filePath: string | null
  editor: import('monaco-editor').editor.IStandaloneCodeEditor | null
  isMarkdown?: boolean
  previewRef?: React.RefObject<HTMLDivElement | null>
  outlineTarget?: OutlineTarget
  onOutlineTargetChange?: (target: OutlineTarget) => void
  previewActiveSlug?: string | null
  onScrollCapture?: (scrollTop: number) => void
  initialScrollTop?: number
}

const FILTER_THRESHOLD = 8

function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[^;]+;/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function getIconInfo(kind: OutlineSymbolKind): { label: string; className: string } {
  switch (kind) {
    case OutlineSymbolKind.Class:
      return { label: 'C', className: 'kind-class' }
    case OutlineSymbolKind.Interface:
      return { label: 'I', className: 'kind-interface' }
    case OutlineSymbolKind.Function:
      return { label: 'f', className: 'kind-function' }
    case OutlineSymbolKind.Method:
      return { label: 'm', className: 'kind-method' }
    case OutlineSymbolKind.Constructor:
      return { label: 'c', className: 'kind-constructor' }
    case OutlineSymbolKind.Variable:
      return { label: 'v', className: 'kind-variable' }
    case OutlineSymbolKind.Property:
      return { label: 'p', className: 'kind-property' }
    case OutlineSymbolKind.Field:
      return { label: 'f', className: 'kind-field' }
    case OutlineSymbolKind.Constant:
      return { label: 'K', className: 'kind-constant' }
    case OutlineSymbolKind.Enum:
      return { label: 'E', className: 'kind-enum' }
    case OutlineSymbolKind.EnumMember:
      return { label: 'e', className: 'kind-enum-member' }
    case OutlineSymbolKind.Struct:
      return { label: 'S', className: 'kind-struct' }
    case OutlineSymbolKind.Namespace:
      return { label: 'N', className: 'kind-namespace' }
    case OutlineSymbolKind.Module:
      return { label: 'M', className: 'kind-module' }
    case OutlineSymbolKind.Package:
      return { label: 'P', className: 'kind-package' }
    case OutlineSymbolKind.Key:
      return { label: 'K', className: 'kind-key' }
    case OutlineSymbolKind.Object:
      return { label: 'O', className: 'kind-object' }
    case OutlineSymbolKind.Heading1:
    case OutlineSymbolKind.Heading2:
    case OutlineSymbolKind.Heading3:
    case OutlineSymbolKind.Heading4:
    case OutlineSymbolKind.Heading5:
    case OutlineSymbolKind.Heading6:
      return { label: 'H', className: 'kind-heading' }
    default:
      return { label: '·', className: 'kind-other' }
  }
}

function matchesFilter(item: OutlineItem, query: string): boolean {
  if (item.name.toLowerCase().includes(query)) return true
  return item.children.some((child) => matchesFilter(child, query))
}

function filterItems(items: OutlineItem[], query: string): OutlineItem[] {
  if (!query) return items
  return items
    .filter((item) => matchesFilter(item, query))
    .map((item) => ({
      ...item,
      children: filterItems(item.children, query),
    }))
}

function collectHeadings(items: OutlineItem[]): OutlineItem[] {
  const result: OutlineItem[] = []
  const walk = (list: OutlineItem[]) => {
    for (const item of list) {
      if (item.kind >= OutlineSymbolKind.Heading1 && item.kind <= OutlineSymbolKind.Heading6) {
        result.push(item)
      }
      if (item.children.length > 0) {
        walk(item.children)
      }
    }
  }
  walk(items)
  return result
}

function buildSlugMap(allHeadings: OutlineItem[]): Map<OutlineItem, string> {
  const slugCounts = new Map<string, number>()
  const map = new Map<OutlineItem, string>()
  for (const heading of allHeadings) {
    let slug = headingSlug(heading.name)
    const count = slugCounts.get(slug) ?? 0
    slugCounts.set(slug, count + 1)
    if (count > 0) {
      slug = `${slug}-${count}`
    }
    map.set(heading, slug)
  }
  return map
}

export function OutlinePanel({
  symbols,
  activeItem,
  isLoading,
  filePath,
  editor,
  isMarkdown = false,
  previewRef,
  outlineTarget = 'editor',
  onOutlineTargetChange,
  previewActiveSlug,
  onScrollCapture,
  initialScrollTop,
}: OutlinePanelProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const filterInputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const initialScrollAppliedRef = useRef(false)

  const totalCount = useMemo(() => countSymbols(symbols), [symbols])
  const showFilter = totalCount > FILTER_THRESHOLD

  const normalizedFilter = filter.trim().toLowerCase()
  const filteredSymbols = useMemo(
    () => filterItems(symbols, normalizedFilter),
    [symbols, normalizedFilter]
  )

  const slugMap = useMemo(() => {
    if (!isMarkdown) return new Map<OutlineItem, string>()
    return buildSlugMap(collectHeadings(symbols))
  }, [isMarkdown, symbols])

  const reverseSlugMap = useMemo(() => {
    const map = new Map<string, OutlineItem>()
    for (const [item, slug] of slugMap.entries()) {
      map.set(slug, item)
    }
    return map
  }, [slugMap])

  const effectiveActiveItem = useMemo(() => {
    if (isMarkdown && outlineTarget === 'preview' && previewActiveSlug) {
      return reverseSlugMap.get(previewActiveSlug) ?? null
    }
    return activeItem
  }, [activeItem, isMarkdown, outlineTarget, previewActiveSlug, reverseSlugMap])

  // Reset filter on file switch
  useEffect(() => {
    setFilter('')
    setCollapsed(new Set())
  }, [filePath])

  // Auto-scroll to active item
  useEffect(() => {
    if (!initialScrollAppliedRef.current && typeof initialScrollTop === 'number' && initialScrollTop > 0) {
      return
    }
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [effectiveActiveItem, initialScrollTop])

  useEffect(() => {
    const tree = treeRef.current
    if (!tree || !onScrollCapture) return
    const handleScroll = () => {
      onScrollCapture(tree.scrollTop)
    }
    tree.addEventListener('scroll', handleScroll, { passive: true })
    return () => tree.removeEventListener('scroll', handleScroll)
  }, [onScrollCapture])

  useEffect(() => {
    initialScrollAppliedRef.current = false
  }, [filePath])

  useEffect(() => {
    if (initialScrollAppliedRef.current) return
    if (typeof initialScrollTop !== 'number' || initialScrollTop <= 0) return
    if (!treeRef.current || symbols.length === 0) return
    initialScrollAppliedRef.current = true
    requestAnimationFrame(() => {
      if (treeRef.current) {
        treeRef.current.scrollTop = initialScrollTop
      }
    })
  }, [initialScrollTop, symbols.length])

  const scrollPreviewToHeading = useCallback((item: OutlineItem) => {
    const container = previewRef?.current
    if (!container) return false
    const slug = slugMap.get(item)
    if (!slug) return false
    const target = container.querySelector(`#${CSS.escape(slug)}`) as HTMLElement | null
    if (!target) return false
    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const offsetTop = targetRect.top - containerRect.top + container.scrollTop
    container.scrollTo({ top: offsetTop, behavior: 'smooth' })
    return true
  }, [previewRef, slugMap])

  const handleItemClick = useCallback(
    (item: OutlineItem) => {
      const isHeading = item.kind >= OutlineSymbolKind.Heading1 && item.kind <= OutlineSymbolKind.Heading6
      if (isMarkdown && outlineTarget === 'preview' && isHeading && scrollPreviewToHeading(item)) {
        return
      }
      if (!editor) return
      editor.setPosition({ lineNumber: item.startLine, column: item.startColumn })
      editor.revealLineInCenter(item.startLine)
      editor.focus()
    },
    [editor, isMarkdown, outlineTarget, scrollPreviewToHeading]
  )

  const toggleCollapse = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }, [])

  const handleFilterKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (filter) {
          setFilter('')
        } else {
          editor?.focus()
        }
      }
    },
    [filter, editor]
  )

  const renderItem = useCallback(
    (item: OutlineItem, parentKey: string, _index: number) => {
      const key = `${parentKey}/${item.name}:${item.startLine}`
      const hasChildren = item.children.length > 0
      const isCollapsed = collapsed.has(key)
      const isActive =
        effectiveActiveItem !== null &&
        effectiveActiveItem.startLine === item.startLine &&
        effectiveActiveItem.name === item.name
      const icon = getIconInfo(item.kind)
      const indent = item.depth * 16

      return (
        <div key={key}>
          <div
            ref={isActive ? activeRef : undefined}
            className={`outline-panel-item ${isActive ? 'active' : ''}`}
            style={{ paddingLeft: 10 + indent }}
            onClick={() => handleItemClick(item)}
          >
            {hasChildren ? (
              <span
                className={`outline-panel-item-toggle ${isCollapsed ? 'collapsed' : ''}`}
                onClick={(e) => toggleCollapse(key, e)}
              >
                ▾
              </span>
            ) : (
              <span className="outline-panel-item-spacer" />
            )}
            <span className={`outline-panel-item-icon ${icon.className}`}>
              {icon.label}
            </span>
            <span className="outline-panel-item-name">{item.name}</span>
            {item.detail && (
              <span className="outline-panel-item-detail">{item.detail}</span>
            )}
          </div>
          {hasChildren && !isCollapsed && (
            item.children.map((child, i) => renderItem(child, key, i))
          )}
        </div>
      )
    },
    [collapsed, effectiveActiveItem, handleItemClick, toggleCollapse]
  )

  if (!filePath) {
    return (
      <div className="outline-panel">
        <div className="outline-panel-header">
          <span className="outline-panel-title">{t('outlinePanel.title')}</span>
        </div>
        <div className="outline-panel-empty">{t('outlinePanel.empty.selectFile')}</div>
      </div>
    )
  }

  return (
    <div className="outline-panel">
      <div className="outline-panel-header">
        <span className="outline-panel-title">{t('outlinePanel.title')}</span>
        {isLoading && <span className="outline-panel-loading">{t('outlinePanel.loading')}</span>}
      </div>
      {isMarkdown && onOutlineTargetChange && (
        <div className="outline-panel-target-bar">
          <span className="outline-panel-target-label">{t('outlinePanel.target.label')}</span>
          <div className="outline-panel-target-seg" data-active={outlineTarget}>
            <span className="outline-panel-target-indicator" />
            <button
              type="button"
              className={`outline-panel-target-btn${outlineTarget === 'editor' ? ' active' : ''}`}
              onClick={() => onOutlineTargetChange('editor')}
              title={t('outlinePanel.target.editor.tooltip')}
            >
              {t('outlinePanel.target.editor')}
            </button>
            <button
              type="button"
              className={`outline-panel-target-btn${outlineTarget === 'preview' ? ' active' : ''}`}
              onClick={() => onOutlineTargetChange('preview')}
              title={t('outlinePanel.target.preview.tooltip')}
            >
              {t('outlinePanel.target.preview')}
            </button>
          </div>
        </div>
      )}
      {showFilter && (
        <div className="outline-panel-filter">
          <input
            ref={filterInputRef}
            className="outline-panel-filter-input"
            value={filter}
            placeholder={t('outlinePanel.filterPlaceholder')}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleFilterKeyDown}
          />
        </div>
      )}
      <div className="outline-panel-tree" ref={treeRef}>
        {!isLoading && filteredSymbols.length === 0 ? (
          <div className="outline-panel-empty">
            {normalizedFilter ? t('outlinePanel.empty.noMatch') : t('outlinePanel.empty.noSymbols')}
          </div>
        ) : (
          filteredSymbols.map((item, i) => renderItem(item, '', i))
        )}
      </div>
    </div>
  )
}
