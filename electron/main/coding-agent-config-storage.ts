/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export type CodingAgentType = 'claude-code' | 'codex'
export type CodingAgentProvider = 'openrouter' | 'custom'

export interface CodingAgentHistoryEntry {
  id: string
  agentType: CodingAgentType
  provider?: CodingAgentProvider
  apiUrl?: string
  apiKey?: string
  model?: string
  extraArgs: string
  createdAt: number
  lastUsedAt: number
}

export interface CodingAgentConfigState {
  version: number
  lastUsedId: Record<CodingAgentType, string | null>
  history: CodingAgentHistoryEntry[]
}

export interface CodingAgentConfigInput {
  agentType: CodingAgentType
  provider?: CodingAgentProvider
  apiUrl?: string
  apiKey?: string
  model?: string
  extraArgs?: string
}

const AGENT_TYPES: CodingAgentType[] = ['claude-code', 'codex']
const PROVIDERS: CodingAgentProvider[] = ['openrouter', 'custom']

const DEFAULT_STATE: CodingAgentConfigState = {
  version: 2,
  lastUsedId: { 'claude-code': null, 'codex': null },
  history: []
}

class CodingAgentConfigStorage {
  private storagePath: string
  private state: CodingAgentConfigState = { ...DEFAULT_STATE, lastUsedId: { ...DEFAULT_STATE.lastUsedId } }

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'coding-agent-config.json')
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.storagePath)) {
        const raw = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(raw)
        this.state = this.validateState(parsed)
      }
    } catch (error) {
      console.error('Failed to load coding agent config:', error)
      this.state = { ...DEFAULT_STATE, lastUsedId: { ...DEFAULT_STATE.lastUsedId } }
    }
  }

  private persist(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save coding agent config:', error)
    }
  }

  private str(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim()
  }

  private num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  private normalizeAgentType(value: unknown): CodingAgentType {
    if (typeof value === 'string' && AGENT_TYPES.includes(value as CodingAgentType)) {
      return value as CodingAgentType
    }
    return 'claude-code'
  }

  private normalizeProvider(value: unknown): CodingAgentProvider | undefined {
    if (typeof value === 'string' && PROVIDERS.includes(value as CodingAgentProvider)) {
      return value as CodingAgentProvider
    }
    return undefined
  }

  private validateEntry(entry: unknown): CodingAgentHistoryEntry | null {
    if (!entry || typeof entry !== 'object') return null
    const raw = entry as Record<string, unknown>
    const id = this.str(raw.id)
    if (!id) return null
    const agentType = this.normalizeAgentType(raw.agentType)
    const provider = this.normalizeProvider(raw.provider)
    const apiUrl = this.str(raw.apiUrl)
    const apiKey = this.str(raw.apiKey)
    let model = this.str(raw.model)
    if (!model && raw.models && typeof raw.models === 'object') {
      const legacy = raw.models as Record<string, unknown>
      model = this.str(legacy.sonnet || legacy.haiku || legacy.opus)
    }
    const extraArgs = this.str(raw.extraArgs)
    const createdAt = this.num(raw.createdAt) || Date.now()
    const lastUsedAt = this.num(raw.lastUsedAt) || createdAt
    return { id, agentType, provider, apiUrl, apiKey, model, extraArgs, createdAt, lastUsedAt }
  }

  private validateState(data: unknown): CodingAgentConfigState {
    if (!data || typeof data !== 'object') {
      return { ...DEFAULT_STATE, lastUsedId: { ...DEFAULT_STATE.lastUsedId } }
    }
    const raw = data as Record<string, unknown>
    const historyRaw = Array.isArray(raw.history) ? raw.history : []
    const history = historyRaw
      .map(entry => this.validateEntry(entry))
      .filter((entry): entry is CodingAgentHistoryEntry => Boolean(entry))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)

    const lastUsedIdRaw = (raw.lastUsedId && typeof raw.lastUsedId === 'object')
      ? raw.lastUsedId as Record<string, unknown>
      : {}
    const lastUsedId: Record<CodingAgentType, string | null> = { 'claude-code': null, 'codex': null }
    for (const at of AGENT_TYPES) {
      const id = this.str(lastUsedIdRaw[at])
      lastUsedId[at] = id && history.some(e => e.id === id) ? id : null
    }

    return { version: 2, lastUsedId, history }
  }

  get(agentType?: CodingAgentType): CodingAgentConfigState {
    if (!agentType) return this.state
    return {
      ...this.state,
      history: this.state.history.filter(e => e.agentType === agentType),
      lastUsedId: this.state.lastUsedId
    }
  }

  save(input: CodingAgentConfigInput): CodingAgentConfigState {
    const agentType = this.normalizeAgentType(input.agentType)
    const extraArgs = this.str(input.extraArgs)
    const provider = this.normalizeProvider(input.provider)
    const apiUrl = this.str(input.apiUrl)
    const apiKey = this.str(input.apiKey)
    const model = this.str(input.model)

    const now = Date.now()
    const existing = this.state.history.find(e =>
      e.agentType === agentType &&
      e.provider === provider &&
      (e.apiUrl || '') === apiUrl &&
      (e.apiKey || '') === apiKey &&
      (e.model || '') === model &&
      e.extraArgs === extraArgs
    )

    if (existing) {
      existing.lastUsedAt = now
      this.state.lastUsedId[agentType] = existing.id
      this.state.history.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      this.persist()
      return this.get(agentType)
    }

    const newEntry: CodingAgentHistoryEntry = {
      id: `${agentType}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      agentType,
      provider,
      apiUrl: apiUrl || undefined,
      apiKey: apiKey || undefined,
      model: model || undefined,
      extraArgs,
      createdAt: now,
      lastUsedAt: now
    }

    this.state.history = [newEntry, ...this.state.history]
    this.state.lastUsedId[agentType] = newEntry.id
    this.persist()
    return this.get(agentType)
  }

  delete(id: string): CodingAgentConfigState {
    const targetId = this.str(id)
    if (!targetId) return this.state
    const entry = this.state.history.find(e => e.id === targetId)
    if (!entry) return this.state

    this.state.history = this.state.history.filter(e => e.id !== targetId)
    if (this.state.lastUsedId[entry.agentType] === targetId) {
      const remaining = this.state.history.filter(e => e.agentType === entry.agentType)
      this.state.lastUsedId[entry.agentType] = remaining[0]?.id || null
    }
    this.persist()
    return this.get(entry.agentType)
  }
}

let instance: CodingAgentConfigStorage | null = null

export function getCodingAgentConfigStorage(): CodingAgentConfigStorage {
  if (!instance) {
    instance = new CodingAgentConfigStorage()
  }
  return instance
}
