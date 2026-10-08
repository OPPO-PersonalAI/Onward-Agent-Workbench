/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, isDeepStrictEqual } from 'node:util'
import { openSettingsPage } from './themes-ui-driver-support.mjs'

const exec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(ROOT, 'test/autotest/fixtures')
const TRIALS = 5
const LIGHT = 'light-modern'
const DARK = 'dark-modern'
// Vendored pdf.js RenderingStates.FINISHED; data-loaded is set at render START.
const PDF_RENDERING_FINISHED = 3

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

async function makeFixture(parent) {
  const repo = await mkdtemp(path.join(parent, 'theme-surfaces-'))
  try {
    const git = args => exec('git', args, { cwd: repo, timeout: 20000, windowsHide: true, env: {
      ...process.env, HOME: parent, USERPROFILE: parent, GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(parent, '.gitconfig')
    } })
    await git(['init', '--template='])
    await git(['config', 'core.autocrlf', 'false'])
    await git(['config', 'core.safecrlf', 'false'])
    const hooks = path.join(repo, '.empty-hooks')
    await mkdir(hooks)
    await git(['config', 'core.hooksPath', hooks])
    const local = path.join(FIXTURES, 'theme-surfaces')
    for (const name of ['preview.md', 'sample.ts', 'authored.html']) await cp(path.join(local, name), path.join(repo, name))
    await cp(path.join(FIXTURES, 'markdown-preview-dot.svg'), path.join(repo, 'original.svg'))
    await cp(path.join(FIXTURES, 'pdf-epub', 'onward-autotest.outlined.pdf'), path.join(repo, 'reader.pdf'))
    const copyBooks = async suffix => {
      for (const extension of ['pdf', 'epub']) {
        await cp(path.join(FIXTURES, 'pdf-epub', `onward-autotest${suffix}.${extension}`), path.join(repo, `book.${extension}`))
      }
    }
    const commit = async message => {
      await git(['add', '--', 'preview.md', 'sample.ts', 'authored.html', 'original.svg', 'reader.pdf', 'book.pdf', 'book.epub'])
      await git(['-c', 'user.name=Onward AutoTest', '-c', 'user.email=autotest@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', message])
    }
    await copyBooks('')
    await commit('Base theme surface fixtures')
    await copyBooks('.alt')
    await cp(path.join(local, 'sample-next.ts'), path.join(repo, 'sample.ts'))
    await commit('Changed theme surface fixtures')
    await copyBooks('')
    await cp(path.join(local, 'sample.ts'), path.join(repo, 'sample.ts'))
    return repo
  } catch (error) {
    await rm(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    throw error
  }
}

/**
 * Run against an already launched ONWARD_AUTOTEST=1 app in an isolated profile.
 * fixtureRoot: the caller-owned scratch workspace (OS temp or test/autotest/results).
 * capture: async (name: string, detail: object) => screenshotPath; must save under traces/.
 * onResult: optional async callback receiving each completed scenario immediately,
 * so earlier results survive a later assertion failure or runner deadline.
 * Returns [{ id, trials?, detail? }]; throws on any failed assertion. The caller owns
 * process lifecycle, deadline, result persistence and the final packaged-app smoke test.
 * Example: await testThemeSurfaces(h.page, h.workspace, name => h.screenshot(name)).
 */
export async function testThemeSurfaces(page, fixtureRoot, capture, onResult = async () => {}) {
  assert.equal(typeof capture, 'function', 'A traces/-scoped Playwright screenshot callback is required')
  assert.equal(typeof onResult, 'function', 'The optional result callback must be a function')
  const parent = await realpath(fixtureRoot)
  const temporary = await realpath(tmpdir())
  assert(inside(temporary, parent) || inside(path.join(ROOT, 'test/autotest/results'), parent), 'Use an isolated scratch workspace, never the checkout or user data')
  const initial = await page.evaluate(() => {
    const value = window.__onwardThemeDebug?.getState()
    if (!value || value.draft) throw new Error('Theme debug API must be ready with no active draft')
    return { settings: value.settings.theme ?? value.settings, systemDark: value.systemDark, terminalId: window.__onwardTerminalDebug?.getVisibleTerminalIds()[0] }
  })
  await openSettingsPage(page, 'general')
  const initialLocale = await page.getByTestId('settings-language-select').inputValue()
  await openSettingsPage(page, 'appearance')
  assert(initial.terminalId, 'A visible terminal is required')
  const results = []
  const record = async result => {
    results.push(result)
    await onResult(result)
  }
  let repo
  let scenarioError
  const settled = () => page.waitForFunction(() => document.querySelector('[data-testid="themes-root"]')?.getAttribute('aria-busy') === 'false')

  const settings = async () => {
    await openSettingsPage(page, 'appearance')
    await settled()
  }
  const language = async locale => {
    await openSettingsPage(page, 'general')
    await page.getByTestId('settings-language-select').selectOption(locale)
    await settings()
  }
  const select = async id => {
    await settings()
    if ([DARK, LIGHT, 'dracula', 'nord', 'one-dark-pro', 'solarized-light'].includes(id)) {
      await page.getByTestId(`theme-card-${id}`).click()
    } else {
      await page.getByTestId('theme-more').selectOption(id)
    }
    await page.waitForFunction(id => {
      const value = window.__onwardThemeDebug.getState()
      const settings = value.settings.theme ?? value.settings
      return document.documentElement.dataset.theme === id && settings.mode === 'manual' && settings.themeId === id
    }, id)
    await settled()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
  const editor = async name => {
    await page.evaluate(({ terminalId, repoRoot, filePath }) => {
      window.dispatchEvent(new CustomEvent('project-editor:open', { detail: { terminalId, repoRoot, filePath } }))
    }, { terminalId: initial.terminalId, repoRoot: repo, filePath: name })
    await page.waitForFunction(({ root, name }) => {
      const api = window.__onwardProjectEditorDebug
      const normalize = value => String(value ?? '').replaceAll('\\', '/').toLowerCase()
      return api?.isOpen() && normalize(api.getRootPath()) === normalize(root) &&
        normalize(api.getActiveFilePath()).split('/').pop() === name.toLowerCase()
    }, { root: repo, name }, { timeout: 30000 })
  }
  const navigate = async surface => {
    if (surface === 'diff') {
      // The editor fixture is a nested repository, not the terminal's startup cwd.
      // Use the existing explicit-root entry boundary so Git reads that fixture.
      await page.evaluate(({ terminalId, cwd }) => window.dispatchEvent(new CustomEvent('git-diff:open', {
        detail: { terminalId, cwd, source: 'debug' }
      })), { terminalId: initial.terminalId, cwd: repo })
    } else {
      await page.locator(`[data-subpage-button="${surface}"]:visible`).first().click()
    }
    await page.waitForFunction(surface => {
      const api = surface === 'diff' ? window.__onwardGitDiffDebug : window.__onwardGitHistoryDebug
      return api?.isOpen()
    }, surface, { timeout: 30000 })
    if (surface === 'history') await page.evaluate(root => window.__onwardGitHistoryDebug.switchRepo(root), repo)
    await page.waitForFunction(({ surface, root }) => {
      const actual = surface === 'diff' ? window.__onwardGitDiffDebug.getCwd() : window.__onwardGitHistoryDebug.getActiveCwd()
      const normalize = value => String(value ?? '').replaceAll('\\', '/').toLowerCase()
      return normalize(actual) === normalize(root)
    }, { surface, root: repo }, { timeout: 30000 })
  }
  const selectGitFile = async (surface, name) => {
    await page.waitForFunction(({ surface, name }) => {
      const api = surface === 'diff' ? window.__onwardGitDiffDebug : window.__onwardGitHistoryDebug
      return (surface === 'diff' ? api?.getFileList() : api?.getFiles())?.some(file => file.filename === name)
    }, { surface, name }, { timeout: 30000 })
    assert(await page.evaluate(({ surface, name }) => {
      const api = surface === 'diff' ? window.__onwardGitDiffDebug : window.__onwardGitHistoryDebug
      return api.selectFileByPath(name)
    }, { surface, name }), `Select real ${surface} fixture ${name}`)
  }
  const cycles = async (id, read, ready = async () => {}, equal = isDeepStrictEqual, drafts = false) => {
    await select(DARK)
    await ready()
    const baseline = await read()
    const trials = []
    for (let trial = 0; trial < TRIALS; trial++) {
      const states = []
      for (const theme of [LIGHT, DARK]) {
        await select(theme)
        await ready()
        states.push(await read())
        if (trial === 0) await capture(`${id}-${theme}`, { id, theme, baseline })
      }
      trials.push({ trial, ok: states.every(state => equal(state, baseline)), states })
    }
    assert(trials.every(trial => trial.ok), `${id}: all five theme round trips must preserve state: ${JSON.stringify({ baseline, trials })}`)
    await record({ id, trials: TRIALS })
    if (drafts) {
      await page.getByTestId('theme-customize').click()
      await page.waitForFunction(() => window.__onwardThemeDebug.getState().draft === true)
      const field = page.getByTestId('theme-override-onward.foreground')
      const checks = []
      try {
        for (let trial = 0; trial < TRIALS; trial++) {
          // Several real input events can overtake an in-flight Mermaid render.
          // Only the final palette is allowed to commit, with the same theme ID.
          for (const value of ['#f2d9b0', '#c1e5ef', '#f3e4ce']) await field.fill(value)
          await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim().toLowerCase() === '#f3e4ce')
          await ready()
          checks.push({ sameId: await page.evaluate(() => document.documentElement.dataset.theme === 'dark-modern'), preserved: equal(await read(), baseline) })
          await field.fill('')
          await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim().toLowerCase() !== '#f3e4ce')
          await ready()
          checks.push({ sameId: await page.evaluate(() => document.documentElement.dataset.theme === 'dark-modern'), preserved: equal(await read(), baseline) })
        }
        assert(checks.every(check => check.sameId && check.preserved), `${id}: same-ID draft update/reset preserves state in all five trials: ${JSON.stringify(checks)}`)
        await record({ id: `${id}-DRAFT`, trials: TRIALS })
      } finally {
        await page.getByTestId('theme-draft-cancel').click()
        await page.waitForFunction(() => window.__onwardThemeDebug.getState().draft === false)
        await ready()
      }
    }
  }

  try {
    repo = await makeFixture(parent)
    await select(DARK)
    await editor('sample.ts')
    await page.waitForFunction(() => window.__onwardProjectEditorDebug.getEditorLineCount() > 10)
    assert(await page.evaluate(() => window.__onwardProjectEditorDebug.setCursorPosition(12, 4)))
    await cycles('TH-SURF-EDITOR', () => page.evaluate(() => ({
      content: window.__onwardProjectEditorDebug.getEditorContent(),
      cursor: window.__onwardProjectEditorDebug.getCursorPosition()
    })))

    await editor('preview.md')
    await page.evaluate(() => {
      window.__onwardProjectEditorDebug.setMarkdownPreviewOpen(true)
      window.__onwardProjectEditorDebug.setMarkdownEditorVisible(false)
    })
    const mermaidReady = async () => page.waitForFunction(() => {
      const api = window.__onwardProjectEditorDebug
      const state = api.getMermaidPreviewState()
      return state.total === 2 && state.rendered === 2 && state.pending === 0 && !state.inFlight &&
        !api.isMarkdownRenderPending() && !api.isPreviewTransitioning() && api.isPreviewContentVisible() &&
        api.getMermaidPanZoomState().every(item => item.enhanced && item.scale > 0)
    }, null, { timeout: 30000 })
    await mermaidReady()
    // Enhancement schedules the first fit via ResizeObserver/rAF. Let that
    // initialization finish before installing the user's non-default transform.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // Set deterministic panzoom state through the existing test boundary, avoiding
    // smooth-zoom animation being mistaken for a theme-induced state mutation.
    await page.evaluate(() => {
      const api = window.__onwardProjectEditorDebug
      for (const item of api.getMermaidPanZoomState()) {
        api.triggerMermaidPanZoomAction(item.id, 'reset')
        api.triggerMermaidPanZoomAction(item.id, 'zoomIn')
        // Zoom is anchored around the viewport. Pan back to a readable,
        // deterministic origin instead of retaining that anchor's translation.
        const zoomed = api.getMermaidPanZoomState().find(current => current.id === item.id)
        api.simulateMermaidPan(item.id, 23 - zoomed.x, 17 - zoomed.y)
      }
      api.scrollPreviewToFraction(0.65)
    })
    await page.waitForFunction(() => window.__onwardProjectEditorDebug.getMermaidPanZoomState().every(item => item.scale > 1))
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.evaluate(() => {
      const preview = document.querySelector('.project-editor-preview-body')
      window.__themeSurfaceNodes = { preview, svgs: [...preview.querySelectorAll('.mermaid-pz-content > svg')] }
    })
    await cycles('TH-SURF-MARKDOWN-MERMAID', () => page.evaluate(() => {
      const api = window.__onwardProjectEditorDebug
      const preview = document.querySelector('.project-editor-preview-body')
      return {
        content: api.getMarkdownRenderedHtml(), scroll: api.getPreviewScrollTop(),
        transforms: api.getMermaidPanZoomState().map(({ id, x, y, scale }) => ({ id, x, y, scale })),
        nodesPreserved: preview === window.__themeSurfaceNodes.preview && window.__themeSurfaceNodes.svgs.length === 2 && preview.querySelectorAll('.mermaid-pz-content > svg').length === 2 && [...preview.querySelectorAll('.mermaid-pz-content > svg')].every((svg, index) => svg === window.__themeSurfaceNodes.svgs[index])
      }
    }), async () => {
      await mermaidReady()
      await assertMermaidPalette(page)
      await assertContrast(page, '.project-editor-preview-body :is(p, .hljs-comment, .hljs-keyword, .hljs-string, .hljs-number)')
    }, (actual, expected) => actual.nodesPreserved && actual.content === expected.content &&
      Math.abs(actual.scroll - expected.scroll) <= 1 && isDeepStrictEqual(actual.transforms, expected.transforms), true)
    const idleTrials = []
    for (let trial = 0; trial < TRIALS; trial++) {
      idleTrials.push(await page.locator('.project-editor-preview-body').evaluate(preview => new Promise(resolve => {
        let redraws = 0
        const observer = new MutationObserver(records => {
          redraws += records.filter(record => record.target.closest?.('.mermaid-pz-content') && record.type === 'childList').length
        })
        observer.observe(preview, { childList: true, subtree: true })
        window.setTimeout(() => { observer.disconnect(); resolve(redraws) }, 250)
      })))
    }
    assert(idleTrials.every(count => count === 0), `No idle diagram re-render loop: ${JSON.stringify(idleTrials)}`)
    await record({ id: 'TH-SURF-MERMAID-IDLE', trials: TRIALS })

    // Fullscreen blocks the Settings panel by design. Real System-mode controls
    // plus Playwright media emulation exercise an OS appearance change in place.
    await page.getByTestId('theme-mode').selectOption('system')
    await settled()
    await page.getByTestId('theme-pair-dark').selectOption(DARK)
    await settled()
    await page.getByTestId('theme-pair-light').selectOption(LIGHT)
    await settled()
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.documentElement.dataset.themeKind === 'dark')
    await mermaidReady()
    await page.locator('.mermaid-diagram').first().hover()
    await page.locator('.mermaid-diagram .mermaid-toolbar-btn').first().scrollIntoViewIfNeeded()
    await page.locator('.mermaid-diagram').first().locator('.mermaid-toolbar-btn').last().click()
    const full = page.locator('.mermaid-fullscreen-overlay')
    await full.waitFor({ state: 'visible' })
    await full.locator('.mermaid-pz-content > svg').evaluate(svg => { window.__themeSurfaceFullscreen = svg })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const fullscreenTransform = await full.locator('.mermaid-pz-content').evaluate(node => node.style.transform)
    const fullscreenTrials = []
    for (let trial = 0; trial < TRIALS; trial++) {
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.waitForFunction(scheme => document.documentElement.dataset.themeKind === scheme, scheme)
        await mermaidReady()
        await assertMermaidPalette(page)
        fullscreenTrials.push(await full.locator('.mermaid-pz-content > svg').evaluate((svg, transform) =>
          svg === window.__themeSurfaceFullscreen && svg.textContent.includes('Readable input') && svg.parentElement.style.transform === transform, fullscreenTransform))
      }
    }
    assert(fullscreenTrials.every(Boolean), 'Fullscreen diagram node and content survive all five OS appearance cycles')
    await capture('TH-SURF-MERMAID-FULLSCREEN', { trials: TRIALS })
    await full.locator('.mermaid-toolbar-btn').last().click()
    await record({ id: 'TH-SURF-MERMAID-FULLSCREEN', trials: TRIALS })

    await editor('reader.pdf')
    await checkPdf('TH-SURF-PDF-READER', '.project-editor-pdf-reader-iframe:visible')

    await editor('book.epub')
    await page.waitForFunction(() => window.__onwardProjectEditorDebug.getEpubReaderState()?.stateReady, null, { timeout: 30000 })
    await page.locator('.project-editor-epub-fontsize button').last().click()
    await page.waitForFunction(() => {
      const state = window.__onwardProjectEditorDebug.getEpubReaderState()
      // The label updates before the serialized font/navigation task applies it.
      return state.stateReady && state.fontSizeLabel === '110%' && state.appliedFontPct === 110
    })
    const readEpub = () => page.evaluate(() => {
      const state = window.__onwardProjectEditorDebug.getEpubReaderState()
      const frame = document.querySelector('.project-editor-epub-content iframe')
      return {
        session: state.sessionId, cfi: state.currentLocationCfi, href: state.currentLocationHref,
        font: state.bodyFontSizePx, zoom: state.fontSizeLabel, scroll: state.scrollTop,
        stylesheets: frame.contentDocument.querySelectorAll('#epubjs-inserted-css-onward-theme').length,
        text: frame.contentDocument.body.textContent
      }
    })
    const epubReady = async () => {
      await page.waitForFunction(() => {
        const iframe = document.querySelector('.project-editor-epub-content iframe')
        const body = iframe?.contentDocument?.body
        if (!body) return false
        const probe = document.createElement('span')
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--text-1')
        document.body.appendChild(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return window.__onwardProjectEditorDebug.getEpubReaderState()?.stateReady &&
          iframe.contentDocument.querySelectorAll('#epubjs-inserted-css-onward-theme').length === 1 &&
          iframe.contentWindow.getComputedStyle(body).color === expected
      })
      await assertContrast(page, '.project-editor-epub-toolbar :is(button, input)')
    }
    await cycles('TH-SURF-EPUB-READER', readEpub, epubReady, isDeepStrictEqual, true)
    const chapterTrials = []
    for (let trial = 0; trial < TRIALS; trial++) {
      const before = await readEpub()
      await select(LIGHT)
      await page.locator('.project-editor-epub-toolbar > button').nth(1).click()
      await page.waitForFunction(href => {
        const state = window.__onwardProjectEditorDebug.getEpubReaderState()
        return state.stateReady && state.currentLocationHref !== href
      }, before.href)
      await epubReady()
      const next = await readEpub()
      await select(DARK)
      await page.locator('.project-editor-epub-toolbar > button').first().click()
      await page.waitForFunction(href => {
        const state = window.__onwardProjectEditorDebug.getEpubReaderState()
        return state.stateReady && state.currentLocationHref === href
      }, before.href)
      await epubReady()
      chapterTrials.push(next.session === before.session && next.zoom === before.zoom && next.stylesheets === 1)
    }
    assert(chapterTrials.every(Boolean), 'Every newly displayed EPUB chapter receives exactly one current theme stylesheet')
    await record({ id: 'TH-SURF-EPUB-CHAPTER', trials: TRIALS })

    await editor('authored.html')
    await page.waitForFunction(() => window.__onwardProjectEditorDebug.getHtmlReaderState()?.ready, null, { timeout: 30000 })
    const authored = async () => {
      const result = await page.evaluate(() => window.__onwardProjectEditorDebug.evaluateHtmlPreviewForTest(`(() => ({
        color: getComputedStyle(document.body).color, background: getComputedStyle(document.body).backgroundColor,
        content: document.body.textContent, filter: getComputedStyle(document.body).filter
      }))()`))
      assert.equal(result?.success, true, 'Read the real authored HTML iframe through its existing debug boundary')
      assert(result.value.content.includes('THEME_SURFACES_AUTHORED_CONTENT'))
      assert.equal(result.value.color, 'rgb(23, 50, 77)')
      assert.equal(result.value.background, 'rgb(255, 244, 214)')
      assert.equal(result.value.filter, 'none')
      return result.value
    }
    await cycles('TH-SURF-AUTHORED-HTML', authored)

    await editor('original.svg')
    const image = page.locator('.project-editor-image-preview img:visible')
    await image.waitFor()
    await page.waitForFunction(() => {
      const image = document.querySelector('.project-editor-image-preview img')
      return image?.complete && image.naturalWidth > 0
    })
    await cycles('TH-SURF-AUTHORED-IMAGE', () => image.evaluate(image => ({
      src: image.src, width: image.naturalWidth, height: image.naturalHeight,
      filters: [image, image.parentElement].map(node => getComputedStyle(node).filter)
    })))

    await editor('sample.ts')
    await navigate('diff')
    await selectGitFile('diff', 'sample.ts')
    await page.waitForFunction(() => window.__onwardGitDiffDebug.getSelectedEditorModelContent()?.modifiedMatchesState === true)
    await cycles('TH-SURF-DIFF-CODE', () => page.evaluate(() => ({
      file: window.__onwardGitDiffDebug.getSelectedFile(),
      model: window.__onwardGitDiffDebug.getSelectedEditorModelContent()
    })))
    await selectGitFile('diff', 'book.pdf')
    await checkPdf('TH-SURF-DIFF-PDF', '.git-diff-modal .git-pdf-compare-frame:visible')
    await selectGitFile('diff', 'book.epub')
    await checkEpubCompare('TH-SURF-DIFF-EPUB')

    await navigate('history')
    await page.waitForFunction(() => window.__onwardGitHistoryDebug?.getCommitCount() >= 2, null, { timeout: 30000 })
    assert(await page.evaluate(() => window.__onwardGitHistoryDebug.selectCommitByIndex(0)))
    await selectGitFile('history', 'sample.ts')
    await page.waitForFunction(() => !window.__onwardGitHistoryDebug.isLoading() && window.__onwardGitHistoryDebug.getSelectedFileContent()?.modifiedContent?.includes('updated-reading-state'))
    await cycles('TH-SURF-HISTORY-CODE', () => page.evaluate(() => ({
      shas: window.__onwardGitHistoryDebug.getSelectedShas(),
      file: window.__onwardGitHistoryDebug.getSelectedFile(),
      content: window.__onwardGitHistoryDebug.getSelectedFileContent()
    })))
    await selectGitFile('history', 'book.pdf')
    await checkPdf('TH-SURF-HISTORY-PDF', '.git-history-modal .git-pdf-compare-frame:visible')
    await selectGitFile('history', 'book.epub')
    await checkEpubCompare('TH-SURF-HISTORY-EPUB')
    return results
  } catch (error) {
    scenarioError = error
    await capture('TH-SURF-FAILURE', { error: String(error), results }).catch(() => {})
    throw error
  } finally {
    const cleanupErrors = []
    try {
      // Retaining/hiding a subpage does not tear down its body-level fullscreen
      // overlay. Close it first so it cannot intercept Settings cleanup clicks.
      const fullscreen = page.locator('.mermaid-fullscreen-overlay')
      if (await fullscreen.isVisible()) await fullscreen.locator('.mermaid-toolbar-btn').last().click()
      await page.evaluate(() => {
        window.__onwardTerminalDebug?.closeAllSubpages()
        delete window.__themeSurfaceNodes
        delete window.__themeSurfaceFullscreen
      })
      await settings()
      if (await page.getByTestId('theme-draft-cancel').isVisible()) await page.getByTestId('theme-draft-cancel').click()
      await language(initialLocale)
      await page.getByTestId('theme-mode').selectOption('system')
      await settled()
      await page.getByTestId('theme-pair-dark').selectOption(initial.settings.darkThemeId)
      await settled()
      await page.getByTestId('theme-pair-light').selectOption(initial.settings.lightThemeId)
      await settled()
      await page.emulateMedia({ colorScheme: initial.systemDark ? 'dark' : 'light' })
      // Changing mode writes themeId=activeId. Restore the stored manual ID
      // AFTER the system pair, then optionally re-enter System mode from that ID.
      await select(initial.settings.themeId)
      if (initial.settings.mode === 'system') await page.getByTestId('theme-mode').selectOption('system')
      await settled()
      const restored = await page.evaluate(() => {
        const value = window.__onwardThemeDebug.getState()
        return value.settings.theme ?? value.settings
      })
      assert.deepEqual(restored, initial.settings, 'Restore the complete original theme settings, including the inactive manual ID')
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      if (repo) await rm(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length) {
      if (scenarioError) {
        // Preserve the original failing assertion in the caller's persisted log.
        scenarioError.stack += `\nSurface cleanup also failed:\n${cleanupErrors.map(error => error.stack ?? String(error)).join('\n')}`
      } else {
        throw new AggregateError(cleanupErrors, 'Surface helper cleanup failed')
      }
    }
  }

  async function checkPdf(id, selector) {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 30000 })
    if (id.includes('READER')) await page.waitForFunction(() => window.__onwardProjectEditorDebug.getPdfReaderState()?.stateReady)
    const locators = await page.locator(selector).all()
    assert.equal(locators.length, id.includes('READER') ? 1 : 2, `${id}: real PDF panes`)
    const frames = []
    let expectedEnhancement = true
    for (const frameLocator of locators) {
      const frame = await (await frameLocator.elementHandle()).contentFrame()
      frames.push(frame)
      // viewer.js is a classic script, so its lexical pdfViewer is available in
      // this frame's main world. Use the real model's finished-render contract.
      await frame.waitForFunction(finished => typeof pdfViewer !== 'undefined' && pdfViewer.pagesCount > 0 &&
        pdfViewer.getPageView(pdfViewer.currentPageNumber - 1)?.renderingState === finished &&
        pdfViewer.getPageView(pdfViewer.currentPageNumber - 1)?.div.querySelector('canvas')?.width > 0,
      PDF_RENDERING_FINISHED, { timeout: 30000 })
      assert.equal(await frame.locator('#viewer').evaluate(node => node.classList.contains('dark-invert')), false, `${id}: original PDF colors by default`)
      await frame.locator('#zoomSelect').selectOption('0.75')
      const count = await frame.locator('#pageCountLabel').evaluate(node => Number(node.textContent.replace(/\D/g, '')))
      const target = Math.min(2, count)
      await frame.locator('#pageNumberInput').fill(String(target))
      await frame.locator('#pageNumberInput').press('Tab')
      await frame.waitForFunction(({ target, finished }) => pdfViewer.currentPageNumber === target &&
        pdfViewer.currentScale === 0.75 && pdfViewer.getPageView(target - 1)?.renderingState === finished &&
        pdfViewer.getPageView(target - 1)?.div.querySelector('canvas')?.width > 0 &&
        document.querySelector('#pageNumberInput').value === String(target), { target, finished: PDF_RENDERING_FINISHED })
      await frame.locator('#colorToggleBtn').click()
      await frame.evaluate(() => { window.__themeSurfacePdfDocument = document })
    }
    const ready = async () => {
      const expected = await page.evaluate(() => ({
        text: getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim(),
        background: getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim(),
        kind: document.documentElement.dataset.themeKind
      }))
      for (const frame of frames) {
        await frame.waitForFunction(expected => {
          const style = getComputedStyle(document.documentElement)
          return style.getPropertyValue('--onward-pdf-text').trim() === expected.text &&
            style.getPropertyValue('--onward-pdf-bg').trim() === expected.background &&
            document.documentElement.style.colorScheme === expected.kind
        }, expected)
        await assertContrast(frame, '#toolbar :is(button, input, select, #pageCountLabel)')
        assert.equal(await frame.locator('#viewer').evaluate(node => node.classList.contains('dark-invert')), expectedEnhancement, `${id}: theme never changes the explicit PDF enhancement preference`)
        assert(await frame.evaluate(() => window.__themeSurfacePdfDocument === document), `${id}: PDF document stays mounted`)
      }
    }
    const read = () => Promise.all(frames.map(frame => frame.evaluate(() => ({
      sameDocument: window.__themeSurfacePdfDocument === document, src: location.href,
      page: document.querySelector('#pageNumberInput').value, zoom: document.querySelector('#zoomSelect').value,
      model: readReadingState(),
      enhancement: document.querySelector('#viewer').classList.contains('dark-invert'),
      scroll: document.querySelector('#viewerContainer').scrollTop
    }))))
    await cycles(id, read, ready, isDeepStrictEqual, true)
    // Repeat the independence check with enhancement explicitly OFF as well.
    for (const frame of frames) await frame.locator('#colorToggleBtn').click()
    expectedEnhancement = false
    await cycles(`${id}-ORIGINAL`, read, ready)
    const languageBaseline = await read()
    for (let trial = 0; trial < TRIALS; trial++) {
      for (const locale of ['zh-CN', 'en']) {
        await language(locale)
        for (const frame of frames) {
          await frame.waitForFunction(locale => {
            const values = [
              document.querySelector('#colorToggleBtn').textContent.trim(),
              document.querySelector('#colorToggleBtn').title,
              document.querySelector('#searchInput').placeholder,
              document.querySelector('#prevPageBtn').title
            ]
            return values.every(value => value && (locale === 'zh-CN' ? /\p{Script=Han}/u.test(value) : !/\p{Script=Han}/u.test(value)))
          }, locale)
          assert.equal(await frame.locator('#colorToggleBtn').getAttribute('aria-pressed'), 'true', 'Original-color mode remains selected')
          const overflow = await frame.locator('#toolbar').evaluate(node => node.scrollWidth - node.clientWidth)
          assert(overflow <= 1, `${id}: ${locale} toolbar fits its real pane (${overflow}px overflow)`)
        }
        assert.deepEqual(await read(), languageBaseline, `${id}: ${locale} translation preserves the PDF document and reading state`)
        if (trial === 0 && locale === 'zh-CN') await capture(`${id}-ZH`, { locale })
      }
    }
    await record({ id: `${id}-I18N`, trials: TRIALS })
    for (const frame of frames) await frame.evaluate(() => { delete window.__themeSurfacePdfDocument })
  }

  async function checkEpubCompare(id) {
    const compare = page.locator('.git-epub-compare:visible')
    await compare.locator('.git-epub-compare-chapter-item').first().waitFor({ state: 'visible', timeout: 30000 })
    const changed = compare.locator('.git-epub-compare-chapter-item.git-epub-compare-chapter-modified').first()
    await changed.click()
    await compare.locator('.git-epub-compare-line-add').first().waitFor()
    await cycles(id, () => compare.evaluate(node => ({
      selected: node.querySelector('.git-epub-compare-chapter-item.active')?.textContent,
      panes: [...node.querySelectorAll('.git-epub-compare-pane-body')].map(pane => ({ text: pane.textContent, scroll: pane.scrollTop }))
    })), () => assertContrast(page, '.git-epub-compare :is(.git-epub-compare-line-add, .git-epub-compare-line-del, .git-epub-compare-chapter-item.active)'))
  }
}

async function assertMermaidPalette(page) {
  await page.waitForFunction(() => {
    const expected = getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim()
    const diagrams = [...document.querySelectorAll('.project-editor-preview-body .mermaid-diagram')]
    return diagrams.length === 2 && diagrams.every(node => {
      try { return JSON.parse(node.dataset.mermaidTheme).themeVariables.primaryTextColor === expected } catch { return false }
    })
  })
  const checks = await page.locator('.project-editor-preview-body .mermaid-pz-content > svg, .mermaid-fullscreen-overlay .mermaid-pz-content > svg').evaluateAll(svgs => {
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const resolved = name => {
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name)
      return getComputedStyle(probe).color
    }
    const text = resolved('--text-1')
    const background = resolved('--bg-2')
    probe.remove()
    return svgs.map(svg => {
      const label = svg.querySelector('.nodeLabel')
      const message = svg.querySelector('.messageText')
      const ink = (label ?? message)?.getBoundingClientRect()
      const viewport = svg.closest('.mermaid-pz-viewport')?.getBoundingClientRect()
      return {
        labels: label ? getComputedStyle(label).color === text : Boolean(message && getComputedStyle(message).fill === text),
        layout: svg.style.maxWidth === 'none' && Number(svg.getAttribute('width')) > 0 && Number(svg.getAttribute('height')) > 0,
        background: !svg.style.backgroundColor || getComputedStyle(svg).backgroundColor === background,
        contentInViewport: Boolean(ink && viewport && ink.width > 0 && ink.height > 0 &&
          ink.right > viewport.left && ink.left < viewport.right && ink.bottom > viewport.top && ink.top < viewport.bottom),
        geometry: { ink: ink?.toJSON(), viewport: viewport?.toJSON(), transform: svg.parentElement.style.transform }
      }
    })
  })
  assert(checks.length >= 2 && checks.every(check => check.labels && check.layout && check.background && check.contentInViewport), `Mermaid SVG and fullscreen palette/layout: ${JSON.stringify(checks)}`)
}

async function assertContrast(scope, selector) {
  const samples = await scope.locator(selector).evaluateAll(nodes => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = value => {
      if (value === 'none') return [0, 0, 0, 0]
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v)
    }
    const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1)
    const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0)
    return nodes.filter(node => node.getClientRects().length && !node.matches(':disabled') && getComputedStyle(node).visibility !== 'hidden').map(node => {
      const ancestors = []
      for (let current = node; current; current = current.parentElement) ancestors.push(current)
      let background = [255, 255, 255, 1]
      for (const ancestor of ancestors.reverse()) {
        background = over(rgba(getComputedStyle(ancestor).backgroundColor), background)
        // Mermaid's foreignObject labels sit over a sibling SVG shape. Its fill
        // is the painted backdrop, although it is not a CSS ancestor background.
        if (ancestor.matches('g.node')) {
          const shape = ancestor.querySelector(':scope > .label-container')
          if (shape) {
            const style = getComputedStyle(shape)
            const fill = rgba(style.fill)
            fill[3] *= Number(style.fillOpacity) * Number(style.opacity)
            background = over(fill, background)
          }
        }
      }
      // Empty search fields paint ::placeholder, not the input's normal color.
      const placeholder = node.matches('input:placeholder-shown, textarea:placeholder-shown')
      const style = getComputedStyle(node, placeholder ? '::placeholder' : null)
      const ink = rgba(style.color)
      if (placeholder) ink[3] *= Number(style.opacity)
      const foreground = over(ink, background)
      const a = luminance(foreground)
      const b = luminance(background)
      return { text: (node.textContent || node.value || node.placeholder || node.tagName).trim().slice(0, 60), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
    })
  })
  assert(samples.length > 0, `Contrast check must reach real visible content: ${selector}`)
  assert(samples.every(sample => sample.ratio >= 4.5), `Text contrast below 4.5:1 (${selector}): ${JSON.stringify(samples.filter(sample => sample.ratio < 4.5))}`)
}
