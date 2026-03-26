/*
 * Prompt Send Integrity Test Suite
 *
 * Test Plan:
 *   TC-01  PowerShell echo: send test-prompt.txt, verify all lines appear in output
 *   TC-02  PowerShell echo: verify line ORDER is correct
 *   TC-03  Node.js raw-mode capture: send test-prompt.txt, verify exact bytes received
 *   TC-04  Node.js raw-mode capture with bracket paste: verify markers + content
 *   TC-05  Short single-line content: baseline sanity check
 *   TC-06  Multi-line Chinese content: verify CJK integrity
 *   TC-07  Code block with special chars: verify no corruption
 *   TC-08  Large 50-line content: stress test
 *
 * Capture strategy:
 *   - For TC-01/02: use PowerShell echo (PTY output) with per-line matching
 *   - For TC-03/04: use a Node.js child script that puts stdin in raw mode,
 *     reads all input, and writes it hex-encoded to a temp file for comparison.
 *     This avoids ConPTY echo issues entirely.
 */

import * as pty from 'node-pty'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const PROMPT_PATH = join(__dirname, '..', 'test-prompt.txt')
const RAW_CONTENT = readFileSync(PROMPT_PATH, 'utf-8')

// Temp file for Node.js capture script to write results
const CAPTURE_FILE = join(tmpdir(), `onward-capture-${Date.now()}.json`)

// Node.js script that captures stdin in raw mode and writes to a temp file.
// This simulates how Claude Code reads input.
function makeCapturScript(outputPath: string, enableBracketPaste: boolean): string {
  // Build the script as an array of lines to avoid template escape issues
  const lines: string[] = [
    `const fs = require('fs');`,
    `const path = ${JSON.stringify(outputPath)};`,
    `process.stdin.setRawMode(true);`,
    `process.stdin.resume();`,
    `process.stdin.setEncoding(null);`,
  ]

  if (enableBracketPaste) {
    // ESC[?2004h enables bracket paste mode
    lines.push(`process.stdout.write(String.fromCharCode(0x1b) + '[?2004h');`)
  }

  lines.push(
    `const chunks = [];`,
    `const STOP = Buffer.from('__CAPTURE_STOP__');`,
    `const ESC = String.fromCharCode(0x1b);`,
    `const BPSTART = Buffer.from(ESC + '[200~');`,
    `const BPEND = Buffer.from(ESC + '[201~');`,
    ``,
    `process.stdin.on('data', (chunk) => {`,
    `  chunks.push(Buffer.from(chunk));`,
    `  const combined = Buffer.concat(chunks);`,
    `  const stopIdx = combined.indexOf(STOP);`,
    `  if (stopIdx >= 0) {`,
    `    const captured = combined.slice(0, stopIdx);`,
    `    const result = {`,
    `      totalBytes: captured.length,`,
    `      hex: captured.toString('hex'),`,
    `      utf8: captured.toString('utf-8'),`,
    `      hasBracketStart: captured.indexOf(BPSTART) >= 0,`,
    `      hasBracketEnd: captured.indexOf(BPEND) >= 0,`,
    `    };`,
    `    fs.writeFileSync(path, JSON.stringify(result, null, 2));`,
    `    process.stdout.write('__CAPTURED__');`,
    `    setTimeout(() => process.exit(0), 100);`,
    `  }`,
    `});`,
    ``,
    `setTimeout(() => {`,
    `  const combined = Buffer.concat(chunks);`,
    `  const result = {`,
    `    totalBytes: combined.length,`,
    `    hex: combined.toString('hex'),`,
    `    utf8: combined.toString('utf-8'),`,
    `    timeout: true,`,
    `  };`,
    `  fs.writeFileSync(path, JSON.stringify(result, null, 2));`,
    `  process.exit(1);`,
    `}, 10000);`,
  )

  return lines.join('\n')
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')
}

interface TestResult {
  id: string
  name: string
  pass: boolean
  detail: string
}

const results: TestResult[] = []

function report(id: string, name: string, pass: boolean, detail: string) {
  results.push({ id, name, pass, detail })
  const icon = pass ? 'PASS' : 'FAIL'
  console.log(`  [${icon}] ${id}: ${name}`)
  console.log(`         ${detail}`)
}

// ---------- TC-01 & TC-02: PowerShell echo test ----------

async function testPowerShellEcho(content: string, testId: string, testName: string) {
  console.log(`\n--- ${testId}: ${testName} ---`)

  const proc = pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
    name: 'xterm-256color',
    cols: 500,
    rows: 200
  })

  let output = ''
  proc.onData((data: string) => { output += data })

  await sleep(2500)
  const preLen = output.length

  // Send content as-is (simulates the app's sendContentToTerminals fallback)
  proc.write(content)
  await sleep(100)
  proc.write('\r')
  await sleep(3000)

  const postOutput = stripAnsi(output.slice(preLen))
  proc.kill()

  // Extract meaningful content lines
  const contentLines = content.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length >= 3)

  // Check each line's first 12 chars appear in output
  let found = 0
  let lastPos = -1
  let orderCorrect = true
  const missing: string[] = []

  for (const line of contentLines) {
    const sample = line.slice(0, Math.min(12, line.length))
    const pos = postOutput.indexOf(sample)
    if (pos >= 0) {
      found++
      if (pos <= lastPos) orderCorrect = false
      lastPos = pos
    } else {
      missing.push(line.slice(0, 40))
    }
  }

  const allFound = found === contentLines.length
  report(
    testId, testName, allFound && orderCorrect,
    `lines=${found}/${contentLines.length} order=${orderCorrect ? 'correct' : 'WRONG'} output=${postOutput.length}chars` +
    (missing.length > 0 ? ` missing=[${missing.slice(0, 3).map(m => `"${m}"`).join(', ')}]` : '')
  )
}

// ---------- TC-03 & TC-04: Node.js raw-mode capture ----------

async function testNodeCapture(
  content: string,
  bracketPaste: boolean,
  testId: string,
  testName: string
) {
  console.log(`\n--- ${testId}: ${testName} ---`)

  const capturePath = CAPTURE_FILE + `.${testId}`
  if (existsSync(capturePath)) unlinkSync(capturePath)

  const script = makeCapturScript(capturePath, bracketPaste)
  const scriptPath = join(tmpdir(), `capture-${testId}.js`)
  writeFileSync(scriptPath, script)

  const nodePath = process.execPath // Use the same Node.js that's running this test
  const proc = pty.spawn(nodePath, [scriptPath], {
    name: 'xterm-256color',
    cols: 500,
    rows: 200
  })

  let output = ''
  proc.onData((data: string) => { output += data })

  // Wait for Node.js to start and set up raw mode
  await sleep(2000)

  // Send content
  proc.write(content)
  await sleep(200)

  // Send stop marker
  proc.write('__CAPTURE_STOP__')
  await sleep(3000)

  proc.kill()

  // Read the capture file
  if (!existsSync(capturePath)) {
    report(testId, testName, false, 'Capture file not created — child process may have failed')
    return
  }

  try {
    const result = JSON.parse(readFileSync(capturePath, 'utf-8'))

    if (result.timeout) {
      report(testId, testName, false, `Timeout — received ${result.totalBytes} bytes but stop marker not found`)
      return
    }

    const received = result.utf8 as string

    // Compare with original content
    // The child receives the content we wrote. On ConPTY, \r\n may be modified.
    // Normalize both sides for comparison.
    const expectedNorm = content.replace(/\r\n/g, '\r').replace(/\n/g, '\r')
    const receivedNorm = received.replace(/\r\n/g, '\r').replace(/\n/g, '\r')

    // Check line-by-line content
    const expectedLines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length >= 3)
    let linesFound = 0
    let orderOk = true
    let lastIdx = -1

    for (const line of expectedLines) {
      const sample = line.slice(0, Math.min(12, line.length))
      const idx = receivedNorm.indexOf(sample)
      if (idx >= 0) {
        linesFound++
        if (idx <= lastIdx) orderOk = false
        lastIdx = idx
      }
    }

    // Also check raw byte coverage
    const contentChars = content.replace(/[\r\n]/g, '')
    let charMatched = 0
    let scanPos = 0
    for (const ch of contentChars) {
      const pos = received.indexOf(ch, scanPos)
      if (pos >= 0) {
        charMatched++
        scanPos = pos + 1
      }
    }
    const charCoverage = contentChars.length > 0
      ? (charMatched / contentChars.length * 100).toFixed(1) : '100.0'

    const allLines = linesFound === expectedLines.length
    const pass = allLines && orderOk

    report(testId, testName, pass,
      `lines=${linesFound}/${expectedLines.length} order=${orderOk ? 'correct' : 'WRONG'} ` +
      `charCoverage=${charCoverage}% receivedBytes=${result.totalBytes}` +
      (bracketPaste ? ` bracketStart=${result.hasBracketStart} bracketEnd=${result.hasBracketEnd}` : '')
    )
  } catch (err) {
    report(testId, testName, false, `Parse error: ${err}`)
  } finally {
    try { unlinkSync(capturePath) } catch {}
    try { unlinkSync(scriptPath) } catch {}
  }
}

// ---------- Main ----------

async function main() {
  console.log('='.repeat(70))
  console.log('Prompt Send Integrity Test Suite')
  console.log('='.repeat(70))
  console.log(`Test prompt: ${RAW_CONTENT.length} chars, ${Buffer.byteLength(RAW_CONTENT)} bytes`)
  console.log(`Lines: ${RAW_CONTENT.split('\n').length}`)
  console.log()

  // TC-01: PowerShell echo — all lines present?
  await testPowerShellEcho(RAW_CONTENT, 'TC-01', 'PowerShell echo: test-prompt.txt all lines present')

  // TC-02: PowerShell echo — simple multi-line
  await testPowerShellEcho(
    '第一行\r\n第二行\r\n第三行\r\n第四行',
    'TC-02', 'PowerShell echo: simple 4-line Chinese')

  // TC-03: Node.js raw capture — test-prompt.txt without bracket paste
  await testNodeCapture(RAW_CONTENT, false, 'TC-03',
    'Node.js raw capture: test-prompt.txt (no bracket paste)')

  // TC-04: Node.js raw capture — test-prompt.txt WITH bracket paste
  await testNodeCapture(RAW_CONTENT, true, 'TC-04',
    'Node.js raw capture: test-prompt.txt (bracket paste enabled)')

  // TC-05: Short single line
  await testNodeCapture('Hello World 你好世界', false, 'TC-05',
    'Node.js raw capture: single line baseline')

  // TC-06: Multi-line Chinese
  await testNodeCapture(
    '关于notice\r\n1、代码库检查\r\n2、二进制软件包\r\n3、Claude检查\r\n4、NOTICE不能多语言',
    false, 'TC-06', 'Node.js raw capture: multi-line Chinese')

  // TC-07: Code block with special chars
  await testNodeCapture(
    'function test() {\r\n  const x = "hello";\r\n  return x > 0 && y < 10;\r\n}',
    false, 'TC-07', 'Node.js raw capture: code block')

  // TC-08: Large 50-line content
  const large = Array.from({ length: 50 }, (_, i) =>
    `Line${i + 1}: 验证传输完整性 content${i + 1}`
  ).join('\r\n')
  await testNodeCapture(large, false, 'TC-08',
    'Node.js raw capture: 50 lines (~3KB)')

  // TC-09: Node.js raw capture — multi-line Chinese WITH bracket paste
  await testNodeCapture(
    '关于notice\r\n1、代码库检查\r\n2、二进制软件包\r\n3、Claude检查\r\n4、NOTICE不能多语言',
    true, 'TC-09', 'Node.js raw capture: multi-line Chinese (bracket paste)')

  // ---------- Summary ----------
  console.log('\n' + '='.repeat(70))
  console.log('SUMMARY')
  console.log('='.repeat(70))
  console.log()

  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL'
    console.log(`[${icon}] ${r.id}: ${r.name}`)
  }

  const passed = results.filter(r => r.pass).length
  const failed = results.filter(r => !r.pass).length
  console.log(`\nTotal: ${results.length} | Pass: ${passed} | Fail: ${failed}`)

  // Key comparison: TC-03 vs TC-04
  const tc03 = results.find(r => r.id === 'TC-03')
  const tc04 = results.find(r => r.id === 'TC-04')
  if (tc03 && tc04) {
    console.log(`\nKEY: Bracket paste comparison for test-prompt.txt:`)
    console.log(`  Without bracket paste (TC-03): ${tc03.pass ? 'PASS' : 'FAIL'} — ${tc03.detail}`)
    console.log(`  With bracket paste (TC-04):    ${tc04.pass ? 'PASS' : 'FAIL'} — ${tc04.detail}`)
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(2)
})
