/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, SettingsDebugApi, TestResult } from './types'

function querySettingsToggleButton(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="sidebar-settings-button"]') as HTMLButtonElement | null
}

function querySettingsSelect(testId: string): HTMLSelectElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLSelectElement | null
}

function querySettingsUpdateProgress(): HTMLElement | null {
  return document.querySelector('[data-testid="settings-update-progress"]') as HTMLElement | null
}

export async function testSettingsUpdate(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const getApi = () => window.__onwardSettingsDebug as SettingsDebugApi | undefined
  const getState = () => getApi()?.getUpdaterState()

  const openSettings = async () => {
    if (getApi()?.isOpen()) {
      return true
    }

    const button = querySettingsToggleButton()
    if (!button) {
      return false
    }

    button.click()
    return await waitFor(
      'settings-update-open-settings',
      () => Boolean(getApi()?.isOpen()),
      4000,
      50
    )
  }

  const closeSettings = async () => {
    if (!getApi()) {
      return true
    }

    const button = querySettingsToggleButton()
    if (!button) {
      return false
    }

    button.click()
    return await waitFor(
      'settings-update-close-settings',
      () => !window.__onwardSettingsDebug,
      4000,
      50
    )
  }

  const applyMockStatus = async (
    patch: Parameters<SettingsDebugApi['setMockUpdaterStatus']>[0],
    waitLabel: string
  ) => {
    const api = getApi()
    if (!api) return false
    const applied = api.setMockUpdaterStatus(patch)
    if (!applied) return false
    return await waitFor(waitLabel, () => getState()?.phase === patch.phase, 1200, 40)
  }

  log('settings-update:start')

  try {
    const opened = await openSettings()
    record('SU-00-open-settings', opened, {
      buttonFound: Boolean(querySettingsToggleButton())
    })
    if (!opened || cancelled()) {
      return results
    }

    const api = getApi()
    record('SU-00-debug-api-available', Boolean(api), {
      available: Boolean(api)
    })
    if (!api || cancelled()) {
      return results
    }

    const trackedSelects = [
      {
        testId: 'settings-language-select',
        label: 'language'
      },
      {
        testId: 'settings-terminal-font-select',
        label: 'terminal-font'
      },
      {
        testId: 'settings-terminal-select',
        label: 'terminal'
      }
    ]

    const selectStyleSummary = trackedSelects.map(({ testId, label }) => {
      const select = querySettingsSelect(testId)
      const shell = select?.closest('.onward-select-shell') as HTMLElement | null
      const style = select ? window.getComputedStyle(select) : null
      return {
        label,
        exists: Boolean(select),
        shellWrapped: Boolean(shell),
        sharedSelectClass: select?.classList.contains('onward-select') ?? false,
        appearance: style?.appearance ?? null,
        paddingRight: style?.paddingRight ?? null
      }
    })
    const selectsUseInsetArrow = selectStyleSummary.every(item => {
      if (!item.exists || !item.shellWrapped || !item.paddingRight) return false
      return item.sharedSelectClass && item.appearance === 'none' && Number.parseFloat(item.paddingRight) >= 30
    })
    record('SU-00b-settings-selects-use-inset-arrow-spacing', selectsUseInsetArrow, {
      selects: selectStyleSummary
    })
    if (cancelled()) return results

    api.resetMockUpdater()
    await sleep(60)

    const unsupportedReady = await applyMockStatus({
      phase: 'unsupported',
      supported: false,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: null,
      error: null,
      bannerDismissed: false
    }, 'settings-update-unsupported')
    const unsupportedState = getState()
    record('SU-01-unsupported-disables-action', unsupportedReady && unsupportedState?.actionDisabled === true, unsupportedState ?? undefined)
    if (cancelled()) return results

    const idleReady = await applyMockStatus({
      phase: 'idle',
      supported: true,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: null,
      error: null,
      bannerDismissed: false
    }, 'settings-update-idle')
    const idleState = getState()
    const idleActionLabel = idleState?.actionLabel ?? ''
    record('SU-02-idle-shows-check-action', idleReady && !idleState?.actionDisabled && idleActionLabel.length > 0, idleState ?? undefined)
    if (!idleReady || cancelled()) {
      return results
    }

    api.setMockNextCheckResult({
      phase: 'up-to-date',
      supported: true,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: Date.now(),
      error: null,
      bannerDismissed: false
    }, 220)

    const clickIdleAction = await api.clickUpdateAction()
    const enteredChecking = await waitFor(
      'settings-update-enter-checking',
      () => getState()?.phase === 'checking',
      1200,
      40
    )
    const checkingState = getState()
    record('SU-03-check-action-enters-checking', clickIdleAction && enteredChecking && checkingState?.actionDisabled === true, checkingState ?? undefined)

    const repeatWhileChecking = await api.clickUpdateAction()
    const checkingCounts = getState()?.actionCounts
    record('SU-04-checking-blocks-repeat-clicks', repeatWhileChecking === false && checkingCounts?.checkNow === 1, {
      repeatWhileChecking,
      actionCounts: checkingCounts
    })
    if (cancelled()) return results

    const upToDateReady = await waitFor(
      'settings-update-up-to-date',
      () => getState()?.phase === 'up-to-date',
      3200,
      40
    )
    const upToDateState = getState()
    record('SU-05-up-to-date-shows-last-checked', upToDateReady && Boolean(upToDateState?.lastCheckedAt) && Boolean(upToDateState?.detailText), upToDateState ?? undefined)
    if (cancelled()) return results

    const errorReady = await applyMockStatus({
      phase: 'error',
      supported: true,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: Date.now(),
      error: 'Manifest request failed: 503',
      bannerDismissed: false
    }, 'settings-update-error')
    const errorState = getState()
    record('SU-06-error-shows-detail', errorReady && !errorState?.actionDisabled && Boolean(errorState?.detailText?.includes('503')), errorState ?? undefined)
    if (cancelled()) return results

    const zhOfflineSnippet = String.fromCharCode(26080, 32593, 32476, 36830, 25509)
    const localizedErrorReady = await applyMockStatus({
      phase: 'error',
      supported: true,
      targetVersion: null,
      targetTag: null,
      downloadedFileName: null,
      lastCheckedAt: Date.now(),
      error: 'raw-offline-sentinel',
      errorCode: 'offline',
      bannerDismissed: false
    }, 'settings-update-localized-error')
    const localizedErrorDetailReady = await waitFor(
      'settings-update-localized-error-detail',
      () => {
        const detail = getState()?.detailText ?? ''
        return (detail.includes('No network connection') || detail.includes(zhOfflineSnippet)) &&
          !detail.includes('raw-offline-sentinel')
      },
      1200,
      40
    )
    const localizedErrorState = getState()
    const localizedErrorDetail = localizedErrorState?.detailText ?? ''
    record('SU-06b-error-code-uses-localized-detail', localizedErrorReady &&
      localizedErrorDetailReady &&
      (localizedErrorDetail.includes('No network connection') || localizedErrorDetail.includes(zhOfflineSnippet)) &&
      !localizedErrorDetail.includes('raw-offline-sentinel'), localizedErrorState ?? undefined)
    if (cancelled()) return results

    const targetVersion = `2.0.2-daily.${Date.now()}`
    const targetTag = `v${targetVersion}`

    const downloadingReady = await applyMockStatus({
      phase: 'downloading',
      supported: true,
      targetVersion,
      targetTag,
      downloadedFileName: 'Onward 2.zip',
      lastCheckedAt: Date.now(),
      error: null,
      bannerDismissed: false
    }, 'settings-update-downloading')
    const downloadingState = getState()
    record('SU-07-downloading-disables-action-and-shows-target-version', downloadingReady &&
      downloadingState?.actionDisabled === true &&
      downloadingState.detailText?.includes(targetVersion) === true &&
      downloadingState.actionLabel !== idleActionLabel, downloadingState ?? undefined)

    const downloadingProgressReady = await applyMockStatus({
      phase: 'downloading',
      supported: true,
      targetVersion,
      targetTag,
      downloadedFileName: 'Onward 2.zip',
      lastCheckedAt: Date.now(),
      error: null,
      downloadProgress: {
        downloadedBytes: 512 * 1024,
        totalBytes: 1024 * 1024,
        percent: 50,
        bytesPerSecond: 128 * 1024
      },
      bannerDismissed: false
    }, 'settings-update-downloading-progress')
    const progressDetailReady = await waitFor(
      'settings-update-downloading-progress-detail',
      () => {
        const detail = getState()?.detailText ?? ''
        return Boolean(querySettingsUpdateProgress()) && detail.includes('512.0 KB')
      },
      1200,
      40
    )
    const downloadingProgressState = getState()
    const progressEl = querySettingsUpdateProgress()
    const downloadingProgressDetail = downloadingProgressState?.detailText ?? ''
    record('SU-07c-downloading-shows-progress-detail', downloadingProgressReady &&
      progressDetailReady &&
      Boolean(progressEl) &&
      downloadingProgressDetail.includes('512.0 KB') &&
      progressEl?.textContent?.includes('50%') === true, {
        ...(downloadingProgressState ?? {}),
        progressText: progressEl?.textContent ?? null
      })

    const repeatWhileDownloading = await api.clickUpdateAction()
    record('SU-07b-downloading-blocks-repeat-clicks', repeatWhileDownloading === false && getState()?.actionCounts.checkNow === 1, {
      repeatWhileDownloading,
      actionCounts: getState()?.actionCounts
    })
    if (cancelled()) return results

    const downloadedReady = await applyMockStatus({
      phase: 'downloaded',
      supported: true,
      targetVersion,
      targetTag,
      downloadedFileName: 'Onward 2.zip',
      lastCheckedAt: Date.now(),
      error: null,
      bannerDismissed: false
    }, 'settings-update-downloaded')
    const downloadedState = getState()
    const downloadedActionLabel = downloadedState?.actionLabel ?? ''
    record('SU-08-downloaded-shows-restart-action', downloadedReady &&
      downloadedState?.actionDisabled === false &&
      downloadedState.detailText?.includes(targetVersion) === true &&
      downloadedActionLabel.length > 0 &&
      downloadedActionLabel !== idleActionLabel, downloadedState ?? undefined)
    if (!downloadedReady || cancelled()) {
      return results
    }

    api.setMockRestartResult({
      success: false,
      error: 'Mock install denied',
      delayMs: 240
    })

    const clickedRestart = await api.clickUpdateAction()
    const restartPending = await waitFor(
      'settings-update-restart-pending',
      () => getState()?.actionDisabled === true,
      1000,
      40
    )
    const restartingState = getState()
    record('SU-09-restart-locks-while-pending', clickedRestart &&
      restartPending &&
      restartingState?.actionLabel !== downloadedActionLabel, restartingState ?? undefined)

    const restartFinished = await waitFor(
      'settings-update-restart-finished',
      () => getState()?.actionDisabled === false && getState()?.actionCounts.restartToUpdate === 1,
      3200,
      40
    )
    const restartErrorState = getState()
    record('SU-10-restart-error-visible', restartFinished &&
      restartErrorState?.detailText?.includes('Mock install denied') === true, restartErrorState ?? undefined)
  } finally {
    getApi()?.resetMockUpdater()
    await closeSettings().catch(() => {})
  }

  return results
}
