/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('fs')
const path = require('path')

// Both platform runners use the same fixture preparation and on-disk corpus.
if (process.argv[2] === '--prepare') {
  const root = process.argv[3]
  if (!root) throw new Error('Missing isolated fixture directory')
  fs.mkdirSync(path.join(root, 'captures'), { recursive: true })
  fs.copyFileSync(__filename, path.join(root, 'prompt-capture-stdin.cjs'))
  fs.writeFileSync(path.join(root, '.prompt-integrity-root'), 'prompt-integrity-v2\n')
  fs.writeFileSync(path.join(root, 'cases.json'), JSON.stringify({
    single: 'Prompt integrity: literal Q, Enter and Control+C are ordinary text.',
    mixed: [
      '# Prompt integrity fixture',
      'Prompt integrity: multiline input is one transaction.',
      'CJK: \u4f60\u597d\uff0c\u4e16\u754c. Emoji: \u{1f642}. Combining: e\u0301.',
      '',
      '- bullet item one',
      '- bullet item two',
      '',
      '```ts',
      "const marker = 'prompt-integrity'",
      "console.log('code-block-line')",
      '```',
      '',
      '  Indentation is intentional.',
      '\tA leading tab is intentional.',
      'Last line must arrive before the terminal suffix.'
    ].join('\n'),
    // The paste prefix places this surrogate pair across the old 8 KiB split.
    large: 'x'.repeat(8185) + '\u{1f642}' + '\n' +
      Array.from({ length: 200 }, (_, index) =>
        `row-${String(index).padStart(3, '0')}: ` + 'mixed \u4e2d\u6587 e\u0301 \u{1f680} '.repeat(12) + 'END'
      ).join('\n') + '\nEND-OF-LARGE-PROMPT'
  }), 'utf8')
  process.exit(0)
}

const outputPath = process.argv[2]
const enableBracketedPaste = process.argv.includes('--enable-bracketed-paste')
const checkpoints = process.argv.includes('--checkpoints')
const captureControlKeys = process.argv.includes('--capture-control-keys')

if (!outputPath) {
  console.error('[PROMPT_CAPTURE] missing output path')
  process.exit(1)
}
const outputName = path.basename(outputPath)
if (checkpoints && fs.readFileSync(path.join(path.dirname(outputPath), '..', '.prompt-integrity-root'), 'utf8') !== 'prompt-integrity-v2\n') {
  throw new Error('Refusing to capture outside the isolated integrity fixture')
}

const STOP_MARKER = Buffer.from('__CAPTURE_STOP__')
const CHECKPOINT_PREFIX = Buffer.from('__ONWARD_PI_CHECKPOINT__')
const CTRL_C = 0x03
const ESC = '\x1b'
const BRACKET_START = Buffer.from(`${ESC}[200~`)
const BRACKET_END = Buffer.from(`${ESC}[201~`)
const BRACKET_ENABLE = `${ESC}[?2004h`
const BRACKET_DISABLE = `${ESC}[?2004l`

let settled = false
let pending = Buffer.alloc(0)
let checkpointCount = 0
let bracketedPasteActive = enableBracketedPaste
let splitModePending = false
let timeout

function armTimeout() {
  clearTimeout(timeout)
  // This is an idle fixture watchdog, not a user-facing latency assertion.
  timeout = setTimeout(finalizeTimeout, 15000)
}

function applyMode(mode) {
  if (mode === 'keep') return
  if (mode === 'split-on-prefix') {
    if (splitModePending) throw new Error('An incomplete mode sequence is already pending')
    splitModePending = true
    process.stdout.write(`${ESC}[?20`)
    return
  }
  if (mode === 'split-on-suffix') {
    if (!splitModePending) throw new Error('No incomplete mode sequence is pending')
    splitModePending = false
    bracketedPasteActive = true
    process.stdout.write('04h')
    return
  }
  if (splitModePending) throw new Error('Finish the incomplete mode sequence first')
  bracketedPasteActive = mode !== 'off' && mode !== 'on-off'
  if (mode === 'off-on') process.stdout.write(BRACKET_DISABLE + BRACKET_ENABLE)
  else if (mode === 'on-off') process.stdout.write(BRACKET_ENABLE + BRACKET_DISABLE)
  else process.stdout.write(bracketedPasteActive ? BRACKET_ENABLE : BRACKET_DISABLE)
}

function restoreInputMode() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    try {
      process.stdin.setRawMode(false)
    } catch {
      // Ignore teardown errors; the process is exiting and the fixture has already written its result.
    }
  }
  process.stdin.pause()
  process.stdin.removeAllListeners('data')
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function writeSnapshot(filePath, value) {
  ensureParentDir(filePath)
  const temporaryPath = `${filePath}.tmp`
  fs.writeFileSync(temporaryPath, JSON.stringify(value))
  fs.renameSync(temporaryPath, filePath)
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
    rawMode: Boolean(process.stdin.isTTY && process.stdin.isRaw),
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
  clearTimeout(timeout)
  try {
    writeSnapshot(outputPath, buildCaptureResult(captured, reason))
  } finally {
    restoreInputMode()
    if (bracketedPasteActive) {
      process.stdout.write(BRACKET_DISABLE)
    }
    process.stdout.write(`__CAPTURED__:${outputName}:${reason}`)
    setTimeout(() => process.exit(0), 50)
  }
}

function finalizeTimeout() {
  if (settled) return
  settled = true
  const captured = pending
  writeSnapshot(outputPath, { ...buildCaptureResult(captured, 'timeout'), timeout: true })
  restoreInputMode()
  if (bracketedPasteActive) {
    process.stdout.write(BRACKET_DISABLE)
  }
  process.exit(1)
}

if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(true)
}

process.stdin.resume()

// Explicit OFF avoids inheriting the launching shell's bracketed-paste state.
process.stdout.write(enableBracketedPaste ? BRACKET_ENABLE : BRACKET_DISABLE)
process.stdout.write(`[PROMPT_CAPTURE] ready:${outputName}:${enableBracketedPaste ? 'bp-on' : 'bp-off'}`)
if (checkpoints) {
  writeSnapshot(`${outputPath}.ready`, { rawMode: Boolean(process.stdin.isTTY && process.stdin.isRaw) })
}

process.stdin.on('data', (chunk) => {
  if (settled) return
  if (checkpoints) armTimeout()
  const buffer = Buffer.from(chunk)
  const ctrlCIndex = buffer.indexOf(CTRL_C)
  if (!captureControlKeys && ctrlCIndex >= 0) {
    const combined = Buffer.concat([pending, buffer.slice(0, ctrlCIndex)])
    finalize(combined, 'sigint')
    return
  }

  pending = Buffer.concat([pending, buffer])
  // Checkpoints keep one real receiver alive for all five trials. Markers are
  // sent through terminal.write AFTER the action ACK, so they fence the same
  // PTY input stream instead of guessing when its content has arrived.
  while (checkpoints && !settled) {
    const index = pending.indexOf(CHECKPOINT_PREFIX)
    const stopIndex = pending.indexOf(STOP_MARKER)
    if (index < 0 || (stopIndex >= 0 && stopIndex < index)) break
    const headerStart = index + CHECKPOINT_PREFIX.length
    const headerEnd = pending.indexOf('__', headerStart)
    if (headerEnd < 0) return
    const match = /^([a-zA-Z0-9-]+):(keep|on|off|split-on-prefix|split-on-suffix|off-on|on-off)$/.exec(
      pending.subarray(headerStart, headerEnd).toString('ascii')
    )
    if (!match) throw new Error('Malformed integrity checkpoint')
    const [, label, mode] = match
    const result = buildCaptureResult(pending.subarray(0, index), 'checkpoint')
    const snapshotPath = path.join(path.dirname(outputPath), `${label}.json`)
    writeSnapshot(snapshotPath, { ...result, checkpointCount: ++checkpointCount })
    pending = pending.subarray(headerEnd + 2)
    applyMode(mode)
    // No diagnostic text may interrupt the deliberately fragmented CSI.
    if (!splitModePending) process.stdout.write(`[PROMPT_CAPTURE] checkpoint:${label}`)
  }
  const stopIndex = pending.indexOf(STOP_MARKER)
  if (stopIndex >= 0) {
    finalize(pending.subarray(0, stopIndex), 'marker')
  }
})

armTimeout()
