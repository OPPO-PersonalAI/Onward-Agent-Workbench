/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'

export interface EnvVarEntry {
  key: string
  value: string
  masked?: boolean
}

export interface CodingAgentHistoryEntry {
  id: string
  command: string
  executablePath: string
  extraArgs: string
  envVars: EnvVarEntry[]
  alias: string
  createdAt: number
  lastUsedAt: number
}

export interface CodingAgentConfigState {
  version: number
  lastUsedId: string | null
  history: CodingAgentHistoryEntry[]
}

export interface CodingAgentConfigInput {
  command: string
  executablePath?: string
  extraArgs?: string
  envVars?: EnvVarEntry[]
  alias?: string
}

const DEFAULT_STATE: CodingAgentConfigState = {
  version: 3,
  lastUsedId: null,
  history: []
}

class CodingAgentConfigStorage {
  private storagePath: string
  private state: CodingAgentConfigState = { ...DEFAULT_STATE }

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'coding-agent-config.json')
    this.load()
  }

  private load(): void {
    // Try main file first; if corrupted/missing, try .tmp (last successful write before rename)
    for (const path of [this.storagePath, this.storagePath + '.tmp']) {
      try {
        if (!existsSync(path)) continue
        const raw = readFileSync(path, 'utf-8')
        if (!raw.trim()) continue
        const parsed = JSON.parse(raw)
        this.state = this.validateState(parsed)
        return
      } catch (error) {
        console.error(`Failed to load coding agent config from ${path}:`, error)
      }
    }
    this.state = { ...DEFAULT_STATE }
  }

  // Atomic persist: write to .tmp then rename to avoid corruption on crash
  private persist(): boolean {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const tmpPath = this.storagePath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8')
      renameSync(tmpPath, this.storagePath)
      return true
    } catch (error) {
      console.error('Failed to save coding agent config:', error)
      return false
    }
  }

  private str(value: unknown): string {
    if (typeof value !== 'string') return ''
    return value.trim()
  }

  private num(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }

  private validateEnvVars(value: unknown): EnvVarEntry[] {
    if (!Array.isArray(value)) return []
    const result: EnvVarEntry[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      const key = this.str(raw.key)
      if (!key) continue
      result.push({ key, value: typeof raw.value === 'string' ? raw.value : '', masked: raw.masked === true ? true : undefined })
    }
    return result
  }

  private envVarsFingerprint(vars: EnvVarEntry[]): string {
    return JSON.stringify(
      [...vars].sort((a, b) => a.key.localeCompare(b.key)).map(v => [v.key, v.value, v.masked || false])
    )
  }

  // Migrate a v2 entry (old schema with agentType/provider/apiUrl/apiKey/model) to v3
  private migrateV2Entry(raw: Record<string, unknown>): CodingAgentHistoryEntry | null {
    const id = this.str(raw.id)
    if (!id) return null

    const agentType = this.str(raw.agentType)
    let command = ''
    if (agentType === 'codex') command = 'codex'
    else if (agentType === 'claude-code') command = 'claude'
    else command = agentType || 'codex'

    const extraArgs = this.str(raw.extraArgs)
    const envVars: EnvVarEntry[] = []

    // Convert Claude Code API fields to environment variables,
    // preserving v2 provider-specific semantics (openrouter vs custom)
    if (agentType === 'claude-code') {
      const provider = this.str(raw.provider)
      const apiUrl = this.str(raw.apiUrl)
      const apiKey = this.str(raw.apiKey)
      let model = this.str(raw.model)
      if (!model && raw.models && typeof raw.models === 'object') {
        const legacy = raw.models as Record<string, unknown>
        model = this.str(legacy.sonnet || legacy.haiku || legacy.opus)
      }
      if (apiUrl) envVars.push({ key: 'ANTHROPIC_BASE_URL', value: apiUrl })
      if (apiKey) {
        // OpenRouter uses AUTH_TOKEN for auth; API_KEY must be empty to avoid
        // Claude Code attempting native Anthropic auth with the wrong key.
        envVars.push({ key: 'ANTHROPIC_API_KEY', value: provider === 'openrouter' ? '' : apiKey, masked: true })
        envVars.push({ key: 'ANTHROPIC_AUTH_TOKEN', value: apiKey, masked: true })
      }
      if (model) {
        envVars.push({ key: 'ANTHROPIC_MODEL', value: model })
        envVars.push({ key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', value: model })
        envVars.push({ key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', value: model })
        envVars.push({ key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', value: model })
        envVars.push({ key: 'CLAUDE_CODE_SUBAGENT_MODEL', value: model })
      }
    }

    const createdAt = this.num(raw.createdAt) || Date.now()
    const lastUsedAt = this.num(raw.lastUsedAt) || createdAt
    return { id, command, executablePath: '', extraArgs, envVars, alias: '', createdAt, lastUsedAt }
  }

  private validateEntry(entry: unknown): CodingAgentHistoryEntry | null {
    if (!entry || typeof entry !== 'object') return null
    const raw = entry as Record<string, unknown>
    const id = this.str(raw.id)
    if (!id) return null

    // Detect v2 entries by presence of agentType field and absence of command
    if (raw.agentType && !raw.command) {
      return this.migrateV2Entry(raw)
    }

    const command = this.str(raw.command)
    if (!command) return null
    const executablePath = this.str(raw.executablePath)
    const extraArgs = this.str(raw.extraArgs)
    const envVars = this.validateEnvVars(raw.envVars)
    const alias = this.str(raw.alias)
    const createdAt = this.num(raw.createdAt) || Date.now()
    const lastUsedAt = this.num(raw.lastUsedAt) || createdAt
    return { id, command, executablePath, extraArgs, envVars, alias, createdAt, lastUsedAt }
  }

  private validateState(data: unknown): CodingAgentConfigState {
    if (!data || typeof data !== 'object') {
      return { ...DEFAULT_STATE }
    }
    const raw = data as Record<string, unknown>
    const historyRaw = Array.isArray(raw.history) ? raw.history : []
    const history = historyRaw
      .map(entry => this.validateEntry(entry))
      .filter((entry): entry is CodingAgentHistoryEntry => Boolean(entry))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)

    // Migrate v2 lastUsedId (Record<string, string|null>) to v3 (string|null)
    let lastUsedId: string | null = null
    if (typeof raw.lastUsedId === 'string') {
      lastUsedId = raw.lastUsedId || null
    } else if (raw.lastUsedId && typeof raw.lastUsedId === 'object') {
      // v2 format: pick the most recently used entry across all agent types
      const idMap = raw.lastUsedId as Record<string, unknown>
      let best: CodingAgentHistoryEntry | null = null
      for (const val of Object.values(idMap)) {
        const id = this.str(val)
        if (!id) continue
        const entry = history.find(e => e.id === id)
        if (entry && (!best || entry.lastUsedAt > best.lastUsedAt)) {
          best = entry
        }
      }
      lastUsedId = best?.id ?? null
    }

    // Ensure lastUsedId references a valid entry
    if (lastUsedId && !history.some(e => e.id === lastUsedId)) {
      lastUsedId = history[0]?.id ?? null
    }

    return { version: 3, lastUsedId, history }
  }

  get(command?: string): CodingAgentConfigState {
    if (!command) return this.state
    return {
      ...this.state,
      history: this.state.history.filter(e => e.command === command)
    }
  }

  save(input: CodingAgentConfigInput): CodingAgentConfigState {
    const command = this.str(input.command)
    if (!command) return this.state
    const executablePath = this.str(input.executablePath)
    const extraArgs = this.str(input.extraArgs)
    const envVars = this.validateEnvVars(input.envVars)
    const alias = this.str(input.alias)

    const now = Date.now()
    const fp = this.envVarsFingerprint(envVars)
    const existing = this.state.history.find(e =>
      e.command === command &&
      e.executablePath === executablePath &&
      e.extraArgs === extraArgs &&
      e.alias === alias &&
      this.envVarsFingerprint(e.envVars) === fp
    )

    if (existing) {
      existing.lastUsedAt = now
      this.state.lastUsedId = existing.id
      this.state.history.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      this.persist()
      return this.state
    }

    const newEntry: CodingAgentHistoryEntry = {
      id: `${command}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      command,
      executablePath,
      extraArgs,
      envVars,
      alias,
      createdAt: now,
      lastUsedAt: now
    }

    this.state.history = [newEntry, ...this.state.history]
    this.state.lastUsedId = newEntry.id
    this.persist()
    return this.state
  }

  update(id: string, input: CodingAgentConfigInput): CodingAgentConfigState {
    const targetId = this.str(id)
    if (!targetId) return this.state
    const entry = this.state.history.find(e => e.id === targetId)
    if (!entry) return this.state

    const command = this.str(input.command)
    if (!command) return this.state

    entry.command = command
    entry.executablePath = this.str(input.executablePath)
    entry.extraArgs = this.str(input.extraArgs)
    entry.envVars = this.validateEnvVars(input.envVars)
    entry.alias = this.str(input.alias)
    entry.lastUsedAt = Date.now()

    this.state.lastUsedId = entry.id
    this.state.history.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    this.persist()
    return this.state
  }

  delete(id: string): CodingAgentConfigState {
    const targetId = this.str(id)
    if (!targetId) return this.state
    const entry = this.state.history.find(e => e.id === targetId)
    if (!entry) return this.state
    this.state.history = this.state.history.filter(e => e.id !== targetId)
    if (this.state.lastUsedId === targetId) {
      this.state.lastUsedId = this.state.history[0]?.id ?? null
    }
    this.persist()
    return this.state
  }
}

let instance: CodingAgentConfigStorage | null = null

export function getCodingAgentConfigStorage(): CodingAgentConfigStorage {
  if (!instance) {
    instance = new CodingAgentConfigStorage()
  }
  return instance
}
