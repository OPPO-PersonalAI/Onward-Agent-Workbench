/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TerminalEnvVarEntry {
  key?: string
  value?: string
}

/** Autotest-only Windows startup: flags must precede PowerShell's -Command. */
export function isolateWindowsShellArgsForAutotest(kind: string, args: string[]): string[] {
  if (kind === 'powershell') return ['-NoProfile', '-NonInteractive', ...args]
  if (kind === 'cmd') return ['/d', ...args]
  return args.slice()
}

function findEnvKey(env: NodeJS.ProcessEnv, targetKey: string): string | undefined {
  const normalizedTarget = targetKey.toLowerCase()
  return Object.keys(env).find(key => key.toLowerCase() === normalizedTarget)
}

function deleteEnvKey(env: NodeJS.ProcessEnv, targetKey: string): void {
  const key = findEnvKey(env, targetKey)
  if (key) delete env[key]
}

function readEnvValue(env: NodeJS.ProcessEnv, targetKey: string): string | undefined {
  const key = findEnvKey(env, targetKey)
  return key ? env[key] : undefined
}

function setEnvValue(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const existingKey = findEnvKey(env, key)
  if (existingKey && existingKey !== key) delete env[existingKey]
  env[key] = value
}

function isZeroValue(value: string | undefined): boolean {
  return (value ?? '').trim() === '0'
}

function stripSurroundingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

export function buildColorCapableTerminalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  deleteEnvKey(env, 'NO_COLOR')

  if (isZeroValue(readEnvValue(env, 'FORCE_COLOR'))) {
    deleteEnvKey(env, 'FORCE_COLOR')
  }
  if (isZeroValue(readEnvValue(env, 'CLICOLOR'))) {
    deleteEnvKey(env, 'CLICOLOR')
  }

  if (!readEnvValue(env, 'COLORTERM')) {
    setEnvValue(env, 'COLORTERM', 'truecolor')
  }
  if (!readEnvValue(env, 'CLICOLOR')) {
    setEnvValue(env, 'CLICOLOR', '1')
  }

  return env
}

function normalizePathForEnvComparison(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  return trimmed.replace(/[\\/]+$/g, '').replace(/\\/g, '/')
}

export function isOnwardZshIntegrationZdotdir(value: string | undefined, currentIntegrationZdotdir?: string): boolean {
  const normalized = normalizePathForEnvComparison(value)
  if (!normalized) return false

  const current = normalizePathForEnvComparison(currentIntegrationZdotdir)
  if (current && normalized === current) return true

  const parts = normalized.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  const parent = parts[parts.length - 2]
  if (last !== 'zsh-zdotdir' || parent !== 'shell-integration') return false

  return parts.includes('resources') || parts.includes('Resources')
}

export function resolveUserZdotdirForShellIntegration(
  baseEnv: NodeJS.ProcessEnv,
  fallbackHome: string | undefined,
  currentIntegrationZdotdir?: string
): string | null {
  const candidates = [
    baseEnv.USER_ZDOTDIR,
    baseEnv.ZDOTDIR,
    fallbackHome
  ]

  for (const candidate of candidates) {
    const normalized = normalizePathForEnvComparison(candidate)
    if (!normalized) continue
    if (isOnwardZshIntegrationZdotdir(normalized, currentIntegrationZdotdir)) continue
    return candidate!.trim()
  }

  return null
}

export function applyTerminalUserEnvVars(
  baseEnv: NodeJS.ProcessEnv,
  userEnvVars: ReadonlyArray<TerminalEnvVarEntry>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  for (const entry of userEnvVars) {
    const key = stripSurroundingQuotes((entry.key || '').trim())
    const value = stripSurroundingQuotes(entry.value ?? '')
    if (key) setEnvValue(env, key, value)
  }

  return env
}
