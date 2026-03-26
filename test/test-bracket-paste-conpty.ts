/*
 * ConPTY Bracket Paste Passthrough Test
 *
 * Definitive test: does ConPTY pass \x1b[200~ and \x1b[201~ through to
 * the child process when the child is in raw mode (ENABLE_VIRTUAL_TERMINAL_INPUT)?
 *
 * If YES: terminal.paste() is the correct fix — markers reach Claude Code.
 * If NO:  we need a completely different approach for Windows.
 */

import * as pty from 'node-pty'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const ESC = '\x1b'
const BRACKET_START = `${ESC}[200~`
const BRACKET_END = `${ESC}[201~`

const PROMPT_CONTENT = readFileSync(
  join(__dirname, '..', 'test-prompt.txt'), 'utf-8'
)

function makeRawCaptureScript(outputPath: string): string {
  return [
    `const fs = require('fs');`,
    `process.stdin.setRawMode(true);`,
    `process.stdin.resume();`,
    `const chunks = [];`,
    `const STOP = Buffer.from('__STOP__');`,
    `process.stdin.on('data', (chunk) => {`,
    `  chunks.push(Buffer.from(chunk));`,
    `  const combined = Buffer.concat(chunks);`,
    `  if (combined.indexOf(STOP) >= 0) {`,
    `    const data = combined.slice(0, combined.indexOf(STOP));`,
    `    const hex = data.toString('hex');`,
    `    const text = data.toString('utf-8');`,
    // Check for bracket paste markers as raw bytes
    // ESC = 0x1b, [ = 0x5b, 2 = 0x32, 0 = 0x30, 0 = 0x30, ~ = 0x7e
    `    const bpStart = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);`,
    `    const bpEnd = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);`,
    `    const hasStart = data.indexOf(bpStart) >= 0;`,
    `    const hasEnd = data.indexOf(bpEnd) >= 0;`,
    `    const startPos = data.indexOf(bpStart);`,
    `    const endPos = data.indexOf(bpEnd);`,
    // Count ESC bytes
    `    let escCount = 0;`,
    `    for (let i = 0; i < data.length; i++) if (data[i] === 0x1b) escCount++;`,
    // Show first 100 bytes as hex for debugging
    `    const hexHead = data.slice(0, 100).toString('hex');`,
    `    const result = {`,
    `      totalBytes: data.length,`,
    `      hasStart, hasEnd, startPos, endPos, escCount,`,
    `      hexHead,`,
    `      text: text.slice(0, 200),`,
    `    };`,
    `    fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result, null, 2));`,
    `    process.exit(0);`,
    `  }`,
    `});`,
    `setTimeout(() => {`,
    `  const combined = Buffer.concat(chunks);`,
    `  fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({`,
    `    timeout: true,`,
    `    totalBytes: combined.length,`,
    `    hexHead: combined.slice(0, 100).toString('hex'),`,
    `  }, null, 2));`,
    `  process.exit(1);`,
    `}, 8000);`,
  ].join('\n')
}

async function runTest(
  name: string,
  content: string,
  wrapInBracketPaste: boolean
): Promise<{ pass: boolean; detail: string }> {
  console.log(`\n--- ${name} ---`)

  const capPath = join(tmpdir(), `bp-test-${Date.now()}.json`)
  const scriptPath = join(tmpdir(), `bp-capture-${Date.now()}.js`)
  writeFileSync(scriptPath, makeRawCaptureScript(capPath))

  const proc = pty.spawn(process.execPath, [scriptPath], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50
  })

  let output = ''
  proc.onData((d: string) => { output += d })

  await sleep(1500)

  // Send content — with or without bracket paste wrapping
  if (wrapInBracketPaste) {
    proc.write(BRACKET_START + content + BRACKET_END)
  } else {
    proc.write(content)
  }

  await sleep(300)
  proc.write('__STOP__')
  await sleep(3000)

  proc.kill()

  if (!existsSync(capPath)) {
    try { unlinkSync(scriptPath) } catch {}
    return { pass: false, detail: 'Capture file not created' }
  }

  const result = JSON.parse(readFileSync(capPath, 'utf-8'))
  try { unlinkSync(capPath) } catch {}
  try { unlinkSync(scriptPath) } catch {}

  if (result.timeout) {
    return { pass: false, detail: `Timeout — ${result.totalBytes} bytes received` }
  }

  const detail = [
    `bytes=${result.totalBytes}`,
    `hasStart=${result.hasStart}`,
    `hasEnd=${result.hasEnd}`,
    `startPos=${result.startPos}`,
    `endPos=${result.endPos}`,
    `escCount=${result.escCount}`,
  ].join(' | ')

  console.log(`  ${detail}`)
  console.log(`  hexHead: ${result.hexHead}`)

  return { pass: result.hasStart && result.hasEnd, detail }
}

async function main() {
  console.log('='.repeat(70))
  console.log('ConPTY Bracket Paste Passthrough Test')
  console.log('='.repeat(70))

  // Test 1: Send simple text WITH bracket paste markers
  const r1 = await runTest(
    'T1: Simple text WITH bracket paste markers',
    'Hello World',
    true
  )
  console.log(`  Result: ${r1.pass ? 'MARKERS RECEIVED' : 'MARKERS STRIPPED'}`)

  // Test 2: Send simple text WITHOUT bracket paste markers (baseline)
  const r2 = await runTest(
    'T2: Simple text without markers (baseline)',
    'Hello World',
    false
  )
  console.log(`  Result: ${r2.pass ? 'UNEXPECTED MARKERS' : 'No markers (expected)'}`)

  // Test 3: Send test-prompt.txt WITH bracket paste markers
  const r3 = await runTest(
    'T3: test-prompt.txt WITH bracket paste markers',
    PROMPT_CONTENT,
    true
  )
  console.log(`  Result: ${r3.pass ? 'MARKERS RECEIVED' : 'MARKERS STRIPPED'}`)

  // Test 4: Send just the bracket paste markers with \r\n content
  const r4 = await runTest(
    'T4: Line1\\r\\nLine2 WITH bracket paste markers',
    'Line1\r\nLine2\r\nLine3',
    true
  )
  console.log(`  Result: ${r4.pass ? 'MARKERS RECEIVED' : 'MARKERS STRIPPED'}`)

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('CONCLUSION')
  console.log('='.repeat(70))

  if (r1.pass) {
    console.log('ConPTY PASSES bracket paste markers through!')
    console.log('→ terminal.paste() IS the correct fix.')
    console.log('→ The issue may be in xterm.js not wrapping correctly.')
  } else {
    console.log('ConPTY STRIPS bracket paste markers.')
    console.log('→ terminal.paste() alone cannot fix this on Windows.')
    console.log('→ Need an alternative approach for Windows.')
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(2)
})
