// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ThemeUiHarness, REPO_ROOT, eventually } from './themes-ui-driver-support.mjs'
import { inventoryTraceFiles, selectNewTraceFiles, validateTraceFiles } from './trace-self-check-files.mjs'

const TRIALS = 5
const [appBin, logFile] = process.argv.slice(2)
assert(appBin, 'Pass the packaged development executable')
const h = new ThemeUiHarness({ appBin, logFile, group: 'window-shortcuts' })
async function run() {
  const traceDir = path.join(REPO_ROOT, 'traces/perf')
  await mkdir(traceDir, { recursive: true })
  const traceBefore = inventoryTraceFiles(traceDir)
  const fixture = path.join(h.workspace, 'keys.json')
  await cp(path.join(REPO_ROOT, 'test/autotest/fixtures/window-shortcuts/keys.json'), fixture)
  const cases = JSON.parse(await readFile(fixture, 'utf8'))
  await h.start()
  await h.page.locator('.settings-close-btn').click()
  await h.page.locator('.tab-add-btn').click()
  assert.equal(await h.page.locator('.tab-item').count(), 2)
  await h.page.evaluate(() => {
    window.__windowShortcutProbeEvents = []
    window.__windowShortcutProbeStop = window.electronAPI.settings.onWindowShortcutTriggered(action => {
      window.__windowShortcutProbeEvents.push(action)
    })
  })
  const cdp = await h.context.newCDPSession(h.page)
  const active = () => h.page.locator('.tab-item').evaluateAll(tabs => tabs.findIndex(tab => tab.classList.contains('active')))
  const events = () => h.page.evaluate(() => window.__windowShortcutProbeEvents)
  const send = async (key, modifiers = key.modifiers) => {
    assert(Number.isInteger(key.native[process.platform]), `Native key map missing for ${process.platform}`)
    const payload = { key: key.key, code: key.code, modifiers, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.native[process.platform] }
    // Raw keydown crosses Electron's real before-input-event boundary.
    await cdp.send('Input.dispatchKeyEvent', { ...payload, type: 'rawKeyDown' })
    await cdp.send('Input.dispatchKeyEvent', { ...payload, type: 'keyUp' })
  }
  const record = async key => {
    await h.openSettings('shortcuts')
    const group = h.page.locator('[data-settings-target="tabSwitch"]')
    const disclosure = group.locator('.settings-shortcut-disclosure')
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
    const recorder = group.locator('.shortcut-input').first()
    await recorder.click()
    await eventually('recorder is ready', () => recorder.getAttribute('data-recording'), value => value === 'ready')
    await h.page.keyboard.press(key.stroke)
    await eventually('recorder accepts the binding', () => recorder.getAttribute('data-recording'), value => value === 'idle')
    await eventually('binding is persisted', () => h.diskSettings(), settings => settings?.shortcuts.switchTab1 === key.stored)
    assert.equal((await h.page.evaluate(() => window.electronAPI.settings.load())).shortcuts.switchTab1, key.stored)
    await h.page.locator('.settings-close-btn').click()
  }
  const switchOnce = async key => {
    await h.page.locator('.tab-item').nth(1).click()
    assert.equal(await active(), 1)
    const before = (await events()).length
    await send(key)
    await eventually(`${key.stored} switches to Tab 1`, active, index => index === 0)
    const delivered = (await events()).slice(before)
    assert.deepEqual(delivered, [{ type: 'switchTab', index: 1 }], 'Exactly one native IPC action is delivered')
  }
  for (const key of cases) {
    await h.case(`WSC-01-${key.id}-record-save-trigger-five-trials`, async () => {
      await record(key)
      for (let trial = 0; trial < TRIALS; trial++) await switchOnce(key)
      return { stored: key.stored, code: key.code, trials: TRIALS }
    })
  }
  await h.case('WSC-02-wrong-modifiers-do-not-switch-five-trials', async () => {
    const key = cases[0]
    await record(key)
    for (let trial = 0; trial < TRIALS; trial++) {
      await h.page.locator('.tab-item').nth(1).click()
      const before = (await events()).length
      await send({ ...key, key: '1' }, 1)
      await send(key, 9 | 2)
      await h.page.waitForTimeout(100)
      assert.equal(await active(), 1)
      assert.equal((await events()).length, before)
    }
    return { trials: TRIALS }
  })
  await h.case('WSC-03-repeat-switches-preserve-binding-and-tabs', async () => {
    const before = await h.diskSettings()
    for (let trial = 0; trial < TRIALS; trial++) {
      for (let index = 0; index < 20; index++) await switchOnce(cases[0])
    }
    assert.equal(await h.page.locator('.tab-item').count(), 2)
    assert.deepEqual((await h.diskSettings()).shortcuts, before.shortcuts)
    return { trials: TRIALS, switchesPerTrial: 20 }
  })
  await h.screenshot('window-shortcuts-passed')
  await h.page.evaluate(() => window.__windowShortcutProbeStop())
  await cdp.detach()
  await h.stop(true)
  await h.case('WSC-04-dispatch-and-receipt-trace-evidence', async () => {
    const { events } = validateTraceFiles(selectNewTraceFiles(traceDir, traceBefore))
    const sent = events.filter(event => event.name === 'main:window-shortcut.dispatched')
    const received = events.filter(event => event.name === 'renderer:window-shortcut.received')
    assert.equal(sent.length, cases.length * TRIALS + TRIALS * 20)
    assert.equal(received.length, sent.length)
    await writeFile(path.join(traceDir, 'window-shortcuts-validation.json'), JSON.stringify({ traceEvents: events }))
    return { sent: sent.length, received: received.length }
  })
}

let failure
let rejectAbort
let signalError
const abort = new Promise((_, reject) => { rejectAbort = reject })
void abort.catch(() => {})
const interrupted = signal => {
  h.cancelled = true
  signalError ??= new Error(`Runner interrupted by ${signal}`)
  rejectAbort(signalError)
}
const onSigint = () => interrupted('SIGINT')
const onSigterm = () => interrupted('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)
const deadline = setTimeout(() => interrupted('150s work deadline'), 150000)
try {
  await h.initialize()
  await Promise.race([run(), abort])
} catch (error) {
  failure = error
  if (h.page) await h.screenshot('window-shortcuts-failure').catch(() => {})
} finally {
  clearTimeout(deadline)
  process.exitCode = await h.finish(failure ?? signalError)
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}
