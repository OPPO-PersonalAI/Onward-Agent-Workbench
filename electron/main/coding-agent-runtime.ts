/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { platform, homedir } from 'os'
import { join, delimiter, isAbsolute } from 'path'
import { accessSync, constants } from 'fs'

const execFileAsync = promisify(execFile)

export interface CodingAgentRuntimeInfo {
  success: boolean
  executablePath?: string
  error?: string
}

// Known agent commands with install hints
const KNOWN_INSTALL_HINTS: Record<string, string> = {
  'claude': 'npm install -g @anthropic-ai/claude-code',
  'codex': 'npm install -g @openai/codex'
}

// Build a normalized PATH that includes common install locations.
// When launched from Finder/Dock on macOS, process.env.PATH typically
// only contains /usr/bin:/bin, missing Homebrew and npm global dirs.
function getNormalizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH'
  const current = env[pathKey] || ''
  const extras: string[] = []

  if (platform() === 'win32') {
    const appData = process.env.APPDATA || ''
    if (appData) extras.push(join(appData, 'npm'))
    extras.push('C:\\Program Files\\nodejs')
  } else {
    extras.push(
      join(homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/local/bin'
    )
  }

  const merged = [...current.split(delimiter).filter(Boolean), ...extras]
  env[pathKey] = Array.from(new Set(merged)).join(delimiter)
  return env
}

// Check whether a command string looks like an absolute path
function isAbsolutePath(cmd: string): boolean {
  if (isAbsolute(cmd)) return true
  // Windows drive-letter paths like C:\... or D:/...
  if (platform() === 'win32' && /^[A-Za-z]:[/\\]/.test(cmd)) return true
  return false
}

// Validate that an absolute path points to an existing, executable file
function validateAbsolutePath(filePath: string): CodingAgentRuntimeInfo {
  try {
    const mode = platform() === 'win32' ? constants.R_OK : constants.R_OK | constants.X_OK
    accessSync(filePath, mode)
    return { success: true, executablePath: filePath }
  } catch {
    return { success: false, error: `File not found or not executable: ${filePath}` }
  }
}

// Resolve an agent command via `which` (unix) / `where` (win)
// using a normalized PATH that covers Homebrew, npm global, ~/.local/bin, etc.
// If executablePath is provided, validate that file directly instead of PATH lookup.
export async function getCodingAgentRuntimeInfo(command: string, executablePath?: string): Promise<CodingAgentRuntimeInfo> {
  if (!command && !executablePath) {
    return { success: false, error: 'No command specified' }
  }

  // User-provided executable path: validate directly without PATH resolution
  if (executablePath) {
    return validateAbsolutePath(executablePath)
  }

  const whichCmd = platform() === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, [command], {
      timeout: 5000,
      env: getNormalizedEnv()
    })
    const resolved = (stdout || '').split(/\r?\n/)[0].trim()
    if (!resolved) {
      const hint = KNOWN_INSTALL_HINTS[command]
      return {
        success: false,
        error: hint
          ? `${command} not found in PATH. Please install: ${hint}`
          : `${command} not found in PATH.`
      }
    }
    return { success: true, executablePath: resolved }
  } catch {
    const hint = KNOWN_INSTALL_HINTS[command]
    return {
      success: false,
      error: hint
        ? `${command} not found in PATH. Please install: ${hint}`
        : `${command} not found in PATH.`
    }
  }
}
