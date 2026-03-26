#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')

// ─── Service discovery ───────────────────────────────────────────────

function discoverOnward() {
  // Priority: environment variables (Injected when Onward creates PTY)
  const port = process.env.ONWARD_API_PORT
  if (port) {
    return { host: '127.0.0.1', port: parseInt(port, 10) }
  }

  // Alternative: read from lock file
  const userDataDir = process.env.ONWARD_USER_DATA
  if (!userDataDir) {
    throw new Error('Onward environment was not detected (missing ONWARD_API_PORT and ONWARD_USER_DATA)')
  }

  const lockPath = path.join(userDataDir, 'onward-api.lock')
  if (!fs.existsSync(lockPath)) {
    throw new Error('Onward is not running (lock file not found)')
  }

  let lock
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
  } catch {
    throw new Error('The lock file is invalid')
  }

  // Verify that the process is alive
  try {
    process.kill(lock.pid, 0)
  } catch {
    throw new Error('The Onward process has already exited (PID: ' + lock.pid + ')')
  }

  return { host: '127.0.0.1', port: lock.port }
}

// ─── HTTP request tool ───────────────────────────────────────────

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    let connection
    try {
      connection = discoverOnward()
    } catch (err) {
      reject(err)
      return
    }

    const options = {
      hostname: connection.host,
      port: connection.port,
      path: urlPath,
      method: method,
      headers: {}
    }

    let bodyStr
    if (body !== undefined) {
      bodyStr = JSON.stringify(body)
      options.headers['Content-Type'] = 'application/json; charset=utf-8'
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr)
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve({ raw: data })
        }
      })
    })

    req.on('error', (err) => {
      reject(new Error('Failed to connect to Onward: ' + err.message))
    })

    // Timeout 10 seconds
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Request timed out'))
    })

    if (bodyStr) {
      req.write(bodyStr)
    }
    req.end()
  })
}

// ─── Terminal ID analysis ────────────────────────────────────────────

/**
 * Parse the task ID entered by the user into the complete terminal ID
 * Supported: numbers (1, 2, 3), "terminal-1", or full ID
 */
async function resolveTerminalId(taskArg) {
  if (!taskArg) {
    throw new Error('Specify a Task number or a terminal ID')
  }

  // If it is a pure number, first get the tasks list to map
  const num = parseInt(taskArg, 10)
  if (!isNaN(num) && String(num) === taskArg) {
    const tasksResult = await request('GET', '/api/tasks')
    if (!tasksResult.tasks || tasksResult.tasks.length === 0) {
      throw new Error('The current tab has no available Task')
    }

    const task = tasksResult.tasks.find(t => t.index === num)
    if (!task) {
      const available = tasksResult.tasks.map(t => t.index).join(', ')
      throw new Error(`Task ${num} does not exist. Available Task numbers: ${available}`)
    }
    return task.id
  }

  // If it is "terminal-N" format or other complete ID, return it directly
  return taskArg
}

// ─── Button mapping table ───────────────────────────────────────────────

/**
 * Mapping of special key names → ANSI escape sequences
 * Supports common keys required for TUI application interaction
 */
const KEY_MAP = {
  // Basic buttons
  'enter':     '\r',
  'return':    '\r',
  'tab':       '\t',
  'escape':    '\x1b',
  'esc':       '\x1b',
  'space':     ' ',
  'backspace': '\x7f',
  'delete':    '\x1b[3~',
  'del':       '\x1b[3~',

  // Arrow keys
  'up':        '\x1b[A',
  'down':      '\x1b[B',
  'right':     '\x1b[C',
  'left':      '\x1b[D',

  // Navigation keys
  'home':      '\x1b[H',
  'end':       '\x1b[F',
  'pageup':    '\x1b[5~',
  'pagedown':  '\x1b[6~',

  // Key combination
  'shift+tab': '\x1b[Z',
  'ctrl+c':    '\x03',
  'ctrl+d':    '\x04',
  'ctrl+z':    '\x1a',
  'ctrl+l':    '\x0c',
  'ctrl+a':    '\x01',
  'ctrl+e':    '\x05',
  'ctrl+u':    '\x15',
  'ctrl+k':    '\x0b',
  'ctrl+w':    '\x17',
  'ctrl+r':    '\x12',
  'ctrl+o':    '\x0f',
  'ctrl+b':    '\x02',

  // Function keys
  'f1':        '\x1bOP',
  'f2':        '\x1bOQ',
  'f3':        '\x1bOR',
  'f4':        '\x1bOS',
  'f5':        '\x1b[15~',
  'f6':        '\x1b[17~',
  'f7':        '\x1b[18~',
  'f8':        '\x1b[19~',
  'f9':        '\x1b[20~',
  'f10':       '\x1b[21~',
  'f11':       '\x1b[23~',
  'f12':       '\x1b[24~'
}

// ───Command processing ────────────────────────────────────────────────

async function cmdHealth() {
  const result = await request('GET', '/api/health')
  return result
}

async function cmdTasks() {
  const result = await request('GET', '/api/tasks')
  return result
}

async function cmdRead(taskArg, options) {
  const terminalId = await resolveTerminalId(taskArg)

  let urlPath = `/api/terminal/${encodeURIComponent(terminalId)}/buffer`
  const params = []

  if (options.chars) {
    params.push('mode=tail-chars')
    params.push(`chars=${options.chars}`)
  } else {
    // Default tail-lines, 100 lines each time
    params.push('mode=tail-lines')
    params.push(`lines=${options.lines || 100}`)
    if (options.offset) {
      params.push(`offset=${options.offset}`)
    }
  }

  // Support specifying buffer type
  if (options.buffer && ['active', 'normal', 'alternate'].includes(options.buffer)) {
    params.push(`buffer=${options.buffer}`)
  }

  if (params.length > 0) {
    urlPath += '?' + params.join('&')
  }

  const result = await request('GET', urlPath)
  return result
}

async function cmdExec(taskArg, text, options) {
  const terminalId = await resolveTerminalId(taskArg)

  // --clean-env: Automatically add the unset statement before the command to clear environment variables that may interfere with the child process
  let finalText = text
  if (options && options.cleanEnv) {
    finalText = 'unset CLAUDECODE CLAUDE_CODE_ENTRY_POINT && ' + text
  }

  const result = await request('POST', `/api/terminal/${encodeURIComponent(terminalId)}/write`, {
    text: finalText,
    execute: true
  })
  return result
}

async function cmdSend(taskArg, text) {
  const terminalId = await resolveTerminalId(taskArg)
  const result = await request('POST', `/api/terminal/${encodeURIComponent(terminalId)}/write`, {
    text: text,
    execute: false
  })
  return result
}

async function cmdKey(taskArg, keyNames) {
  const terminalId = await resolveTerminalId(taskArg)

  // Convert key name sequence to ANSI sequence
  const sequence = keyNames.map(name => {
    const lower = name.toLowerCase()
    const mapped = KEY_MAP[lower]
    if (!mapped) {
      const available = Object.keys(KEY_MAP).join(', ')
      throw new Error(`Unknown key: "${name}". Available keys: ${available}`)
    }
    return mapped
  }).join('')

  const result = await request('POST', `/api/terminal/${encodeURIComponent(terminalId)}/write`, {
    text: sequence,
    execute: false
  })
  return result
}

// ─── Parameter analysis ────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2) // Remove node and script paths
  const command = args[0]
  const positional = []
  const flags = {}

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--lines' && i + 1 < args.length) {
      flags.lines = parseInt(args[++i], 10)
    } else if (arg === '--chars' && i + 1 < args.length) {
      flags.chars = parseInt(args[++i], 10)
    } else if (arg === '--offset' && i + 1 < args.length) {
      flags.offset = parseInt(args[++i], 10)
    } else if (arg === '--all') {
      throw new Error('--all is disabled because it reads the full buffer and can consume too many tokens. Use --lines <N> or --chars <N> instead.')
    } else if (arg === '--buffer' && i + 1 < args.length) {
      flags.buffer = args[++i]
    } else if (arg === '--clean-env' || arg === '-E') {
      flags.cleanEnv = true
    } else if (arg.startsWith('--')) {
      // Ignore unknown flag
    } else {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

function printUsage() {
  const usage = `onward-bridge - Onward cross-Task terminal bridge

Usage:
  onward-bridge health                            Health check
  onward-bridge tasks                             List all Tasks in the current tab
  onward-bridge read <task> [options]             Read terminal content
  onward-bridge exec <task> "<command>" [options] Send a command and execute it (Enter)
  onward-bridge send <task> "<text>"              Send text only (no Enter)
  onward-bridge key <task> <key> [key...]         Send special keys

Read options:
  --lines <N>       Read the last N lines (default: 100)
  --offset <N>      Skip N lines from the end before reading (for incremental reads)
  --chars <N>       Read the last N characters
  --buffer <type>   Choose which buffer to read:
                      active    - currently active buffer (default)
                      normal    - main shell history buffer
                      alternate - alternate screen buffer for TUI apps

Execution options:
  --clean-env, -E   Clear CLAUDECODE-related environment variables before execution
                    (useful when launching Claude Code inside an Onward terminal)

Available keys:
  Basic:      enter, tab, escape/esc, space, backspace, delete
  Direction:  up, down, left, right
  Navigation: home, end, pageup, pagedown
  Combos:     shift+tab, ctrl+c, ctrl+d, ctrl+z, ctrl+l, ctrl+a,
              ctrl+e, ctrl+u, ctrl+k, ctrl+w, ctrl+r, ctrl+o, ctrl+b
  Function:   f1-f12

<task> accepts a numeric index (1, 2, 3) or a full terminal ID (terminal-1)

Examples:
  onward-bridge read 1                            Read the last 100 lines from Task 1
  onward-bridge read 1 --offset 100               Read lines 101-200 from the end of Task 1
  onward-bridge read 1 --buffer alternate         Read the TUI screen buffer from Task 1
  onward-bridge read 1 --buffer normal            Read the shell history buffer from Task 1
  onward-bridge exec 2 "npm test"                 Run npm test in Task 2
  onward-bridge exec 2 "claude" --clean-env       Launch Claude Code after cleaning env vars
  onward-bridge exec 2 "claude" -E                Same as above (short form)
  onward-bridge send 2 "some text"                Send text to Task 2
  onward-bridge key 2 enter                       Send Enter to Task 2
  onward-bridge key 2 shift+tab                   Send Shift+Tab to Task 2
  onward-bridge key 2 up up enter                 Send Up, Up, Enter to Task 2`

  return { usage }
}

// ─── Main entrance ─────────────────────────────────────────────────

async function main() {
  let command, positional, flags
  try {
    ({ command, positional, flags } = parseArgs(process.argv))
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }, null, 2))
    process.exit(1)
  }

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(JSON.stringify(printUsage(), null, 2))
    process.exit(0)
  }

  try {
    let result

    switch (command) {
      case 'health':
        result = await cmdHealth()
        break

      case 'tasks':
        result = await cmdTasks()
        break

      case 'read':
        result = await cmdRead(positional[0], flags)
        break

      case 'exec':
        if (!positional[1]) {
          throw new Error('Provide a command to execute, for example: onward-bridge exec 1 "ls -la"')
        }
        result = await cmdExec(positional[0], positional[1], flags)
        break

      case 'send':
        if (!positional[1]) {
          throw new Error('Provide text to send, for example: onward-bridge send 1 "text"')
        }
        result = await cmdSend(positional[0], positional[1])
        break

      case 'key':
        if (positional.length < 2) {
          throw new Error('Provide at least one key name, for example: onward-bridge key 1 enter\nAvailable keys: ' + Object.keys(KEY_MAP).join(', '))
        }
        result = await cmdKey(positional[0], positional.slice(1))
        break

      default:
        throw new Error(`Unknown command: ${command}. Use "onward-bridge help" for usage.`)
    }

    console.log(JSON.stringify(result, null, 2))
    process.exit(0)
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }, null, 2))
    process.exit(1)
  }
}

main()
