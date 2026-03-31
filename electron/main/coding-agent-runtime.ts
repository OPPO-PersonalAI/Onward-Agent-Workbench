/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { platform, homedir } from 'os'
import { join, delimiter } from 'path'

const execFileAsync = promisify(execFile)

export type CodingAgentType = 'claude-code' | 'codex'

export interface CodingAgentRuntimeInfo {
  success: boolean
  executablePath?: string
  error?: string
}

const AGENT_EXECUTABLE: Record<CodingAgentType, string> = {
  'claude-code': 'claude',
  'codex': 'codex'
}

const AGENT_INSTALL_HINT: Record<CodingAgentType, string> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
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

// Resolve the agent executable via `which` (unix) / `where` (win)
// using a normalized PATH that covers Homebrew, npm global, ~/.local/bin, etc.
export async function getCodingAgentRuntimeInfo(agentType: CodingAgentType): Promise<CodingAgentRuntimeInfo> {
  const cmd = AGENT_EXECUTABLE[agentType]
  if (!cmd) {
    return { success: false, error: `Unknown agent type: ${agentType}` }
  }

  const whichCmd = platform() === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, [cmd], {
      timeout: 5000,
      env: getNormalizedEnv()
    })
    const resolved = (stdout || '').split(/\r?\n/)[0].trim()
    if (!resolved) {
      return {
        success: false,
        error: `${cmd} not found in PATH. Please install: ${AGENT_INSTALL_HINT[agentType]}`
      }
    }
    return { success: true, executablePath: resolved }
  } catch {
    return {
      success: false,
      error: `${cmd} not found in PATH. Please install: ${AGENT_INSTALL_HINT[agentType]}`
    }
  }
}
