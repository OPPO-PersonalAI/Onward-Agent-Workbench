/*
 * Test: Does ConPTY pass \x1b[?2004h (bracket paste enable) from child OUTPUT
 * through to the terminal (xterm.js)?
 *
 * If NO: xterm.js never knows bracket paste is enabled → never wraps content.
 * This would explain why the fix doesn't work in the real app.
 */

import * as pty from 'node-pty'
import { writeFileSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  console.log('='.repeat(70))
  console.log('ConPTY Output Passthrough: does \\x1b[?2004h reach xterm.js?')
  console.log('='.repeat(70))

  // Child script: writes \x1b[?2004h to stdout (like Claude Code does)
  const script = [
    // Write the bracket paste enable sequence
    `process.stdout.write('BEFORE_BP');`,
    `process.stdout.write('\\x1b[?2004h');`,
    `process.stdout.write('AFTER_BP');`,
    // Also write some other DECSET sequences for comparison
    `process.stdout.write('\\x1b[?1049h');`, // alt screen
    `process.stdout.write('AFTER_ALT');`,
    `process.stdout.write('\\x1b[?1049l');`, // exit alt screen
    `process.stdout.write('AFTER_ALT_EXIT');`,
    // Keep alive
    `setTimeout(() => process.exit(0), 5000);`,
  ].join('\n')

  const scriptPath = join(tmpdir(), `bp-output-test-${Date.now()}.js`)
  writeFileSync(scriptPath, script)

  const proc = pty.spawn(process.execPath, [scriptPath], {
    name: 'xterm-256color',
    cols: 200,
    rows: 50
  })

  let rawOutput = ''
  const outputChunks: string[] = []

  proc.onData((data: string) => {
    rawOutput += data
    outputChunks.push(data)
  })

  await sleep(3000)
  proc.kill()

  // Analyze the raw PTY output
  console.log(`\nTotal PTY output: ${rawOutput.length} chars`)
  console.log(`Output chunks: ${outputChunks.length}`)

  // Check for our markers
  console.log(`\nContains 'BEFORE_BP': ${rawOutput.includes('BEFORE_BP')}`)
  console.log(`Contains 'AFTER_BP': ${rawOutput.includes('AFTER_BP')}`)

  // Check for the bracket paste enable sequence in the output
  // \x1b[?2004h = ESC [ ? 2 0 0 4 h
  const bpEnable = '\x1b[?2004h'
  const hasBPEnable = rawOutput.includes(bpEnable)
  console.log(`Contains \\x1b[?2004h: ${hasBPEnable}`)

  // Show all ESC sequences in the output
  const escRegex = /\x1b\[[^a-zA-Z]*[a-zA-Z]/g
  const escMatches = rawOutput.match(escRegex) || []
  console.log(`\nESC sequences found in output (${escMatches.length}):`)
  for (const seq of escMatches.slice(0, 20)) {
    const hex = Array.from(seq).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    console.log(`  ${hex}  (${JSON.stringify(seq)})`)
  }

  // Check specifically for DECSET ?2004
  const decsetRegex = /\x1b\[\?[0-9;]*[hl]/g
  const decsetMatches = rawOutput.match(decsetRegex) || []
  console.log(`\nDECSET/DECRST sequences (${decsetMatches.length}):`)
  for (const seq of decsetMatches) {
    const hex = Array.from(seq).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')
    console.log(`  ${hex}  (${JSON.stringify(seq)})`)
  }

  // Show raw hex of first 200 bytes
  const hexBytes = Array.from(rawOutput.slice(0, 200))
    .map(c => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join(' ')
  console.log(`\nFirst 200 chars as hex:\n  ${hexBytes}`)

  console.log('\n' + '='.repeat(70))
  if (hasBPEnable) {
    console.log('RESULT: \\x1b[?2004h PASSES through ConPTY output')
    console.log('→ xterm.js CAN detect bracket paste mode')
    console.log('→ terminal.paste() WILL wrap content in markers')
  } else {
    console.log('RESULT: \\x1b[?2004h is STRIPPED by ConPTY output')
    console.log('→ xterm.js CANNOT detect bracket paste mode')
    console.log('→ terminal.paste() will NOT wrap content')
    console.log('→ THIS IS WHY THE FIX DOES NOT WORK')
  }
  console.log('='.repeat(70))

  try { require('fs').unlinkSync(scriptPath) } catch {}
}

main().catch(err => { console.error('Fatal:', err); process.exit(2) })
