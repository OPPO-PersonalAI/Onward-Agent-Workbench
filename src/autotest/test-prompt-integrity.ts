/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, PromptNotebookDebugApi, PromptSenderDebugApi, TerminalDebugApi, TestResult } from './types'

interface CaptureResult {
  stopReason?: string
  totalBytes: number
  utf8: string
  hex: string
  hasBracketStart?: boolean
  hasBracketEnd?: boolean
  payloadUtf8?: string
  payloadHex?: string
  suffixUtf8?: string
  suffixHex?: string
  suffixHasEnter?: boolean
  trailingEnterBytes?: number
  timeout?: boolean
}

const STOP_MARKER = '__CAPTURE_STOP__'
const SUITE_TIMEOUT_MS = 10000
const NOTICE_TIMEOUT_MS = 4000

function normalizePromptForTransport(content: string): string {
  return content.replace(/\r?\n/g, '\r')
}

function joinPlatformPath(separator: string, ...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .map((part, index) => {
      const normalized = part.replace(/[\\/]/g, separator)
      if (index === 0) return normalized.replace(/[\\/]+$/, '')
      return normalized.replace(/^[\\/]+|[\\/]+$/g, '')
    })
    .join(separator)
}

function buildMixedPrompt(marker: string): string {
  return [
    `# ${marker}`,
    '中文段落：多行 Prompt 需要完整保留，不能在中途被回车截断。',
    '',
    '- bullet item one',
    '- bullet item two',
    '',
    '```ts',
    `const marker = '${marker}'`,
    "console.log('code-block-line')",
    '```',
    '',
    `Summary line for ${marker}`
  ].join('\n')
}

function buildLargePrompt(marker: string): string {
  return Array.from({ length: 50 }, (_, index) => `${marker} line ${String(index + 1).padStart(2, '0')}`).join('\n')
}

export async function testPromptIntegrity(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, rootPath, sleep, terminalId, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const senderApi = () => window.__onwardPromptSenderDebug as PromptSenderDebugApi | undefined
  const notebookApi = () => window.__onwardPromptNotebookDebug as PromptNotebookDebugApi | undefined
  const terminalApi = () => window.__onwardTerminalDebug as TerminalDebugApi | undefined
  const platform = window.electronAPI.platform
  const separator = platform === 'win32' ? '\\' : '/'
  const fixturePath = joinPlatformPath(separator, rootPath, 'test', 'fixtures', 'prompt-capture-stdin.cjs')
  const outputDir = `test-prompt-integrity-${Date.now()}`
  const selectedTerminal = () => senderApi()?.getSelectedTerminalIds()[0] ?? terminalId

  const waitForActionIdle = async (label: string) => {
    return await waitFor(`${label}:idle`, () => Boolean(senderApi() && !senderApi()!.isSubmitting()), 5000, 80)
  }

  const waitForShellReady = async (label: string) => {
    const marker = `__PROMPT_INTEGRITY_READY_${label}_${Date.now()}__`
    const command = platform === 'win32'
      ? `Write-Output '${marker}'`
      : `printf '${marker}\\n'`
    await window.electronAPI.terminal.write(selectedTerminal(), `${command}\r`)
    return await waitFor(`${label}:shell-ready`, () => {
      return (terminalApi()?.getTailText(selectedTerminal(), 60) ?? '').includes(marker)
    }, 8000, 120)
  }

  const clearPromptEditor = async () => {
    notebookApi()?.setEditorContent('')
    await sleep(80)
  }

  const waitForNotice = async (label: string) => {
    return await waitFor(`${label}:notice`, () => {
      return Boolean(senderApi()?.getNotice())
    }, NOTICE_TIMEOUT_MS, 80)
  }

  const waitForNoticeClear = async (label: string) => {
    return await waitFor(`${label}:notice-clear`, () => {
      return !senderApi()?.getNotice()
    }, 3000, 80)
  }

  const ensureSelection = async () => {
    const api = senderApi()
    const cards = api?.getTerminalCards() ?? []
    if (!api || cards.length === 0) return false
    api.deselectAllTerminals()
    await sleep(80)
    const targetId = cards[0].id
    api.selectTerminal(targetId)
    return await waitFor('prompt-integrity:selected-terminal', () => {
      return senderApi()?.getSelectedTerminalIds().includes(targetId) ?? false
    }, 3000, 80)
  }

  const startCapture = async (label: string, enableBracketedPaste: boolean) => {
    const outputRelativePath = `${outputDir}/${label}.json`
    const outputAbsolutePath = joinPlatformPath(separator, rootPath, outputDir, `${label}.json`)
    const bpArg = enableBracketedPaste ? ' --enable-bracketed-paste' : ''
    const command = `node "${fixturePath}" "${outputAbsolutePath}"${bpArg}`
    const readyMarker = `[PROMPT_CAPTURE] ready:${label}.json:${enableBracketedPaste ? 'bp-on' : 'bp-off'}`
    await window.electronAPI.terminal.write(selectedTerminal(), `${command}\r`)
    const ready = await waitFor(`${label}:capture-ready`, () => {
      const tail = terminalApi()?.getTailText(selectedTerminal(), 80) ?? ''
      return tail.includes(readyMarker)
    }, SUITE_TIMEOUT_MS, 100)
    const capabilityStartedAt = Date.now()
    let capabilityReady = false
    while (!capabilityReady && Date.now() - capabilityStartedAt < SUITE_TIMEOUT_MS) {
      try {
        const capabilities = await window.electronAPI.terminal.getInputCapabilities(selectedTerminal())
        capabilityReady = capabilities.bracketedPasteEnabled === enableBracketedPaste
      } catch {
        capabilityReady = false
      }
      if (!capabilityReady) {
        await sleep(100)
      }
    }
    return { ready, capabilityReady, outputRelativePath }
  }

  const stopCapture = async (label: string) => {
    const doneMarker = `__CAPTURED__:${label}.json:`
    await window.electronAPI.terminal.write(selectedTerminal(), STOP_MARKER)
    return await waitFor(`${label}:capture-stop`, () => {
      const tail = terminalApi()?.getTailText(selectedTerminal(), 80) ?? ''
      return tail.includes(doneMarker)
    }, SUITE_TIMEOUT_MS, 100)
  }

  const readCaptureResult = async (relativePath: string): Promise<CaptureResult | null> => {
    const startedAt = Date.now()
    while (Date.now() - startedAt < SUITE_TIMEOUT_MS) {
      const readResult = await window.electronAPI.project.readFile(rootPath, relativePath)
      if (readResult.success) {
        try {
          return JSON.parse(readResult.content) as CaptureResult
        } catch (error) {
          log('prompt-integrity:parse-failed', { relativePath, error: String(error) })
          return null
        }
      }
      await sleep(120)
    }
    return null
  }

  const runPromptAction = async (
    action: 'send' | 'sendAndExecute',
    content: string
  ) => {
    notebookApi()?.setEditorContent(content)
    await sleep(120)
    const clicked = await senderApi()!.clickAction(action)
    const idle = await waitForActionIdle(`prompt-action:${action}`)
    const noticeSeen = await waitFor(`${action}:notice-seen`, () => {
      return Boolean(senderApi()?.getNotice())
    }, 1200, 80)
    return {
      clicked,
      idle,
      noticeSeen,
      notice: senderApi()?.getNotice() ?? null
    }
  }

  const runCaptureCase = async (
    label: string,
    action: 'send' | 'sendAndExecute',
    content: string,
    enableBracketedPaste: boolean
  ) => {
    const capture = await startCapture(label, enableBracketedPaste)
    const actionResult = await runPromptAction(action, content)
    await sleep(200)
    const stopped = await stopCapture(label)
    const captureResult = await readCaptureResult(capture.outputRelativePath)
    await clearPromptEditor()
    const shellReady = await waitForShellReady(`${label}:after`)
    return {
      ...capture,
      ...actionResult,
      stopped,
      captureResult,
      shellReady
    }
  }

  const cleanup = async () => {
    await clearPromptEditor()
    await window.electronAPI.project.deletePath(rootPath, outputDir).catch(() => {})
  }

  try {
    log('prompt-integrity:start', { suite: 'PromptIntegrity', rootPath, terminalId })

    const apisReady = await waitFor('prompt-integrity:apis', () => {
      return Boolean(senderApi() && notebookApi() && terminalApi())
    }, 8000, 120)
    record('PI-00-debug-apis-ready', apisReady, { available: apisReady })
    if (!apisReady || cancelled()) return results

    const cardsReady = await waitFor('prompt-integrity:terminal-cards', () => {
      return (senderApi()?.getTerminalCards().length ?? 0) > 0
    }, 8000, 120)
    record('PI-00a-terminal-cards-ready', cardsReady, {
      cardCount: senderApi()?.getTerminalCards().length ?? 0
    })
    if (!cardsReady || cancelled()) return results

    const selectionReady = await ensureSelection()
    record('PI-00b-terminal-selected', selectionReady, {
      selectedTerminalId: selectedTerminal()
    })
    if (!selectionReady || cancelled()) return results

    const shellReady = await waitForShellReady('setup')
    record('PI-00c-shell-ready', shellReady, {
      tail: terminalApi()?.getTailText(selectedTerminal(), 40)
    })
    if (!shellReady || cancelled()) return results

    if (!cancelled()) {
      const marker = `PI01-${Date.now()}`
      const prompt = buildMixedPrompt(marker)
      const result = await runCaptureCase('pi01-send-bp', 'send', prompt, true)
      const captureResult = result.captureResult
      const expectedPayload = normalizePromptForTransport(prompt)
      record('PI-01-send-multiline-with-bracketed-paste', Boolean(
        result.ready &&
        result.capabilityReady &&
        result.clicked &&
        result.idle &&
        result.stopped &&
        result.shellReady &&
        captureResult &&
        !captureResult.timeout &&
        captureResult.hasBracketStart &&
        captureResult.hasBracketEnd &&
        captureResult.payloadUtf8 === expectedPayload &&
        !captureResult.suffixHasEnter
      ), {
        ...result,
        captureResult
      })
    }

    if (!cancelled()) {
      const marker = `PI02-${Date.now()}`
      const prompt = buildMixedPrompt(marker)
      const result = await runCaptureCase('pi02-send-exec-bp', 'sendAndExecute', prompt, true)
      const captureResult = result.captureResult
      const expectedPayload = normalizePromptForTransport(prompt)
      record('PI-02-send-and-execute-multiline-with-bracketed-paste', Boolean(
        result.ready &&
        result.capabilityReady &&
        result.clicked &&
        result.idle &&
        result.stopped &&
        result.shellReady &&
        captureResult &&
        !captureResult.timeout &&
        captureResult.hasBracketStart &&
        captureResult.hasBracketEnd &&
        captureResult.payloadUtf8 === expectedPayload &&
        captureResult.suffixHasEnter &&
        (captureResult.trailingEnterBytes ?? 0) >= 1
      ), {
        ...result,
        captureResult
      })
    }

    if (!cancelled()) {
      const marker = `PI03-${Date.now()}`
      const prompt = buildLargePrompt(marker)
      const result = await runCaptureCase('pi03-send-large-bp', 'send', prompt, true)
      const captureResult = result.captureResult
      const expectedPayload = normalizePromptForTransport(prompt)
      const expectedLineCount = prompt.split('\n').length
      const actualLineCount = captureResult?.payloadUtf8?.split('\r').length ?? 0
      record('PI-03-send-large-multiline-preserves-all-lines', Boolean(
        result.ready &&
        result.capabilityReady &&
        result.clicked &&
        result.idle &&
        result.stopped &&
        result.shellReady &&
        captureResult &&
        !captureResult.timeout &&
        captureResult.payloadUtf8 === expectedPayload &&
        actualLineCount === expectedLineCount
      ), {
        ...result,
        expectedLineCount,
        actualLineCount,
        captureResult
      })
    }

    if (!cancelled()) {
      await waitForNoticeClear('pi04:before')
      const marker = `PI04-${Date.now()}`
      const prompt = buildMixedPrompt(marker)
      const result = await runCaptureCase('pi04-send-no-bp', 'send', prompt, false)
      const captureResult = result.captureResult
      const blockedNotice = result.noticeSeen || Boolean(result.notice) || await waitForNotice('pi04:blocked')
      record('PI-04-send-blocked-without-bracketed-paste', Boolean(
        result.ready &&
        result.capabilityReady &&
        result.clicked &&
        result.idle &&
        result.stopped &&
        result.shellReady &&
        blockedNotice &&
        captureResult &&
        !captureResult.timeout &&
        captureResult.totalBytes === 0 &&
        captureResult.payloadUtf8 === ''
      ), {
        ...result,
        blockedNotice,
        captureResult
      })
    }

    if (!cancelled()) {
      await waitForNoticeClear('pi05:before')
      const marker = `PI05-${Date.now()}`
      const prompt = buildMixedPrompt(marker)
      const result = await runCaptureCase('pi05-send-exec-no-bp', 'sendAndExecute', prompt, false)
      const captureResult = result.captureResult
      const blockedNotice = result.noticeSeen || Boolean(result.notice) || await waitForNotice('pi05:blocked')
      record('PI-05-send-and-execute-blocked-without-bracketed-paste', Boolean(
        result.ready &&
        result.capabilityReady &&
        result.clicked &&
        result.idle &&
        result.stopped &&
        result.shellReady &&
        blockedNotice &&
        captureResult &&
        !captureResult.timeout &&
        captureResult.totalBytes === 0 &&
        captureResult.payloadUtf8 === ''
      ), {
        ...result,
        blockedNotice,
        captureResult
      })
    }
  } finally {
    await cleanup()
  }

  log('prompt-integrity:done', {
    total: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length
  })

  return results
}
