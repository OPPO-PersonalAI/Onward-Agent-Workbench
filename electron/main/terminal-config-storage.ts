/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

/**
 * Terminal window configuration data structure
 */
export interface TerminalWindowConfig {
  version: number                              // Configuration version number
  layoutMode: 1 | 2 | 4 | 6                   // layout mode
  activeTerminalId: string | null              // Active terminal ID
  activePanel: 'prompt' | null                 // active panel
  terminals: { id: string; title: string }[]   // terminal list
  promptPanelWidth: number                     // PROMPT panel width, default 280
  updatedAt: number                            // Last updated
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: TerminalWindowConfig = {
  version: 1,
  layoutMode: 1,
  activeTerminalId: null,
  activePanel: null,
  terminals: [],
  promptPanelWidth: 280,
  updatedAt: Date.now()
}

/**
 * Terminal configuration storage manager
 * Use JSON files stored in the userData directory
 */
class TerminalConfigStorage {
  private storagePath: string
  private config: TerminalWindowConfig

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'terminal-config.json')
    this.config = this.load()
  }

  /**
   * Load configuration data from file
   */
  private load(): TerminalWindowConfig {
    try {
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        const parsed = JSON.parse(data) as TerminalWindowConfig
        // Verify and migrate configuration
        return this.validateConfig(parsed)
      }
    } catch (error) {
      console.error('Failed to load terminal config:', error)
    }
    return { ...DEFAULT_CONFIG }
  }

  /**
   * Validate configuration data to ensure all fields are present and valid
   */
  private validateConfig(config: Partial<TerminalWindowConfig>): TerminalWindowConfig {
    const validLayoutModes = [1, 2, 4, 6]
    // Validation panel width: minimum 150px, default 280px
    const promptPanelWidth = typeof config.promptPanelWidth === 'number' && config.promptPanelWidth >= 150
      ? config.promptPanelWidth
      : DEFAULT_CONFIG.promptPanelWidth
    return {
      version: config.version ?? DEFAULT_CONFIG.version,
      layoutMode: validLayoutModes.includes(config.layoutMode as number)
        ? config.layoutMode as 1 | 2 | 4 | 6
        : DEFAULT_CONFIG.layoutMode,
      activeTerminalId: config.activeTerminalId ?? DEFAULT_CONFIG.activeTerminalId,
      activePanel: config.activePanel === 'prompt' ? 'prompt' : null,
      terminals: Array.isArray(config.terminals) ? config.terminals : DEFAULT_CONFIG.terminals,
      promptPanelWidth,
      updatedAt: config.updatedAt ?? Date.now()
    }
  }

  /**
   * Save configuration data to file
   */
  private persist(): void {
    try {
      const dir = app.getPath('userData')
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save terminal config:', error)
    }
  }

  /**
   * Get current configuration
   */
  get(): TerminalWindowConfig {
    return { ...this.config }
  }

  /**
   * Save complete configuration
   */
  save(config: TerminalWindowConfig): boolean {
    try {
      this.config = {
        ...this.validateConfig(config),
        updatedAt: Date.now()
      }
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to save terminal config:', error)
      return false
    }
  }

  /**
   * Partially updated configuration
   */
  update(partial: Partial<TerminalWindowConfig>): boolean {
    try {
      this.config = {
        ...this.config,
        ...this.validateConfig({ ...this.config, ...partial }),
        updatedAt: Date.now()
      }
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to update terminal config:', error)
      return false
    }
  }
}

// Singleton pattern
let instance: TerminalConfigStorage | null = null

export function getTerminalConfigStorage(): TerminalConfigStorage {
  if (!instance) {
    instance = new TerminalConfigStorage()
  }
  return instance
}
