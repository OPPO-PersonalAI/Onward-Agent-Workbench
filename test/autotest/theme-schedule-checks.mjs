/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TRIALS = 5
const fixture = JSON.parse(await readFile(new URL('./fixtures/themes-ui/schedule.json', import.meta.url), 'utf8'))
const timelineFixture = JSON.parse(await readFile(new URL('./fixtures/themes-ui/schedule-timeline.json', import.meta.url), 'utf8'))
export const scheduleTime = (hour, day = fixture.day, minute = 0) => new Date(fixture.year, fixture.month - 1, day, hour, minute).getTime()
const settled = h => h.page.waitForFunction(() => document.querySelector('[data-testid="themes-root"]')?.getAttribute('aria-busy') === 'false')
export async function scheduleClock(h, now, reason = 'timer') {
  await h.page.evaluate(({ now, reason }) => window.electronAPI.themes.setClockForAutotest(now, reason), { now, reason })
}
async function addRange(h, range) {
  await h.page.getByTestId('schedule-add').click()
  await h.page.getByTestId('schedule-start').fill(range.start)
  await h.page.getByTestId('schedule-end').fill(range.end)
  for (let day = 0; day < 7; day++) {
    const button = h.page.getByTestId(`schedule-day-${day}`)
    if ((await button.getAttribute('aria-pressed') === 'true') !== range.days.includes(day)) await button.click()
  }
  await h.page.getByTestId('schedule-theme').selectOption(range.theme)
  await h.page.getByTestId('schedule-save').click()
  await h.page.getByTestId('schedule-editor').waitFor({ state: 'detached' })
  await settled(h)
}
export async function setupSchedule(h, fallback = fixture.fallback) {
  await h.openSettings()
  await scheduleClock(h, scheduleTime(8))
  await h.page.getByTestId('theme-mode').selectOption('schedule')
  await settled(h)
  await h.page.getByTestId('schedule-fallback').selectOption(fallback)
  await settled(h)
  for (const range of fixture.ranges) await addRange(h, range)
  await h.persisted((await h.state()).settings)
}

async function chooseSegmentTheme(h, start, themeId) {
  await h.page.locator(`[data-testid="schedule-segment"][data-start="${start}"]`).click()
  await h.page.getByTestId(`schedule-choice-${themeId}`).click()
  await h.page.getByTestId('schedule-theme-picker').waitFor({ state: 'detached' })
  await settled(h)
}

export async function scheduleCore(h, { waitBase, snapshot }) {
  await h.case('TH-SCH-01-create-validate-edit-toggle-delete', async () => {
    await setupSchedule(h)
    await waitBase(h, 'nord', 2)
    assert((await h.page.getByTestId('schedule-status').innerText()).includes('Nord'))
    assert(!(await h.page.getByTestId('schedule-status').innerText()).includes('{'))
    assert.equal(await h.page.getByTestId('schedule-range').count(), 2)
    const saved = (await h.state()).settings
    await h.page.getByTestId('schedule-add').click()
    assert(await h.page.getByTestId('schedule-validation').isVisible(), 'An overlapping range cannot be saved')
    assert((await h.page.getByTestId('schedule-validation').innerText()).includes('09:00–18:00'))
    assert(await h.page.getByTestId('schedule-save').isDisabled())
    await h.page.getByTestId('schedule-end').fill('09:00')
    assert(await h.page.getByTestId('schedule-save').isDisabled(), 'Equal endpoints are invalid')
    await h.page.keyboard.press('Escape')
    await h.page.getByTestId('schedule-editor').waitFor({ state: 'detached' })
    assert.deepEqual((await h.state()).settings, saved)
    assert(await h.page.getByTestId('schedule-add').evaluate(node => node === document.activeElement))
    for (let trial = 0; trial < TRIALS; trial++) {
      await scheduleClock(h, scheduleTime(10))
      await waitBase(h, 'light-modern', 2)
      await h.page.getByTestId('schedule-toggle').first().uncheck()
      await settled(h)
      await waitBase(h, 'nord', 2)
      await h.page.getByTestId('schedule-toggle').first().check()
      await settled(h)
      await waitBase(h, 'light-modern', 2)
      await h.page.getByTestId('schedule-edit').first().click()
      await h.page.getByTestId('schedule-theme').selectOption('dracula')
      await waitBase(h, 'light-modern', 2)
      await h.page.getByTestId('schedule-cancel').click()
      assert.deepEqual((await h.state()).settings, saved)
    }
    await addRange(h, { start: '18:00', end: '19:00', days: [1], theme: 'dark-modern' })
    assert.equal(await h.page.getByTestId('schedule-range').count(), 3, 'Adjacent intervals are accepted')
    await h.page.getByTestId('schedule-edit').nth(1).click()
    await h.page.getByTestId('schedule-delete').click()
    await settled(h)
    assert.equal(await h.page.getByTestId('schedule-range').count(), 2)
  })
  await h.case('TH-SCH-02-five-boundary-and-resume-cycles-preserve-tasks', async () => {
    const before = await snapshot(h)
    for (let trial = 0; trial < TRIALS; trial++) for (const check of fixture.checks) {
      await scheduleClock(h, scheduleTime(check.hour, check.day, check.minute), trial % 2 ? 'resume' : 'timer')
      const after = await waitBase(h, check.theme, 2)
      assert.deepEqual(after.terminals.map(item => item.id), before.terminals.map(item => item.id))
      assert(after.terminals.every(item => item.output?.includes('THEMES_ACCEPTANCE_BUFFER_END')))
      assert.equal((await h.state()).settings.mode, 'schedule')
    }
    return { trials: TRIALS, checks: fixture.checks.length }
  })
  await h.case('TH-SCH-03-five-temporary-expiry-resume-and-mode-cycles', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      await scheduleClock(h, scheduleTime(10))
      await h.page.getByTestId('theme-card-dracula').click()
      await settled(h)
      await waitBase(h, 'dracula', 2)
      assert.equal((await h.state()).settings.mode, 'schedule')
      assert.equal((await h.state()).settings.schedule.temporary.until, scheduleTime(18))
      assert(await h.page.getByTestId('schedule-resume').isVisible())
      assert((await h.page.getByTestId('schedule-status').innerText()).includes('Dracula'))
      assert(!(await h.page.getByTestId('schedule-status').innerText()).includes('{'))
      await h.page.getByTestId('schedule-resume').click()
      await settled(h)
      await waitBase(h, 'light-modern', 2)
      await h.page.getByTestId('theme-card-dracula').click()
      await settled(h)
      await scheduleClock(h, scheduleTime(18))
      await waitBase(h, 'nord', 2)
      assert.equal(await h.page.getByTestId('schedule-resume').count(), 0)
      await h.page.getByTestId('theme-mode').selectOption('manual')
      await settled(h)
      await scheduleClock(h, scheduleTime(10), 'resume')
      await waitBase(h, 'nord', 2)
      await h.page.getByTestId('theme-mode').selectOption('schedule')
      await settled(h)
      await waitBase(h, 'light-modern', 2)
    }
    await h.page.getByTestId('theme-mode').scrollIntoViewIfNeeded()
    await h.screenshot('schedule-complete')
  })
  await h.case('TH-SCH-06-named-regions-direct-choice-keyboard-and-scope', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      await scheduleClock(h, scheduleTime(10))
      const before = (await h.state()).settings.schedule
      assert.deepEqual(await h.page.getByTestId('schedule-segment-name').allTextContents(), ['Nord', 'Light Modern', 'Nord'])
      const day = h.page.locator('[data-testid="schedule-segment"][data-start="540"]')
      await day.focus()
      await day.press('Enter')
      assert(await h.page.getByTestId('schedule-choice-light-modern').evaluate(node => node === document.activeElement))
      assert((await h.page.getByTestId('schedule-picker-scope').innerText()).includes('repeating'))
      await h.page.keyboard.press('ArrowDown')
      assert(await h.page.getByTestId('schedule-choice-dracula').evaluate(node => node === document.activeElement))
      await h.page.keyboard.press('Enter')
      await h.page.getByTestId('schedule-theme-picker').waitFor({ state: 'detached' })
      await settled(h)
      await waitBase(h, 'dracula', 2)
      assert(await day.evaluate(node => node === document.activeElement))
      const after = (await h.state()).settings.schedule
      assert.deepEqual(after.ranges, before.ranges.map((range, index) => index === 0 ? { ...range, themeId: 'dracula' } : range))
      assert.equal(after.fallbackThemeId, 'nord')
      await chooseSegmentTheme(h, 540, 'light-modern')
      await waitBase(h, 'light-modern', 2)
      await h.page.getByTestId('schedule-segment').first().click()
      assert((await h.page.getByTestId('schedule-picker-scope').innerText()).includes('all'))
      await h.page.keyboard.press('Escape')
      assert(await h.page.getByTestId('schedule-segment').first().evaluate(node => node === document.activeElement))
      await chooseSegmentTheme(h, 0, 'one-dark-pro')
      assert.deepEqual(await h.page.getByTestId('schedule-segment-name').allTextContents(), ['One Dark Pro', 'Light Modern', 'One Dark Pro'])
      await waitBase(h, 'light-modern', 2)
      await chooseSegmentTheme(h, 0, 'nord')
      await scheduleClock(h, scheduleTime(2, 25))
      await h.page.getByTestId('schedule-segment').first().click()
      const ownerLabel = await h.page.getByTestId('schedule-picker-rule').innerText()
      assert(ownerLabel.includes('22:00 – 07:00') && ownerLabel.includes('Fri') && ownerLabel.includes('Sat'), ownerLabel)
      await h.page.getByTestId('schedule-choice-one-dark-pro').click()
      await h.page.getByTestId('schedule-theme-picker').waitFor({ state: 'detached' })
      await settled(h)
      await waitBase(h, 'one-dark-pro', 2)
      const overnight = (await h.state()).settings.schedule.ranges[1]
      assert.deepEqual(overnight, { ...before.ranges[1], themeId: 'one-dark-pro' })
      await chooseSegmentTheme(h, 0, 'dracula')
      await h.page.getByTestId('schedule-segment').first().click()
      await scheduleClock(h, scheduleTime(10, 26), 'resume')
      await h.page.getByTestId('schedule-theme-picker').waitFor({ state: 'detached' })
      assert(await h.page.getByTestId('theme-mode').isEnabled(), 'A day change releases the picker lock')
      await h.openSettings('general')
      await h.openSettings()
    }
    await scheduleClock(h, scheduleTime(10))
    await h.persisted((await h.state()).settings)
    await h.page.getByTestId('schedule-timeline').scrollIntoViewIfNeeded()
    await h.screenshot('schedule-named-timeline')
    return { trials: TRIALS }
  })
  await h.case('TH-SCH-05-rejected-save-rolls-back-and-retries', async () => {
    const saved = (await h.state()).settings
    await h.persisted(saved)
    const filename = path.join(h.userData, 'settings.json')
    const backup = path.join(h.userData, 'settings-backup.json')
    await rename(filename, backup)
    try {
      await mkdir(filename)
      await h.page.getByTestId('schedule-fallback').selectOption('one-dark-pro')
      await settled(h)
      assert(await h.page.getByTestId('schedule-error').isVisible())
      assert.deepEqual((await h.state()).settings, saved)
      await h.page.getByTestId('schedule-segment').first().click()
      await h.page.getByTestId('schedule-choice-one-dark-pro').click()
      await settled(h)
      assert(await h.page.getByTestId('schedule-picker-error').isVisible())
      assert.deepEqual((await h.state()).settings, saved, 'Rejected direct choice preserves all stored rules')
    } finally {
      await rm(filename, { recursive: true, force: true })
      await rename(backup, filename)
    }
    await h.page.getByTestId('schedule-choice-one-dark-pro').click()
    await h.page.getByTestId('schedule-theme-picker').waitFor({ state: 'detached' })
    await settled(h)
    await h.persisted((await h.state()).settings)
    assert.equal((await h.state()).settings.schedule.fallbackThemeId, 'one-dark-pro')
    assert.equal(await h.page.getByTestId('schedule-error').count(), 0)
  })
  await h.case('TH-SCH-04-diagnostic-coverage', async () => {
    const status = await h.page.evaluate(() => window.electronAPI.debug.flushPerfTrace())
    assert(status.filePath)
    await h.stop(true)
    const directory = path.dirname(status.filePath)
    const suffix = path.basename(status.filePath).match(/-\d+\.jsonl$/)?.[0]
    const files = suffix ? (await readdir(directory)).filter(name => name.endsWith(suffix)).map(name => path.join(directory, name)) : [status.filePath]
    const events = []
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      events.push(...(file.endsWith('.jsonl') ? content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : JSON.parse(content).traceEvents))
    }
    for (const [name, reasons] of [
      ['main:themes.schedule-reconciled', ['start', 'startup', 'settings', 'timer', 'resume', 'clock-request', 'dispose']],
      ['renderer:themes.schedule-action', ['subscribe', 'clock-send', 'clock-received', 'mount', 'edit-open', 'save', 'save-result', 'cancel', 'delete', 'toggle', 'fallback', 'temporary-selection', 'resume']],
      ['renderer:themes.schedule-timeline-action', ['mount', 'unmount', 'open', 'choose', 'saved', 'cancel', 'focus-returned', 'target-dismissed', 'save-result']]
    ]) for (const reason of reasons) assert(events.some(event => event.name === name && event.args?.reason === reason), `${name}: ${reason}`)
    assert(events.some(event => event.name === 'main:themes.schedule-reconciled' && event.ph === 'X'))
    assert(events.some(event => event.name === 'renderer:themes.schedule-timeline-action' && event.ph === 'X' && event.args?.ok === false))
    await writeFile(path.join(h.artifacts, 'schedule-trace.json'), JSON.stringify({ traceEvents: events.filter(event => /themes\./.test(event.name)) }))
    return { files, events: events.length }
  })
}

export async function scheduleDraft(h, { waitBase, beginDraft, endDraft, fill }) {
  await h.case('TH-SCH-DR01-five-pinned-previews-across-boundaries', async () => {
    await setupSchedule(h)
    for (let trial = 0; trial < TRIALS; trial++) {
      await scheduleClock(h, scheduleTime(10))
      await waitBase(h, 'light-modern', 2)
      await beginDraft(h)
      await fill(h, 'theme-override-terminal.background', '#123456')
      await scheduleClock(h, scheduleTime(18), 'resume')
      assert.equal((await h.state()).resolvedTheme.id, 'light-modern', 'Preview stays pinned across the clock boundary')
      await endDraft(h, 'cancel')
      await waitBase(h, 'nord', 2)
      assert.equal((await h.state()).settings.mode, 'schedule')
    }
    return { trials: TRIALS }
  })
}

export async function scheduleVisual(h, { setLanguage, resizeSettings }) {
  await h.case('TH-SCH-VIS01-bilingual-narrow-schedule-editor', async () => {
    await setupSchedule(h)
    const captions = []
    for (const language of ['en', 'zh-CN']) {
      await setLanguage(h, language)
      for (const width of [600, 300]) {
        await resizeSettings(h, width)
        assert(!(await h.page.getByTestId('schedule-status').innerText()).includes('{'), 'Localized state renders values, not placeholders')
        await h.page.getByTestId('schedule-edit').last().click()
        const layout = await h.page.getByTestId('theme-schedule').evaluate(root => {
          const bounds = root.getBoundingClientRect()
          return [...root.querySelectorAll('input, select, button, label, h3, p, strong, small')].filter(node => {
            const box = node.getBoundingClientRect()
            return box.width && (box.left < bounds.left - 1 || box.right > bounds.right + 1 || node.scrollWidth > node.clientWidth + 2)
          }).map(node => ({ tag: node.tagName, testId: node.dataset.testid }))
        })
        assert.deepEqual(layout, [], `${language} at ${width}px`)
        captions.push(await h.page.getByTestId('schedule-editor').innerText())
        await h.page.getByTestId('schedule-editor').scrollIntoViewIfNeeded()
        await h.screenshot(`schedule-${language}-${width}`)
        await h.page.keyboard.press('Escape')
      }
    }
    assert.notEqual(captions[0], captions[2])
    await setLanguage(h, 'en')
    await resizeSettings(h, 600)
  })
  await h.case('TH-SCH-VIS02-named-one-minute-regions-and-contextual-picker', async () => {
    for (const range of timelineFixture.shortRanges) await addRange(h, range)
    const expected = ['Dracula', 'Dracula', 'One Dark Pro', 'Dark Modern', 'Solarized Light', 'Nord', 'Light Modern', 'Nord']
    assert.deepEqual(await h.page.getByTestId('schedule-segment-name').allTextContents(), expected)
    const ids = await h.page.getByTestId('schedule-segment').evaluateAll(nodes => nodes.map(node => node.dataset.rangeId))
    assert.notEqual(ids[0], ids[1], 'Adjacent identical themes are separate editable regions')
    await chooseSegmentTheme(h, 0, 'nord')
    assert.deepEqual(await h.page.getByTestId('schedule-segment-name').allTextContents(), ['Nord', ...expected.slice(1)])
    await chooseSegmentTheme(h, 0, 'dracula')
    for (const language of ['en', 'zh-CN']) {
      await setLanguage(h, language)
      for (const width of [600, 300]) {
        await resizeSettings(h, width)
        const names = await h.page.getByTestId('schedule-segment-name').evaluateAll(nodes => nodes.map(node => ({
          name: node.textContent, clipped: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
          ellipsis: getComputedStyle(node).textOverflow === 'ellipsis', hitHeight: node.closest('button').getBoundingClientRect().height
        })))
        assert.deepEqual(names.map(item => item.name), expected)
        assert(names.every(item => !item.clipped && !item.ellipsis && item.hitHeight >= 40), JSON.stringify(names))
        await h.page.getByTestId('schedule-timeline').scrollIntoViewIfNeeded()
        await h.screenshot(`schedule-names-${language}-${width}`)
        await h.page.getByTestId('schedule-segment').first().click()
        assert.equal(await h.page.getByTestId('schedule-choice-dracula').getAttribute('aria-pressed'), 'true')
        const geometry = await h.page.getByTestId('schedule-theme-picker').evaluate(panel => {
          const root = document.querySelector('[data-testid="theme-schedule"]').getBoundingClientRect()
          const box = panel.getBoundingClientRect()
          return { inside: box.left >= root.left && box.right <= root.right, overflow: panel.scrollWidth > panel.clientWidth + 1,
            clippedNames: [...panel.querySelectorAll('.theme-schedule-choice-name')].some(node => node.scrollWidth > node.clientWidth + 1) }
        })
        assert.deepEqual(geometry, { inside: true, overflow: false, clippedNames: false }, `${language}/${width}`)
        await h.screenshot(`schedule-picker-${language}-${width}`)
        await h.page.getByTestId('schedule-picker-close').click()
        assert(await h.page.getByTestId('schedule-segment').first().evaluate(node => node === document.activeElement))
      }
    }
    await setLanguage(h, 'en')
    await resizeSettings(h, 600)
  })
}

export async function schedulePersistence(h, { boot, waitBase, grid }) {
  await h.case('TH-SCH-P01-five-real-restarts-bootstrap-and-expiry', async () => {
    await h.openSettings()
    await setupSchedule(h)
    const imported = (await h.state()).settings.imported[0]
    assert(imported, 'Persistence fixture includes an imported saved theme')
    await h.page.getByTestId('schedule-edit').first().click()
    await h.page.getByTestId('schedule-theme').selectOption(imported.id)
    await h.page.getByTestId('schedule-save').click()
    await settled(h)
    for (let trial = 0; trial < TRIALS; trial++) {
      const day = fixture.day + trial
      await scheduleClock(h, scheduleTime(10, day))
      await h.page.waitForFunction(id => window.__onwardThemeDebug.getState().resolvedTheme.id === id, imported.id)
      await h.page.getByTestId('theme-card-one-dark-pro').click()
      await settled(h)
      const saved = (await h.state()).settings
      await h.persisted(saved)
      await h.stop(true)
      h.themeNow = scheduleTime(11, day)
      await boot(h)
      await grid(h, 2)
      await waitBase(h, 'one-dark-pro', 2)
      assert.equal(await h.page.evaluate(() => window.onwardThemeBootstrap.resolvedTheme.id), 'one-dark-pro')
      assert.deepEqual((await h.state()).settings, saved)
      await h.stop(true)
      h.themeNow = scheduleTime(18, day)
      await boot(h)
      await grid(h, 2)
      await waitBase(h, 'nord', 2)
      assert.equal(await h.page.evaluate(() => window.onwardThemeBootstrap.resolvedTheme.id), 'nord')
      assert.equal((await h.state()).settings.mode, 'schedule')
      assert.equal(await h.page.getByTestId('schedule-resume').count(), 0)
    }
    return { trials: TRIALS, realRestarts: TRIALS * 2 }
  })
}
