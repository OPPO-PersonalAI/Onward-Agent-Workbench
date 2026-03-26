/*
 * Onward App E2E Test via CDP
 *
 * Connects to the Onward Electron app's renderer via Chrome DevTools Protocol.
 * Uses the exposed window.__terminalSessionManager to call paste() directly,
 * testing the EXACT same code path as "Send and Execute".
 */

import { readFileSync } from 'fs'
import { join } from 'path'
// Use Node.js built-in WebSocket (available in Node 22+)
const WebSocket = globalThis.WebSocket

const CDP_PORT = 9229
const PROMPT_CONTENT = readFileSync(join(__dirname, '..', 'test-prompt.txt'), 'utf-8')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Minimal CDP client using raw WebSocket
async function createCDP() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`)
  const targets = await resp.json() as any[]
  const page = targets.find((t: any) => t.type === 'page')
  if (!page) throw new Error('No page target found')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (e) => reject(e))
  })

  let msgId = 0
  const pending = new Map<number, { resolve: Function; reject: Function }>()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); p.resolve(msg) }
    }
  })

  async function evaluate(expr: string): Promise<any> {
    const id = ++msgId
    const result = await new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      }))
    })
    if (result.error) throw new Error(result.error.message)
    if (result.result?.exceptionDetails) {
      throw new Error(result.result.exceptionDetails.exception?.description || 'Eval error')
    }
    return result.result?.result?.value
  }

  return { evaluate, close: () => ws.close() }
}

async function main() {
  console.log('='.repeat(70))
  console.log('Onward App E2E Test via CDP')
  console.log('='.repeat(70))
  console.log(`Prompt: ${PROMPT_CONTENT.length} chars\n`)

  await sleep(8000) // Wait for app to fully load
  const cdp = await createCDP()
  console.log('Connected to Onward renderer\n')

  // Step 1: Find terminal sessions
  console.log('--- Step 1: Find terminal sessions ---')
  const sessionsInfo = await cdp.evaluate(`
    (() => {
      const mgr = window.__terminalSessionManager
      if (!mgr) return { error: '__terminalSessionManager not found' }
      const sessions = []
      mgr.sessions.forEach((s, id) => {
        sessions.push({ id, status: s.status, open: s.open })
      })
      return { count: sessions.length, sessions }
    })()
  `)
  console.log('  Sessions:', JSON.stringify(sessionsInfo, null, 2))

  if (!sessionsInfo.sessions || sessionsInfo.sessions.length === 0) {
    console.log('\n  No terminals found. The app needs at least one Task terminal.')
    cdp.close()
    process.exit(1)
  }

  const targetId = sessionsInfo.sessions[0].id
  console.log(`\n  Target terminal: ${targetId}`)

  // Step 2: Check bracketedPasteMode
  console.log('\n--- Step 2: Check bracketedPasteMode ---')
  const bpMode = await cdp.evaluate(`
    (() => {
      const mgr = window.__terminalSessionManager
      const session = mgr.sessions.get(${JSON.stringify(targetId)})
      if (!session) return { error: 'Session not found' }
      const terminal = session.terminal
      const modes = terminal.modes
      return {
        bracketedPasteMode: modes?.bracketedPasteMode ?? 'unknown',
        allModes: modes ? JSON.parse(JSON.stringify(modes)) : null,
      }
    })()
  `)
  console.log('  bracketedPasteMode:', JSON.stringify(bpMode))

  // Step 3: Call paste() with test content
  console.log('\n--- Step 3: Call terminalSessionManager.paste() ---')
  const pasteResult = await cdp.evaluate(`
    (() => {
      const mgr = window.__terminalSessionManager
      const content = ${JSON.stringify(PROMPT_CONTENT)}
      const ok = mgr.paste(${JSON.stringify(targetId)}, content)
      return { success: ok, contentLength: content.length }
    })()
  `)
  console.log('  paste() result:', JSON.stringify(pasteResult))

  // Step 4: Wait and send \r to trigger execution (same as handleSendAndExecuteOnTerminals)
  console.log('\n--- Step 4: Send \\r to execute ---')
  await sleep(100)
  const execResult = await cdp.evaluate(`
    (async () => {
      const ok = await window.electronAPI.terminal.write(${JSON.stringify(targetId)}, '\\r')
      return { success: ok }
    })()
  `)
  console.log('  Execute result:', JSON.stringify(execResult))

  // Step 5: Wait and capture terminal buffer to verify content
  console.log('\n--- Step 5: Wait and verify terminal content ---')
  await sleep(3000)

  const bufferContent = await cdp.evaluate(`
    (() => {
      const mgr = window.__terminalSessionManager
      const session = mgr.sessions.get(${JSON.stringify(targetId)})
      if (!session) return { error: 'Session not found' }
      const terminal = session.terminal
      const buffer = terminal.buffer.active

      // Read all lines from the terminal buffer
      const lines = []
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)
        if (line) {
          const text = line.translateToString(true)
          if (text.trim()) lines.push(text.trim())
        }
      }
      return { totalLines: buffer.length, nonEmptyLines: lines.length, lines: lines.slice(-30) }
    })()
  `)
  console.log(`  Buffer: ${bufferContent.totalLines} total, ${bufferContent.nonEmptyLines} non-empty`)
  console.log('  Last 30 non-empty lines:')
  for (const line of bufferContent.lines || []) {
    console.log(`    ${line.slice(0, 100)}`)
  }

  // Step 6: Verify content integrity
  console.log('\n--- Step 6: Content integrity check ---')
  const contentLines = PROMPT_CONTENT.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l.length >= 3)
  const bufferText = (bufferContent.lines || []).join('\n')
  let found = 0
  let missing: string[] = []
  for (const line of contentLines) {
    const sample = line.slice(0, 12)
    if (bufferText.includes(sample)) {
      found++
    } else {
      missing.push(line.slice(0, 50))
    }
  }
  console.log(`  Lines found: ${found}/${contentLines.length}`)
  if (missing.length > 0) {
    console.log('  Missing lines:')
    for (const m of missing) console.log(`    "${m}"`)
  }

  const pass = found === contentLines.length
  console.log(`\n${'='.repeat(70)}`)
  console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`)
  console.log(`  bracketedPasteMode: ${bpMode.bracketedPasteMode}`)
  console.log(`  paste() success: ${pasteResult.success}`)
  console.log(`  Lines in buffer: ${found}/${contentLines.length}`)
  console.log('='.repeat(70))

  cdp.close()
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(2)
})
