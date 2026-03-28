/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TerminalDebugApi, TestResult } from './types'

export async function testTerminalAutofollow(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const debugApi = () => window.__onwardTerminalDebug
  const platform = window.electronAPI.platform
  const separator = platform === 'win32' ? '\\' : '/'
  const fixturePath = `${rootPath}${separator}test${separator}fixtures${separator}terminal-autofollow-repro.mjs`

  const execCommand = async (command: string, label: string, waitMs = 300) => {
    await window.electronAPI.terminal.write(terminalId, `${command}\r`)
    await sleep(waitMs)
    log(`terminal-autofollow:exec:${label}`, { command })
  }

  const readViewport = (api: TerminalDebugApi) => api.getViewportState(terminalId)
  const readTail = (api: TerminalDebugApi, lastLines = 24) => api.getTailText(terminalId, lastLines) ?? ''
  const captureSamples = async (api: TerminalDebugApi, count: number, intervalMs: number) => {
    const samples: Array<ReturnType<TerminalDebugApi['getViewportState']>> = []
    for (let index = 0; index < count; index += 1) {
      await sleep(intervalMs)
      samples.push(api.getViewportState(terminalId))
    }
    return samples
  }

  const apiReady = await waitFor('terminal-debug-api', () => Boolean(debugApi()), 8000)
  record('TA-00-terminal-debug-api', apiReady, { available: apiReady })
  if (!apiReady || cancelled()) return results

  const api = debugApi()!

  await execCommand(`node "${fixturePath}"`, 'start-fixture', 200)

  const started = await waitFor('terminal-autofollow-started', () => {
    const viewport = readViewport(api)
    const tail = readTail(api)
    return Boolean(viewport && viewport.baseY > viewport.rows && tail.includes('[AUTOFOLLOW] tick'))
  }, 12000, 120)

  record('TA-01-fixture-started', started, {
    fixturePath,
    viewport: readViewport(api),
    tail: readTail(api)
  })
  if (!started || cancelled()) return results

  const initialBottomScroll = api.scrollToBottom(terminalId)
  await sleep(200)
  const bottomSamples = await captureSamples(api, 8, 120)
  record(
    'TA-02-follow-bottom-during-refresh',
    initialBottomScroll && bottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { initialBottomScroll, samples: bottomSamples }
  )
  if (cancelled()) return results

  const manualScrollTop = api.scrollToTop(terminalId)
  await sleep(200)
  const topState = readViewport(api)
  const topSamples = await captureSamples(api, 6, 120)
  record(
    'TA-03-manual-scroll-not-forced-bottom',
    manualScrollTop &&
      Boolean(topState) &&
      topSamples.every(sample => Boolean(sample && sample.viewportY <= (topState?.viewportY ?? 0) + 1 && !sample.isNearBottom && !sample.userWantsBottom)),
    { manualScrollTop, topState, samples: topSamples }
  )
  if (cancelled()) return results

  const resumedBottomScroll = api.scrollToBottom(terminalId)
  await sleep(200)
  const resumedBottomSamples = await captureSamples(api, 6, 120)
  record(
    'TA-04-bottom-follow-recovers-after-manual-scroll',
    resumedBottomScroll && resumedBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { resumedBottomScroll, samples: resumedBottomSamples }
  )
  if (cancelled()) return results

  const fitAtBottom = api.forceFit(terminalId)
  await sleep(220)
  const fitBottomSamples = await captureSamples(api, 4, 120)
  record(
    'TA-05-fit-keeps-bottom-follow',
    fitAtBottom && fitBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { fitAtBottom, samples: fitBottomSamples }
  )
  if (cancelled()) return results

  const manualScrollTopAgain = api.scrollToTop(terminalId)
  await sleep(180)
  const beforeFitTopState = readViewport(api)
  const fitAtTop = api.forceFit(terminalId)
  await sleep(220)
  const fitTopSamples = await captureSamples(api, 4, 120)
  record(
    'TA-06-fit-preserves-manual-scroll',
    manualScrollTopAgain &&
      fitAtTop &&
      Boolean(beforeFitTopState) &&
      fitTopSamples.every(sample => Boolean(sample && sample.viewportY <= (beforeFitTopState?.viewportY ?? 0) + 1 && !sample.isNearBottom && !sample.userWantsBottom)),
    { manualScrollTopAgain, fitAtTop, beforeFitTopState, samples: fitTopSamples }
  )
  if (cancelled()) return results

  const remountBottomReset = api.scrollToBottom(terminalId)
  await sleep(180)
  const remountAtBottom = api.remountTerminal(terminalId)
  await sleep(260)
  const remountBottomSamples = await captureSamples(api, 4, 120)
  record(
    'TA-07-remount-keeps-bottom-follow',
    remountBottomReset && remountAtBottom && remountBottomSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom)),
    { remountBottomReset, remountAtBottom, samples: remountBottomSamples }
  )
  if (cancelled()) return results

  const manualScrollTopBeforeRemount = api.scrollToTop(terminalId)
  await sleep(180)
  const beforeRemountTopState = readViewport(api)
  const remountAtTop = api.remountTerminal(terminalId)
  await sleep(260)
  const remountTopSamples = await captureSamples(api, 4, 120)
  record(
    'TA-08-remount-preserves-manual-scroll',
    manualScrollTopBeforeRemount &&
      remountAtTop &&
      Boolean(beforeRemountTopState) &&
      remountTopSamples.every(sample => Boolean(sample && sample.viewportY <= (beforeRemountTopState?.viewportY ?? 0) + 1 && !sample.isNearBottom && !sample.userWantsBottom)),
    { manualScrollTopBeforeRemount, remountAtTop, beforeRemountTopState, samples: remountTopSamples }
  )
  if (cancelled()) return results

  const stressBottomReset = api.scrollToBottom(terminalId)
  await sleep(180)
  const operations: Array<Record<string, unknown>> = []
  let stressOk = stressBottomReset
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const fitOk = api.forceFit(terminalId)
    await sleep(120)
    const remountOk = api.remountTerminal(terminalId)
    await sleep(220)
    const viewport = readViewport(api)
    operations.push({ iteration, fitOk, remountOk, viewport })
    if (!fitOk || !remountOk || !viewport?.isNearBottom || !viewport.userWantsBottom) {
      stressOk = false
    }
  }
  const stressSamples = await captureSamples(api, 4, 120)
  stressOk = stressOk && stressSamples.every(sample => Boolean(sample?.isNearBottom && sample?.userWantsBottom))
  record('TA-09-fit-remount-stress-keeps-bottom', stressOk, {
    stressBottomReset,
    operations,
    samples: stressSamples
  })
  if (cancelled()) return results

  const fixtureCompleted = await waitFor('terminal-autofollow-finished', () => {
    return readTail(api, 30).includes('[AUTOFOLLOW] end')
  }, 10000, 150)
  record('TA-10-fixture-completed', fixtureCompleted, { tail: readTail(api, 30) })

  log('terminal-autofollow:done', {
    total: results.length,
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length
  })

  return results
}
