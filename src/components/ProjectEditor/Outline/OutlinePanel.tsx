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

interface OutlinePanelProps {
  symbols: OutlineItem[]
  activeItem: OutlineItem | null
  isLoading: boolean
  filePath: string | null
  editor: import('monaco-editor').editor.IStandaloneCodeEditor | null
}

const FILTER_THRESHOLD = 8

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

export function OutlinePanel({
  symbols,
  activeItem,
  isLoading,
  filePath,
  editor,
}: OutlinePanelProps) {
  const { t } = useI18n()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const filterInputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  const totalCount = useMemo(() => countSymbols(symbols), [symbols])
  const showFilter = totalCount > FILTER_THRESHOLD

  const normalizedFilter = filter.trim().toLowerCase()
  const filteredSymbols = useMemo(
    () => filterItems(symbols, normalizedFilter),
    [symbols, normalizedFilter]
  )

  // Reset filter on file switch
  useEffect(() => {
    setFilter('')
    setCollapsed(new Set())
  }, [filePath])

  // Auto-scroll to active item
  useEffect(() => {
    if (activeRef.current) {
      activeRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [activeItem])

  const handleItemClick = useCallback(
    (item: OutlineItem) => {
      if (!editor) return
      editor.setPosition({ lineNumber: item.startLine, column: item.startColumn })
      editor.revealLineInCenter(item.startLine)
      editor.focus()
    },
    [editor]
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
        activeItem !== null &&
        activeItem.startLine === item.startLine &&
        activeItem.name === item.name
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
    [collapsed, activeItem, handleItemClick, toggleCollapse]
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
