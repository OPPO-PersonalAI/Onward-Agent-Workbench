/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { eventually, saveSettingsPage } from './themes-ui-driver-support.mjs'

const TRIALS = 5
const live = h => h.page.evaluate(() => window.electronAPI.settings.load())
async function navigate(h, page) {
  const compact = h.page.getByTestId('settings-page-select')
  if (await compact.isVisible()) await compact.selectOption(page)
  else await h.page.getByTestId(`settings-tab-${page}`).click()
}

export async function settingsSaveChecks(h) {
  await h.case('SP-UI01-general-save-discard-and-three-leave-decisions', async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      await h.openSettings('general')
      const before = await live(h)
      const language = before.language === 'en' ? 'zh-CN' : 'en'
      await h.page.getByTestId('settings-language-select').selectOption(language)
      assert.equal((await live(h)).language, before.language)
      await navigate(h, 'fonts')
      await h.page.getByTestId('settings-leave-keep').click()
      assert.equal(await h.page.getByTestId('settings-language-select').inputValue(), language)
      await navigate(h, 'fonts')
      await h.page.getByTestId('settings-leave-discard').click()
      await h.openSettings('fonts')
      assert.equal((await live(h)).language, before.language)
      await h.openSettings('general')
      await h.page.getByTestId('settings-language-select').selectOption(language)
      await navigate(h, 'fonts')
      await h.page.getByTestId('settings-leave-save').click()
      await h.openSettings('fonts')
      assert.equal((await live(h)).language, language)
    }
    return { trials: TRIALS }
  })
  await h.case('SP-UI02-failed-save-and-leave-retains-draft-and-retries', async () => {
    await h.openSettings('general')
    const before = await live(h)
    const language = before.language === 'en' ? 'zh-CN' : 'en'
    await h.page.getByTestId('settings-language-select').selectOption(language)
    const filename = path.join(h.userData, 'settings.json')
    const backup = path.join(h.userData, 'settings-save-backup.json')
    await rename(filename, backup)
    try {
      await mkdir(filename)
      await navigate(h, 'appearance')
      await h.page.getByTestId('settings-leave-save').click()
      await h.page.locator('[data-testid="settings-save-status"][data-state="error"]').waitFor()
      assert.equal(await h.page.locator('.settings-content').getAttribute('data-settings-page'), 'general')
      assert.equal(await h.page.getByTestId('settings-language-select').inputValue(), language)
      assert.equal((await live(h)).language, before.language)
    } finally {
      await rm(filename, { recursive: true, force: true })
      await rename(backup, filename)
    }
    await saveSettingsPage(h.page)
    assert.equal((await live(h)).language, language)
  })
  await h.case('SP-UI03-fonts-keep-all-task-drafts-and-commit-whole-page', async () => {
    await h.openSettings('fonts')
    const before = await live(h)
    const selector = h.page.getByTestId('settings-terminal-select')
    const ids = await selector.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
    assert(ids.length >= 2)
    const size = h.page.locator('[data-settings-target="terminal-font-size"] input[type="number"]')
    for (let trial = 0; trial < TRIALS; trial++) {
      for (const [index, id] of ids.slice(0, 2).entries()) {
        await selector.selectOption(id)
        await size.fill(String(22 + index))
      }
      await selector.selectOption(ids[0])
      assert.equal(await size.inputValue(), '22')
      assert.equal(await h.page.getByTestId('settings-leave-dialog').count(), 0)
      assert.deepEqual((await live(h)).terminalStyles, before.terminalStyles)
    }
    await saveSettingsPage(h.page)
    const after = await live(h)
    assert.equal(after.terminalStyles[ids[0]].fontSize, 22)
    assert.equal(after.terminalStyles[ids[1]].fontSize, 23)
    assert.deepEqual(after.shortcuts, before.shortcuts)
  })
  await h.case('SP-UI04-close-escape-shortcut-save-and-bilingual-footer', async () => {
    for (const language of ['en', 'zh-CN']) {
      await h.openSettings('general')
      await h.page.getByTestId('settings-language-select').selectOption(language)
      await saveSettingsPage(h.page)
      for (const width of [300, 400, 600]) {
        await h.page.evaluate(width => window.__onwardSettingsDebug.setPanelWidth(width), width)
        const geometry = await h.page.getByTestId('settings-save-footer').evaluate(root => {
          const bounds = root.getBoundingClientRect()
          return [...root.querySelectorAll('button')].every(button => {
            const box = button.getBoundingClientRect()
            return box.left >= bounds.left && box.right <= bounds.right && button.scrollWidth <= button.clientWidth
          })
        })
        assert(geometry, `${language} footer at ${width}px`)
      }
      const originalViewport = await h.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      try {
        for (const width of [400, 800, 1280]) {
          await h.page.setViewportSize({ width, height: 800 })
          await h.page.getByTestId('settings-language-select').selectOption(language === 'en' ? 'zh-CN' : 'en')
          await h.page.locator('.settings-close-btn').click()
          const dialog = h.page.getByTestId('settings-leave-dialog')
          await dialog.waitFor({ state: 'visible' })
          const geometry = await dialog.evaluate(root => {
            const box = root.getBoundingClientRect()
            return {
              centerX: Math.abs(box.left + box.width / 2 - innerWidth / 2),
              centerY: Math.abs(box.top + box.height / 2 - innerHeight / 2),
              insideViewport: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
              buttonsFit: [...root.querySelectorAll('button')].every(button => {
                const bounds = button.getBoundingClientRect()
                return bounds.left >= box.left && bounds.right <= box.right && bounds.top >= box.top && bounds.bottom <= box.bottom && button.scrollWidth <= button.clientWidth
              })
            }
          })
          assert(geometry.centerX <= 1 && geometry.centerY <= 1, `${language} dialog centered at ${width}px: ${JSON.stringify(geometry)}`)
          assert(geometry.insideViewport && geometry.buttonsFit, `${language} dialog and actions fit at ${width}px`)
          await h.screenshot(`settings-leave-${language}-${width}`)
          await h.page.getByTestId('settings-leave-keep').click()
          await h.page.getByTestId('settings-discard').click()
        }
      } finally {
        await h.page.setViewportSize(originalViewport)
      }
    }
    for (let trial = 0; trial < TRIALS; trial++) {
      const input = h.page.getByTestId('settings-language-select')
      await input.selectOption(trial % 2 ? 'zh-CN' : 'en')
      await h.page.locator('.settings-close-btn').click()
      await h.page.getByTestId('settings-leave-keep').click()
      await input.focus()
      await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
      await h.page.locator('[data-testid="settings-save-status"][data-state="clean"]').waitFor()
      assert.equal((await live(h)).language, trial % 2 ? 'zh-CN' : 'en')
    }
    await h.page.getByTestId('settings-language-select').selectOption('zh-CN')
    await h.page.getByTestId('settings-language-select').press('Escape')
    await h.page.getByTestId('settings-leave-discard').click()
    await h.page.locator('.settings-container').waitFor({ state: 'detached' })
    await h.openSettings('about')
    assert.equal(await h.page.getByTestId('settings-save-footer').count(), 0)
  })
  await h.case('SP-UI05-prompt-panel-position-layout-resizing-and-dimension-memory', async () => {
    await h.openSettings('general')
    await h.page.getByTestId('settings-language-select').selectOption('en')
    await saveSettingsPage(h.page)

    // 1. Verify Settings search locates Prompt Panel Position and highlights the section
    const searchInput = h.page.getByTestId('settings-search')
    await searchInput.fill('Prompt Panel')
    const searchHit = h.page.getByTestId('settings-search-promptPanelPosition')
    await searchHit.waitFor({ state: 'visible' })
    await searchHit.click()
    await h.page.locator('[data-settings-target="promptPanelPosition"]').waitFor({ state: 'visible' })

    // 2. Verify Segmented Control radio semantics, draft dirty state, and Discard
    const leftBtn = h.page.getByTestId('settings-prompt-position-left')
    const bottomBtn = h.page.getByTestId('settings-prompt-position-bottom')
    const rightBtn = h.page.getByTestId('settings-prompt-position-right')
    assert.equal(await leftBtn.getAttribute('aria-checked'), 'true')
    assert.equal(await bottomBtn.getAttribute('aria-checked'), 'false')
    assert.equal(await rightBtn.getAttribute('aria-checked'), 'false')

    await bottomBtn.click()
    assert.equal(await bottomBtn.getAttribute('aria-checked'), 'true')
    assert.equal((await live(h)).promptPanelPosition ?? 'left', 'left', 'Uncommitted draft must not mutate live setting')
    await h.page.getByTestId('settings-discard').click()
    assert.equal(await leftBtn.getAttribute('aria-checked'), 'true')

    // Helper to ensure PromptNotebook is open and Settings is closed
    const ensurePromptOpen = async () => {
      if (await h.page.locator('.settings-container').isVisible()) {
        await h.page.locator('.settings-close-btn').click()
        await h.page.locator('.settings-container').waitFor({ state: 'detached' })
      }
      const visibleNotebook = h.page.locator('.prompt-notebook:not(.prompt-notebook-hidden)')
      if (!await visibleNotebook.isVisible()) {
        await h.page.getByTestId('sidebar-prompt-button').click()
        await visibleNotebook.waitFor({ state: 'visible' })
      }
    }

    // Helper to perform a real mouse drag on a resizer element
    const dragResizer = async (selector, dx, dy) => {
      const box = await h.page.locator(selector).boundingBox()
      assert(box, `Resizer bounding box not found: ${selector}`)
      const startX = Math.round(box.x + box.width / 2)
      const startY = Math.round(box.y + box.height / 2)
      await h.page.mouse.move(startX, startY)
      await h.page.mouse.down()
      await h.page.mouse.move(startX + dx, startY + dy, { steps: 4 })
      await h.page.mouse.up()
    }

    // 3. Verify LEFT mode geometry & outer resizer drag (+60px -> 380px)
    await ensurePromptOpen()
    const leftGeomBefore = await h.page.evaluate(() => {
      const main = document.querySelector('main.main-content')
      const nb = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden)')
      const term = document.querySelector('.terminal-area')
      const nbRect = nb.getBoundingClientRect()
      const termRect = term.getBoundingClientRect()
      return {
        mainPos: main.getAttribute('data-prompt-position'),
        flexDir: getComputedStyle(main).flexDirection,
        dockPos: nb.getAttribute('data-dock-position'),
        nbRight: nbRect.right,
        termLeft: termRect.left,
        nbWidth: Math.round(nbRect.width)
      }
    })
    assert.equal(leftGeomBefore.mainPos, 'left')
    assert.equal(leftGeomBefore.flexDir, 'row')
    assert.equal(leftGeomBefore.dockPos, 'left')
    assert(leftGeomBefore.nbRight <= leftGeomBefore.termLeft + 2, `Left mode: notebook should be left of terminal (${JSON.stringify(leftGeomBefore)})`)
    await dragResizer('.prompt-notebook:not(.prompt-notebook-hidden) > [data-testid="prompt-notebook-resizer"]', 60, 0)
    const leftDimsAfter = await eventually(
      'left outer resize',
      () => h.page.evaluate(() => window.__onwardPromptNotebookDebug.getPanelDimensions()),
      dims => dims?.width === leftGeomBefore.nbWidth + 60
    )

    // 4. Switch to RIGHT mode in Settings -> Save -> verify Settings left-fixed invariant while open, then close & verify RIGHT geometry + drag
    await h.openSettings('general')
    await h.page.getByTestId('settings-prompt-position-right').click()
    await saveSettingsPage(h.page)
    assert.equal((await live(h)).promptPanelPosition, 'right')

    // While Settings is still open, main-content MUST remain left-fixed row!
    const whileSettingsOpenRight = await h.page.evaluate(() => {
      const main = document.querySelector('main.main-content')
      const settingsEl = document.querySelector('.settings-container')
      const term = document.querySelector('.terminal-area')
      return {
        mainPos: main.getAttribute('data-prompt-position'),
        flexDir: getComputedStyle(main).flexDirection,
        settingsRight: settingsEl.getBoundingClientRect().right,
        termLeft: term.getBoundingClientRect().left,
        visibleNotebooks: document.querySelectorAll('.prompt-notebook:not(.prompt-notebook-hidden)').length
      }
    })
    assert.equal(whileSettingsOpenRight.mainPos, 'left', 'Settings open must force effectivePosition=left')
    assert.equal(whileSettingsOpenRight.flexDir, 'row')
    assert(whileSettingsOpenRight.settingsRight <= whileSettingsOpenRight.termLeft + 2, 'Settings must remain on the left of terminal-area')
    assert.equal(whileSettingsOpenRight.visibleNotebooks, 0, 'PromptNotebook must be hidden while Settings is open')

    await ensurePromptOpen()
    const rightGeomBefore = await h.page.evaluate(() => {
      const main = document.querySelector('main.main-content')
      const nb = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden)')
      const term = document.querySelector('.terminal-area')
      const nbRect = nb.getBoundingClientRect()
      const termRect = term.getBoundingClientRect()
      return {
        mainPos: main.getAttribute('data-prompt-position'),
        flexDir: getComputedStyle(main).flexDirection,
        dockPos: nb.getAttribute('data-dock-position'),
        termRight: termRect.right,
        nbLeft: nbRect.left,
        nbWidth: Math.round(nbRect.width),
        dims: window.__onwardPromptNotebookDebug.getPanelDimensions()
      }
    })
    assert.equal(rightGeomBefore.mainPos, 'right')
    assert.equal(rightGeomBefore.flexDir, 'row')
    assert.equal(rightGeomBefore.dockPos, 'right')
    assert(rightGeomBefore.termRight <= rightGeomBefore.nbLeft + 2, `Right mode: notebook should be right of terminal (${JSON.stringify(rightGeomBefore)})`)
    assert.equal(rightGeomBefore.dims.width, leftDimsAfter.width, 'Switching to right mode must preserve left width')
    // Drag left edge of right-docked panel by -50px (widens rightWidth by +50px)
    await dragResizer('.prompt-notebook:not(.prompt-notebook-hidden) > [data-testid="prompt-notebook-resizer"]', -50, 0)
    const rightDimsAfter = await eventually(
      'right outer resize',
      () => h.page.evaluate(() => window.__onwardPromptNotebookDebug.getPanelDimensions()),
      dims => dims?.rightWidth === rightGeomBefore.nbWidth + 50
    )
    assert.equal(rightDimsAfter.width, leftDimsAfter.width, 'Right drag must not alter left width')

    // 5. Switch to BOTTOM mode in Settings -> Save -> close Settings -> verify 3-column layout & all 3 bottom resizers
    await h.openSettings('general')
    await h.page.getByTestId('settings-prompt-position-bottom').click()
    await saveSettingsPage(h.page)
    assert.equal((await live(h)).promptPanelPosition, 'bottom')

    // Verify Settings left-fixed invariant when promptPanelPosition === 'bottom'
    const whileSettingsOpenBottom = await h.page.evaluate(() => ({
      mainPos: document.querySelector('main.main-content').getAttribute('data-prompt-position'),
      flexDir: getComputedStyle(document.querySelector('main.main-content')).flexDirection
    }))
    assert.equal(whileSettingsOpenBottom.mainPos, 'left')
    assert.equal(whileSettingsOpenBottom.flexDir, 'row')

    await ensurePromptOpen()
    const bottomGeomBefore = await h.page.evaluate(() => {
      const main = document.querySelector('main.main-content')
      const nb = document.querySelector('.prompt-notebook:not(.prompt-notebook-hidden)')
      const term = document.querySelector('.terminal-area')
      const hist = nb.querySelector('[data-testid="prompt-notebook-history-pane"]')
      const editor = nb.querySelector('.prompt-editor')
      const sender = nb.querySelector('[data-testid="prompt-notebook-sender-pane"]')
      const editorResizer = nb.querySelector('.prompt-editor-resizer')
      const nbRect = nb.getBoundingClientRect()
      const termRect = term.getBoundingClientRect()
      const histRect = hist.getBoundingClientRect()
      const editorRect = editor.getBoundingClientRect()
      const senderRect = sender.getBoundingClientRect()
      return {
        mainPos: main.getAttribute('data-prompt-position'),
        mainFlexDir: getComputedStyle(main).flexDirection,
        dockPos: nb.getAttribute('data-dock-position'),
        nbFlexDir: getComputedStyle(nb).flexDirection,
        termBottom: termRect.bottom,
        nbTop: nbRect.top,
        nbHeight: Math.round(nbRect.height),
        histRight: histRect.right,
        editorLeft: editorRect.left,
        editorRight: editorRect.right,
        senderLeft: senderRect.left,
        histWidth: Math.round(histRect.width),
        senderWidth: Math.round(senderRect.width),
        editorResizerDisplay: getComputedStyle(editorResizer).display,
        dims: window.__onwardPromptNotebookDebug.getPanelDimensions()
      }
    })
    assert.equal(bottomGeomBefore.mainPos, 'bottom')
    assert.equal(bottomGeomBefore.mainFlexDir, 'column')
    assert.equal(bottomGeomBefore.dockPos, 'bottom')
    assert.equal(bottomGeomBefore.nbFlexDir, 'row')
    assert(bottomGeomBefore.termBottom <= bottomGeomBefore.nbTop + 2, `Bottom mode: notebook should be below terminal (${JSON.stringify(bottomGeomBefore)})`)
    assert(bottomGeomBefore.histRight <= bottomGeomBefore.editorLeft + 8, `Bottom 3-col: history left of editor (${JSON.stringify(bottomGeomBefore)})`)
    assert(bottomGeomBefore.editorRight <= bottomGeomBefore.senderLeft + 8, `Bottom 3-col: editor left of sender (${JSON.stringify(bottomGeomBefore)})`)
    assert.equal(bottomGeomBefore.editorResizerDisplay, 'none', 'Vertical editor resizer must be hidden in bottom mode')

    // Drag outer top resizer up by -40px (increases bottomHeight by +40px)
    await dragResizer('.prompt-notebook:not(.prompt-notebook-hidden) > [data-testid="prompt-notebook-resizer"]', 0, -40)
    // Drag bottom left column resizer right by +35px (increases bottomHistoryWidth by +35px)
    await dragResizer('.prompt-notebook:not(.prompt-notebook-hidden) [data-testid="prompt-bottom-resizer-left"]', 35, 0)
    // Drag bottom right column resizer left by -30px (increases bottomSenderWidth by +30px)
    await dragResizer('.prompt-notebook:not(.prompt-notebook-hidden) [data-testid="prompt-bottom-resizer-right"]', -30, 0)

    const bottomDimsAfter = await eventually(
      'bottom outer and inner column resizes',
      () => h.page.evaluate(() => window.__onwardPromptNotebookDebug.getPanelDimensions()),
      dims =>
        dims?.bottomHeight === bottomGeomBefore.nbHeight + 40 &&
        dims?.bottomHistoryWidth === bottomGeomBefore.histWidth + 35 &&
        dims?.bottomSenderWidth === bottomGeomBefore.senderWidth + 30
    )
    assert.equal(bottomDimsAfter.width, leftDimsAfter.width, 'Bottom drags must not alter left width')
    assert.equal(bottomDimsAfter.rightWidth, rightDimsAfter.rightWidth, 'Bottom drags must not alter right width')

    // 6. Restore position to 'left' and verify all 5 dimensions remain intact
    await h.openSettings('general')
    await h.page.getByTestId('settings-prompt-position-left').click()
    await saveSettingsPage(h.page)
    assert.equal((await live(h)).promptPanelPosition, 'left')
    await ensurePromptOpen()
    const finalDims = await h.page.evaluate(() => window.__onwardPromptNotebookDebug.getPanelDimensions())
    assert.deepEqual(finalDims, bottomDimsAfter, 'All 5 independent panel dimensions must persist across position switches')
  })
}
