/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('fs')
const path = require('path')

const outputPath = process.argv[2]
const enableBracketedPaste = process.argv.includes('--enable-bracketed-paste')
const outputName = path.basename(outputPath)

if (!outputPath) {
  console.error('[PROMPT_CAPTURE] missing output path')
  process.exit(1)
}

const STOP_MARKER = Buffer.from('__CAPTURE_STOP__')
const CTRL_C = 0x03
const ESC = '\x1b'
const BRACKET_START = Buffer.from(`${ESC}[200~`)
const BRACKET_END = Buffer.from(`${ESC}[201~`)
const BRACKET_ENABLE = `${ESC}[?2004h`
const BRACKET_DISABLE = `${ESC}[?2004l`

let settled = false
const chunks = []

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function countTrailingEnterBytes(buffer) {
  let count = 0
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const byte = buffer[index]
    if (byte !== 0x0d && byte !== 0x0a) {
      break
    }
    count += 1
  }
  return count
}

function buildCaptureResult(captured, reason) {
  const bracketStartIndex = captured.indexOf(BRACKET_START)
  const bracketEndIndex = captured.indexOf(BRACKET_END)
  const hasBracketStart = bracketStartIndex >= 0
  const hasBracketEnd = bracketEndIndex >= 0

  let payload = captured
  let suffix = Buffer.alloc(0)

  if (hasBracketStart && hasBracketEnd && bracketEndIndex >= bracketStartIndex + BRACKET_START.length) {
    payload = captured.slice(bracketStartIndex + BRACKET_START.length, bracketEndIndex)
    suffix = captured.slice(bracketEndIndex + BRACKET_END.length)
  }

  return {
    stopReason: reason,
    totalBytes: captured.length,
    utf8: captured.toString('utf8'),
    hex: captured.toString('hex'),
    hasBracketStart,
    hasBracketEnd,
    bracketStartIndex,
    bracketEndIndex,
    payloadUtf8: payload.toString('utf8'),
    payloadHex: payload.toString('hex'),
    suffixUtf8: suffix.toString('utf8'),
    suffixHex: suffix.toString('hex'),
    suffixHasEnter: /[\r\n]/.test(suffix.toString('utf8')),
    trailingEnterBytes: countTrailingEnterBytes(suffix)
  }
}

function finalize(captured, reason) {
  if (settled) return
  settled = true
  try {
    ensureParentDir(outputPath)
    fs.writeFileSync(outputPath, JSON.stringify(buildCaptureResult(captured, reason), null, 2))
  } finally {
    if (enableBracketedPaste) {
      process.stdout.write(BRACKET_DISABLE)
    }
    process.stdout.write(`__CAPTURED__:${outputName}:${reason}`)
    setTimeout(() => process.exit(0), 50)
  }
}

function finalizeTimeout() {
  if (settled) return
  settled = true
  ensureParentDir(outputPath)
  const captured = Buffer.concat(chunks)
  fs.writeFileSync(outputPath, JSON.stringify({
    stopReason: 'timeout',
    totalBytes: captured.length,
    utf8: captured.toString('utf8'),
    hex: captured.toString('hex'),
    timeout: true
  }, null, 2))
  if (enableBracketedPaste) {
    process.stdout.write(BRACKET_DISABLE)
  }
  process.exit(1)
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true)
}

process.stdin.resume()

if (enableBracketedPaste) {
  process.stdout.write(BRACKET_ENABLE)
}
process.stdout.write(`[PROMPT_CAPTURE] ready:${outputName}:${enableBracketedPaste ? 'bp-on' : 'bp-off'}`)

process.stdin.on('data', (chunk) => {
  const buffer = Buffer.from(chunk)
  const ctrlCIndex = buffer.indexOf(CTRL_C)
  if (ctrlCIndex >= 0) {
    const combined = Buffer.concat([...chunks, buffer.slice(0, ctrlCIndex)])
    finalize(combined, 'sigint')
    return
  }

  chunks.push(buffer)
  const combined = Buffer.concat(chunks)
  const stopIndex = combined.indexOf(STOP_MARKER)
  if (stopIndex >= 0) {
    finalize(combined.slice(0, stopIndex), 'marker')
  }
})

setTimeout(finalizeTimeout, 15000)
