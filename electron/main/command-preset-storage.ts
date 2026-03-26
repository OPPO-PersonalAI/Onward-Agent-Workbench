/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

/**
 * Command default data structure
 */
export interface CommandPreset {
  id: string
  command: string
  isBuiltin: boolean
  createdAt: number
}

/**
 * List of built-in commands
 */
const BUILTIN_COMMANDS: string[] = [
  'claude',
  'claude -c',
  'claude --dangerously-skip-permissions',
  'claude --dangerously-skip-permissions -c',
  'pwd',
  'ls -l'
]

/**
 * Command to preset local storage manager
 * Use JSON files stored in the userData directory
 */
class CommandPresetStorage {
  private storagePath: string
  private customCommands: CommandPreset[] = []

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'command-presets.json')
    this.load()
  }

  /**
   * Load custom command data from file
   */
  private load(): void {
    try {
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        this.customCommands = JSON.parse(data)
      }
    } catch (error) {
      console.error('Failed to load command presets:', error)
      this.customCommands = []
    }
  }

  /**
   * Save custom command data to file
   */
  private persist(): void {
    try {
      const dir = join(app.getPath('userData'))
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.customCommands, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save command presets:', error)
    }
  }

  /**
   * Get all commands (built-in + custom)
   */
  getAll(): CommandPreset[] {
    const builtinPresets: CommandPreset[] = BUILTIN_COMMANDS.map((cmd, index) => ({
      id: `builtin-${index}`,
      command: cmd,
      isBuiltin: true,
      createdAt: 0
    }))
    return [...builtinPresets, ...this.customCommands]
  }

  /**
   * Save custom command
   */
  save(preset: CommandPreset): boolean {
    try {
      // Check for duplicates
      const allCommands = this.getAll()
      if (allCommands.some(p => p.command === preset.command)) {
        return false
      }

      this.customCommands.push({
        ...preset,
        isBuiltin: false,
        createdAt: preset.createdAt || Date.now()
      })
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to save command preset:', error)
      return false
    }
  }

  /**
   * Delete custom command
   */
  delete(id: string): boolean {
    try {
      // Removal of built-in commands is not allowed
      if (id.startsWith('builtin-')) {
        return false
      }

      const index = this.customCommands.findIndex(p => p.id === id)
      if (index >= 0) {
        this.customCommands.splice(index, 1)
        this.persist()
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to delete command preset:', error)
      return false
    }
  }
}

// Singleton pattern
let instance: CommandPresetStorage | null = null

export function getCommandPresetStorage(): CommandPresetStorage {
  if (!instance) {
    instance = new CommandPresetStorage()
  }
  return instance
}
