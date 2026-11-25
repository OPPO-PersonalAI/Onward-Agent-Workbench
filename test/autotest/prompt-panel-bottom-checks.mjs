/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eventually, saveSettingsPage } from './themes-ui-driver-support.mjs'

// Bottom-dock Prompt panel behaviour: the vertical icon action rail at the right edge of the
// editor, side columns and height without fixed caps, display-only compression in a small
// window, and the vertical attachment column. Runs inside the `draft` group after SP-UI05.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Expected rail labels come from the locale dictionary (en first, then zh-CN), so this
// driver carries no localized copy of its own.
const ADD_TO_HISTORY_LABEL = await (async () => {
  const dictionary = await readFile(path.join(REPO_ROOT, 'src/i18n/core.ts'), 'utf8')
  const labels = [...dictionary.matchAll(/'promptEditor\.addToHistory':\s*'([^']+)'/g)].map(match => match[1])
  assert.equal(labels.length, 2, 'promptEditor.addToHistory has exactly one en and one zh-CN entry')
  return { en: labels[0], 'zh-CN': labels[1] }
})()
const TRIALS = 5
const VIEWPORT = { width: 1720, height: 1080 }
const SMALL_VIEWPORT = { width: 1100, height: 640 }
const NARROW_VIEWPORT = { width: 1100, height: 1080 }
// Former fixed caps that the bottom dock no longer enforces.
const FORMER_HISTORY_CAP = 640
const FORMER_SENDER_CAP = 600
const FORMER_HEIGHT_CAP = 600
const MIN_EDITOR_WIDTH = 240
const RAIL_WIDTH = 48
const MIN_EDITOR_COLUMN_WIDTH = MIN_EDITOR_WIDTH + RAIL_WIDTH
const MIN_PANEL_HEIGHT = 160
const MIN_TERMINAL_AREA_HEIGHT = 160

const NOTEBOOK = '.prompt-notebook:not(.prompt-notebook-hidden)'
const TOP_RESIZER = `${NOTEBOOK} > [data-testid="prompt-notebook-resizer"]`
const LEFT_RESIZER = `${NOTEBOOK} [data-testid="prompt-bottom-resizer-left"]`
const RIGHT_RESIZER = `${NOTEBOOK} [data-testid="prompt-bottom-resizer-right"]`
const ATTACHMENT_RESIZER = `${NOTEBOOK} [data-testid="prompt-bottom-resizer-attachments"]`

const live = h => h.page.evaluate(() => window.electronAPI.settings.load())
const dims = h => h.page.evaluate(() => window.__onwardPromptNotebookDebug.getPanelDimensions())
const bottomLayout = h => h.page.evaluate(() => window.__onwardPromptNotebookDebug.getBottomLayout())

async function ensurePromptOpen(h) {
  if (await h.page.locator('.settings-container').isVisible()) {
    await h.page.locator('.settings-close-btn').click()
    await h.page.locator('.settings-container').waitFor({ state: 'detached' })
  }
  const visibleNotebook = h.page.locator(NOTEBOOK)
  if (!await visibleNotebook.isVisible()) {
    await h.page.getByTestId('sidebar-prompt-button').click()
    await visibleNotebook.waitFor({ state: 'visible' })
  }
}

async function setPosition(h, position) {
  await h.openSettings('general')
  await h.page.getByTestId(`settings-prompt-position-${position}`).click()
  await saveSettingsPage(h.page)
  assert.equal((await live(h)).promptPanelPosition, position)
  await ensurePromptOpen(h)
  await h.page.locator(`${NOTEBOOK}[data-dock-position="${position}"]`).waitFor({ state: 'visible' })
}

async function setLanguage(h, language) {
  await h.openSettings('general')
  await h.page.getByTestId('settings-language-select').selectOption(language)
  await saveSettingsPage(h.page)
  assert.equal((await live(h)).language, language)
  await ensurePromptOpen(h)
}

async function dragResizer(h, selector, dx, dy) {
  const box = await h.page.locator(selector).boundingBox()
  assert(box, `Resizer bounding box not found: ${selector}`)
  const startX = Math.round(box.x + box.width / 2)
  const startY = Math.round(box.y + box.height / 2)
  await h.page.mouse.move(startX, startY)
  await h.page.mouse.down()
  await h.page.mouse.move(startX + dx, startY + dy, { steps: 4 })
  await h.page.mouse.up()
}

async function dragResizerToX(h, selector, targetX) {
  const box = await h.page.locator(selector).boundingBox()
  assert(box, `Resizer bounding box not found: ${selector}`)
  await dragResizer(h, selector, Math.round(targetX - (box.x + box.width / 2)), 0)
}

function readGeometry(h) {
  return h.page.evaluate((selector) => {
    const rect = el => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const nb = document.querySelector(selector)
    const strip = nb.querySelector('[data-testid="prompt-editor-images-strip"]')
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      notebook: rect(nb),
      terminal: rect(document.querySelector('.terminal-area')),
      history: rect(nb.querySelector('[data-testid="prompt-notebook-history-pane"]')),
      editor: rect(nb.querySelector('.prompt-editor')),
      inputs: rect(nb.querySelector('.prompt-editor-inputs')),
      sender: rect(nb.querySelector('[data-testid="prompt-notebook-sender-pane"]')),
      actions: rect(nb.querySelector('[data-testid="prompt-editor-actions"]')),
      buttons: Array.from(nb.querySelectorAll('[data-testid="prompt-editor-actions"] .prompt-editor-btn')).map(rect),
      strip: rect(strip),
      stripLayout: strip?.getAttribute('data-layout') ?? null,
      cards: Array.from(nb.querySelectorAll('.prompt-editor-image-card')).map(rect)
    }
  }, NOTEBOOK)
}

function readRail(h) {
  return h.page.evaluate((selector) => {
    const rect = el => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    const nb = document.querySelector(selector)
    const bar = nb.querySelector('[data-testid="prompt-editor-actions"]')
    const strip = nb.querySelector('[data-testid="prompt-editor-images-strip"]')
    return {
      layout: bar.getAttribute('data-layout'),
      rail: rect(bar),
      scrollHeight: bar.scrollHeight,
      clientHeight: bar.clientHeight,
      editor: rect(nb.querySelector('.prompt-editor')),
      inputs: rect(nb.querySelector('.prompt-editor-inputs')),
      strip: strip ? rect(strip) : null,
      colors: Array.from(bar.querySelectorAll('.prompt-editor-color-btn')).map(rect),
      buttons: Array.from(bar.querySelectorAll('.prompt-editor-btn')).map(button => ({
        action: button.getAttribute('data-action'),
        rect: rect(button),
        text: button.textContent.trim(),
        label: button.getAttribute('aria-label'),
        title: button.getAttribute('title'),
        hasIcon: button.querySelector('svg') !== null,
        disabled: button.disabled
      }))
    }
  }, NOTEBOOK)
}

// Every control of the rail must be reachable: scroll each into view and confirm it lies
// fully inside the rail's visible box.
function railControlsReachable(h) {
  return h.page.evaluate((selector) => {
    const bar = document.querySelector(`${selector} [data-testid="prompt-editor-actions"]`)
    const controls = Array.from(bar.querySelectorAll('.prompt-editor-color-btn, .prompt-editor-btn'))
    const result = controls.map(control => {
      control.scrollIntoView({ block: 'nearest' })
      const box = bar.getBoundingClientRect()
      const r = control.getBoundingClientRect()
      return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
    })
    bar.scrollTop = bar.scrollHeight
    return result
  }, NOTEBOOK)
}

function assertStackedAtBottom(r, tag) {
  const stack = [...r.colors, ...r.buttons.map(button => button.rect)]
  const railCenter = r.rail.left + r.rail.width / 2
  for (let i = 0; i < stack.length; i++) {
    const center = stack[i].left + stack[i].width / 2
    assert(Math.abs(center - railCenter) <= 1.5, `${tag}: control ${i} is centered in the rail (${center} vs ${railCenter})`)
    if (i > 0) assert(stack[i].top >= stack[i - 1].bottom - 1, `${tag}: control ${i} is below control ${i - 1}`)
  }
  const last = stack[stack.length - 1]
  assert(r.rail.bottom - last.bottom <= 12, `${tag}: the group sits at the bottom of the rail (${r.rail.bottom - last.bottom}px gap)`)
}

async function readTraceEvents(pid) {
  const directory = path.join(REPO_ROOT, 'traces/perf')
  const events = []
  for (const filename of await readdir(directory)) {
    if (!filename.endsWith(`-${pid}.jsonl`) && !filename.endsWith(`-${pid}.json`)) continue
    const text = await readFile(path.join(directory, filename), 'utf8')
    events.push(...(filename.endsWith('.jsonl')
      ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      : JSON.parse(text).traceEvents))
  }
  return events
}

export async function promptPanelBottomChecks(h) {
  await h.case('SP-UI06-bottom-action-rail-stacks-icons-at-the-right-edge', async () => {
    await setPosition(h, 'bottom')
    const samples = {}
    for (const language of ['en', 'zh-CN']) {
      await setLanguage(h, language)
      const r = await readRail(h)
      assert.equal(r.layout, 'rail', `${language}: bottom dock renders the action rail`)
      assert(Math.abs(r.rail.width - RAIL_WIDTH) <= 1, `${language}: rail is ${RAIL_WIDTH}px wide (${r.rail.width})`)
      assert(Math.abs(r.rail.right - r.editor.right) <= 1, `${language}: rail is at the right edge of the editor`)
      assert(r.rail.left >= r.inputs.right - 1, `${language}: rail is right of the text area`)
      assert(Math.abs(r.inputs.bottom - r.editor.bottom) <= 2, `${language}: no footer row below the text area (${JSON.stringify({ inputs: r.inputs, editor: r.editor })})`)
      assert.equal(r.colors.length, 3, `${language}: three color tags`)
      assert.deepEqual(r.buttons.map(button => button.action), ['add-to-history'], `${language}: one add button`)
      assertStackedAtBottom(r, language)
      const add = r.buttons[0]
      assert.equal(add.text, '', `${language}: add button shows an icon, not text`)
      assert(add.hasIcon, `${language}: add button has an SVG icon`)
      assert.equal(add.label, ADD_TO_HISTORY_LABEL[language], `${language}: accessible label`)
      assert.equal(add.title, ADD_TO_HISTORY_LABEL[language], `${language}: tooltip carries the label`)
      samples[language] = { rail: Math.round(r.rail.width), topGap: Math.round(r.colors[0].top - r.rail.top) }
    }
    await setLanguage(h, 'en')

    // Wiring: the icon button adds the draft to history.
    const content = `rail add check ${Date.now()}`
    await h.page.evaluate(text => window.__onwardPromptNotebookDebug.setEditorContent(text), content)
    await eventually('add button enabled', () => readRail(h), r => r.buttons[0] && !r.buttons[0].disabled)
    await h.page.locator(`${NOTEBOOK} [data-action="add-to-history"]`).click()
    const added = await eventually('prompt added from the rail', () => h.page.evaluate(text =>
      window.__onwardPromptNotebookDebug.getPrompts().find(prompt => prompt.content === text) ?? null, content), prompt => prompt !== null)

    // Editing an existing prompt swaps in cancel / save / save-as-new icons.
    const editingEditor = `${NOTEBOOK} .prompt-editor[data-prompt-editing="true"]`
    const enterEdit = async () => {
      await h.page.locator(`${NOTEBOOK} .prompt-list-item[data-prompt-id="${added.id}"]`).dblclick()
      await h.page.locator(editingEditor).waitFor({ state: 'visible' })
    }
    const exitEdit = async () => {
      await h.page.locator(`${NOTEBOOK} [data-action="cancel"]`).click()
      await h.page.locator(editingEditor).waitFor({ state: 'detached' })
    }
    await enterEdit()
    const editing = await readRail(h)
    assert.deepEqual(editing.buttons.map(button => button.action), ['cancel', 'save', 'save-as-new'])
    for (const button of editing.buttons) {
      assert.equal(button.text, '', `${button.action}: icon only`)
      assert(button.hasIcon && button.label, `${button.action}: icon and accessible label`)
      assert(button.title.startsWith(button.label), `${button.action}: tooltip starts with the label (${button.title})`)
    }
    assert.deepEqual(editing.buttons.map(button => button.label), ['Cancel', 'Save', 'Add'])
    assertStackedAtBottom(editing, 'editing')
    await exitEdit()

    // Shortest panel: the default group fits without scrolling; the editing group may
    // overflow, but every control stays reachable by scrolling the rail.
    const originalHeight = (await dims(h)).bottomHeight
    await dragResizer(h, TOP_RESIZER, 0, 2000)
    await eventually('panel at its minimum height', () => dims(h), d => d.bottomHeight === MIN_PANEL_HEIGHT)
    const shortIdle = await readRail(h)
    assert(shortIdle.scrollHeight <= shortIdle.clientHeight + 1, `Default rail fits a ${MIN_PANEL_HEIGHT}px panel (${shortIdle.scrollHeight} > ${shortIdle.clientHeight})`)
    assertStackedAtBottom(shortIdle, 'short panel')
    const shortReach = []
    for (let trial = 0; trial < TRIALS; trial++) {
      await enterEdit()
      const reachable = await railControlsReachable(h)
      assert(reachable.length === 6 && reachable.every(Boolean), `trial ${trial}: every editing control is reachable (${JSON.stringify(reachable)})`)
      shortReach.push((await readRail(h)).scrollHeight)
      await exitEdit()
    }
    await dragResizer(h, TOP_RESIZER, 0, -(originalHeight - MIN_PANEL_HEIGHT))
    await eventually('panel height restored', () => dims(h), d => d.bottomHeight === originalHeight)

    // Left dock is unchanged: a footer row below the inputs with a stretched text button.
    await setPosition(h, 'left')
    const left = await readRail(h)
    assert.equal(left.layout, 'row')
    assert(left.rail.top >= left.inputs.bottom - 1, 'Left dock: actions stay below the inputs')
    assert.equal(left.buttons[0].text, ADD_TO_HISTORY_LABEL.en, 'Left dock: the button keeps its text')
    assert(left.buttons[0].rect.width > left.editor.width / 2, 'Left dock keeps the stretched footer button')
    await setPosition(h, 'bottom')
    return { samples, shortReach, shortIdle: { scrollHeight: shortIdle.scrollHeight, clientHeight: shortIdle.clientHeight } }
  })

  await h.case('SP-UI07-bottom-columns-and-height-exceed-former-caps', async () => {
    await ensurePromptOpen(h)
    const before = await dims(h)
    const layout = await bottomLayout(h)
    const targetHistory = FORMER_HISTORY_CAP + 60
    const targetSender = FORMER_SENDER_CAP + 20
    const targetHeight = FORMER_HEIGHT_CAP + 100
    assert(layout.containerWidth - 10 - targetHistory - targetSender >= MIN_EDITOR_COLUMN_WIDTH, `Viewport wide enough for the target columns (${JSON.stringify(layout)})`)
    assert(layout.containerHeight - targetHeight >= MIN_TERMINAL_AREA_HEIGHT, `Viewport tall enough for the target height (${JSON.stringify(layout)})`)

    await dragResizer(h, LEFT_RESIZER, targetHistory - before.bottomHistoryWidth, 0)
    await dragResizer(h, RIGHT_RESIZER, -(targetSender - before.bottomSenderWidth), 0)
    await dragResizer(h, TOP_RESIZER, 0, -(targetHeight - before.bottomHeight))
    const after = await eventually('bottom dimensions above former caps', () => dims(h), d =>
      d.bottomHistoryWidth === targetHistory && d.bottomSenderWidth === targetSender && d.bottomHeight === targetHeight)
    const g = await readGeometry(h)
    assert.equal(Math.round(g.history.width), targetHistory)
    assert.equal(Math.round(g.sender.width), targetSender)
    assert.equal(Math.round(g.notebook.height), targetHeight)
    assert(g.editor.width >= MIN_EDITOR_COLUMN_WIDTH - 1, `Editor keeps its minimum (${g.editor.width})`)
    assert(g.terminal.height >= MIN_TERMINAL_AREA_HEIGHT - 1, `Task area keeps its minimum (${g.terminal.height})`)

    // Dragging the top edge far past the window stops at the Task-area minimum, not at 600.
    await dragResizer(h, TOP_RESIZER, 0, -2000)
    const ceiling = layout.containerHeight - MIN_TERMINAL_AREA_HEIGHT
    await eventually('height stops at the Task-area minimum', () => dims(h), d => d.bottomHeight === ceiling)
    await dragResizer(h, TOP_RESIZER, 0, ceiling - targetHeight)
    await eventually('height restored', () => dims(h), d => d.bottomHeight === targetHeight)
    return { before, after, ceiling }
  })

  await h.case('SP-UI08-small-window-compresses-display-without-rewriting-memory', async () => {
    await ensurePromptOpen(h)
    const stored = await dims(h)
    const cycles = []
    for (let trial = 0; trial < TRIALS; trial++) {
      await h.page.setViewportSize(SMALL_VIEWPORT)
      const small = await eventually(`trial ${trial}: compressed`, () => bottomLayout(h), l => l.widthCompressed && l.heightCompressed)
      const g = await readGeometry(h)
      assert(g.sender.right <= g.viewportWidth + 1, `trial ${trial}: sender stays fully visible (${JSON.stringify(g.sender)})`)
      assert(g.editor.width >= MIN_EDITOR_COLUMN_WIDTH - 1, `trial ${trial}: editor keeps its minimum (${g.editor.width})`)
      assert(g.terminal.height >= MIN_TERMINAL_AREA_HEIGHT - 1, `trial ${trial}: Task area keeps its minimum (${g.terminal.height})`)
      assert.deepEqual(await dims(h), stored, `trial ${trial}: stored dimensions are untouched while compressed`)

      await h.page.setViewportSize(VIEWPORT)
      const wide = await eventually(`trial ${trial}: restored`, () => bottomLayout(h), l => !l.widthCompressed && !l.heightCompressed)
      assert.equal(wide.historyWidth, stored.bottomHistoryWidth, `trial ${trial}: history width comes back`)
      assert.equal(wide.senderWidth, stored.bottomSenderWidth, `trial ${trial}: sender width comes back`)
      assert.equal(wide.height, stored.bottomHeight, `trial ${trial}: height comes back`)
      cycles.push({ history: small.historyWidth, sender: small.senderWidth, height: small.height })
    }
    assert.deepEqual(await dims(h), stored, 'No drift after repeated shrink/grow cycles')

    // Dragging while compressed adopts the visible widths as the new memory.
    await h.page.setViewportSize(NARROW_VIEWPORT)
    const compressed = await eventually('compressed before drag', () => bottomLayout(h), l => l.widthCompressed)
    await dragResizer(h, LEFT_RESIZER, -10, 0)
    const adopted = await eventually('visible widths adopted', () => dims(h), d =>
      d.bottomHistoryWidth === compressed.historyWidth - 10 && d.bottomSenderWidth === compressed.senderWidth)
    await h.page.setViewportSize(VIEWPORT)
    await eventually('adopted widths render after restore', () => bottomLayout(h), l =>
      !l.widthCompressed && l.historyWidth === adopted.bottomHistoryWidth && l.senderWidth === adopted.bottomSenderWidth)
    return { cycles, adopted }
  })

  await h.case('SP-UI09-bottom-attachments-stack-in-a-resizable-right-column', async () => {
    await ensurePromptOpen(h)
    const before = await readGeometry(h)
    assert.equal(before.strip, null, 'No attachment column without attachments')
    for (let i = 0; i < 3; i++) {
      await h.page.evaluate(() => window.__onwardPromptNotebookDebug.pasteClipboardIntoEditor({ autotestImage: { width: 640, height: 400 } }))
    }
    await eventually('three attachments', () => h.page.evaluate(() => window.__onwardPromptNotebookDebug.getEditorImages().length), n => n === 3)
    const g = await eventually('attachment column rendered', () => readGeometry(h), x => x.stripLayout === 'column' && x.cards.length === 3)
    assert(g.strip.left >= g.inputs.right - 1, `Column sits right of the text area (${JSON.stringify({ strip: g.strip, inputs: g.inputs })})`)
    assert(g.strip.right <= g.editor.right + 1, 'Column stays inside the editor')
    const railWithImages = await readRail(h)
    assert(railWithImages.rail.left >= g.strip.right - 1, `Action rail stays at the far right, after the attachment column (${JSON.stringify({ strip: g.strip, rail: railWithImages.rail })})`)
    assert(Math.abs(railWithImages.rail.right - g.editor.right) <= 1, 'Action rail is flush with the editor right edge')
    assert(Math.abs(g.inputs.height - before.inputs.height) <= 2, `Text area height is not reduced (${before.inputs.height} -> ${g.inputs.height})`)
    assert(g.inputs.width >= MIN_EDITOR_WIDTH - 1, `Text area keeps its minimum (${g.inputs.width})`)
    for (let i = 1; i < g.cards.length; i++) {
      assert(Math.abs(g.cards[i].left - g.cards[0].left) <= 1, `Card @${i + 1} is in the same column`)
      assert(g.cards[i].top >= g.cards[i - 1].bottom - 1, `Card @${i + 1} is below @${i}`)
    }

    const startWidth = (await dims(h)).bottomAttachmentWidth
    await dragResizer(h, ATTACHMENT_RESIZER, -80, 0)
    await eventually('attachment column widened', () => dims(h), d => d.bottomAttachmentWidth === startWidth + 80)
    const widened = await readGeometry(h)
    assert.equal(Math.round(widened.strip.width), startWidth + 80)
    assert(widened.inputs.width >= MIN_EDITOR_WIDTH - 1)
    // The column can grow only until the text area hits its minimum; the rail never shrinks.
    await dragResizerToX(h, ATTACHMENT_RESIZER, widened.editor.left + 10)
    await eventually('attachment column grew to its ceiling', () => dims(h), d => d.bottomAttachmentWidth > startWidth + 80)
    const maxed = await readRail(h)
    assert(maxed.inputs.width >= MIN_EDITOR_WIDTH - 1, `Text area keeps its minimum at the ceiling (${maxed.inputs.width})`)
    assert(Math.abs(maxed.rail.width - RAIL_WIDTH) <= 1, `Rail keeps ${RAIL_WIDTH}px at the ceiling (${maxed.rail.width})`)
    await dragResizerToX(h, ATTACHMENT_RESIZER, widened.editor.right - 10)
    await eventually('attachment column at its minimum', () => dims(h), d => d.bottomAttachmentWidth === 96)
    await dragResizer(h, ATTACHMENT_RESIZER, -(startWidth + 80 - 96), 0)
    await eventually('attachment column back to the widened width', () => dims(h), d => d.bottomAttachmentWidth === startWidth + 80)

    // Left dock keeps the attachment grid above the inputs; the remembered column width survives.
    await setPosition(h, 'left')
    const left = await readGeometry(h)
    assert.equal(left.stripLayout, 'grid')
    assert(left.strip.bottom <= left.inputs.top + 1, 'Left dock: attachments above the inputs')
    await setPosition(h, 'bottom')
    assert.equal((await dims(h)).bottomAttachmentWidth, startWidth + 80)

    for (let index = 3; index >= 1; index--) {
      await h.page.evaluate(i => window.__onwardPromptNotebookDebug.removeEditorImage(i), index)
    }
    await eventually('attachments cleared', () => readGeometry(h), x => x.strip === null)
    return { startWidth, widened: startWidth + 80 }
  })

  await h.case('SP-UI10-bottom-dimensions-survive-restart-with-trace-evidence', async () => {
    await ensurePromptOpen(h)
    const remembered = await dims(h)
    const pid = h.launches[h.launches.length - 1].pid
    await h.stop(true)
    const events = await readTraceEvents(pid)
    const commits = events.filter(event => event.name === 'renderer:prompt-panel.commit-bottom-resize')
    for (const target of ['height', 'history', 'sender', 'attachment']) {
      assert(commits.some(event => event.args?.target === target), `Resize commit recorded for ${target}`)
    }
    const compression = events.filter(event => event.name === 'renderer:prompt-panel.change-bottom-compression')
    assert(compression.some(event => event.args?.widthCompressed === true), 'Compression entry recorded')
    assert(compression.some(event => event.args?.widthCompressed === false), 'Compression exit recorded')

    await h.start()
    await ensurePromptOpen(h)
    await h.page.locator(`${NOTEBOOK}[data-dock-position="bottom"]`).waitFor({ state: 'visible' })
    const restored = await eventually('dimensions restored after restart', () => dims(h), d =>
      d.bottomHistoryWidth === remembered.bottomHistoryWidth && d.bottomSenderWidth === remembered.bottomSenderWidth
      && d.bottomHeight === remembered.bottomHeight && d.bottomAttachmentWidth === remembered.bottomAttachmentWidth)
    const layout = await eventually('restored layout renders uncompressed', () => bottomLayout(h), l => !l.widthCompressed && !l.heightCompressed)
    assert.equal(layout.historyWidth, remembered.bottomHistoryWidth)
    assert.equal(layout.senderWidth, remembered.bottomSenderWidth)
    assert.equal(layout.height, remembered.bottomHeight)
    return { remembered: restored, commits: commits.length, compression: compression.length }
  })
}
