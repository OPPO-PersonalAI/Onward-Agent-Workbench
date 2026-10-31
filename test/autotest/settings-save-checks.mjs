/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { saveSettingsPage } from './themes-ui-driver-support.mjs'

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
}
