/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { appendFile, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { ThemeUiHarness, GROUPS, SETTINGS_PAGES, FIXTURE_SOURCE, eventually } from './themes-ui-driver-support.mjs'
import { scheduleCore, scheduleDraft, scheduleVisual, schedulePersistence, setupSchedule, scheduleClock, scheduleTime } from './theme-schedule-checks.mjs'

// Product-approved on 2026-10-07: six visible terminals, three trials,
// all results correct and at least one complete paint within 200 ms.
const THEME_SWITCH_BUDGET_MS = 200
const LATENCY_TRIALS = 3
const BOOLEAN_TRIALS = 5
const PRESSURE_INTERVAL_MS = 50
const WORK_DEADLINE_MS = 260000
const FEATURED = ['dark-modern', 'light-modern', 'dracula', 'one-dark-pro', 'nord', 'solarized-light']
const OUTPUT_MARKER = 'THEMES_ACCEPTANCE_BUFFER_END'
const PALETTES = JSON.parse(await readFile(path.join(FIXTURE_SOURCE, 'expected-palettes.json'), 'utf8'))
const IMPORT_ORACLE = JSON.parse(await readFile(path.join(FIXTURE_SOURCE, 'acceptance-midnight.json'), 'utf8'))
const TERMINAL_KEYS = {
  'terminal.background': 'background', 'terminal.foreground': 'foreground',
  'terminalCursor.foreground': 'cursor', 'terminalCursor.background': 'cursorAccent',
  'terminal.selectionBackground': 'selectionBackground',
  ...Object.fromEntries([
    'Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White',
    'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'
  ].map(name => [`terminal.ansi${name}`, name[0].toLowerCase() + name.slice(1)]))
}

function parseArgs(argv) {
  const result = { appBin: '', logFile: '', group: 'core' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app-bin') result.appBin = argv[++i] ?? ''
    else if (argv[i] === '--log-file') result.logFile = argv[++i] ?? ''
    else if (argv[i] === '--group') result.group = argv[++i] ?? ''
    else if (argv[i] === '--help') return { help: true }
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  assert(result.appBin, 'Pass --app-bin with a packaged development executable')
  assert(GROUPS.includes(result.group), `--group must be one of ${GROUPS.join(', ')}`)
  return result
}

async function installReadout(page) {
  // Test-owned readout: computed styles and the actual xterm consumer palette.
  // Never import the production resolver as the oracle for these assertions.
  await page.evaluate(() => {
    window.__themesAcceptanceState = () => {
      const state = window.__onwardThemeDebug.getState()
      return { ...state, settings: state.settings.theme ?? state.settings }
    }
    const context = document.createElement('canvas').getContext('2d')
    const normalize = value => {
      if (!value) return null
      context.fillStyle = '#010203'
      context.fillStyle = value
      return String(context.fillStyle).toLowerCase()
    }
    const background = element => {
      for (let node = element; node; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor
        if (value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return normalize(value)
      }
      return null
    }
    const surface = selector => {
      const node = document.querySelector(selector)
      if (!node) return null
      const style = getComputedStyle(node)
      return { background: background(node), color: normalize(style.color), border: normalize(style.borderBottomColor) }
    }
    window.__themesAcceptanceRead = (includeOutput = true) => {
      const themes = window.__onwardThemeDebug.getTerminalThemes()
      const cells = [...document.querySelectorAll('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid-cell[data-terminal-id]')]
        .filter(cell => cell.getBoundingClientRect().width > 0 && cell.getBoundingClientRect().height > 0)
      return {
        body: surface('body'),
        title: surface('.settings-title'),
        settings: surface('.settings-container'),
        sidebar: surface('.sidebar'),
        header: surface('.settings-header'),
        terminals: cells.map(cell => {
          const id = cell.getAttribute('data-terminal-id')
          const applied = themes.find(item => (item.id ?? item.terminalId) === id)
          const viewport = cell.querySelector('.xterm-viewport')
          const screen = cell.querySelector('.xterm-screen')
          const canvasPainted = [...(screen?.querySelectorAll('canvas') ?? [])].some(canvas => canvas.width > 0 && canvas.height > 0)
          const domPainted = Boolean(screen?.querySelector('.xterm-rows')?.textContent?.trim())
          return {
            id, status: applied?.status ?? window.__onwardTerminalDebug.getSessionState(id)?.status ?? null,
            minimumContrastRatio: applied?.minimumContrastRatio,
            fontSize: applied?.fontSize, fontFamily: applied?.fontFamily,
            palette: Object.fromEntries(Object.entries(applied?.theme ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.map(normalize) : normalize(value)])),
            background: viewport ? background(viewport) : null,
            painted: Boolean(screen && (canvasPainted || domPainted)),
            output: includeOutput ? window.__onwardTerminalDebug.getTailText(id, 200) : null
          }
        })
      }
    }
  })
}

async function boot(h, scheme = 'dark') {
  await h.start(scheme)
  await installReadout(h.page)
}

async function snapshot(h) {
  return h.page.evaluate(() => window.__themesAcceptanceRead())
}

function appearance(value) {
  return {
    body: value.body, title: value.title, settings: value.settings, sidebar: value.sidebar, header: value.header,
    terminals: value.terminals.map(({ id, palette, background }) => ({ id, palette, background }))
  }
}

async function painted(h) {
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function terminalOutputFixture(h) {
  return (await readFile(path.join(h.fixture, 'terminal-screen.txt'), 'utf8'))
    .replaceAll('\\x1b', '\x1b').replace(/\r?\n/g, '\r\n')
}

async function grid(h, count) {
  const names = { 2: 'Two terminals', 6: 'Six terminals' }
  await h.page.getByTitle(names[count], { exact: true }).click()
  await h.page.waitForFunction(expected => {
    const current = window.__themesAcceptanceRead()
    return current.terminals.length === expected && current.terminals.every(item => item.status === 'ready' && item.painted)
  }, count, { timeout: 45000 })
  const output = await terminalOutputFixture(h)
  await h.page.evaluate(data => {
    for (const id of window.__onwardTerminalDebug.getVisibleTerminalIds()) {
      if (!window.__onwardTerminalDebug.injectPtyData(data, id)) throw new Error(`Output injection rejected: ${id}`)
    }
  }, output)
  await h.page.waitForFunction(marker => window.__themesAcceptanceRead().terminals.every(item => item.output?.includes(marker)), OUTPUT_MARKER)
  return (await snapshot(h)).terminals.map(item => item.id)
}

async function waitBase(h, id, count) {
  const expected = PALETTES[id]
  assert(expected, `Independent builtin palette fixture missing: ${id}`)
  await h.page.waitForFunction(({ id, expected, count }) => {
    const state = window.__themesAcceptanceState()
    const actual = window.__themesAcceptanceRead()
    return state.resolvedTheme.id === id && actual.body?.background === expected.background &&
      actual.terminals.length === count && actual.terminals.every(item => item.status === 'ready' &&
        item.palette.background === expected.background && item.palette.foreground === expected.foreground &&
        item.background === expected.background && item.painted)
  }, { id, expected, count })
  await painted(h)
  return snapshot(h)
}

async function select(h, id, count, checkBase = true) {
  if (FEATURED.includes(id)) await h.page.getByTestId(`theme-card-${id}`).click()
  else await h.page.getByTestId('theme-more').selectOption(id)
  await h.page.waitForFunction(id => {
    const { settings, resolvedTheme } = window.__themesAcceptanceState()
    return settings.mode === 'manual' && settings.themeId === id && resolvedTheme.id === id
  }, id)
  if (checkBase && PALETTES[id]) await waitBase(h, id, count)
  else await painted(h)
}

async function fill(h, testId, value) {
  const input = h.page.getByTestId(testId)
  const collapsed = input.locator('xpath=ancestor::details[not(@open)]')
  while (await collapsed.count()) await collapsed.first().locator(':scope > summary').click()
  await input.fill(value)
  await input.press('Tab')
}

async function beginDraft(h) {
  await h.page.getByTestId('theme-customize').click()
  await h.page.waitForFunction(() => window.__onwardThemeDebug.getState().draft === true)
}

async function endDraft(h, operation) {
  if (operation === 'escape') await h.page.keyboard.press('Escape')
  else await h.page.getByTestId(`theme-draft-${operation}`).click()
  await h.page.waitForFunction(() => window.__onwardThemeDebug.getState().draft === false)
  await painted(h)
}

async function assertTerminalColors(h, expectedById) {
  await h.page.waitForFunction(({ expected, marker }) => {
    const actual = window.__themesAcceptanceRead()
    return actual.terminals.length > 0 && actual.terminals.every(item => item.output?.includes(marker)) && Object.entries(expected).every(([id, colors]) => {
      const terminal = actual.terminals.find(item => item.id === id)
      return terminal?.status === 'ready' && Object.entries(colors).every(([key, value]) => terminal.palette[key] === value) &&
        terminal.background === terminal.palette.background && terminal.painted
    })
  }, { expected: expectedById, marker: OUTPUT_MARKER })
  const current = await snapshot(h)
  assert(current.terminals.every(item => item.output?.includes(OUTPUT_MARKER)), 'Visible terminal output survives theme updates')
  return current
}

async function setLanguage(h, language) {
  const previous = await h.page.locator('.settings-content').getAttribute('data-settings-page')
  await h.openSettings('general')
  await h.page.getByTestId('settings-language-select').selectOption(language)
  await eventually('language persisted', () => h.diskSettings(), state => state?.language === language)
  await h.openSettings(previous)
}

async function resizeSettings(h, width) {
  const panel = h.page.locator('.settings-container')
  const box = await panel.boundingBox()
  const handle = await h.page.locator('.settings-resize-handle').boundingBox()
  assert(box && handle)
  const x = handle.x + handle.width / 2
  const y = handle.y + Math.min(handle.height / 2, 40)
  await h.page.mouse.move(x, y)
  await h.page.mouse.down()
  await h.page.mouse.move(x + width - box.width, y, { steps: 6 })
  await h.page.mouse.up()
  await eventually(`Settings width is ${width}px`, () => panel.boundingBox(), value => value && Math.abs(value.width - width) <= 1)
}

async function setTaskFonts(h, id, fonts) {
  await h.openSettings('fonts')
  await h.page.getByTestId('settings-terminal-select').selectOption(id)
  for (const [key, target] of [['fontSize', 'terminal-font-size'], ['gitDiffFontSize', 'editor-font-size']]) {
    if (!Object.hasOwn(fonts, key)) continue
    const input = h.page.locator(`[data-settings-target="${target}"] input[type="number"]`)
    await input.fill(fonts[key] === null ? '' : String(fonts[key]))
    await input.press('Tab')
  }
  if (Object.hasOwn(fonts, 'fontFamily')) await h.page.getByTestId('settings-terminal-font-select').selectOption(fonts.fontFamily ?? '')
  await eventually('Task fonts persisted', () => h.diskSettings(), state =>
    Object.entries(fonts).every(([key, value]) => state?.terminalStyles?.[id]?.[key] === value))
}

async function terminalFonts(h) {
  return h.page.evaluate(() => window.__onwardThemeDebug.getTerminalThemes().map(item => ({
    id: item.terminalId ?? item.id, fontSize: item.fontSize, fontFamily: item.fontFamily
  })).sort((a, b) => a.id.localeCompare(b.id)))
}

async function openEditor(h, terminalId) {
  await h.page.evaluate(({ terminalId, root }) => {
    window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId, repoRoot: root, filePath: 'sample.ts' } }))
  }, { terminalId, root: h.workspace })
  await h.page.waitForFunction(() => window.__onwardProjectEditorDebug?.isOpen() &&
    window.__onwardProjectEditorDebug.getEditorContent()?.includes('base-reading-state'))
  await h.page.locator('.project-editor-modal:visible .monaco-editor .view-lines').first().waitFor({ state: 'visible' })
}

async function closeSubpages(h) {
  await h.page.evaluate(() => window.__onwardTerminalDebug.closeAllSubpages())
  await h.page.waitForFunction(() => !window.__onwardProjectEditorDebug?.isOpen())
}

async function editorFont(h, terminalId, expected) {
  await openEditor(h, terminalId)
  try {
    const lines = h.page.locator('.project-editor-modal:visible .monaco-editor .view-lines').first()
    if (expected !== undefined) await eventually('Real Monaco font applied', () => lines.evaluate(node => parseFloat(getComputedStyle(node).fontSize)), value => value === expected)
    return await lines.evaluate(node => parseFloat(getComputedStyle(node).fontSize))
  } finally {
    await closeSubpages(h)
  }
}

async function editorPalette(h, terminalId) {
  await openEditor(h, terminalId)
  try {
    await h.page.waitForFunction(() => [...document.querySelectorAll('.project-editor-modal .view-line span')]
      .some(node => node.textContent?.replaceAll('\u00a0', ' ').includes('Comments must be readable') && getComputedStyle(node).fontStyle === 'italic'))
    return await h.page.locator('.project-editor-modal:visible .monaco-editor').first().evaluate(root => {
      const context = document.createElement('canvas').getContext('2d')
      const color = value => { context.fillStyle = value; return String(context.fillStyle).toLowerCase() }
      const comment = [...root.querySelectorAll('.view-line span')].find(node => node.textContent?.replaceAll('\u00a0', ' ').includes('Comments must be readable') && !node.querySelector('span'))
      if (!comment) throw new Error('Actual Monaco comment token missing')
      const style = getComputedStyle(root)
      const token = getComputedStyle(comment)
      return { background: color(style.backgroundColor), foreground: color(style.color), comment: color(token.color), commentStyle: token.fontStyle }
    })
  } finally {
    await closeSubpages(h)
  }
}

async function core(h) {
  await boot(h)
  await h.case('TH-SYS-01-fresh-follows-system', async () => {
    const state = await h.state()
    assert.equal(state.settings.mode, 'system')
    assert.equal(state.settings.darkThemeId, 'dark-modern')
    assert.equal(state.settings.lightThemeId, 'light-modern')
    assert.equal(state.systemDark, true)
    await grid(h, 2)
    await waitBase(h, 'dark-modern', 2)
    await h.page.emulateMedia({ colorScheme: 'light' })
    await waitBase(h, 'light-modern', 2)
    assert.equal((await h.state()).settings.mode, 'system')
  })
  await h.case('TH-SEL-01-six-one-click-cards', async () => {
    assert.equal(await h.page.locator('[data-testid^="theme-card-"]').count(), 6)
    for (const id of FEATURED) {
      assert((await h.page.getByTestId(`theme-card-${id}`).innerText()).includes(PALETTES[id].name))
      await select(h, id, 2)
    }
    return { palettes: FEATURED }
  })
  await h.case('TH-SYS-02-pair-and-five-system-cycles', async () => {
    await h.page.getByTestId('theme-mode').selectOption('system')
    await h.page.getByTestId('theme-pair-dark').selectOption('dracula')
    await h.page.getByTestId('theme-pair-light').selectOption('solarized-light')
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await h.page.emulateMedia({ colorScheme: 'dark' })
      await waitBase(h, 'dracula', 2)
      await h.page.emulateMedia({ colorScheme: 'light' })
      await waitBase(h, 'solarized-light', 2)
      const state = await h.state()
      assert.equal(state.settings.mode, 'system')
      assert.equal(state.settings.darkThemeId, 'dracula')
      assert.equal(state.settings.lightThemeId, 'solarized-light')
    }
    return { trials: BOOLEAN_TRIALS }
  })
  await h.case('TH-SYS-03-inactive-pair-edit-does-not-apply', async () => {
    await h.page.emulateMedia({ colorScheme: 'dark' })
    await waitBase(h, 'dracula', 2)
    const before = appearance(await snapshot(h))
    await h.page.getByTestId('theme-pair-light').selectOption('light-modern')
    await painted(h)
    assert.deepEqual(appearance(await snapshot(h)), before)
    assert.equal((await h.state()).settings.mode, 'system')
    await h.page.emulateMedia({ colorScheme: 'light' })
    await waitBase(h, 'light-modern', 2)
  })
  await h.case('TH-SYS-04-card-enters-manual-and-system-restores-pair', async () => {
    await select(h, 'nord', 2)
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await h.page.emulateMedia({ colorScheme: trial % 2 ? 'light' : 'dark' })
      await waitBase(h, 'nord', 2)
      assert.equal((await h.state()).settings.mode, 'manual')
    }
    await h.page.getByTestId('theme-mode').selectOption('system')
    await waitBase(h, 'dracula', 2)
    assert.equal((await h.state()).settings.lightThemeId, 'light-modern')
  })
  await h.case('TH-SEL-03-classic-in-more', async () => {
    await select(h, 'onward-classic', 2, false)
    assert.equal(await h.page.getByTestId('theme-more').inputValue(), 'onward-classic')
    await beginDraft(h)
    await h.page.getByTestId('classic-preset').selectOption('graphite')
    await endDraft(h, 'save')
    assert.equal((await h.state()).settings.classic.presetId, 'graphite')
    const ids = (await snapshot(h)).terminals.map(item => item.id)
    await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, { background: '#1e1e1e', foreground: '#cccccc' }])))
    await h.screenshot('classic-main-ui')
  })
  await h.case('TH-SEL-04-classic-accent-cancel-keeps-legacy-preset', async () => {
    const before = (await h.state()).settings
    const beforePaint = appearance(await snapshot(h))
    await beginDraft(h)
    await h.page.locator('.theme-classic-controls input[type="checkbox"]').check()
    await fill(h, 'classic-accent', '#c97943')
    await h.page.waitForFunction(background => window.__themesAcceptanceRead().body.background !== background, beforePaint.body.background)
    assert.deepEqual((await h.state()).settings, before)
    await h.screenshot('classic-custom-accent-preview')
    await endDraft(h, 'cancel')
    assert.deepEqual((await h.state()).settings, before)
    assert.deepEqual(appearance(await snapshot(h)), beforePaint)
  })
  await scheduleCore(h, { waitBase, snapshot })
}

async function draft(h) {
  await boot(h)
  const ids = await grid(h, 2)
  await select(h, 'dracula', 2)
  await h.persisted((await h.state()).settings)
  await h.case('TH-DR-01-preview-cancel-five-trials', async () => {
    const committed = (await h.state()).settings
    const original = appearance(await snapshot(h))
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await beginDraft(h)
      for (const id of ['theme-mode', 'theme-more', 'theme-export', ...FEATURED.map(id => `theme-card-${id}`)]) {
        assert(await h.page.getByTestId(id).isDisabled(), `Selection disabled during draft: ${id}`)
      }
      await fill(h, 'theme-override-onward.background', '#102030')
      await fill(h, 'theme-override-terminal.background', '#152637')
      await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, { background: '#152637' }])))
      assert.equal((await snapshot(h)).body.background, '#102030')
      assert.deepEqual((await h.state()).settings, committed, 'Preview must not mutate committed Context settings')
      // This case owns draft/persistence isolation. Drive the real state setter
      // directly; TH-UX-03 independently covers actual pointer drags five times.
      await h.page.evaluate(width => window.__onwardSettingsDebug.setPanelWidth(width), trial % 2 ? 600 : 400)
      await eventually('Settings resize persisted during draft', () => h.diskSettings(), state => state?.settingsPanelWidth === (trial % 2 ? 600 : 400))
      assert.equal((await h.state()).draft, true, 'Resizing across the navigation breakpoint retains the draft')
      assert.deepEqual((await h.diskSettings()).theme, committed, 'Unrelated width persistence must not save draft')
      await endDraft(h, 'cancel')
      await waitBase(h, 'dracula', 2)
      assert.deepEqual(appearance(await snapshot(h)), original)
      assert.deepEqual((await h.diskSettings()).theme, committed)
    }
    return { trials: BOOLEAN_TRIALS }
  })
  await h.case('TH-DR-08-category-navigation-cancels-preview-five-trials', async () => {
    const committed = (await h.state()).settings
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await beginDraft(h)
      await fill(h, 'theme-override-terminal.background', '#152637')
      await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, { background: '#152637' }])))
      await h.openSettings('general')
      await h.page.waitForFunction(() => window.__onwardThemeDebug.getState().draft === false)
      await setLanguage(h, trial % 2 ? 'en' : 'zh-CN')
      await h.openSettings('appearance')
      await waitBase(h, 'dracula', 2)
      assert.equal(await h.page.getByTestId('theme-draft-save').count(), 0)
      assert.deepEqual((await h.diskSettings()).theme, committed, 'Navigation cancels the preview before unrelated settings save')
    }
    await setLanguage(h, 'en')
    return { trials: BOOLEAN_TRIALS }
  })
  await h.case('TH-DR-04-save-scoped-basic-and-advanced-overrides', async () => {
    await beginDraft(h)
    for (const [token, value] of Object.entries(IMPORT_ORACLE.colors)) await fill(h, `theme-override-${token}`, value)
    const terminal = Object.fromEntries(Object.entries(TERMINAL_KEYS).map(([key, xtermKey]) => [xtermKey, IMPORT_ORACLE.colors[key]]))
    await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, terminal])))
    assert.equal((await snapshot(h)).body.background, '#102030')
    assert.equal((await snapshot(h)).title.color, '#e1e2e3')
    await endDraft(h, 'save')
    const saved = (await h.state()).settings
    for (const [key, value] of Object.entries(IMPORT_ORACLE.colors)) assert.equal(saved.overrides.dracula[key], value)
    await h.persisted(saved)
    await select(h, 'light-modern', 2)
    await select(h, 'dracula', 2, false)
    await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, terminal])))
    await h.screenshot('saved-custom-palette')
  })
  await h.case('TH-DR-06-invalid-input-keeps-preview-and-disables-save', async () => {
    await beginDraft(h)
    const before = appearance(await snapshot(h))
    await fill(h, 'theme-override-terminal.background', 'not-a-color')
    assert.equal(await h.page.getByTestId('theme-override-terminal.background').getAttribute('aria-invalid'), 'true')
    assert(await h.page.getByTestId('theme-draft-save').isDisabled())
    const describedBy = await h.page.getByTestId('theme-override-terminal.background').getAttribute('aria-describedby')
    assert(describedBy)
    const description = await h.page.evaluate(id => document.getElementById(id)?.textContent?.trim(), describedBy)
    assert(description?.length > 8, 'Invalid input has an associated explanation')
    assert.deepEqual(appearance(await snapshot(h)), before, 'Invalid intermediate input never reaches consumers')
    await endDraft(h, 'cancel')
  })
  await h.case('TH-DR-05-reset-is-draft-until-save', async () => {
    const saved = (await h.state()).settings
    await beginDraft(h)
    await h.page.getByTestId('theme-draft-reset').click()
    await waitBase(h, 'dracula', 2)
    await endDraft(h, 'cancel')
    await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, { background: '#152637' }])))
    assert.deepEqual((await h.state()).settings, saved)
    await beginDraft(h)
    await h.page.getByTestId('theme-draft-reset').click()
    await endDraft(h, 'save')
    await waitBase(h, 'dracula', 2)
    assert.deepEqual((await h.state()).settings.overrides.dracula ?? {}, {})
    await h.persisted((await h.state()).settings)
  })
  await h.case('TH-DR-07-os-change-while-draft-pinned-escape-five-trials', async () => {
    await h.page.getByTestId('theme-mode').selectOption('system')
    await h.page.getByTestId('theme-pair-dark').selectOption('dracula')
    await h.page.getByTestId('theme-pair-light').selectOption('solarized-light')
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await h.page.emulateMedia({ colorScheme: 'dark' })
      await waitBase(h, 'dracula', 2)
      await beginDraft(h)
      assert(await h.page.getByTestId('theme-pair-dark').isDisabled())
      assert(await h.page.getByTestId('theme-pair-light').isDisabled())
      await fill(h, 'theme-override-terminal.background', '#152637')
      await h.page.emulateMedia({ colorScheme: 'light' })
      await h.page.waitForFunction(() => window.__onwardThemeDebug.getState().systemDark === false)
      assert.equal((await h.state()).resolvedTheme.id, 'dracula', 'Draft target remains pinned through system event')
      await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, { background: '#152637' }])))
      await endDraft(h, 'escape')
      await waitBase(h, 'solarized-light', 2)
      assert(await h.page.getByTestId('themes-root').isVisible(), 'Escape cancels customization, not all Settings')
    }
    return { trials: BOOLEAN_TRIALS }
  })
  await scheduleDraft(h, { waitBase, beginDraft, endDraft, fill })
}

async function tasks(h) {
  await boot(h)
  const [first, second] = await grid(h, 2)
  await select(h, 'dracula', 2)
  const initialFonts = await terminalFonts(h)
  const secondEditorFont = await editorFont(h, second)
  const custom = { fontSize: 19, gitDiffFontSize: 17, fontFamily: 'monospace' }
  await h.case('TH-TASK-01-terminal-editor-fonts-task-scope', async () => {
    await setTaskFonts(h, first, custom)
    await eventually('Actual xterm Task font', () => terminalFonts(h), rows => rows.find(row => row.id === first)?.fontSize === custom.fontSize && rows.find(row => row.id === first)?.fontFamily === custom.fontFamily)
    assert.deepEqual((await terminalFonts(h)).find(row => row.id === second), initialFonts.find(row => row.id === second), 'Another Task retains its xterm fonts')
    await editorFont(h, first, custom.gitDiffFontSize)
    await editorFont(h, second, secondEditorFont)
    await h.openSettings('fonts')
    for (const retired of ['task-colors-advanced', 'task-foreground', 'task-background', 'task-colors-reset']) assert.equal(await h.page.getByTestId(retired).count(), 0)
    await h.openSettings()
    await waitBase(h, 'dracula', 2)
  })
  await h.case('TH-TASK-02-apply-all-font-fields-independently', async () => {
    await h.openSettings('fonts')
    await h.page.getByTestId('settings-terminal-select').selectOption(first)
    await h.page.locator('[data-settings-target="terminal-font-size"] .settings-apply-global-btn').click()
    await eventually('Both actual xterm sizes', () => terminalFonts(h), rows => rows.length === 2 && rows.every(row => row.fontSize === custom.fontSize))
    await editorFont(h, second, secondEditorFont)
    await h.page.locator('[data-settings-target="font-family"] .settings-apply-global-btn').click()
    await eventually('Both actual xterm families', () => terminalFonts(h), rows => rows.every(row => row.fontFamily === custom.fontFamily))
    await h.page.locator('[data-settings-target="editor-font-size"] .settings-apply-global-btn').click()
    await editorFont(h, first, custom.gitDiffFontSize)
    await editorFont(h, second, custom.gitDiffFontSize)
    await eventually('All font defaults persisted', () => h.diskSettings(), state =>
      Object.entries(custom).every(([key, value]) => state?.globalTerminalStyle?.[key] === value &&
        [first, second].every(id => (state?.terminalStyles?.[id] ?? state?.globalTerminalStyle)?.[key] === value)))
  })
  await h.case('TH-TASK-03-five-theme-roundtrips-preserve-fonts-unify-colors', async () => {
    await setTaskFonts(h, second, { fontSize: 21, gitDiffFontSize: 20 })
    await eventually('Second xterm font settled', () => terminalFonts(h), rows => rows.find(row => row.id === second)?.fontSize === 21)
    const beforeFonts = await terminalFonts(h)
    const beforeSettings = await h.diskSettings()
    await h.openSettings()
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      for (const id of ['solarized-light', 'dracula']) {
        await select(h, id, 2)
        assert.deepEqual(await terminalFonts(h), beforeFonts, 'Theme selection retains actual xterm fonts')
        const current = await snapshot(h)
        assert.deepEqual(current.terminals.map(item => item.id), [first, second])
        assert(current.terminals.every(item => item.output?.includes(OUTPUT_MARKER)))
        assert.deepEqual(current.terminals[0].palette, current.terminals[1].palette, 'Both Tasks follow the entire active theme palette')
      }
    }
    await editorFont(h, first, 17)
    await editorFont(h, second, 20)
    const after = await h.persisted((await h.state()).settings)
    assert.deepEqual(after.terminalStyles, beforeSettings.terminalStyles)
    assert.deepEqual(after.globalTerminalStyle, beforeSettings.globalTerminalStyle)
    await h.screenshot('theme-colors-with-independent-task-fonts')
    return { trials: BOOLEAN_TRIALS, first, second }
  })
  await h.case('TH-TASK-04-v8-real-task-colors-retired-on-restart', async () => {
    const before = await h.diskSettings()
    await h.stop(true)
    const legacy = structuredClone(before)
    legacy.version = 8
    legacy.theme.version = 2
    legacy.theme.taskOverrides = { dracula: {
      [first]: { foregroundColor: '#fedcba', backgroundColor: '#112233' },
      [second]: { foregroundColor: '#123456', backgroundColor: '#f1e2d3' }
    } }
    Object.assign(legacy.globalTerminalStyle, { foregroundColor: '#aabbcc', backgroundColor: '#334455' })
    for (const id of [first, second]) Object.assign(legacy.terminalStyles[id], legacy.theme.taskOverrides.dracula[id])
    await h.writeSettingsFixture(legacy)
    for (let launch = 0; launch < 2; launch++) {
      await boot(h)
      await waitBase(h, 'dracula', 2)
      assert.deepEqual((await snapshot(h)).terminals.map(item => item.id), [first, second], 'Migration uses and retains real persisted Task IDs')
      const state = await h.state()
      assert.equal(state.settings.version, 4)
      assert(!Object.hasOwn(state.settings, 'taskOverrides'))
      const live = await h.page.evaluate(() => window.__onwardThemeDebug.getState().settings)
      assert.equal(live.version, 10)
      assert([live.globalTerminalStyle, ...Object.values(live.terminalStyles)].every(style => !Object.hasOwn(style, 'foregroundColor') && !Object.hasOwn(style, 'backgroundColor')), 'Retired color fields are removed before renderer consumers see migrated settings')
      await editorFont(h, first, 17)
      await editorFont(h, second, 20)
      if (launch === 0) {
        // Storage normalizes on load and persists on the next real settings save.
        await setLanguage(h, before.language === 'en' ? 'zh-CN' : 'en')
        await setLanguage(h, before.language)
      }
      await eventually('Retired fields absent from v10 disk settings', () => h.diskSettings(), data => data?.version === 10 && data.theme?.version === 4 &&
        !Object.hasOwn(data.theme, 'taskOverrides') && [data.globalTerminalStyle, ...Object.values(data.terminalStyles)].every(style => !Object.hasOwn(style, 'foregroundColor') && !Object.hasOwn(style, 'backgroundColor')))
      const migrated = await h.diskSettings()
      assert.deepEqual(migrated.terminalStyles, before.terminalStyles)
      assert.deepEqual(migrated.globalTerminalStyle, before.globalTerminalStyle)
      assert.deepEqual(migrated.shortcuts, before.shortcuts)
      assert.equal(migrated.language, before.language)
      assert.deepEqual(await terminalFonts(h), [
        { id: first, fontSize: 19, fontFamily: 'monospace' },
        { id: second, fontSize: 21, fontFamily: 'monospace' }
      ].sort((a, b) => a.id.localeCompare(b.id)))
      if (launch === 0) await h.stop(true)
    }
    return { launches: 2, realTaskIds: [first, second] }
  })
}

async function startImport(h, file) {
  await h.page.evaluate(async selected => {
    if (!window.electronAPI.themes?.setImportPathForAutotest) throw new Error('Missing native-dialog injection boundary')
    await window.electronAPI.themes.setImportPathForAutotest(selected)
  }, file)
  await h.page.getByTestId('theme-import').click()
  await h.page.waitForFunction(() => document.querySelector('[data-testid="themes-root"]')?.getAttribute('aria-busy') === 'false')
}

async function confirmImport(h, names) {
  const choices = h.page.locator('[data-testid^="theme-import-choice-"]')
  await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'visible' })
  assert(await h.page.getByTestId('theme-export').isDisabled(), 'Export is disabled while import candidates await confirmation')
  const selectedIds = []
  for (let index = 0; index < await choices.count(); index++) {
    const choice = choices.nth(index)
    const text = await choice.locator('..').innerText()
    const chosen = names.some(name => text.includes(name))
    await choice.setChecked(chosen)
    if (chosen) selectedIds.push((await choice.getAttribute('data-testid')).slice('theme-import-choice-'.length))
  }
  assert.equal(selectedIds.length, names.length, 'Every requested import candidate has a distinct checkbox')
  await h.page.getByTestId('theme-import-confirm').click()
  await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'hidden' })
  const state = await h.state()
  for (const id of selectedIds) assert(state.settings.imported.some(theme => theme.id === id))
  await h.persisted(state.settings)
  return state.settings.imported.filter(theme => selectedIds.includes(theme.id))
}

async function importTheme(h, filename, name) {
  await startImport(h, path.join(h.fixture, filename))
  return (await confirmImport(h, [name]))[0]
}

async function assertImported(h, theme, oracle, ids) {
  await select(h, theme.id, ids.length, false)
  const expected = Object.fromEntries(Object.entries(TERMINAL_KEYS)
    .filter(([key]) => oracle.colors[key])
    .map(([key, xtermKey]) => [xtermKey, oracle.colors[key]]))
  await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, expected])))
  assert.equal((await snapshot(h)).body.background, oracle.colors['onward.background'])
  assert.equal((await snapshot(h)).title.color, oracle.colors['onward.foreground'])
  assert.equal(await h.page.getByTestId('theme-more').inputValue(), theme.id)
  const option = h.page.getByTestId('theme-more').locator('option').filter({ hasText: theme.name })
  assert(await option.count(), 'Imported name appears in More, not only in an internal catalog')
}

async function exportTheme(h, destination, outcome = 'success') {
  await h.page.evaluate(async destination => {
    if (!window.electronAPI.themes?.setExportPathForAutotest) throw new Error('Missing one-shot export dialog boundary')
    await window.electronAPI.themes.setExportPathForAutotest(destination)
  }, destination)
  await h.page.getByTestId('theme-export').click()
  await h.page.waitForFunction(() => document.querySelector('[data-testid="themes-root"]')?.getAttribute('aria-busy') === 'false')
  const status = h.page.getByTestId('theme-export-status')
  if (outcome === 'canceled') assert.equal(await status.count(), 0, 'Canceled export shows no success or error status')
  else {
    await status.waitFor({ state: 'visible' })
    assert.equal(await status.getAttribute('role'), outcome === 'success' ? 'status' : 'alert')
    assert((await status.innerText()).trim().length > 3)
  }
  assert(!await h.page.getByTestId('theme-export').isDisabled(), 'Export unlocks for immediate retry')
}

async function saveDraftWithExportLock(h) {
  await h.page.evaluate(() => {
    const root = document.querySelector('[data-testid="themes-root"]')
    const samples = []
    const read = () => {
      if (root.getAttribute('aria-busy') === 'true') samples.push(root.querySelector('[data-testid="theme-export"]').disabled)
    }
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, subtree: true, childList: true })
    window.__themesExportSaveProbe = { samples, observer }
  })
  try {
    await endDraft(h, 'save')
    const samples = await h.page.evaluate(() => window.__themesExportSaveProbe.samples)
    assert(samples.length > 0 && samples.every(Boolean), 'Every observed save-pending state disables export')
  } finally {
    await h.page.evaluate(() => {
      window.__themesExportSaveProbe?.observer.disconnect()
      delete window.__themesExportSaveProbe
    })
  }
}

async function exportTemporaryFiles(directory) {
  return (await readdir(directory)).filter(name => name.startsWith('.onward-theme-') && name.endsWith('.tmp')).sort()
}

async function watchExportCancellationStatus(h) {
  await h.page.evaluate(() => {
    const probe = { retryStarted: false, errors: [], prematureStatuses: [], observer: null }
    const inspect = node => {
      if (!(node instanceof Element)) return
      const statuses = node.matches('[data-testid="theme-export-status"]') ? [node] : node.querySelectorAll('[data-testid="theme-export-status"]')
      for (const status of statuses) {
        const text = (status.textContent ?? '').trim().slice(0, 128)
        if (status.getAttribute('role') === 'alert' && probe.errors.length < 20) probe.errors.push(text)
        if (!probe.retryStarted && probe.prematureStatuses.length < 20) probe.prematureStatuses.push(text)
      }
    }
    probe.observer = new MutationObserver(records => {
      for (const record of records) {
        // Inspect inserted nodes as well as live DOM so even a transient stale
        // error removed in the same mutation batch is recorded.
        inspect(record.target)
        for (const node of record.addedNodes) inspect(node)
      }
    })
    probe.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role'] })
    window.__themesExportCancelProbe = probe
  })
}

async function exportCancellation(h, committedExport) {
  const directory = path.join(h.fixture, 'export cancellation')
  await mkdir(directory, { recursive: true })
  const source = path.join(h.fixture, 'acceptance-midnight.json')
  const originalBytes = await readFile(source)
  const phases = ['before-worker', 'before-commit']
  const seed = async label => {
    const destination = path.join(directory, `${label}-existing.json`)
    const retry = path.join(directory, `${label}-retry.json`)
    await cp(source, destination)
    await cp(source, retry)
    assert.deepEqual(await exportTemporaryFiles(directory), [], 'Each cancellation trial starts without sibling temp files')
    return { destination, retry }
  }
  const paused = async (destination, pauseAt) => {
    await h.page.evaluate(async ({ destination, pauseAt }) => {
      await window.electronAPI.themes.setExportPathForAutotest(destination, { pauseAt })
    }, { destination, pauseAt })
    await h.page.getByTestId('theme-export').click()
    await h.page.evaluate(() => window.electronAPI.themes.setExportPathForAutotest(null, { waitUntilPaused: true }))
    assert.equal(await h.page.getByTestId('themes-root').getAttribute('aria-busy'), 'true')
    assert(await h.page.getByTestId('theme-export').isDisabled())
    assert.deepEqual(await readFile(destination), originalBytes, 'Neither export phase may truncate the existing destination')
    const files = await exportTemporaryFiles(directory)
    assert.equal(files.length, pauseAt === 'before-commit' ? 1 : 0, `Barrier reached the requested ${pauseAt} filesystem boundary`)
    if (files.length) assert.deepEqual(JSON.parse(await readFile(path.join(directory, files[0]), 'utf8')), committedExport, 'Sibling temp contains the complete current saved palette before rename')
  }
  for (const [cause, id] of [['escape', '04'], ['category', '05'], ['settings-close', '06']]) {
    await h.case(`TH-EXP-${id}-${cause}-preserves-existing-file-and-immediate-retry`, async () => {
      const committed = (await h.state()).settings
      const beforePaint = appearance(await snapshot(h))
      const trials = []
      for (const pauseAt of phases) {
        for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
          const { destination, retry } = await seed(`${cause}-${pauseAt}-${trial}`)
          await paused(destination, pauseAt)
          await watchExportCancellationStatus(h)
          try {
            if (cause === 'escape') {
              await h.page.keyboard.press('Escape')
              assert(await h.page.locator('.settings-container').isVisible(), 'Escape cancels only the pending export')
            } else if (cause === 'category') {
              await h.openSettings('fonts')
              assert.equal(await h.page.getByTestId('themes-root').count(), 0)
              await h.openSettings()
            } else {
              await h.page.locator('.settings-close-btn').click()
              await h.page.locator('.settings-container').waitFor({ state: 'hidden' })
              await h.openSettings()
            }
            assert.equal(await h.page.getByTestId('theme-export-status').count(), 0, 'Cancel/remount must not display stale export status')
            await h.page.evaluate(() => { window.__themesExportCancelProbe.retryStarted = true })
            // Do not wait for the old request or filesystem cleanup before retry.
            // A successful real successor joins predecessor.done in main, proving
            // the cancellation/cleanup acknowledgement boundary has been crossed.
            await exportTheme(h, retry)
            await painted(h)
            assert.deepEqual(await readFile(destination), originalBytes, 'Canceled export preserves original bytes after the successor joins cleanup')
            assert.deepEqual(await exportTemporaryFiles(directory), [], 'No sibling temp remains after cancellation acknowledgement and retry completion')
            assert.deepEqual(JSON.parse(await readFile(retry, 'utf8')), committedExport, 'Immediate retry atomically replaces an existing file with the saved palette')
            assert.equal(await h.page.getByTestId('theme-export-status').getAttribute('role'), 'status', 'Late canceled result cannot overwrite retry success')
            const statuses = await h.page.evaluate(() => ({
              errors: window.__themesExportCancelProbe.errors,
              prematureStatuses: window.__themesExportCancelProbe.prematureStatuses
            }))
            assert.deepEqual(statuses, { errors: [], prematureStatuses: [] }, 'No transient stale status or false busy error')
            assert.deepEqual((await h.state()).settings, committed)
            assert.deepEqual(appearance(await snapshot(h)), beforePaint)
            trials.push({ pauseAt, trial: trial + 1, preserved: true, retry: true, scratchClean: true })
          } finally {
            await h.page.evaluate(() => {
              window.__themesExportCancelProbe?.observer.disconnect()
              delete window.__themesExportCancelProbe
            })
          }
        }
      }
      assert.equal(trials.length, phases.length * BOOLEAN_TRIALS)
      assert.deepEqual((await h.diskSettings()).theme, committed)
      return { trialsPerPhase: BOOLEAN_TRIALS, phases, trials }
    })
  }
  await h.case('TH-EXP-07-request-id-cancel-ack-cleans-temp-five-trials', async () => {
    const themeId = (await h.state()).resolvedTheme.id
    for (const pauseAt of phases) {
      for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
        const { destination, retry } = await seed(`request-id-${pauseAt}-${trial}`)
        await h.page.evaluate(async ({ destination, pauseAt, themeId }) => {
          const api = window.electronAPI.themes
          await api.setExportPathForAutotest(destination, { pauseAt })
          const requestId = crypto.randomUUID()
          window.__themesPendingExport = { requestId, promise: api.export(requestId, themeId) }
        }, { destination, pauseAt, themeId })
        try {
          await h.page.evaluate(() => window.electronAPI.themes.setExportPathForAutotest(null, { waitUntilPaused: true }))
          const stale = await h.page.evaluate(() => window.electronAPI.themes.cancelExport(crypto.randomUUID()))
          assert.deepEqual(stale, { canceled: false }, 'Another UUID cannot cancel the active export')
          assert.deepEqual(await readFile(destination), originalBytes)
          assert.equal((await exportTemporaryFiles(directory)).length, pauseAt === 'before-commit' ? 1 : 0, 'Wrong-ID cancellation leaves the paused request intact')
          const acknowledged = await h.page.evaluate(async () => {
            const pending = window.__themesPendingExport
            const ack = await window.electronAPI.themes.cancelExport(pending.requestId)
            return { ack, result: await pending.promise }
          })
          assert.deepEqual(acknowledged, { ack: { canceled: true }, result: { success: false, canceled: true } })
          assert.deepEqual(await readFile(destination), originalBytes, 'Cancellation ACK guarantees existing bytes survive')
          assert.deepEqual(await exportTemporaryFiles(directory), [], 'Cancellation ACK waits for sibling temp removal')
          await exportTheme(h, retry)
          assert.deepEqual(JSON.parse(await readFile(retry, 'utf8')), committedExport)
          assert.deepEqual(await exportTemporaryFiles(directory), [], 'Successful retry also leaves no sibling temp')
        } finally {
          await h.page.evaluate(async () => {
            const pending = window.__themesPendingExport
            if (pending) await window.electronAPI.themes.cancelExport(pending.requestId)
            delete window.__themesPendingExport
          })
        }
      }
    }
    return { trialsPerPhase: BOOLEAN_TRIALS, phases, explicitCancellationAck: true }
  })
}

async function imports(h) {
  await boot(h)
  const ids = await grid(h, 2)
  await select(h, 'dark-modern', 2)
  const vsix = await h.buildVsix()
  await h.case('TH-IMP-01-json-import-and-live-consumers', async () => {
    const imported = await importTheme(h, 'acceptance-midnight.json', 'Acceptance Midnight')
    await assertImported(h, imported, IMPORT_ORACLE, ids)
    return { importedId: imported.id }
  })
  await h.case('TH-IMP-02-jsonc-comments-trailing-commas-equivalence', async () => {
    const baseline = appearance(await snapshot(h))
    const imported = await importTheme(h, 'acceptance-midnight.jsonc', 'Acceptance Midnight JSONC')
    await assertImported(h, imported, IMPORT_ORACLE, ids)
    assert.deepEqual(appearance(await snapshot(h)), baseline, 'Equivalent JSON and JSONC render identically')
    return { importedId: imported.id }
  })
  await h.case('TH-IMP-03-native-cancel-five-trials', async () => {
    const before = (await h.state()).settings
    const beforePaint = appearance(await snapshot(h))
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      // Contract: null is a one-shot canceled dialog result, never "open the OS dialog".
      await startImport(h, null)
      assert.equal(await h.page.getByTestId('theme-import-confirm').count(), 0)
      assert.equal(await h.page.getByTestId('theme-import-error').count(), 0)
      assert.deepEqual((await h.state()).settings, before)
      assert.deepEqual(appearance(await snapshot(h)), beforePaint)
    }
    assert.deepEqual((await h.diskSettings()).theme, before)
    return { trials: BOOLEAN_TRIALS }
  })
  await h.case('TH-IMP-04-vsix-choice-cancel-five-trials', async () => {
    const before = (await h.state()).settings
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await startImport(h, vsix)
      await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'visible' })
      assert.equal(await h.page.locator('[data-testid^="theme-import-choice-"]').count(), 2)
      await h.page.keyboard.press('Escape')
      await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'hidden' })
      assert.deepEqual((await h.state()).settings, before)
    }
    return { trials: BOOLEAN_TRIALS }
  })
  await h.case('TH-IMP-05-vsix-multiple-choices-selective-then-both', async () => {
    await startImport(h, vsix)
    const choices = h.page.locator('[data-testid^="theme-import-choice-"]')
    for (const choice of await choices.all()) await choice.uncheck()
    assert(await h.page.getByTestId('theme-import-confirm').isDisabled(), 'Empty selection cannot import')
    const [day] = await confirmImport(h, ['Acceptance VSIX Day'])
    assert(!(await h.state()).settings.imported.some(theme => theme.name === 'Acceptance VSIX Night'))
    const dayOracle = JSON.parse(await readFile(path.join(h.fixture, 'vsix-source/extension/themes/day.json'), 'utf8'))
    await assertImported(h, day, dayOracle, ids)
    await startImport(h, vsix)
    const imported = await confirmImport(h, ['Acceptance VSIX Day', 'Acceptance VSIX Night'])
    const night = imported.find(theme => theme.name === 'Acceptance VSIX Night')
    assert(night)
    const nightOracle = JSON.parse(await readFile(path.join(h.fixture, 'vsix-source/extension/themes/night.json'), 'utf8'))
    await assertImported(h, night, nightOracle, ids)
    assert.equal((await h.state()).settings.imported.filter(theme => theme.id === day.id).length, 1, 'Reimport does not duplicate identity')
    await h.screenshot('vsix-imported-main-ui')
  })
  await h.case('TH-IMP-06-malformed-import-bilingual-error-and-recovery', async () => {
    const before = (await h.state()).settings
    const messages = []
    for (const language of ['en', 'zh-CN']) {
      await setLanguage(h, language)
      await startImport(h, path.join(h.fixture, 'invalid-theme.json'))
      const error = h.page.getByTestId('theme-import-error')
      await error.waitFor({ state: 'visible' })
      const message = (await error.innerText()).trim()
      assert(message.length > 8 && !message.startsWith('settings.'), 'Error is readable localized copy, not a dictionary key')
      messages.push(message)
      assert.deepEqual((await h.state()).settings, before, 'Failed import is atomic')
    }
    assert.notEqual(messages[0], messages[1], 'Both supported languages have designed error text')
    await setLanguage(h, 'en')
    const corruptVsix = path.join(h.fixture, 'corrupt.vsix')
    await cp(path.join(h.fixture, 'corrupt-vsix.txt'), corruptVsix)
    for (const filename of [path.join(h.fixture, 'missing-include.json'), corruptVsix]) {
      await startImport(h, filename)
      await h.page.getByTestId('theme-import-error').waitFor({ state: 'visible' })
      assert((await h.page.getByTestId('theme-import-error').innerText()).trim().length > 8)
      assert.deepEqual((await h.state()).settings, before, 'Unreadable archive/include cannot partially install a theme')
    }
    await startImport(h, path.join(h.fixture, 'invalid-color.json'))
    await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'visible' })
    const details = h.page.locator('.theme-unsupported')
    await details.locator('summary').click()
    assert((await details.innerText()).includes('terminal.background'), 'Ignored invalid token is explicitly reported')
    await h.page.keyboard.press('Escape')
    await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'hidden' })
    assert.deepEqual((await h.state()).settings, before)
    const valid = await importTheme(h, 'acceptance-midnight.json', 'Acceptance Midnight')
    await assertImported(h, valid, IMPORT_ORACLE, ids)
    assert.equal(await h.page.getByTestId('theme-import-error').count(), 0)
    return { localizedErrors: messages }
  })
  for (const [cause, id] of [['escape', '07'], ['unmount', '08'], ['category', '09']]) {
    await h.case(`TH-IMP-${id}-${cause}-pending-cancel-and-immediate-retry`, async () => {
      const before = (await h.state()).settings
      const beforePaint = appearance(await snapshot(h))
      const file = path.join(h.fixture, 'acceptance-midnight.json')
      for (const pauseAt of ['before-worker', 'worker']) {
        for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
          await h.page.evaluate(async ({ file, pauseAt }) => {
            await window.electronAPI.themes.setImportPathForAutotest(file, { pauseAt })
          }, { file, pauseAt })
          await h.page.getByTestId('theme-import').click()
          // Wait for an explicit main/worker barrier, never a sleep or a file-size race.
          await h.page.evaluate(() => window.electronAPI.themes.setImportPathForAutotest(null, { waitUntilPaused: true }))
          assert.equal(await h.page.getByTestId('themes-root').getAttribute('aria-busy'), 'true')
          assert(await h.page.getByTestId('theme-export').isDisabled(), 'Export is disabled during pending import work')
          if (cause === 'escape') {
            await h.page.keyboard.press('Escape')
          } else if (cause === 'category') {
            await h.openSettings('fonts')
            assert.equal(await h.page.getByTestId('themes-root').count(), 0)
            await h.openSettings()
          } else {
            await h.page.locator('.settings-close-btn').click()
            await h.page.getByTestId('themes-root').waitFor({ state: 'hidden' })
            await h.openSettings()
          }
          // Retry before waiting for the canceled request's cleanup acknowledgment.
          await h.page.getByTestId('theme-import').click()
          await h.page.waitForFunction(() => document.querySelector('[data-testid="themes-root"]')?.getAttribute('aria-busy') === 'false')
          assert.equal(await h.page.getByTestId('theme-import-error').count(), 0, 'Cancel/retry must not produce a false busy error')
          await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'visible' })
          assert.equal(await h.page.locator('[data-testid^="theme-import-choice-"]').count(), 1)
          await h.page.keyboard.press('Escape')
          await h.page.getByTestId('theme-import-confirm').waitFor({ state: 'hidden' })
          assert.deepEqual((await h.state()).settings, before, 'Cancellation and retry preserve committed settings')
          assert.deepEqual(appearance(await snapshot(h)), beforePaint, 'Cancellation preserves live content and palette')
        }
      }
      assert.deepEqual((await h.diskSettings()).theme, before)
      return { trialsPerPhase: BOOLEAN_TRIALS, phases: ['before-worker', 'worker'] }
    })
  }
  await exportRoundTrip(h, ids)
}

async function exportRoundTrip(h, originalIds) {
  const exportedPath = path.join(h.fixture, 'Exported custom theme 主题.json')
  let committedExport
  let expectedTerminal
  let expectedEditor
  const customColors = {
    ...IMPORT_ORACLE.colors,
    'terminal.background': '#192a3b',
    'terminal.foreground': '#ddeebb',
    'editor.background': '#213243',
    'editor.foreground': '#f2e3d4'
  }
  await h.case('TH-EXP-01-ui-export-custom-committed-vscode-palette', async () => {
    const imported = await importTheme(h, 'acceptance-midnight.json', 'Acceptance Midnight')
    await select(h, imported.id, originalIds.length, false)
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      await beginDraft(h)
      for (const key of ['terminal.background', 'terminal.foreground', 'editor.background', 'editor.foreground']) {
        const value = key === 'terminal.background' && trial < BOOLEAN_TRIALS - 1 ? `#192a3${trial}` : customColors[key]
        await fill(h, `theme-override-${key}`, value)
      }
      await saveDraftWithExportLock(h)
    }
    const committed = (await h.state()).settings
    await h.persisted(committed)
    const terminal = Object.fromEntries(Object.entries(TERMINAL_KEYS).map(([key, xtermKey]) => [xtermKey, customColors[key]]))
    await assertTerminalColors(h, Object.fromEntries(originalIds.map(id => [id, terminal])))
    expectedTerminal = (await snapshot(h)).terminals[0].palette
    expectedEditor = await editorPalette(h, originalIds[0])
    assert.deepEqual(expectedEditor, {
      background: customColors['editor.background'], foreground: customColors['editor.foreground'],
      comment: IMPORT_ORACLE.tokenColors[0].settings.foreground, commentStyle: 'italic'
    }, 'Actual Monaco surface and syntax use the custom/imported colors')
    await exportTheme(h, exportedPath)
    const text = await readFile(exportedPath, 'utf8')
    committedExport = JSON.parse(text)
    assert.equal(committedExport.$schema, 'vscode://schemas/color-theme')
    assert.equal(committedExport.type, 'dark')
    assert.equal(committedExport.name, imported.name)
    for (const key of [...Object.keys(TERMINAL_KEYS), 'editor.background', 'editor.foreground']) assert.equal(committedExport.colors[key], customColors[key], `Portable color ${key}`)
    assert.deepEqual(committedExport.tokenColors, IMPORT_ORACLE.tokenColors)
    const inspect = value => {
      if (!value || typeof value !== 'object') return
      for (const [key, nested] of Object.entries(value)) {
        assert(!key.startsWith('onward.') && !['include', 'taskOverrides', 'terminalStyles', 'globalTerminalStyle', 'terminalId'].includes(key), `Export contains portable theme data only: ${key}`)
        inspect(nested)
      }
    }
    inspect(committedExport)
    for (const id of originalIds) assert(!text.includes(id), 'Export must not contain Task IDs')
    for (const location of [h.fixture, h.userData, h.workspace]) assert(!text.includes(location) && !text.includes(JSON.stringify(location).slice(1, -1)), 'Export must not contain local source/profile paths')
    await beginDraft(h)
    await fill(h, 'theme-override-terminal.background', '#993355')
    assert(await h.page.getByTestId('theme-export').isDisabled(), 'UI cannot export a preview')
    const committedPath = path.join(h.fixture, 'committed-storage-export.json')
    const result = await h.page.evaluate(async ({ file, themeId }) => {
      await window.electronAPI.themes.setExportPathForAutotest(file)
      return window.electronAPI.themes.export(crypto.randomUUID(), themeId)
    }, { file: committedPath, themeId: imported.id })
    assert.equal(result.success, true)
    assert.deepEqual(JSON.parse(await readFile(committedPath, 'utf8')), committedExport, 'Main process exports committed storage even with a live renderer draft')
    await endDraft(h, 'cancel')
    assert.deepEqual((await h.diskSettings()).theme, committed)
    return { ansiColors: 16, editorSyntax: true, committedStorage: true }
  })
  await h.case('TH-EXP-02-cancel-unwritable-retry-five-trials-bilingual', async () => {
    const before = (await h.state()).settings
    const localized = {}
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      const language = trial % 2 ? 'zh-CN' : 'en'
      await setLanguage(h, language)
      const appearanceBefore = appearance(await snapshot(h))
      await exportTheme(h, null, 'canceled')
      // A directory is unwritable as a regular file on Windows, macOS and Linux;
      // unlike chmod-based fixtures this also fails for privileged CI accounts.
      await exportTheme(h, h.fixture, 'error')
      assert.deepEqual(await exportTemporaryFiles(path.dirname(h.fixture)), [], 'Failed destination rename removes its temporary sibling')
      localized[language] = await h.page.getByTestId('theme-export-status').innerText()
      const retry = path.join(h.fixture, `export-retry-${trial}.json`)
      await exportTheme(h, retry)
      assert.deepEqual(JSON.parse(await readFile(retry, 'utf8')), committedExport)
      assert.deepEqual((await h.state()).settings, before)
      assert.deepEqual(appearance(await snapshot(h)), appearanceBefore, 'Export failures and retry leave live palettes intact')
    }
    assert.notEqual(localized.en, localized['zh-CN'], 'Export failure has distinct English/Chinese copy')
    await setLanguage(h, 'en')
    return { trials: BOOLEAN_TRIALS, localizedErrors: localized }
  })
  await exportCancellation(h, committedExport)
  await h.case('TH-EXP-03-clean-profile-import-real-export-consumer-equivalence', async () => {
    const oldProfile = h.userData
    await h.stop(true)
    await h.freshProfile()
    assert.notEqual(h.userData, oldProfile)
    await boot(h)
    const ids = await grid(h, 2)
    assert.equal((await h.state()).settings.imported.length, 0, 'Round trip starts in a genuinely new profile')
    assert(ids.every(id => !originalIds.includes(id)), 'The fresh profile has different real Task IDs')
    await startImport(h, exportedPath)
    const [imported] = await confirmImport(h, [committedExport.name])
    await select(h, imported.id, ids.length, false)
    await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, expectedTerminal])))
    assert.deepEqual(await editorPalette(h, ids[0]), expectedEditor, 'Exported/reimported actual Monaco colors and syntax match')
    const settings = (await h.state()).settings
    assert.deepEqual(settings.overrides, {}, 'Imported export is self-contained without original customizations')
    assert(!Object.hasOwn(settings, 'taskOverrides'))
    await h.screenshot('clean-profile-export-roundtrip')
    return { newProfile: true, ansiColors: 16, syntax: 'comment/italic', originalSourceNotUsed: true }
  })
}

async function visual(h) {
  await boot(h)
  const ids = await grid(h, 6)
  const expectedContrast = id => ['light-modern', 'solarized-light'].includes(id) ? 4.5 : 1
  const rawPalettes = new Map()
  await h.case('TH-VIS-01-six-palettes-full-working-main-ui', async () => {
    const screenshots = []
    for (const id of FEATURED) {
      await select(h, id, 6)
      assert.equal(await h.page.getByTestId(`theme-card-${id}`).getAttribute('aria-pressed'), 'true')
      assert.equal(await h.page.locator('[data-testid^="theme-card-"][aria-pressed="true"]').count(), 1)
      const current = await snapshot(h)
      assert.deepEqual(current.terminals.map(item => item.id), ids, 'Theme selection preserves the same sessions')
      for (const terminal of current.terminals) assert.equal(terminal.minimumContrastRatio, expectedContrast(id), id)
      rawPalettes.set(id, await h.page.evaluate(terminalId => window.__onwardThemeDebug.getTerminalThemes().find(item => item.terminalId === terminalId).theme, ids[0]))
      assert(current.terminals.every(item => item.output?.includes(OUTPUT_MARKER)))
      await h.page.locator('.theme-preset-grid').scrollIntoViewIfNeeded()
      screenshots.push(await h.screenshot(`palette-${id}`))
    }
    return { screenshots }
  })
  await h.case('TH-VIS-02-contrast-resets-in-place-including-hidden-tasks', async () => {
    const originalTabIndex = await h.page.locator('.tab-item').evaluateAll(tabs => tabs.findIndex(tab => tab.classList.contains('active')))
    assert(originalTabIndex >= 0)
    // Hide the existing sessions via a real tab switch; downsizing destroys excess Tasks.
    await h.page.locator('.tab-add-btn').click()
    const hiddenIds = ids
    await h.page.waitForFunction(hidden => {
      const sessions = window.__onwardThemeDebug.getTerminalThemes()
      return hidden.every(id => sessions.find(item => item.terminalId === id)?.visible === false)
    }, hiddenIds)
    const visibleIds = await grid(h, 2)
    const allIds = [...hiddenIds, ...visibleIds]
    const sequence = [...FEATURED, 'onward-classic']
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      for (const id of sequence) {
        await select(h, id, 2, id !== 'onward-classic')
        await h.page.waitForFunction(({ ids, ratio }) => {
          const sessions = window.__onwardThemeDebug.getTerminalThemes()
          return ids.every(id => sessions.find(item => item.terminalId === id)?.minimumContrastRatio === ratio)
        }, { ids: allIds, ratio: expectedContrast(id) })
        const sessions = await h.page.evaluate(() => window.__onwardThemeDebug.getTerminalThemes())
        assert.deepEqual(sessions.map(item => item.terminalId).sort(), [...allIds].sort(), 'Switching must retain original hidden and visible sessions')
        for (const session of sessions) {
          assert.equal(session.minimumContrastRatio, expectedContrast(id), `${id}: ${session.terminalId}`)
          if (rawPalettes.has(id)) assert.deepEqual(session.theme, rawPalettes.get(id), 'Contrast leaves the raw ANSI palette intact')
        }
        assert((await snapshot(h)).terminals.every(item => item.output?.includes(OUTPUT_MARKER)))
      }
    }
    await h.page.locator('.tab-item').nth(originalTabIndex).click()
    await h.page.waitForFunction(marker => {
      const { terminals } = window.__themesAcceptanceRead()
      return terminals.length === 6 && terminals.every(item => item.painted && item.minimumContrastRatio === 1 && item.output?.includes(marker))
    }, OUTPUT_MARKER)
    assert.deepEqual((await snapshot(h)).terminals.map(item => item.id), ids)
    await h.screenshot('classic-contrast-reset-six-tasks')
    return { trials: BOOLEAN_TRIALS, themes: sequence, hiddenIds }
  })
  await h.case('TH-UX-01-actual-keyboard-selection-and-focus', async () => {
    await h.page.getByTestId('theme-mode').focus()
    let reached = false
    for (let step = 0; step < 30; step++) {
      await h.page.keyboard.press('Tab')
      reached = await h.page.getByTestId('theme-card-dark-modern').evaluate(node => node === document.activeElement)
      if (reached) break
    }
    assert(reached, 'Featured cards are reachable by Tab from the mode control')
    const focus = await h.page.getByTestId('theme-card-dark-modern').evaluate(node => {
      const style = getComputedStyle(node)
      return { visible: node.matches(':focus-visible'), outline: parseFloat(style.outlineWidth), shadow: style.boxShadow }
    })
    assert(focus.visible && (focus.outline > 0 || focus.shadow !== 'none'), 'Keyboard focus is visibly indicated')
    await h.page.keyboard.press('Space')
    await waitBase(h, 'dark-modern', 6)
    assert.equal((await h.state()).settings.mode, 'manual')
    await h.page.keyboard.press('Tab')
    assert(await h.page.getByTestId('theme-card-light-modern').evaluate(node => node === document.activeElement))
    await h.page.keyboard.press('Enter')
    await waitBase(h, 'light-modern', 6)
    await beginDraft(h)
    await fill(h, 'theme-override-terminal.background', '#e1e2e3')
    await h.page.keyboard.press('Escape')
    await waitBase(h, 'light-modern', 6)
    assert(await h.page.getByTestId('theme-customize').evaluate(node => node === document.activeElement), 'Cancel returns focus to Customize')
  })
  await h.case('TH-UX-03-category-switches-and-manual-keyboard-five-trials', async () => {
    await resizeSettings(h, 600)
    const content = h.page.locator('.settings-content')
    const current = () => content.getAttribute('data-settings-page')
    const focused = id => h.page.getByTestId(`settings-tab-${id}`).evaluate(node => node === document.activeElement)
    const before = (await h.state()).settings
    const tablist = h.page.getByRole('tablist')
    assert.equal(await tablist.getAttribute('aria-orientation'), 'vertical')
    assert.equal(await tablist.getByRole('tab').count(), SETTINGS_PAGES.length)
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      for (const id of SETTINGS_PAGES) {
        await h.openSettings(id)
        assert.equal(await h.page.getByTestId(`settings-tab-${id}`).getAttribute('aria-selected'), 'true')
        assert.equal(await tablist.locator('[aria-selected="true"]').count(), 1)
      }
      await h.openSettings('general')
      await h.page.getByTestId('settings-tab-general').focus()
      for (const [key, id] of [['ArrowDown', 'appearance'], ['End', 'about'], ['ArrowDown', 'general'], ['ArrowUp', 'about'], ['Home', 'general'], ['ArrowDown', 'appearance']]) {
        await h.page.keyboard.press(key)
        assert(await focused(id), `${key} moves focus to ${id}`)
        assert.equal(await current(), 'general', 'Arrow/Home/End focus must not activate a category')
      }
      await h.page.keyboard.press('Enter')
      assert.equal(await current(), 'appearance')
      await h.page.keyboard.press('ArrowDown')
      assert(await focused('fonts'))
      assert.equal(await current(), 'appearance')
      await h.page.keyboard.press('Space')
      assert.equal(await current(), 'fonts')
      assert.equal(await h.page.getByTestId('themes-root').count(), 0)
    }
    assert.deepEqual((await h.state()).settings, before)
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      for (const width of [300, 400, 499, 500, 600]) {
        await resizeSettings(h, width)
        assert.equal(await h.page.getByTestId('settings-page-select').isVisible(), width < 500)
        assert.equal(await tablist.isVisible(), width >= 500)
      }
    }
    await h.openSettings()
    return { trials: BOOLEAN_TRIALS, breakpoint: 500, pages: SETTINGS_PAGES }
  })
  await h.case('TH-UX-04-bilingual-search-targets-and-no-results', async () => {
    const entries = [
      ['general', 'language', 'Language', '语言'],
      ['general', 'diagnostics', 'Diagnostics', '诊断'],
      ['general', 'privacy', 'Privacy', '隐私'],
      ['appearance', 'themes', 'Featured themes', '精选主题'],
      ['fonts', 'terminal-font-size', 'Terminal font size', '终端字体大小'],
      ['fonts', 'editor-font-size', 'Project Editor font size', 'Project Editor 字体大小'],
      ['fonts', 'font-family', 'Font family', '字体'],
      ['shortcuts', 'globalShortcuts', 'Global Shortcuts', '全局快捷键'],
      ['shortcuts', 'windowShortcuts', 'Window Shortcuts', '窗口快捷键'],
      ['shortcuts', 'terminalActions', 'Terminal Actions', '终端操作'],
      ['shortcuts', 'terminalFocus', 'Terminal Focus', '终端聚焦'],
      ['shortcuts', 'tabSwitch', 'Tab Switching', '标签页切换'],
      ['about', 'updates', 'Updates', '更新']
    ]
    const shortcutLabels = [
      ['shortcuts', 'terminalActions', 'View Git Diff', '查看 Git Diff'],
      ['shortcuts', 'windowShortcuts', 'Focus Prompt editor', '聚焦 Prompt 编辑器'],
      ['shortcuts', 'terminalActions', 'Change working directory', '更改工作目录'],
      ['shortcuts', 'terminalFocus', 'Focus Task 1', '聚焦 Task 1'],
      ['shortcuts', 'tabSwitch', 'Switch to Tab 2', '切换到 Tab 2']
    ]
    const search = h.page.getByTestId('settings-search')
    const messages = []
    for (const language of ['en', 'zh-CN']) {
      await setLanguage(h, language)
      for (const [page, target, en, zh] of [...entries, ...shortcutLabels]) {
        await search.fill(language === 'en' ? en : zh)
        await h.page.getByTestId(`settings-search-${target}`).click()
        assert.equal(await h.page.locator('.settings-content').getAttribute('data-settings-page'), page)
        assert.equal(await search.inputValue(), '')
        const destination = h.page.locator(`[data-settings-target="${target}"]`)
        assert(await destination.evaluate(node => node === document.activeElement), `Search focuses ${target}`)
        assert(await destination.isVisible())
      }
      const previous = await h.page.locator('.settings-content').getAttribute('data-settings-page')
      await search.fill('NO_MATCH_739AF20')
      assert.equal(await h.page.locator('[data-testid^="settings-search-"]').count(), 0)
      const message = await h.page.locator('.settings-search-results [role="status"]').innerText()
      assert(message.trim().length > 2 && !message.startsWith('settings.'))
      messages.push(message)
      await search.press('Enter')
      assert.equal(await h.page.locator('.settings-content').getAttribute('data-settings-page'), previous)
      await search.press('Escape')
      assert.equal(await search.inputValue(), '')
      assert(await h.page.locator('.settings-container').isVisible())
    }
    assert.notEqual(messages[0], messages[1])
    await setLanguage(h, 'en')
    await h.openSettings()
    return { targets: entries.map(entry => entry[1]), shortcutLabels: shortcutLabels.map(entry => ({ en: entry[2], zh: entry[3] })), localizedEmptyStates: messages }
  })
  await h.case('TH-UX-02-real-resize-300-and-600-all-pages-en-and-zh', async () => {
    const panel = h.page.locator('.settings-container')
    const screenshots = []
    const captions = []
    const horizontalLayouts = []
    const assertSettingsFits = async (language, stage) => {
      const layout = await panel.locator('.settings-content').evaluate(root => {
        const viewport = root.getBoundingClientRect()
        const left = viewport.left + root.clientLeft
        const right = left + root.clientWidth
        const selectors = [
          'button', 'select', 'input', 'textarea', '[tabindex]', '[role="button"]', 'label', 'summary',
          '.color-preview', '.settings-row-label', '.terminal-selector-label', '.settings-row-value', '.settings-row-hint',
            '.settings-page-heading', '.settings-section-title', '.settings-group-title', '.settings-group-description',
            '.settings-diagnostics-description', '.settings-telemetry-description',
          '.settings-update-action-label', '.settings-update-action-detail', '.settings-placeholder-title', '.settings-placeholder-text',
          '.settings-version-number', '.settings-version-label', '.settings-version-copyright',
          '.theme-preset-name', '.theme-card-kind', '.theme-active-name', '.theme-hint', 'h3', 'h4'
        ].join(', ')
        const overflow = []
        let checked = 0
        let verticallyOffscreen = 0
        for (const node of root.querySelectorAll(selectors)) {
          const style = getComputedStyle(node)
          if (!node.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse') continue
          const rect = node.getBoundingClientRect()
          checked++
          // Offscreen rows still contribute to this shared scroll container's horizontal extent.
          if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) verticallyOffscreen++
          const clipped = !node.matches('input, select, textarea') &&
            node.scrollWidth > node.clientWidth + 2 && ['hidden', 'clip'].includes(style.overflowX)
          if (rect.left < left - 1 || rect.right > right + 1 || clipped) overflow.push({
            tag: node.tagName, id: node.getAttribute('data-testid'), className: node.className,
            text: (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 100),
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, clipped
          })
        }
        return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, scrollLeft: root.scrollLeft, left, right, checked, verticallyOffscreen, overflow }
      })
      horizontalLayouts.push({ language, stage, ...layout })
      const context = `${language}/${stage}: ${JSON.stringify(layout)}`
      assert(layout.checked > 0, `Settings controls were measured: ${context}`)
      assert(layout.scrollWidth <= layout.clientWidth + 1, `Whole Settings content has no horizontal overflow: ${context}`)
      assert(Math.abs(layout.scrollLeft) <= 1, `Settings content has not scrolled sideways: ${context}`)
      assert.deepEqual(layout.overflow, [], `All Settings controls and labels fit, including vertically offscreen rows: ${context}`)
    }
    for (const width of [300, 600]) {
      await resizeSettings(h, width)
      for (const language of ['en', 'zh-CN']) {
        await setLanguage(h, language)
        for (const page of SETTINGS_PAGES) {
          await h.openSettings(page)
          assert.equal(await h.page.getByTestId('settings-page-select').isVisible(), width < 500)
          assert.equal(await h.page.getByRole('tablist').isVisible(), width >= 500)
          await assertSettingsFits(language, `${width}/${page}`)
          const chrome = await panel.evaluate(root => {
            const box = root.getBoundingClientRect()
            return [...root.querySelectorAll('.settings-header, .settings-search input, .settings-navigation button, .settings-navigation-compact select')]
              .filter(node => node.getClientRects().length).filter(node => {
                const rect = node.getBoundingClientRect()
                return rect.left < box.left - 1 || rect.right > box.right + 1 || node.scrollWidth > node.clientWidth + 2
              }).map(node => node.getAttribute('data-testid') ?? node.className)
          })
          assert.deepEqual(chrome, [], `Navigation/search/header fit ${width}px/${language}/${page}`)
          screenshots.push(await h.screenshot(`settings-${width}-${language}-${page}`))
          if (page !== 'appearance') continue
          if (width === 300) captions.push(await h.page.getByTestId('theme-customize').innerText())
          await h.page.getByTestId('theme-mode').selectOption('system')
          await h.page.getByTestId('theme-pair-dark').selectOption('dracula')
          await beginDraft(h)
          await fill(h, 'theme-override-onward.background', '#102030')
          await h.page.getByTestId('theme-draft-save').scrollIntoViewIfNeeded()
          await assertSettingsFits(language, `${width}/customize`)
          screenshots.push(await h.screenshot(`settings-${width}-${language}-customize`))
          await endDraft(h, 'cancel')
        }
      }
    }
    assert.notEqual(captions[0], captions[1], 'Customize is translated, not hardcoded English')
    return { widths: [300, 600], pages: SETTINGS_PAGES, languages: ['en', 'zh-CN'], screenshots, horizontalLayouts }
  })
  await scheduleVisual(h, { setLanguage, resizeSettings })
}

async function latency(h) {
  await boot(h)
  const terminalIds = await grid(h, 6)
  await select(h, 'dark-modern', 6)
  await select(h, 'light-modern', 6)
  await h.case('TH-PERF-01-six-terminals-200ms-three-trials', async () => {
    const trials = []
    for (let index = 0; index < LATENCY_TRIALS; index++) {
      const id = index % 2 ? 'light-modern' : 'dark-modern'
      await select(h, id === 'dark-modern' ? 'light-modern' : 'dark-modern', 6)
      await h.page.evaluate(({ id, expected }) => {
        window.__themesAcceptanceTiming?.dispose?.()
        const probe = { result: null, dispose: null }
        window.__themesAcceptanceTiming = probe
        let frame = 0
        let start = 0
        let timeout
        let done = false
        const dispose = () => {
          document.removeEventListener('click', clicked, true)
          cancelAnimationFrame(frame)
          clearTimeout(timeout)
        }
        probe.dispose = dispose
        const finish = (correct, reason) => {
          if (done) return
          done = true
          probe.result = { id, correct, reason, durationMs: performance.now() - start, snapshot: window.__themesAcceptanceRead(false) }
          dispose()
        }
        const matches = () => {
          const actual = window.__themesAcceptanceRead(false)
          return document.documentElement.dataset.theme === id && actual.body?.background === expected.background &&
            actual.terminals.length === 6 && actual.terminals.every(item => item.status === 'ready' && item.painted &&
              item.palette.background === expected.background && item.palette.foreground === expected.foreground &&
              item.background === expected.background)
        }
        let matchedLastFrame = false
        const sample = () => {
          const match = matches()
          // Two consecutive rAF observations include a paint opportunity;
          // settings/resolver state alone is never a completion signal.
          if (match && matchedLastFrame) { finish(true, 'painted-consumers'); return }
          matchedLastFrame = match
          frame = requestAnimationFrame(sample)
        }
        const clicked = event => {
          if (!event.target.closest?.(`[data-testid="theme-card-${id}"]`)) return
          start = performance.now()
          if (!event.isTrusted) { finish(false, 'untrusted-input'); return }
          document.removeEventListener('click', clicked, true)
          timeout = setTimeout(() => finish(false, 'consumers-did-not-converge'), 5000)
          frame = requestAnimationFrame(sample)
        }
        document.addEventListener('click', clicked, true)
      }, { id, expected: PALETTES[id] })
      await h.page.getByTestId(`theme-card-${id}`).click()
      await h.page.waitForFunction(() => window.__themesAcceptanceTiming.result !== null)
      const trial = await h.page.evaluate(() => window.__themesAcceptanceTiming.result)
      trial.identitiesPreserved = JSON.stringify(trial.snapshot.terminals.map(item => item.id)) === JSON.stringify(terminalIds)
      trial.outputPreserved = (await snapshot(h)).terminals.every(item => item.output?.includes(OUTPUT_MARKER))
      trials.push(trial)
      h.measurements.push(trial)
      await h.log('THEME_SWITCH_TRIAL', trial)
    }
    await h.log('THEME_SWITCH_MEASUREMENTS', { budgetMs: THEME_SWITCH_BUDGET_MS, trials })
    assert(trials.every(trial => trial.correct && trial.identitiesPreserved && trial.outputPreserved), 'All three results, task identities, and terminal output must be correct')
    assert(trials.some(trial => trial.durationMs <= THEME_SWITCH_BUDGET_MS), 'At least one of three user-approved 200ms trials passes')
    return { budgetMs: THEME_SWITCH_BUDGET_MS, trials }
  })
  await h.case('TH-STRESS-01-twenty-clicks-last-selection-wins', async () => {
    for (let index = 0; index < 20; index++) {
      await h.page.getByTestId(`theme-card-${index % 2 ? 'solarized-light' : 'nord'}`).click()
    }
    await waitBase(h, 'solarized-light', 6)
    const final = await snapshot(h)
    assert.deepEqual(final.terminals.map(item => item.id), terminalIds)
    assert(final.terminals.every(item => item.output?.includes(OUTPUT_MARKER)))
    await h.screenshot('six-terminals-after-switch-pressure')
    return { clicks: 20, terminals: 6 }
  })
  await h.case('TH-STRESS-02-live-output-prompt-draft-five-roundtrips', async () => {
    await promptPressure(h, terminalIds)
    return { trials: BOOLEAN_TRIALS, terminals: terminalIds.length, intervalMs: PRESSURE_INTERVAL_MS }
  })
  await h.case('TH-SCH-STRESS01-schedule-keeps-prompt-and-six-streams', async () => {
    await promptPressure(h, terminalIds, true)
    return { trials: BOOLEAN_TRIALS, terminals: terminalIds.length, intervalMs: PRESSURE_INTERVAL_MS }
  })
}

async function promptPressure(h, terminalIds, scheduled = false) {
  await h.openSettings()
  const page = h.page
  const prompt = JSON.parse(await readFile(path.join(h.fixture, 'prompt-draft.json'), 'utf8'))
  const output = await terminalOutputFixture(h)
  assert(output.length < 4096, 'Each terminal pressure tick uses a small bounded fixture')
  assert.equal(prompt.typedSuffixes.length, BOOLEAN_TRIALS)
  assert.equal(terminalIds.length, 6)
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="themes-root"]')?.getAttribute('aria-busy') === 'false')
  await page.getByTestId('theme-mode').selectOption('system')
  await settled()
  await page.getByTestId('theme-pair-dark').selectOption('dark-modern')
  await settled()
  await page.getByTestId('theme-pair-light').selectOption('light-modern')
  await settled()
  await page.emulateMedia({ colorScheme: 'dark' })
  await waitBase(h, 'dark-modern', 6)
  if (scheduled) {
    await setupSchedule(h, 'dark-modern')
    await waitBase(h, 'dark-modern', 6)
  }
  const notebook = page.locator('.prompt-notebook:not(.prompt-notebook-hidden)')
  if (!await notebook.isVisible()) await page.getByTitle('Prompt notebook', { exact: true }).click()
  const content = notebook.locator('.prompt-editor-content[contenteditable="plaintext-only"]')
  const title = notebook.locator('.prompt-editor-title')
  await content.waitFor({ state: 'visible' })
  await title.fill(prompt.title)
  await content.fill(prompt.content)
  await content.press('End')
  let expectedContent = prompt.content
  const trials = []
  try {
    await page.evaluate(({ ids, output, intervalMs }) => {
      window.__themesAcceptancePressure?.stop()
      let timer = null
      let sequence = 0
      let stopped = false
      const accepted = Object.fromEntries(ids.map(id => [id, 0]))
      const errors = []
      const stop = () => {
        if (timer !== null) clearInterval(timer)
        timer = null
        stopped = true
      }
      const read = () => ({
        sequence, stopped, accepted: { ...accepted }, errors: [...errors],
        rendered: Object.fromEntries(ids.map(id => {
          const text = window.__onwardTerminalDebug.getTailText(id, 80) ?? ''
          const markers = [...text.matchAll(/TH_STREAM:(\d+)/g)]
          return [id, Number(markers.at(-1)?.[1] ?? 0)]
        }))
      })
      window.__themesAcceptancePressure = { read, stop }
      // Each tick feeds the existing production PTY-output boundary once per
      // visible Task. Never queue asynchronous interval callbacks or catch-up bursts.
      timer = setInterval(() => {
        sequence++
        const chunk = `${output}\r\nTH_STREAM:${String(sequence).padStart(6, '0')}\r\n`
        for (const id of ids) {
          try {
            if (!window.__onwardTerminalDebug.injectPtyData(chunk, id)) throw new Error('PTY injection rejected')
            accepted[id]++
          } catch (error) {
            errors.push({ id, sequence, error: String(error).slice(0, 256) })
            stop()
            break
          }
        }
      }, intervalMs)
    }, { ids: terminalIds, output, intervalMs: PRESSURE_INTERVAL_MS })
    for (let trial = 0; trial < BOOLEAN_TRIALS; trial++) {
      const before = await page.evaluate(() => window.__themesAcceptancePressure.read())
      // Real key events exercise Prompt input while the renderer drains Task output.
      await content.pressSequentially(prompt.typedSuffixes[trial])
      expectedContent += prompt.typedSuffixes[trial]
      const states = []
      for (const colorScheme of ['light', 'dark']) {
        const previous = await page.evaluate(() => window.__themesAcceptancePressure.read())
        if (scheduled) await scheduleClock(h, scheduleTime(colorScheme === 'light' ? 10 : 18), 'resume')
        else await page.emulateMedia({ colorScheme })
        const actual = await waitBase(h, `${colorScheme}-modern`, 6)
        await page.waitForFunction(({ ids, previous }) => {
          const state = window.__themesAcceptancePressure.read()
          if (state.errors.length) throw new Error(JSON.stringify(state.errors))
          // Read counters back from xterm's buffer, not only the injection loop.
          return ids.every(id => state.rendered[id] >= previous.rendered[id] + 2)
        }, { ids: terminalIds, previous })
        const stream = await page.evaluate(() => window.__themesAcceptancePressure.read())
        const draftPreserved = await content.innerText() === expectedContent && await title.inputValue() === prompt.title
        const promptFocused = await content.evaluate(node => node === document.activeElement)
        const identitiesPreserved = JSON.stringify(actual.terminals.map(item => item.id)) === JSON.stringify(terminalIds)
        const outputsAdvanced = terminalIds.every(id => stream.rendered[id] > previous.rendered[id] && stream.accepted[id] > previous.accepted[id])
        const systemModePreserved = (await h.state()).settings.mode === (scheduled ? 'schedule' : 'system')
        states.push({ colorScheme, stream, draftPreserved, promptFocused, identitiesPreserved, outputsAdvanced, systemModePreserved })
      }
      const result = {
        trial: trial + 1, before, states,
        ok: states.every(state => state.draftPreserved && state.promptFocused && state.identitiesPreserved &&
          state.outputsAdvanced && state.systemModePreserved && !state.stream.stopped && state.stream.errors.length === 0)
      }
      trials.push(result)
      h.measurements.push({ id: scheduled ? 'TH-SCH-STRESS01' : 'TH-STRESS-02', ...result })
      await h.log('THEME_PRESSURE_TRIAL', result)
    }
    assert.equal(trials.length, BOOLEAN_TRIALS)
    assert(trials.every(trial => trial.ok), 'Every live-output theme round trip preserves Prompt draft, focus, Task IDs, and advancing buffers')
    await h.screenshot('six-streaming-terminals-prompt-draft')
  } finally {
    // Clear the test-owned interval on assertion failure as well as success.
    // Closing the owned Electron page also disposes it on signal/deadline cleanup.
    if (!page.isClosed()) {
      await page.evaluate(() => {
        window.__themesAcceptancePressure?.stop()
        delete window.__themesAcceptancePressure
      })
    }
  }
}

async function surfaces(h) {
  await boot(h)
  await grid(h, 2)
  await h.case('TH-SURF-SUITE', async () => {
    const { testThemeSurfaces } = await import('./theme-surfaces-checks.mjs')
    const results = await testThemeSurfaces(h.page, h.workspace, name => h.screenshot(name), async result => {
      assert(!h.cancelled, 'Surface group canceled before result recording')
      const recorded = { id: result.id, status: 'PASS', detail: result }
      h.results.push(recorded)
      await appendFile(path.join(h.artifacts, 'surface-results.jsonl'), `${JSON.stringify(recorded)}\n`)
      await h.log(`PASS ${result.id}`, result)
    })
    assert(results.length > 0, 'The surface helper must complete real scenarios')
    return { scenarios: results.map(result => result.id) }
  })
}

async function persistence(h) {
  await boot(h)
  const [first, second] = await grid(h, 2)
  let saved
  let importedId
  await h.case('TH-PERSIST-01-save-import-customization-fonts-pair', async () => {
    importedId = (await importTheme(h, 'acceptance-midnight.jsonc', 'Acceptance Midnight JSONC')).id
    await select(h, 'dracula', 2)
    await beginDraft(h)
    await fill(h, 'theme-override-terminal.background', '#152637')
    await endDraft(h, 'save')
    await setTaskFonts(h, first, { fontSize: 19, gitDiffFontSize: 17, fontFamily: 'monospace' })
    await h.openSettings()
    await h.page.getByTestId('theme-mode').selectOption('system')
    await h.page.getByTestId('theme-pair-dark').selectOption('dracula')
    await h.page.getByTestId('theme-pair-light').selectOption('solarized-light')
    saved = (await h.state()).settings
    await h.persisted(saved)
    await beginDraft(h)
    await fill(h, 'theme-override-terminal.background', '#913247')
    await assertTerminalColors(h, { [second]: { background: '#913247' } })
    assert.deepEqual((await h.diskSettings()).theme, saved, 'Unsaved preview never reaches disk')
    await h.screenshot('before-restart-unsaved-preview')
    await h.stop(true)
    await rm(path.join(h.fixture, 'acceptance-midnight.jsonc'))
  })
  await h.case('TH-PERSIST-02-real-restart-current-system-and-no-draft', async () => {
    await boot(h, 'light')
    await waitBase(h, 'solarized-light', 2)
    assert.deepEqual((await h.state()).settings, saved)
    assert.equal((await h.state()).draft, false)
    assert.equal((await h.state()).systemDark, false)
    assert.deepEqual((await snapshot(h)).terminals.map(item => item.id), [first, second], 'Task identity survives real restart')
    const output = await terminalOutputFixture(h)
    await h.page.evaluate(({ output, ids }) => ids.forEach(id => window.__onwardTerminalDebug.injectPtyData(output, id)), { output, ids: [first, second] })
    await h.page.emulateMedia({ colorScheme: 'dark' })
    await assertTerminalColors(h, {
      [first]: { background: '#152637', foreground: PALETTES.dracula.foreground },
      [second]: { background: '#152637', foreground: PALETTES.dracula.foreground }
    })
    assert.equal((await terminalFonts(h)).find(row => row.id === first)?.fontSize, 19)
    assert.equal((await terminalFonts(h)).find(row => row.id === first)?.fontFamily, 'monospace')
    await editorFont(h, first, 17)
    const imported = (await h.state()).settings.imported.find(theme => theme.id === importedId)
    assert(imported, 'Imported definition survives without its original file')
    await assertImported(h, imported, IMPORT_ORACLE, [first, second])
    await h.screenshot('after-real-restart')
  })
  await schedulePersistence(h, { boot, waitBase, grid })
}

async function migration(h) {
  await cp(path.join(h.fixture, 'legacy-settings.json'), path.join(h.userData, 'settings.json'))
  await boot(h, 'light')
  await grid(h, 2)
  let migrated
  await h.case('TH-MIG-01-old-profile-preserves-classic-raw-defaults', async () => {
    const state = await h.state()
    assert.equal(state.settings.mode, 'manual')
    assert.equal(state.settings.themeId, 'onward-classic')
    assert.deepEqual(state.settings.classic, { mode: 'preset', presetId: 'graphite', custom: null })
    assert.equal((await snapshot(h)).body.background, '#101012', 'Old Graphite workbench appearance is preserved')
    const ids = (await snapshot(h)).terminals.map(item => item.id)
    await assertTerminalColors(h, Object.fromEntries(ids.map(id => [id, { background: '#1e1e1e', foreground: '#cccccc' }])))
    await setLanguage(h, 'zh-CN')
    migrated = (await h.state()).settings
    await h.persisted(migrated)
    await h.screenshot('legacy-classic-preserved')
    await h.stop(true)
  })
  await h.case('TH-MIG-02-second-launch-idempotent', async () => {
    await boot(h, 'dark')
    assert.deepEqual((await h.state()).settings, migrated)
    assert.equal((await snapshot(h)).body.background, '#101012')
    assert((await snapshot(h)).terminals.every(item => item.palette.background === '#1e1e1e'))
    await setLanguage(h, 'en')
    await beginDraft(h)
    await h.page.getByTestId('classic-preset').selectOption('starlight')
    await endDraft(h, 'cancel')
    assert.equal((await h.state()).settings.classic.presetId, 'graphite')
    assert.equal((await snapshot(h)).body.background, '#101012')
  })
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(`Usage: node test/autotest/test-themes-ui.mjs --app-bin <packaged-executable> [--log-file <transcript>] --group <${GROUPS.join('|')}>\nShell runners accept [appbin] [logfile]; group wrappers select their own group. One group per invocation; no build, install, or browser download. Artifacts: traces/test-logs/themes-ui/.`)
} else {
  const harness = new ThemeUiHarness(options)
  let deadline
  let rejectAbort
  let signalError
  const abort = new Promise((_, reject) => { rejectAbort = reject })
  const interrupted = signal => {
    harness.cancelled = true
    signalError ??= new Error(`Runner interrupted by ${signal}`)
    rejectAbort(signalError)
  }
  const onSigint = () => interrupted('SIGINT')
  const onSigterm = () => interrupted('SIGTERM')
  // A signal during fixture initialization must not become an unhandled rejection.
  void abort.catch(() => {})
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  let failure
  try {
    deadline = setTimeout(() => interrupted(`work deadline ${WORK_DEADLINE_MS}ms`), WORK_DEADLINE_MS)
    await harness.initialize()
    await Promise.race([
      ({ core, draft, tasks, imports, visual, latency, persistence, migration, surfaces })[options.group](harness),
      abort
    ])
    assert(harness.results.length > 0, 'A runner cannot pass with zero assertions')
  } catch (error) {
    failure = error
    if (harness.page) await harness.screenshot('failure').catch(() => {})
  } finally {
    clearTimeout(deadline)
    if (harness.scratch) process.exitCode = await harness.finish(failure ?? signalError)
    else {
      console.error(failure)
      process.exitCode = 1
    }
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}
