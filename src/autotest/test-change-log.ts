/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, ChangeLogDebugApi, TestResult } from './types'
import { LAST_SEEN_RELEASE_TAG_STORAGE_KEY } from '../utils/changelog-upgrade'

const EXPECTED_EN_SNIPPET = 'Autotest fixture feature appears in the change log.'
const EXPECTED_ZH_SNIPPET = '\u81ea\u52a8\u5316\u6d4b\u8bd5\u7279\u6027\u51fa\u73b0\u5728\u52a8\u6001\u66f4\u65b0\u753b\u62a5\u4e2d\u3002'
const EXPECTED_TAG = 'v9.9.9-daily.20990101.1'
const LEGACY_TAG = 'v9.9.1-daily.20980101.1'

function queryChangeLogButton(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="sidebar-change-log-button"]') as HTMLButtonElement | null
}

export async function testChangeLog(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardChangeLogDebug as ChangeLogDebugApi | undefined
  const runMode = window.electronAPI?.debug?.autotestFixtureExtra || 'fresh-install'

  const openChangeLog = async () => {
    if (getApi()?.isOpen()) return true
    const button = queryChangeLogButton()
    if (!button) return false
    button.click()
    return await waitFor('change-log-open', () => Boolean(getApi()?.isOpen()), 4000, 50)
  }

  const waitUntilLoaded = async () => {
    return await waitFor('change-log-loaded', () => {
      const api = getApi()
      return Boolean(api?.isOpen() && !api.isLoading() && api.getRenderedText().length > 0)
    }, 5000, 50)
  }

  const closeChangeLog = async (label: string, closeAction: () => boolean) => {
    if (!getApi()?.isOpen()) return true
    const triggered = closeAction()
    if (!triggered) return false
    return await waitFor(label, () => !getApi()?.isOpen(), 4000, 50)
  }

  log(`change-log:start mode=${runMode}`)

  if (runMode === 'upgrade-first-launch') {
    const debugApiReady = await waitFor('change-log-debug-api', () => Boolean(getApi()), 4000, 50)
    record('CL-UPG-00-debug-api-available', debugApiReady, { available: Boolean(getApi()) })
    if (!debugApiReady || cancelled()) return results

    const autoOpenedAndLoaded = await waitUntilLoaded()
    record('CL-UPG-01-auto-opens-on-upgrade', autoOpenedAndLoaded, {
      isOpen: getApi()?.isOpen() ?? false,
      isLoading: getApi()?.isLoading() ?? true
    })
    if (!autoOpenedAndLoaded || cancelled()) return results

    const api = getApi()!
    const text = api.getRenderedText()
    const modalLocale = document.querySelector('.change-log-modal')?.getAttribute('data-locale')
    const stageCount = document.querySelectorAll('.change-log-markdown .rn-stage, .change-log-markdown svg').length
    record(
      'CL-UPG-02-renders-latest-showcase-release',
      stageCount > 0 &&
        api.getCurrentTag() === EXPECTED_TAG &&
        text.includes(EXPECTED_ZH_SNIPPET),
      {
        stageCount,
        currentTag: api.getCurrentTag(),
        modalLocale,
        textSample: text.slice(0, 140)
      }
    )
    record(
      'CL-UPG-02b-auto-follows-zh-cn-language-setting',
      modalLocale === 'zh-CN' &&
        text.includes(EXPECTED_ZH_SNIPPET) &&
        !text.includes(EXPECTED_EN_SNIPPET),
      {
        modalLocale,
        hasZh: text.includes(EXPECTED_ZH_SNIPPET),
        hasEn: text.includes(EXPECTED_EN_SNIPPET)
      }
    )

    const storedTagAfterUpgrade = window.localStorage.getItem(LAST_SEEN_RELEASE_TAG_STORAGE_KEY)
    record(
      'CL-UPG-03-persists-latest-seen-tag',
      storedTagAfterUpgrade === EXPECTED_TAG,
      { storedTagAfterUpgrade }
    )
    return results
  }

  if (runMode === 'upgrade-second-launch') {
    const debugApiReady = await waitFor('change-log-debug-api', () => Boolean(getApi()), 4000, 50)
    record('CL-UPG-04a-debug-api-available', debugApiReady, { available: Boolean(getApi()) })
    if (!debugApiReady || cancelled()) return results

    await sleep(450)
    const storedTag = window.localStorage.getItem(LAST_SEEN_RELEASE_TAG_STORAGE_KEY)
    const stayedClosed = (getApi()?.isOpen() ?? false) === false && storedTag === EXPECTED_TAG
    record('CL-UPG-04-relaunch-does-not-reopen', stayedClosed, {
      isOpen: getApi()?.isOpen() ?? false,
      storedTag
    })
    return results
  }

  try {
    const debugApiReady = await waitFor('change-log-debug-api', () => Boolean(getApi()), 4000, 50)
    record('CL-00-debug-api-available', debugApiReady, {
      available: Boolean(getApi())
    })

    const seededFreshTag = await waitFor(
      'fresh-install-tag-seeded',
      () => window.localStorage.getItem(LAST_SEEN_RELEASE_TAG_STORAGE_KEY) === EXPECTED_TAG,
      4000,
      50
    )
    await sleep(250)
    record(
      'CL-00b-fresh-install-does-not-auto-open',
      seededFreshTag && (getApi()?.isOpen() ?? false) === false,
      {
        isOpen: getApi()?.isOpen() ?? false,
        storedTag: window.localStorage.getItem(LAST_SEEN_RELEASE_TAG_STORAGE_KEY)
      }
    )

    const button = queryChangeLogButton()
    record('CL-01-sidebar-button-visible', Boolean(button), {
      found: Boolean(button)
    })
    if (!button || cancelled()) {
      return results
    }

    const englishPayload = await window.electronAPI.changelog.getCurrent('en')
    record(
      'CL-02-prefetched-entry-exposes-showcase-html',
      englishPayload.success === true &&
        (englishPayload.html?.includes(EXPECTED_EN_SNIPPET) ?? false) &&
        (englishPayload.html?.includes(EXPECTED_ZH_SNIPPET) ?? false),
      {
        success: englishPayload.success,
        tag: englishPayload.tag,
        hasHtml: Boolean(englishPayload.html)
      }
    )
    if (cancelled()) {
      return results
    }

    const zhPayload = await window.electronAPI.changelog.getCurrent('zh-CN')
    record(
      'CL-03-zh-cn-request-exposes-bilingual-showcase',
      zhPayload.success === true &&
        zhPayload.locale === 'zh-CN' &&
        Boolean(zhPayload.html?.includes(EXPECTED_ZH_SNIPPET)),
      {
        success: zhPayload.success,
        locale: zhPayload.locale,
        tag: zhPayload.tag,
        hasHtml: Boolean(zhPayload.html)
      }
    )
    if (cancelled()) {
      return results
    }

    const opened = await openChangeLog()
    record('CL-04-open-from-sidebar', opened, {
      open: getApi()?.isOpen() ?? false
    })
    if (!opened || cancelled()) {
      return results
    }

    const loaded = await waitUntilLoaded()
    const api = getApi()
    const unavailableState = api?.getUnavailableState()
    const initialRenderedText = api?.getRenderedText() || ''
    const modalLocale = document.querySelector('.change-log-modal')?.getAttribute('data-locale')
    const stageCount = document.querySelectorAll('.change-log-markdown .rn-stage').length
    const svgCount = document.querySelectorAll('.change-log-markdown svg').length

    record(
      'CL-05-renders-animated-stages-and-svg',
      loaded &&
        unavailableState?.visible !== true &&
        stageCount >= 2 &&
        svgCount >= 2,
      {
        isLoading: api?.isLoading() ?? true,
        stageCount,
        svgCount,
        currentTag: api?.getCurrentTag() ?? null
      }
    )
    record(
      'CL-06-auto-follows-en-language-setting',
      modalLocale === 'en' &&
        initialRenderedText.includes(EXPECTED_EN_SNIPPET) &&
        !initialRenderedText.includes(EXPECTED_ZH_SNIPPET),
      {
        modalLocale,
        hasEn: initialRenderedText.includes(EXPECTED_EN_SNIPPET),
        hasZh: initialRenderedText.includes(EXPECTED_ZH_SNIPPET)
      }
    )

    if (cancelled()) {
      return results
    }

    const closedByButton = await closeChangeLog('change-log-close-button', () => getApi()?.clickCloseButton() ?? false)
    record('CL-07-close-button-closes-modal', closedByButton, {
      openAfterClose: getApi()?.isOpen() ?? false
    })
    if (cancelled()) {
      return results
    }

    const reopenedForOverlay = await openChangeLog()
    record('CL-08-reopen-after-close', reopenedForOverlay, {
      open: getApi()?.isOpen() ?? false
    })
    let overlayKeptOpen = false
    if (reopenedForOverlay) {
      const overlayClicked = getApi()?.clickOverlay() ?? false
      if (overlayClicked) {
        await sleep(300)
        overlayKeptOpen = getApi()?.isOpen() ?? false
      }
    }
    record('CL-09-overlay-click-keeps-modal-open', overlayKeptOpen, {
      openAfterOverlayClick: getApi()?.isOpen() ?? false
    })
    if (cancelled()) {
      return results
    }

    const closedAfterOverlay = await closeChangeLog('change-log-close-after-overlay', () => getApi()?.clickCloseButton() ?? false)
    record('CL-09b-close-button-still-works-after-overlay-click', closedAfterOverlay, {
      openAfterClose: getApi()?.isOpen() ?? false
    })
    if (cancelled()) {
      return results
    }

    let escapeReopenPasses = 0
    let escapeClosePasses = 0
    const escapeTrials = 5
    for (let i = 0; i < escapeTrials; i++) {
      if (cancelled()) break
      const reopened = await openChangeLog() && await waitUntilLoaded()
      if (!reopened) break
      escapeReopenPasses += 1
      const closed = await closeChangeLog(`change-log-close-escape-${i + 1}`, () => getApi()?.pressEscape() ?? false)
      if (closed) escapeClosePasses += 1
    }
    record('CL-10-reopen-for-escape', escapeReopenPasses === escapeTrials, {
      escapeReopenPasses,
      escapeTrials
    })
    record('CL-11-escape-closes-modal', escapeClosePasses === escapeTrials, {
      escapeClosePasses,
      escapeTrials,
      openAfterClose: getApi()?.isOpen() ?? false
    })

    // Seed older release tag in localStorage so the next launch on this userData dir
    // tests real multi-version upgrade auto-open (v9.9.1 -> v9.9.9)
    window.localStorage.setItem(LAST_SEEN_RELEASE_TAG_STORAGE_KEY, LEGACY_TAG)
  } finally {
    if (getApi()?.isOpen()) {
      await closeChangeLog('change-log-cleanup-close', () => getApi()?.clickCloseButton() ?? false).catch(() => {})
    }
  }

  return results
}
