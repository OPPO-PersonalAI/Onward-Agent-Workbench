// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function inventoryTraceFiles(traceDir) {
  return {
    directory: fs.realpathSync(traceDir),
    names: fs.readdirSync(traceDir),
  }
}

export function selectNewTraceFiles(traceDir, before) {
  const directory = fs.realpathSync(traceDir)
  if (directory !== before.directory) throw new Error('Trace inventory directory changed')
  const oldNames = new Set(before.names)
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !oldNames.has(entry.name))
    .map(entry => path.join(directory, entry.name))
  const chunks = files.filter(file => /^perf-.*\.jsonl$/.test(path.basename(file))).sort()
  if (chunks.length) return { format: 'ndjson', files: chunks }
  const legacy = files.filter(file => file.endsWith('.json'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || a.localeCompare(b))
  if (legacy.length) return { format: 'legacy', files: [legacy[0]] }
  throw new Error(`No newly created NDJSON chunks (perf-*.jsonl) or legacy *.json in ${directory}`)
}

export function validateTraceFiles(selection) {
  let events = []
  let invalidLines = 0
  if (selection.format === 'legacy') {
    let text = fs.readFileSync(selection.files[0], 'utf8').trim()
    if (!text.endsWith(']}')) text = text.replace(/,\s*$/, '') + ']}'
    const obj = JSON.parse(text)
    if (!Array.isArray(obj.traceEvents)) throw new Error('no traceEvents array')
    events = obj.traceEvents
  } else {
    for (const chunk of selection.files) {
      for (const line of fs.readFileSync(chunk, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try { events.push(JSON.parse(trimmed)) } catch { invalidLines += 1 }
      }
    }
  }
  if (events.length === 0) throw new Error('no events parsed')
  if (!events.some(event => typeof event?.name === 'string' && event.name.startsWith('main:'))) {
    throw new Error('no main:* event recorded (main:trace-start canary missing)')
  }
  // Preserve the existing allowance for one signal-truncated write across chunks.
  if (invalidLines > 1) throw new Error(`${invalidLines} unparseable lines — expected ≤1 from signal-truncated tail`)
  return { events, invalidLines }
}

function main() {
  const [command, traceDir, inventoryFile, sealedFile] = process.argv.slice(2)
  if (command === 'inventory') {
    fs.writeFileSync(inventoryFile, JSON.stringify(inventoryTraceFiles(traceDir)))
    return
  }
  if (command !== 'validate') throw new Error('Expected inventory or validate command')
  const selection = selectNewTraceFiles(traceDir, JSON.parse(fs.readFileSync(inventoryFile, 'utf8')))
  const { events, invalidLines } = validateTraceFiles(selection)
  if (selection.format === 'ndjson') {
    fs.writeFileSync(sealedFile, JSON.stringify({ traceEvents: events }))
  }
  console.log(`OK (${selection.format}): ${events.length} events, ${selection.files.length} file(s), first main event found, invalid=${invalidLines}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(`FAIL: ${error.message}`)
    process.exitCode = 1
  }
}
