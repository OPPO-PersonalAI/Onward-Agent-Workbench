// SPDX-FileCopyrightText: 2026 OPPO
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ThemeUiHarness, REPO_ROOT, eventually, saveSettingsPage } from './themes-ui-driver-support.mjs'
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
    assert(Number.isInteger(key.native[process.platform]) && key.native[process.platform] > 0, `Positive native key code required for ${process.platform} (Chromium CDP treats 0 as unset)`)
    const payload = { key: key.key, code: key.code, modifiers, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.native[process.platform] }
    // Raw keydown crosses Electron's real before-input-event boundary.
    await cdp.send('Input.dispatchKeyEvent', { ...payload, type: 'rawKeyDown' })
    await cdp.send('Input.dispatchKeyEvent', { ...payload, type: 'keyUp' })
  }
  const expectedDisplayFor = stored => stored
    .split('+')
    .map(part => {
      if (part === 'CommandOrControl') return process.platform === 'darwin' ? '\u2318' : 'Ctrl'
      if (part === 'Control' || part === 'Ctrl') return 'Ctrl'
      if (part === 'Alt' || part === 'Option') return process.platform === 'darwin' ? '\u2325' : 'Alt'
      if (part === 'Shift') return process.platform === 'darwin' ? '\u21E7' : 'Shift'
      return part
    })
    .join(' ')
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
    assert.equal((await recorder.innerText()).trim(), expectedDisplayFor(key.stored), 'Recorded shortcut must display keys separated by spaces')
    await saveSettingsPage(h.page)
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
  let expectedDispatches = cases.length * TRIALS + TRIALS * 20
  await h.case('WSC-03-repeat-switches-preserve-binding-and-tabs', async () => {
    const before = await h.diskSettings()
    for (let trial = 0; trial < TRIALS; trial++) {
      for (let index = 0; index < 20; index++) await switchOnce(cases[0])
    }
    assert.equal(await h.page.locator('.tab-item').count(), 2)
    assert.deepEqual((await h.diskSettings()).shortcuts, before.shortcuts)
    return { trials: TRIALS, switchesPerTrial: 20 }
  })
  await h.case('WSC-05-unlimited-tabs-and-dynamic-shortcut-slot-7', async () => {
    const addBtn = h.page.locator('.tab-add-btn')
    while ((await h.page.locator('.tab-item').count()) < 8) {
      assert.equal(await addBtn.isDisabled(), false, 'New Tab button must stay enabled past 6 tabs')
      await addBtn.click()
    }
    assert.equal(await h.page.locator('.tab-item').count(), 8)

    await h.openSettings('shortcuts')
    const group = h.page.locator('[data-settings-target="tabSwitch"]')
    const disclosure = group.locator('.settings-shortcut-disclosure')
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
    assert.equal(await group.locator('[data-testid^="settings-tab-shortcut-row-"]').count(), 8)
    assert.equal(await h.page.getByTestId('settings-tab-switch-filter').isVisible(), true)

    const key7 = cases.find(item => item.id === 'shift-letter')
    assert(key7, 'Fixture must include shift-letter key')
    const rec7 = h.page.getByTestId('shortcut-input-switchTab7')
    await rec7.click()
    await eventually('slot 7 recorder is ready', () => rec7.getAttribute('data-recording'), value => value === 'ready')
    await h.page.keyboard.press(key7.stroke)
    await eventually('slot 7 recorder accepts binding', () => rec7.getAttribute('data-recording'), value => value === 'idle')
    assert.equal((await rec7.innerText()).trim(), expectedDisplayFor(key7.stored), 'Slot 7 shortcut must display space-separated tokens')

    // Verify space-separated display for Command/Ctrl+1 and Control+F directly in the recorder.
    const rec8 = h.page.getByTestId('shortcut-input-switchTab8')
    const primaryDigitStroke = process.platform === 'darwin' ? 'Meta+Digit1' : 'Control+Digit1'
    const primaryDigitDisplay = process.platform === 'darwin' ? '\u2318 1' : 'Ctrl 1'
    await rec8.click()
    await eventually('slot 8 recorder ready for primary+1', () => rec8.getAttribute('data-recording'), value => value === 'ready')
    await h.page.keyboard.press(primaryDigitStroke)
    await eventually('slot 8 recorder accepts primary+1', () => rec8.getAttribute('data-recording'), value => value === 'idle')
    assert.equal((await rec8.innerText()).trim(), primaryDigitDisplay, 'Primary+1 must separate modifier and digit with a space')

    await rec8.click()
    await eventually('slot 8 recorder ready for Ctrl+F', () => rec8.getAttribute('data-recording'), value => value === 'ready')
    await h.page.keyboard.press('Control+KeyF')
    await eventually('slot 8 recorder accepts Ctrl+F', () => rec8.getAttribute('data-recording'), value => value === 'idle')
    assert.equal((await rec8.innerText()).trim(), 'Ctrl F', 'Control+F must separate Ctrl and F with a space')
    await rec8.locator('xpath=..').locator('button.shortcut-clear-btn').click()

    await saveSettingsPage(h.page)
    await eventually('switchTab7 persisted', () => h.diskSettings(), settings => settings?.shortcuts.switchTab7 === key7.stored)
    await h.page.locator('.settings-close-btn').click()

    // Confirm TabBar All-Tabs popover renders the same space-separated shortcut badge.
    await h.page.getByTestId('tab-bar-all-btn').click()
    const slot7Badge = h.page.locator('.tab-bar-all-item').nth(6).locator('.tab-bar-all-shortcut')
    await eventually('All-Tabs popover displays space-separated slot 7 shortcut', () => slot7Badge.innerText(), text => text.trim() === expectedDisplayFor(key7.stored))
    await h.page.keyboard.press('Escape')

    for (let trial = 0; trial < TRIALS; trial++) {
      await h.page.locator('.tab-item').nth(0).click()
      assert.equal(await active(), 0)
      const before = (await events()).length
      await send(key7)
      await eventually('switchTab7 activates Tab 7', active, index => index === 6)
      assert.deepEqual((await events()).slice(before), [{ type: 'switchTab', index: 7 }])
      expectedDispatches += 1
    }

    // Close down to 6 tabs and confirm slot 7 surfaces as dormant and clears cleanly.
    for (let target = 7; target >= 6; target--) {
      await h.page.locator('.tab-item').nth(target).hover()
      await h.page.locator('.tab-item').nth(target).locator('.tab-close-btn').click()
      const confirmBtn = h.page.locator('.confirm-dialog-btn.confirm')
      if (await confirmBtn.isVisible({ timeout: 500 }).catch(() => false)) {
        await confirmBtn.click()
      }
      await eventually(`tab count reaches ${target}`, () => h.page.locator('.tab-item').count(), count => count === target)
    }
    await h.openSettings('shortcuts')
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
    assert.equal(await group.locator('[data-testid^="settings-tab-shortcut-row-"]').count(), 6)
    const dormant = h.page.getByTestId('settings-dormant-tab-shortcuts')
    assert.equal(await dormant.isVisible(), true)
    await dormant.locator('summary').click()
    await h.page.getByTestId('settings-dormant-tab-shortcuts-clear-all').click()
    await saveSettingsPage(h.page)
    await eventually('dormant switchTab7 cleared', () => h.diskSettings(), settings => !Object.hasOwn(settings?.shortcuts ?? {}, 'switchTab7'))
    assert.equal(await dormant.count(), 0)
    await h.page.locator('.settings-close-btn').click()
    return { maxTabsTested: 8, slot7Trials: TRIALS }
  })
  await h.case('WSC-06-tab-bar-layouts-all-tabs-search-and-nav-shortcut', async () => {
    // Open enough tabs (18) to overflow Row 1 and exercise full-width expansion + vertical reflow in 2-row mode.
    while ((await h.page.evaluate(() => window.__onwardAppDebug.getTabIds().length)) < 18) {
      await h.page.locator('.tab-add-btn').click()
    }
    await eventually('18 tabs exist', () => h.page.evaluate(() => window.__onwardAppDebug.getTabIds().length), count => count === 18)

    for (const [mode, expectedMaxRows] of [['rows-2', '2'], ['rows-3', '3'], ['rows-4', '4'], ['scroll', '1']]) {
      await h.page.getByTestId('tab-bar-layout-btn').click()
      await h.page.getByTestId(`tab-bar-layout-option-${mode}`).click()
      await eventually(`tab bar layout becomes ${mode}`, () => h.page.locator('.tab-bar').getAttribute('data-tab-bar-layout'), value => value === mode)
      assert.equal(await h.page.locator('.tab-bar').getAttribute('data-tab-bar-max-rows'), expectedMaxRows)
      await eventually(`disk tabBarLayout is ${mode}`, () => h.diskSettings(), settings => settings?.tabBarLayout === mode)
    }

    // Custom rows via TabBar layout popover (increment default 5 -> 6).
    await h.page.getByTestId('tab-bar-layout-btn').click()
    await h.page.getByTestId('tab-bar-layout-custom-inc').click()
    await eventually('custom rows-6 applied', () => h.page.locator('.tab-bar').getAttribute('data-tab-bar-layout'), value => value === 'rows-6')
    assert.equal(await h.page.locator('.tab-bar').getAttribute('data-tab-bar-max-rows'), '6')
    await eventually('disk tabBarLayout is rows-6', () => h.diskSettings(), settings => settings?.tabBarLayout === 'rows-6')
    await h.page.keyboard.press('Escape')

    // Switch to rows-2 and verify Row 2 spans full window width (under both left title and right actions)
    // and vertical scrolling reflows Row 1 / Row 2 cleanly in order.
    await h.page.getByTestId('tab-bar-layout-btn').click()
    await h.page.getByTestId('tab-bar-layout-option-rows-2').click()
    await eventually('rows-2 active', () => h.page.locator('.tab-bar').getAttribute('data-tab-bar-layout'), value => value === 'rows-2')

    const geometry = await h.page.evaluate(() => {
      const bar = document.querySelector('.tab-bar').getBoundingClientRect().toJSON()
      const extraRow = document.querySelector('[data-testid="tab-bar-extra-row-2"]')?.getBoundingClientRect().toJSON() ?? null
      const title = document.querySelector('.tab-bar-title')?.getBoundingClientRect().toJSON() ?? null
      const lights = document.querySelector('.tab-bar-traffic-lights')?.getBoundingClientRect().toJSON() ?? null
      return { bar, extraRow, title, lights }
    })
    assert(geometry.extraRow, 'Row 2 must render when 18 tabs overflow Row 1')
    assert(geometry.extraRow.left <= geometry.bar.left + 4, 'Row 2 must expand all the way under the left app title')
    assert(geometry.extraRow.right >= geometry.bar.right - 22, 'Row 2 must expand under the right controls')
    if (process.platform === 'darwin') {
      assert(geometry.title.left >= geometry.lights.right - 0.5, 'App title must not overlap macOS traffic lights')
    }

    // If 18 tabs overflow 2 rows at the test viewport width, verify vertical scroll step reflows Row 1 start.
    const vscrollRail = h.page.getByTestId('tab-bar-vscroll-rail')
    if (await vscrollRail.isVisible()) {
      const initialRow1First = Number(await h.page.locator('.tab-list .tab-item').first().getAttribute('data-tab-index'))
      const scrollDownBtn = h.page.getByTestId('tab-bar-scroll-down')
      const scrollUpBtn = h.page.getByTestId('tab-bar-scroll-up')
      if (await scrollDownBtn.isEnabled()) {
        await scrollDownBtn.click()
        await eventually('scroll down advances Row 1 start', async () => Number(await h.page.locator('.tab-list .tab-item').first().getAttribute('data-tab-index')), idx => idx > initialRow1First)
      } else if (await scrollUpBtn.isEnabled()) {
        await scrollUpBtn.click()
        await eventually('scroll up shifts Row 1 start earlier', async () => Number(await h.page.locator('.tab-list .tab-item').first().getAttribute('data-tab-index')), idx => idx < initialRow1First)
      }
    }

    // Verify custom row count synchronization from Settings -> General (set 7 rows and save).
    await h.openSettings('general')
    const customInput = h.page.getByTestId('settings-tab-bar-layout-custom-input')
    await customInput.fill('7')
    await saveSettingsPage(h.page)
    await eventually('general save applies rows-7', () => h.page.locator('.tab-bar').getAttribute('data-tab-bar-layout'), value => value === 'rows-7')
    await eventually('disk tabBarLayout is rows-7', () => h.diskSettings(), settings => settings?.tabBarLayout === 'rows-7')
    await h.page.locator('.settings-close-btn').click()

    await h.page.getByTestId('tab-bar-all-btn').click()
    const search = h.page.getByTestId('tab-bar-all-search')
    await search.fill('7')
    await search.press('Enter')
    await eventually('all-tabs search selects Tab 7', () => h.page.evaluate(() => {
      const ids = window.__onwardAppDebug.getTabIds()
      return ids.indexOf(window.__onwardAppDebug.getActiveTabId())
    }), index => index === 6)

    // Bind switchLastTab and verify 5 trials from Tab 1 jump to the last tab (Tab 18).
    const lastKey = cases.find(item => item.id === 'shift-6')
    assert(lastKey, 'Fixture must include shift-6 key')
    await h.openSettings('shortcuts')
    const group = h.page.locator('[data-settings-target="tabSwitch"]')
    const disclosure = group.locator('.settings-shortcut-disclosure')
    if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click()
    const recLast = h.page.getByTestId('shortcut-input-switchLastTab')
    await recLast.click()
    await eventually('switchLastTab recorder ready', () => recLast.getAttribute('data-recording'), value => value === 'ready')
    await h.page.keyboard.press(lastKey.stroke)
    await eventually('switchLastTab recorder accepts', () => recLast.getAttribute('data-recording'), value => value === 'idle')
    await saveSettingsPage(h.page)
    await eventually('switchLastTab persisted', () => h.diskSettings(), settings => settings?.shortcuts.switchLastTab === lastKey.stored)
    await h.page.locator('.settings-close-btn').click()

    const activeTabIndex = () => h.page.evaluate(() => {
      const ids = window.__onwardAppDebug.getTabIds()
      return ids.indexOf(window.__onwardAppDebug.getActiveTabId())
    })
    for (let trial = 0; trial < TRIALS; trial++) {
      const firstId = await h.page.evaluate(() => window.__onwardAppDebug.getTabIds()[0])
      await h.page.evaluate(id => window.__onwardAppDebug.switchToTabById(id), firstId)
      await eventually('switched to Tab 1', activeTabIndex, index => index === 0)
      const before = (await events()).length
      await send(lastKey)
      await eventually('switchLastTab activates Tab 18', activeTabIndex, index => index === 17)
      assert.deepEqual((await events()).slice(before), [{ type: 'switchLastTab' }])
      expectedDispatches += 1
    }
    return { layoutsTested: 6, navTrials: TRIALS }
  })
  await h.screenshot('window-shortcuts-passed')
  await h.page.evaluate(() => window.__windowShortcutProbeStop())
  await cdp.detach()
  await h.stop(true)
  await h.case('WSC-04-dispatch-and-receipt-trace-evidence', async () => {
    const { events } = validateTraceFiles(selectNewTraceFiles(traceDir, traceBefore))
    const sent = events.filter(event => event.name === 'main:window-shortcut.dispatched')
    const received = events.filter(event => event.name === 'renderer:window-shortcut.received')
    const layoutChanges = events.filter(event => event.name === 'main:settings.tab-bar-layout-changed')
    const allListEvents = events.filter(event => event.name === 'renderer:tab-bar.toggle-all-list')
    const dormantCleared = events.filter(event => event.name === 'renderer:settings.tab-shortcuts-dormant-cleared')
    assert.equal(sent.length, expectedDispatches)
    assert.equal(received.length, sent.length)
    assert(layoutChanges.length >= 4, 'Tab bar layout changes must emit main trace breadcrumbs')
    assert(allListEvents.some(event => event.args?.action === 'select'), 'All-tabs search selection must emit trace breadcrumb')
    assert(dormantCleared.length >= 1, 'Clearing dormant tab shortcuts must emit trace breadcrumb')
    await writeFile(path.join(traceDir, 'window-shortcuts-validation.json'), JSON.stringify({ traceEvents: events }))
    return { sent: sent.length, received: received.length, layoutChanges: layoutChanges.length, allListEvents: allListEvents.length }
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
