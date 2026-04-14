/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, execFile } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(check, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const intervalMs = options.intervalMs ?? 500
  const description = options.description ?? 'condition'
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const value = await check()
      if (value) {
        return value
      }
    } catch (error) {
      lastError = error
    }

    await sleep(intervalMs)
  }

  if (lastError) {
    throw new Error(`Timed out waiting for ${description}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  throw new Error(`Timed out waiting for ${description}.`)
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`
}

export async function runShellCommand(command, options = {}) {
  const shellArgs = process.platform === 'win32'
    ? ['cmd.exe', ['/c', command]]
    : ['/bin/zsh', ['-lc', command]]
  const child = spawn(shellArgs[0], shellArgs[1], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? 'inherit'
  })

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })

  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command}`)
  }
}

export function spawnApp(executablePath, options = {}) {
  const child = spawn(executablePath, [], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString()
    stdout += text
    process.stdout.write(text)
  })
  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString()
    stderr += text
    process.stderr.write(text)
  })

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    waitForExit: () => new Promise((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ code: child.exitCode, signal: child.signalCode })
        return
      }
      child.on('error', reject)
      child.on('exit', (code, signal) => resolve({ code, signal }))
    })
  }
}

export async function stopChildProcess(child, options = {}) {
  if (!child || child.exitCode !== null || child.killed) return

  child.kill(options.signal ?? 'SIGTERM')
  await waitFor(
    () => child.exitCode !== null || child.killed,
    {
      timeoutMs: options.timeoutMs ?? 5000,
      intervalMs: 200,
      description: 'child process exit'
    }
  ).catch(async () => {
    child.kill('SIGKILL')
    await sleep(500)
  })
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function terminateProcessByPid(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process id "${String(pid)}".`)
  }

  if (!isProcessAlive(pid)) {
    return
  }

  if (process.platform === 'win32') {
    await runShellCommand(`taskkill /PID ${pid} /T /F`, {
      cwd: options.cwd,
      stdio: options.stdio ?? 'inherit'
    })
  } else {
    process.kill(pid, 'SIGTERM')
    await waitFor(
      () => !isProcessAlive(pid),
      {
        timeoutMs: options.timeoutMs ?? 5000,
        intervalMs: 200,
        description: `process ${pid} exit`
      }
    ).catch(() => {
      process.kill(pid, 'SIGKILL')
    })
  }

  await waitFor(
    () => !isProcessAlive(pid),
    {
      timeoutMs: options.timeoutMs ?? 15000,
      intervalMs: 200,
      description: `process ${pid} termination`
    }
  )
}

export function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

export async function waitForLockFile(userDataDir, options = {}) {
  const previousStartedAt = options.previousStartedAt ?? -1
  const lockFilePath = join(userDataDir, 'onward-api.lock')

  return waitFor(() => {
    if (!existsSync(lockFilePath)) return null
    const lockData = readJsonFile(lockFilePath)
    if (Number(lockData.startedAt || 0) <= previousStartedAt) {
      return null
    }
    return lockData
  }, {
    timeoutMs: options.timeoutMs ?? 30000,
    intervalMs: 250,
    description: `API lock file in ${userDataDir}`
  })
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.headers ?? {})
    },
    body: options.body
  })

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${url}`)
  }

  return response.json()
}

export async function waitForUpdaterStatus(port, predicate, options = {}) {
  return waitFor(async () => {
    const status = await fetchJson(`http://127.0.0.1:${port}/api/debug/updater/status`)
    return predicate(status) ? status : null
  }, {
    timeoutMs: options.timeoutMs ?? 60000,
    intervalMs: options.intervalMs ?? 500,
    description: options.description ?? 'updater status'
  })
}

export async function postJson(port, path) {
  return fetchJson(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
}

export async function waitForHealthVersion(port, expectedVersion, options = {}) {
  return waitFor(async () => {
    const health = await fetchJson(`http://127.0.0.1:${port}/api/health`)
    return health.version === expectedVersion ? health : null
  }, {
    timeoutMs: options.timeoutMs ?? 30000,
    intervalMs: options.intervalMs ?? 500,
    description: `health version ${expectedVersion}`
  })
}

export async function waitForStdoutMatch(appProcess, pattern, options = {}) {
  const matcher = typeof pattern === 'string'
    ? (text) => text.includes(pattern)
    : (text) => pattern.test(text)

  return waitFor(() => matcher(appProcess.getStdout()) ? appProcess.getStdout() : null, {
    timeoutMs: options.timeoutMs ?? 30000,
    intervalMs: options.intervalMs ?? 500,
    description: options.description ?? 'stdout pattern match'
  })
}

export function listUpdateFiles(userDataDir) {
  const updatesDir = join(userDataDir, 'updates')
  if (!existsSync(updatesDir)) return []

  const files = []
  for (const entry of readdirSync(updatesDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(join(updatesDir, entry.name))
      continue
    }
    if (!entry.isDirectory()) continue
    const versionDir = join(updatesDir, entry.name)
    for (const nestedEntry of readdirSync(versionDir, { withFileTypes: true })) {
      if (nestedEntry.isFile()) {
        files.push(join(versionDir, nestedEntry.name))
      }
    }
  }
  return files.sort()
}

export async function readPlistVersion(plistPath) {
  const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    plistPath
  ])
  return stdout.trim()
}
