/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export interface SearchMatch {
  file: string
  line: number
  column: number
  matchLength: number
  lineContent: string
}

export interface FileGroup {
  file: string
  matches: SearchMatch[]
  isCollapsed: boolean
}

export interface GlobalSearchOptions {
  isRegex: boolean
  isCaseSensitive: boolean
  isWholeWord: boolean
  includeGlob: string
  excludeGlob: string
}

interface UseGlobalSearchParams {
  rootPath: string | null
  isActive: boolean
}

export function useGlobalSearch({ rootPath, isActive }: UseGlobalSearchParams) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<GlobalSearchOptions>({
    isRegex: false,
    isCaseSensitive: false,
    isWholeWord: false,
    includeGlob: '',
    excludeGlob: ''
  })
  const [isSearching, setIsSearching] = useState(false)
  const [fileGroups, setFileGroups] = useState<FileGroup[]>([])
  const [totalMatchCount, setTotalMatchCount] = useState(0)
  const [totalFileCount, setTotalFileCount] = useState(0)
  const [durationMs, setDurationMs] = useState<number | null>(null)
  const [limitReached, setLimitReached] = useState(false)

  const activeSearchIdRef = useRef<string | null>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileGroupsRef = useRef<Map<string, SearchMatch[]>>(new Map())

  const clearResults = useCallback(() => {
    fileGroupsRef.current = new Map()
    setFileGroups([])
    setTotalMatchCount(0)
    setTotalFileCount(0)
    setDurationMs(null)
    setLimitReached(false)
  }, [])

  const cancelSearch = useCallback(async () => {
    activeSearchIdRef.current = null
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    try {
      await window.electronAPI.project.searchCancel()
    } catch {
      // Ignore.
    }
    setIsSearching(false)
  }, [])

  const executeSearch = useCallback(async (searchQuery: string, searchOptions: GlobalSearchOptions) => {
    if (!rootPath || !searchQuery.trim()) {
      clearResults()
      setIsSearching(false)
      return
    }

    clearResults()
    setIsSearching(true)

    try {
      const result = await window.electronAPI.project.searchStart({
        rootPath,
        query: searchQuery.trim(),
        isRegex: searchOptions.isRegex,
        isCaseSensitive: searchOptions.isCaseSensitive,
        isWholeWord: searchOptions.isWholeWord,
        includeGlob: searchOptions.includeGlob || undefined,
        excludeGlob: searchOptions.excludeGlob || undefined
      })
      activeSearchIdRef.current = result.searchId
    } catch {
      setIsSearching(false)
    }
  }, [clearResults, rootPath])

  const triggerSearch = useCallback((nextQuery: string, nextOptions: GlobalSearchOptions) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    if (!nextQuery.trim()) {
      void cancelSearch()
      clearResults()
      return
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null
      void executeSearch(nextQuery, nextOptions)
    }, 300)
  }, [cancelSearch, clearResults, executeSearch])

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    triggerSearch(nextQuery, options)
  }, [options, triggerSearch])

  const toggleOption = useCallback((key: keyof Pick<GlobalSearchOptions, 'isRegex' | 'isCaseSensitive' | 'isWholeWord'>) => {
    setOptions((previous) => {
      const next = { ...previous, [key]: !previous[key] }
      if (query.trim()) {
        triggerSearch(query, next)
      }
      return next
    })
  }, [query, triggerSearch])

  const updateGlob = useCallback((key: 'includeGlob' | 'excludeGlob', value: string) => {
    setOptions((previous) => {
      const next = { ...previous, [key]: value }
      if (query.trim()) {
        triggerSearch(query, next)
      }
      return next
    })
  }, [query, triggerSearch])

  const toggleCollapse = useCallback((fileIndex: number) => {
    setFileGroups((previous) => previous.map((group, index) => {
      if (index !== fileIndex) return group
      return { ...group, isCollapsed: !group.isCollapsed }
    }))
  }, [])

  useEffect(() => {
    if (!isActive) return

    const unsubscribeResult = window.electronAPI.project.onSearchResult((searchId, matches) => {
      if (searchId !== activeSearchIdRef.current) return

      const groups = fileGroupsRef.current
      for (const match of matches) {
        const existing = groups.get(match.file)
        if (existing) {
          existing.push(match)
        } else {
          groups.set(match.file, [match])
        }
      }

      let matchTotal = 0
      const nextGroups: FileGroup[] = []
      for (const [file, fileMatches] of groups) {
        nextGroups.push({ file, matches: fileMatches, isCollapsed: false })
        matchTotal += fileMatches.length
      }

      setFileGroups(nextGroups)
      setTotalMatchCount(matchTotal)
      setTotalFileCount(groups.size)
    })

    const unsubscribeDone = window.electronAPI.project.onSearchDone((stats) => {
      if (stats.searchId !== activeSearchIdRef.current) return
      setIsSearching(false)
      setTotalMatchCount(stats.matchCount)
      setTotalFileCount(stats.fileCount)
      setDurationMs(stats.durationMs)
      setLimitReached(stats.cancelled)
    })

    return () => {
      unsubscribeResult()
      unsubscribeDone()
    }
  }, [isActive])

  useEffect(() => {
    if (!isActive) {
      void cancelSearch()
    }
    return () => {
      void cancelSearch()
    }
  }, [cancelSearch, isActive])

  return {
    query,
    options,
    isSearching,
    fileGroups,
    totalMatchCount,
    totalFileCount,
    durationMs,
    limitReached,
    updateQuery,
    toggleOption,
    updateGlob,
    toggleCollapse,
    clearResults,
    cancelSearch
  }
}
