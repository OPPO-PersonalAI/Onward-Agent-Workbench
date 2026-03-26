/*
 * Full End-to-End Prompt Send Test
 *
 * Simulates the EXACT xterm.js paste() flow:
 *   1. prepareTextForTerminal: \r?\n → \r
 *   2. bracketTextForPaste: wrap in \x1b[200~ ... \x1b[201~
 *   3. pty.write(wrappedContent)
 *   4. Child process (Node.js in raw mode, simulating Claude Code) captures stdin
 *   5. Verify: bracket paste markers received, content 100% intact, order correct
 *
 * Also tests the FALLBACK path (no bracket paste) to show the difference.
 */

import * as pty from 'node-pty'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---- xterm.js paste logic (exact copy from Clipboard.ts) ----

function prepareTextForTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r')
}

function bracketTextForPaste(text: string, bracketedPasteMode: boolean): string {
  if (bracketedPasteMode) {
    return '\x1b[200~' + text + '\x1b[201~'
  }
  return text
}

function xtermPaste(text: string, bracketedPasteMode: boolean): string {
  const prepared = prepareTextForTerminal(text)
  return bracketTextForPaste(prepared, bracketedPasteMode)
}

// ---- Capture child script ----

function makeCaptureScript(outputPath: string): string {
  return [
    `const fs = require('fs');`,
    `process.stdin.setRawMode(true);`,
    `process.stdin.resume();`,
    `const chunks = [];`,
    `const STOP = Buffer.from('__STOP__');`,
    `const ESC = String.fromCharCode(0x1b);`,
    `const BP_START = Buffer.from(ESC + '[200~');`,
    `const BP_END = Buffer.from(ESC + '[201~');`,
    `process.stdin.on('data', (chunk) => {`,
    `  chunks.push(Buffer.from(chunk));`,
    `  const combined = Buffer.concat(chunks);`,
    `  if (combined.indexOf(STOP) >= 0) {`,
    `    const data = combined.slice(0, combined.indexOf(STOP));`,
    `    const startIdx = data.indexOf(BP_START);`,
    `    const endIdx = data.indexOf(BP_END);`,
    `    let content = data;`,
    `    if (startIdx >= 0 && endIdx > startIdx) {`,
    `      content = data.slice(startIdx + BP_START.length, endIdx);`,
    `    }`,
    `    const result = {`,
    `      totalBytes: data.length,`,
    `      hasBracketStart: startIdx >= 0,`,
    `      hasBracketEnd: endIdx >= 0,`,
    `      contentBytes: content.length,`,
    `      contentHex: content.toString('hex'),`,
    `      contentUtf8: content.toString('utf-8'),`,
    `    };`,
    `    fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(result, null, 2));`,
    `    process.exit(0);`,
    `  }`,
    `});`,
    `setTimeout(() => {`,
    `  const combined = Buffer.concat(chunks);`,
    `  fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({`,
    `    timeout: true, totalBytes: combined.length,`,
    `    hex: combined.slice(0, 200).toString('hex'),`,
    `  }, null, 2));`,
    `  process.exit(1);`,
    `}, 10000);`,
  ].join('\n')
}

// ---- Test runner ----

interface TestResult {
  id: string
  name: string
  pass: boolean
  detail: string
}

const results: TestResult[] = []

async function runTest(
  id: string,
  name: string,
  originalContent: string,
  useBracketPaste: boolean,
): Promise<void> {
  console.log(`\n--- ${id}: ${name} ---`)

  const capPath = join(tmpdir(), `e2e-${id}-${Date.now()}.json`)
  const scriptPath = join(tmpdir(), `e2e-capture-${id}-${Date.now()}.js`)
  writeFileSync(scriptPath, makeCaptureScript(capPath))

  const proc = pty.spawn(process.execPath, [scriptPath], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50
  })

  let output = ''
  proc.onData((d: string) => { output += d })

  await sleep(1500)

  // Simulate xterm.js paste() — EXACT same transformation
  const pasteData = xtermPaste(originalContent, useBracketPaste)
  proc.write(pasteData)

  await sleep(300)
  proc.write('__STOP__')
  await sleep(3000)

  proc.kill()

  if (!existsSync(capPath)) {
    results.push({ id, name, pass: false, detail: 'Capture file not created' })
    console.log('  FAIL: Capture file not created')
    try { unlinkSync(scriptPath) } catch {}
    return
  }

  const result = JSON.parse(readFileSync(capPath, 'utf-8'))
  try { unlinkSync(capPath) } catch {}
  try { unlinkSync(scriptPath) } catch {}

  if (result.timeout) {
    results.push({ id, name, pass: false, detail: `Timeout (${result.totalBytes} bytes)` })
    console.log(`  FAIL: Timeout (${result.totalBytes} bytes)`)
    return
  }

  // Verify content matches
  // xterm.js converts \r?\n → \r, so expected content has \r instead of \r\n or \n
  const expectedContent = prepareTextForTerminal(originalContent)
  const receivedContent = result.contentUtf8 as string

  // Character-by-character comparison
  let mismatchAt = -1
  const minLen = Math.min(expectedContent.length, receivedContent.length)
  for (let i = 0; i < minLen; i++) {
    if (expectedContent.charCodeAt(i) !== receivedContent.charCodeAt(i)) {
      mismatchAt = i
      break
    }
  }
  if (mismatchAt === -1 && expectedContent.length !== receivedContent.length) {
    mismatchAt = minLen
  }

  const contentMatch = mismatchAt === -1
  const hasBrackets = result.hasBracketStart && result.hasBracketEnd

  // Line-level check
  const originalLines = originalContent.split(/\r?\n/).map((l: string) => l.trim()).filter((l: string) => l.length >= 3)
  let linesFound = 0
  let orderOk = true
  let lastPos = -1
  for (const line of originalLines) {
    const sample = line.slice(0, 12)
    const pos = receivedContent.indexOf(sample)
    if (pos >= 0) {
      linesFound++
      if (pos <= lastPos) orderOk = false
      lastPos = pos
    }
  }

  const pass = contentMatch && (useBracketPaste ? hasBrackets : true)

  const detail = [
    pass ? 'PASS' : 'FAIL',
    `exactMatch=${contentMatch}`,
    `lines=${linesFound}/${originalLines.length}`,
    `order=${orderOk ? 'correct' : 'WRONG'}`,
    `brackets=${hasBrackets}`,
    `sent=${expectedContent.length}chars`,
    `received=${receivedContent.length}chars`,
    mismatchAt >= 0 ? `mismatchAt=${mismatchAt}` : '',
  ].filter(Boolean).join(' | ')

  results.push({ id, name, pass, detail })
  console.log(`  ${detail}`)

  if (mismatchAt >= 0 && mismatchAt < expectedContent.length) {
    const ctx = 20
    console.log(`  Expected around mismatch: ${JSON.stringify(expectedContent.slice(Math.max(0, mismatchAt - ctx), mismatchAt + ctx))}`)
    console.log(`  Received around mismatch: ${JSON.stringify(receivedContent.slice(Math.max(0, mismatchAt - ctx), mismatchAt + ctx))}`)
  }
}

async function main() {
  const promptContent = readFileSync(join(__dirname, '..', 'test-prompt.txt'), 'utf-8')

  console.log('='.repeat(70))
  console.log('Full E2E: xterm.js paste() → ConPTY → child process')
  console.log('='.repeat(70))
  console.log(`Test prompt: ${promptContent.length} chars, ${Buffer.byteLength(promptContent)} bytes`)
  console.log(`After prepareTextForTerminal: ${prepareTextForTerminal(promptContent).length} chars`)
  console.log()

  // TC-01: test-prompt.txt WITH bracket paste (simulates Claude Code scenario)
  await runTest('TC-01', 'test-prompt.txt + bracket paste (Claude Code scenario)',
    promptContent, true)

  // TC-02: test-prompt.txt WITHOUT bracket paste (simulates plain shell)
  await runTest('TC-02', 'test-prompt.txt WITHOUT bracket paste (shell scenario)',
    promptContent, false)

  // TC-03: Simple multi-line Chinese
  await runTest('TC-03', 'Multi-line Chinese + bracket paste',
    '关于notice\r\n1、代码库检查\r\n2、二进制软件包\r\n3、Claude检查\r\n4、NOTICE不能多语言',
    true)

  // TC-04: Code block
  await runTest('TC-04', 'Code block + bracket paste',
    'function test() {\r\n  console.log("hello");\r\n  return x > 0;\r\n}',
    true)

  // TC-05: 50-line stress test
  const large = Array.from({ length: 50 }, (_, i) =>
    `Line${i + 1}: 验证传输完整性 content${i + 1}`
  ).join('\r\n')
  await runTest('TC-05', '50 lines stress test + bracket paste', large, true)

  // TC-06: Content with LF only (macOS style)
  await runTest('TC-06', 'LF-only content + bracket paste',
    '第一行\n第二行\n第三行\n第四行', true)

  // TC-07: Single line
  await runTest('TC-07', 'Single line baseline', 'Hello World 你好世界', true)

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('SUMMARY')
  console.log('='.repeat(70))

  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL'
    console.log(`  [${icon}] ${r.id}: ${r.name}`)
    console.log(`         ${r.detail}`)
  }

  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  console.log(`\n  Total: ${results.length} | Pass: ${passed} | Fail: ${failed}`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(2)
})
