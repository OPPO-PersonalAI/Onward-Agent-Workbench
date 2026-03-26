/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

/**
 * Prompt data structure
 */
export interface Prompt {
  id: string
  title: string
  content: string
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/**
 * Prompt local storage manager
 * Use JSON files stored in the userData directory
 */
class PromptStorage {
  private storagePath: string
  private prompts: Prompt[] = []

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'prompts.json')
    this.load()
  }

  /**
   * Load Prompt data from file
   */
  private load(): void {
    try {
      if (existsSync(this.storagePath)) {
        const data = readFileSync(this.storagePath, 'utf-8')
        const loadedPrompts = JSON.parse(data)
        // Compatible with old data: add default values ​​for data without pinned fields
        this.prompts = loadedPrompts.map((p: Prompt) => ({
          ...p,
          pinned: p.pinned ?? false
        }))
      }
    } catch (error) {
      console.error('Failed to load prompts:', error)
      this.prompts = []
    }
  }

  /**
   * Save Prompt data to file
   */
  private persist(): void {
    try {
      const dir = join(app.getPath('userData'))
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.prompts, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to save prompts:', error)
    }
  }

  /**
   * Get all prompts
   */
  getAll(): Prompt[] {
    return [...this.prompts]
  }

  /**
   * Save or update Prompt
   */
  save(prompt: Prompt): boolean {
    try {
      const index = this.prompts.findIndex(p => p.id === prompt.id)
      if (index >= 0) {
        // Update existing prompt
        this.prompts[index] = {
          ...prompt,
          pinned: prompt.pinned ?? false,
          updatedAt: Date.now()
        }
      } else {
        // New Prompt
        this.prompts.push({
          ...prompt,
          pinned: prompt.pinned ?? false,
          createdAt: prompt.createdAt || Date.now(),
          updatedAt: Date.now()
        })
      }
      this.persist()
      return true
    } catch (error) {
      console.error('Failed to save prompt:', error)
      return false
    }
  }

  /**
   * Delete Prompt
   */
  delete(id: string): boolean {
    try {
      const index = this.prompts.findIndex(p => p.id === id)
      if (index >= 0) {
        this.prompts.splice(index, 1)
        this.persist()
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to delete prompt:', error)
      return false
    }
  }
}

// Singleton pattern
let instance: PromptStorage | null = null

export function getPromptStorage(): PromptStorage {
  if (!instance) {
    instance = new PromptStorage()
  }
  return instance
}
