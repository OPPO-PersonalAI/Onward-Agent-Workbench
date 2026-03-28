/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

const TOTAL_FILL_LINES = 140
const TOTAL_TICKS = 48
const INTERVAL_MS = 80
const STATUS_ROWS = 5
const ESC = '\x1b['
const SPINNER = ['|', '/', '-', '\\']

process.stdout.write('[AUTOFOLLOW] begin\n')

for (let index = 0; index < TOTAL_FILL_LINES; index += 1) {
  process.stdout.write(`[AUTOFOLLOW] fill ${String(index + 1).padStart(3, '0')}\n`)
}

process.stdout.write('\n'.repeat(STATUS_ROWS))

let tick = 0

function renderStatus(currentTick) {
  process.stdout.write(`${ESC}${STATUS_ROWS}A`)

  const progress = `${currentTick}/${TOTAL_TICKS}`
  const spinner = SPINNER[currentTick % SPINNER.length]
  const lines = [
    `[AUTOFOLLOW] tick ${progress}`,
    `[AUTOFOLLOW] spinner ${spinner}`,
    '[AUTOFOLLOW] local-refresh via CSI cursor-up',
    '[AUTOFOLLOW] viewport should remain stable',
    `[AUTOFOLLOW] timestamp ${Date.now()}`
  ]

  for (const line of lines) {
    process.stdout.write(`${ESC}2K\r${line}\n`)
  }
}

const timer = setInterval(() => {
  tick += 1
  renderStatus(tick)

  if (tick >= TOTAL_TICKS) {
    clearInterval(timer)
    process.stdout.write('[AUTOFOLLOW] end\n')
    setTimeout(() => process.exit(0), 50)
  }
}, INTERVAL_MS)

process.on('SIGINT', () => {
  clearInterval(timer)
  process.stdout.write('\n[AUTOFOLLOW] interrupted\n')
  process.exit(130)
})
