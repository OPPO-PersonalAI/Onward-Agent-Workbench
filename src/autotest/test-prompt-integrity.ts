/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, PromptNotebookDebugApi, PromptSenderDebugApi, TestResult } from './types'
import type { PromptInputPayload, PromptInputResult, PromptInputSettings } from '../utils/prompt-input'
import type { PromptDraftSnapshot } from '../contexts/PromptActionsContext'
import { translate, type AppLocale, type TranslationKey } from '../i18n/core'

interface CaptureResult {
  stopReason: string
  rawMode: boolean
  totalBytes: number
  utf8: string
  hex: string
  checkpointCount?: number
  timeout?: boolean
}

interface Corpus { single: string; mixed: string; large: string }
type CaptureMode = 'keep' | 'on' | 'off' | 'split-on-prefix' | 'split-on-suffix' | 'off-on' | 'on-off'
type Sender = Omit<PromptSenderDebugApi, 'clickAction'> & {
  clickAction: (action: string) => Promise<boolean>
}
type HistoryEntry = ReturnType<PromptNotebookDebugApi['getPrompts']>[number] & {
  sendHistory: Array<{
    taskId: string
    sentAt: number
    inputActionId?: string
    inputTerminalKey?: string
    inputResult?: PromptInputResult
  }>
}
type Notebook = Omit<PromptNotebookDebugApi, 'getPrompts'> & {
  getPrompts: () => HistoryEntry[]
  getLiveDraftSnapshot: () => PromptDraftSnapshot | null
  setEditorTitle: (title: string) => void
}
interface CaptureReceiver {
  terminalId: string
  name: string
  checkpoints: number
  started: boolean
}
type Observation = { ok: boolean; detail: Record<string, unknown> }

const TRIALS = 5
const READY_TIMEOUT_MS = 10000
const STOP_MARKER = '__CAPTURE_STOP__'
const BRACKET_START = '\x1b[200~'
const BRACKET_END = '\x1b[201~'
const CASES = [
  'PI-01-send-multiline-with-bracketed-paste',
  'PI-02-send-and-execute-multiline-with-bracketed-paste',
  'PI-03-send-large-multiline-preserves-all-lines',
  'PI-04-send-blocked-without-bracketed-paste',
  'PI-05-send-and-execute-blocked-without-bracketed-paste',
  'PI-06-queue-sends-text-and-exact-tab',
  'PI-07-key-only-preserves-draft-and-selection',
  'PI-08-terminal-key-allowlist-exact-stream',
  'PI-09-invalid-content-rejects-all-bytes',
  'PI-10-unavailable-target-no-fallback-and-recovery',
  'PI-11-large-transaction-excludes-interactive-writes',
  'PI-12-burst-transactions-fifo-exactly-once',
  'PI-13-paste-mode-stream-order',
  'PI-14-paste-mode-split-sequence',
  'PI-15-lf-crlf-cr-guard-and-key-only-bypass',
  'PI-16-notebook-mixed-targets-retain-draft-and-record-all-outcomes-once',
  'PI-17-notebook-mixed-targets-never-automatically-resend'
] as const

// An independent protocol oracle: never derive expected bytes from the product encoder.
const KEY_BYTES: Array<[string, string]> = [
  ['Enter', '\r'], ['Tab', '\t'], ['Shift+Tab', '\x1b[Z'], ['Escape', '\x1b'],
  ['Backspace', '\x7f'], ['Delete', '\x1b[3~'], ['Up', '\x1b[A'],
  ['Down', '\x1b[B'], ['Left', '\x1b[D'], ['Right', '\x1b[C'],
  ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PageUp', '\x1b[5~'], ['PageDown', '\x1b[6~'],
  ...Array.from({ length: 26 }, (_, index): [string, string] =>
    [`Control+${String.fromCharCode(65 + index)}`, String.fromCharCode(index + 1)])
]

function pasteFrame(content: string): string {
  return BRACKET_START + content.replace(/\r\n|\n/g, '\r') + BRACKET_END
}

function hex(content: string): string {
  return Array.from(new TextEncoder().encode(content), byte => byte.toString(16).padStart(2, '0')).join('')
}

function accepted(result: PromptInputResult, contentDelivered: boolean): boolean {
  return result.ok && result.phase === 'complete' && result.contentDelivered === contentDelivered && !result.reason
}

function rejected(result: PromptInputResult, reason: PromptInputResult['reason']): boolean {
  return !result.ok && !result.contentDelivered && result.phase === 'content' && result.reason === reason
}

export async function testPromptIntegrity(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const rootPath = window.electronAPI.debug.autotestCwd ?? ctx.rootPath
  const results: TestResult[] = []
  const observations = new Map<string, Observation[]>(CASES.map(name => [name, []]))
  const sender = () => window.__onwardPromptSenderDebug as Sender | undefined
  const notebook = () => window.__onwardPromptNotebookDebug as Notebook | undefined
  const runtimeSettings = () => (window as unknown as {
    __onwardThemeDebug?: { getState: () => { settings: { language: AppLocale; promptInput: PromptInputSettings } | null } }
  }).__onwardThemeDebug?.getState().settings
  const translated = (key: TranslationKey) => translate(runtimeSettings()?.language ?? 'en', key)
  const notebookElement = () => document.querySelector<HTMLElement>('.prompt-notebook:not(.prompt-notebook-hidden)')
  const taskGrid = () => document.querySelector<HTMLElement>('.terminal-grid-wrapper:not(.terminal-grid-hidden) .terminal-grid')
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }
  const observe = (index: number, observation: Observation) => observations.get(CASES[index])!.push(observation)
  let fixtureVerified = false
  const receivers: CaptureReceiver[] = []
  let primaryReceiver: CaptureReceiver
  let targetId = ''
  let checkpointCount = 0

  async function readJson<T>(relativePath: string): Promise<T> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline && !cancelled()) {
      const result = await window.electronAPI.project.readFile(rootPath, relativePath)
      if (result.success && typeof result.content === 'string') return JSON.parse(result.content) as T
      await sleep(40)
    }
    throw new Error(`Missing fixture result: ${relativePath}`)
  }

  async function modeReady(enabled: boolean, terminalId = targetId): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline && !cancelled()) {
      const capability = await window.electronAPI.terminal.getInputCapabilities(terminalId)
      if (capability.bracketedPasteEnabled === enabled) return
      await sleep(40)
    }
    throw new Error(`Main-process bracketed-paste mode did not become ${enabled} for ${terminalId}`)
  }

  async function startReceiver(terminalId: string, name: string, bracketed: boolean): Promise<CaptureReceiver> {
    const receiver: CaptureReceiver = { terminalId, name, checkpoints: 0, started: false }
    receivers.push(receiver)
    // The runner prepares the same relative fixture in every Task's isolated cwd.
    const started = await window.electronAPI.terminal.write(terminalId,
      `node "prompt-capture-stdin.cjs" "captures/${name}.json" --checkpoints --capture-control-keys${bracketed ? ' --enable-bracketed-paste' : ''}\r`)
    if (!started) throw new Error(`Receiver launch write failed: ${name}`)
    receiver.started = true
    const ready = await readJson<{ rawMode: boolean }>(`captures/${name}.json.ready`)
    if (!ready.rawMode) throw new Error(`Receiver is not using a real raw-mode PTY: ${name}`)
    await modeReady(bracketed, terminalId)
    return receiver
  }

  async function checkpoint(label: string, expected: string, mode: CaptureMode = 'keep', receiver = primaryReceiver): Promise<Observation> {
    if (mode === 'split-on-prefix') {
      let outputTail = ''
      let prefixReceived = false
      const unsubscribe = window.electronAPI.terminal.onData((id, data) => {
        if (id !== receiver.terminalId) return
        outputTail = (outputTail + data).slice(-128)
        if (outputTail.endsWith('\x1b[?20')) prefixReceived = true
      })
      try {
        const capture = await captureCheckpoint(label, expected, mode, receiver)
        const observed = await waitFor(`${label}:prefix-received`, () => prefixReceived, READY_TIMEOUT_MS, 30)
        if (!observed) throw new Error('Main did not forward the incomplete CSI before its suffix')
        await modeReady(false, receiver.terminalId)
        return capture
      } finally {
        unsubscribe()
      }
    }
    return captureCheckpoint(label, expected, mode, receiver)
  }

  async function captureCheckpoint(caseLabel: string, expected: string, mode: CaptureMode, receiver: CaptureReceiver): Promise<Observation> {
    // The fixture uses checkpoint labels as filenames. Prefix each receiver's
    // labels so concurrent raw readers can never overwrite each other's proof.
    const label = `${receiver.name}-${caseLabel}`
    const written = await window.electronAPI.terminal.write(receiver.terminalId, `__ONWARD_PI_CHECKPOINT__${label}:${mode}__`)
    if (!written) throw new Error(`Cannot fence PTY input for ${label}`)
    const capture = await readJson<CaptureResult>(`captures/${label}.json`)
    const expectedHex = hex(expected)
    const bytesEqual = capture.hex === expectedHex
    let mismatch = -1
    if (!bytesEqual) {
      const length = Math.max(capture.hex.length, expectedHex.length)
      for (let index = 0; index < length; index += 2) {
        if (capture.hex.slice(index, index + 2) !== expectedHex.slice(index, index + 2)) {
          mismatch = index / 2
          break
        }
      }
    }
    checkpointCount += 1
    const expectedCheckpoint = ++receiver.checkpoints
    const ok = bytesEqual && capture.utf8 === expected && capture.totalBytes === expectedHex.length / 2 &&
      capture.rawMode && !capture.timeout && capture.stopReason === 'checkpoint' &&
      capture.checkpointCount === expectedCheckpoint
    if (mode !== 'keep' && mode !== 'split-on-prefix') await modeReady(mode !== 'off' && mode !== 'on-off', receiver.terminalId)
    return {
      ok,
      detail: {
        label, terminalId: receiver.terminalId, expectedBytes: expectedHex.length / 2, actualBytes: capture.totalBytes,
        checkpoint: capture.checkpointCount, rawMode: capture.rawMode, mismatch,
        ...(bytesEqual ? {} : {
          expectedHead: expectedHex.slice(0, 128), actualHead: capture.hex.slice(0, 128),
          expectedAtMismatch: expectedHex.slice(Math.max(0, mismatch * 2 - 16), mismatch * 2 + 64),
          actualAtMismatch: capture.hex.slice(Math.max(0, mismatch * 2 - 16), mismatch * 2 + 64)
        })
      }
    }
  }

  async function changeMode(label: string, mode: CaptureMode, receiver = primaryReceiver): Promise<void> {
    const result = await checkpoint(label, '', mode, receiver)
    if (!result.ok) throw new Error(`Unexpected bytes between cases: ${JSON.stringify(result.detail)}`)
  }

  function clickSidebar(key: TranslationKey): void {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar .sidebar-btn'))
      .find(candidate => candidate.title === translated(key))
    if (!button) throw new Error(`Missing sidebar action: ${key}`)
    button.click()
  }

  function changeSelect(element: HTMLSelectElement, value: string): void {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  async function paintTurn(): Promise<void> {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }

  async function prepareAllQueueAction(): Promise<string> {
    // Add an all-Tasks copy of Queue through the actual settings provider/save
    // path. The original Queue remains available to the single-target cases.
    const priorIds = new Set(runtimeSettings()?.promptInput.actions.map(action => action.id) ?? [])
    document.querySelector<HTMLButtonElement>('[data-testid="sidebar-settings-button"]')?.click()
    if (!await waitFor('pi-mixed:settings-open', () => Boolean(window.__onwardSettingsDebug?.isOpen()), READY_TIMEOUT_MS, 40)) {
      throw new Error('Settings did not open for the mixed-target action')
    }
    const compact = document.querySelector<HTMLSelectElement>('[data-testid="settings-page-select"]')
    if (compact?.getClientRects().length) changeSelect(compact, 'shortcuts')
    else document.querySelector<HTMLButtonElement>('[data-testid="settings-tab-shortcuts"]')?.click()
    if (!await waitFor('pi-mixed:settings-page', () => Boolean(document.querySelector('[data-testid="prompt-input-expand"]')), READY_TIMEOUT_MS, 40)) {
      throw new Error('Queue settings were not available')
    }
    const expand = document.querySelector<HTMLButtonElement>('[data-testid="prompt-input-expand"]')!
    if (expand.getAttribute('aria-expanded') === 'false') expand.click()
    await paintTurn()
    const actionSelect = document.querySelector<HTMLSelectElement>('[data-testid="prompt-input-action-select"]')!
    changeSelect(actionSelect, 'queue')
    await paintTurn()
    const duplicate = document.querySelector<HTMLButtonElement>('[data-testid="prompt-input-action-queue-duplicate"]')
    if (!duplicate || duplicate.disabled) throw new Error('Queue duplication is unavailable')
    duplicate.click()
    const newRows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-prompt-action-id]'))
      .filter(row => !priorIds.has(row.dataset.promptActionId ?? ''))
    if (!await waitFor('pi-mixed:action-created', () => newRows().length === 1, READY_TIMEOUT_MS, 40)) {
      throw new Error('Exactly one duplicated Queue action was required')
    }
    const actionId = newRows()[0].dataset.promptActionId!
    const target = document.querySelector<HTMLSelectElement>(`[data-testid="prompt-input-action-${actionId}-target"]`)
    if (!target) throw new Error('All-Tasks target selector is missing')
    changeSelect(target, 'all')
    // Duplicating already enabled Save. Wait for the target edit's React commit
    // rather than letting that older enabled button certify a stale save closure.
    await paintTurn()
    if (!await waitFor('pi-mixed:save-enabled', () => document.querySelector<HTMLButtonElement>('[data-testid="prompt-input-save"]')?.disabled === false, READY_TIMEOUT_MS, 40)) {
      throw new Error('Mixed-target action could not be saved')
    }
    document.querySelector<HTMLButtonElement>('[data-testid="prompt-input-save"]')!.click()
    const matches = (config: PromptInputSettings | undefined) => config?.actions.some(action =>
      action.id === actionId && action.includePrompt && action.terminalKey === 'Tab' && action.target === 'all' && action.visible)
    if (!await waitFor('pi-mixed:save-ack', () =>
      document.querySelector('[data-testid="prompt-input-status"]')?.getAttribute('data-state') === 'saved'
      && matches(runtimeSettings()?.promptInput) === true, READY_TIMEOUT_MS, 40)) {
      throw new Error('Mixed-target Queue did not receive the provider save acknowledgment')
    }
    if (!matches((await window.electronAPI.settings.load()).promptInput)) throw new Error('Mixed-target Queue was not saved durably')
    clickSidebar('sidebar.promptNotebook')
    if (!await waitFor('pi-mixed:notebook-restored', () => Boolean(notebookElement()) && !window.__onwardSettingsDebug
      && typeof notebook()?.getLiveDraftSnapshot === 'function' && typeof notebook()?.setEditorTitle === 'function', READY_TIMEOUT_MS, 40)) {
      throw new Error('Notebook live draft APIs were not restored after settings')
    }
    return actionId
  }

  async function runButton(label: string, action: string, content: string, expected: string, success: boolean, keepDraft = false): Promise<Observation> {
    // These helpers prepare editor/selection state. Trusted keyboard routing is
    // covered by the companion CDP suite; this suite tests the real dispatcher,
    // preload, IPC, PTY and receiving process, without faking terminal output.
    notebook()!.setEditorContent(content)
    const editorReady = await waitFor(`${label}:draft-ready`, () => notebook()?.getEditorContent() === content, READY_TIMEOUT_MS, 30)
    if (!editorReady) throw new Error(`Editor did not accept fixture for ${label}`)
    const completed = await sender()!.clickAction(action)
    const expectedDraft = keepDraft || !success ? content : ''
    const draftCorrect = await waitFor(`${label}:draft-result`, () =>
      notebook()?.getEditorContent() === expectedDraft && sender()?.isSubmitting() === false, READY_TIMEOUT_MS, 30)
    const noticeReady = await waitFor(`${label}:notice`, () => {
      const root = Array.from(document.querySelectorAll('.prompt-sender')).find(element =>
        Array.from(element.querySelectorAll<HTMLElement>('[data-terminal-id]')).some(card => card.dataset.terminalId === targetId))
      const notice = root?.querySelector('.prompt-sender-notice')
      return success ? !notice && Boolean(sender()?.getNotice()) : Boolean(notice?.textContent?.trim()) && notice?.getAttribute('role') === 'alert'
    }, READY_TIMEOUT_MS, 30)
    const selected = sender()!.getSelectedTerminalIds()
    const capture = await checkpoint(label, expected)
    return {
      ok: capture.ok && completed === success && draftCorrect && noticeReady && selected.length === 1 && selected[0] === targetId,
      detail: { ...capture.detail, completed, expectedSuccess: success, draftCorrect, noticeReady, selectionRetained: selected.length === 1 && selected[0] === targetId }
    }
  }

  try {
    const marker = await window.electronAPI.project.readFile(rootPath, '.prompt-integrity-root')
    fixtureVerified = marker.success && marker.content === 'prompt-integrity-v2\n'
    record('PI-00-isolated-fixture', fixtureVerified)
    if (!fixtureVerified) throw new Error('Use the isolated prompt-integrity runner; refusing repository-root fixtures')
    const corpus = await readJson<Corpus>('cases.json')
    if (!corpus.single || !corpus.mixed.includes('\n') || corpus.large.length < 24576) throw new Error('Incomplete integrity corpus')
    const apisReady = await waitFor('prompt-integrity:apis', () => Boolean(
      sender() && notebook() && runtimeSettings() && typeof window.electronAPI.promptInput?.send === 'function' && sender()!.getTerminalCards().length
    ), READY_TIMEOUT_MS, 50)
    record('PI-00a-production-apis-ready', apisReady)
    if (!apisReady) throw new Error('Prompt input production API or UI dispatcher is unavailable')
    // Prepare both Tasks and the additional action before any idle-watchdog
    // receiver starts. The second receiver is launched only for the mixed cases.
    if (sender()!.getTerminalCards().length !== 2) clickSidebar('sidebar.layout.double')
    const twoTasks = await waitFor('pi-mixed:two-visible-tasks', () => {
      const ids = sender()?.getTerminalCards().map(card => card.id) ?? []
      const cells = Array.from(taskGrid()?.querySelectorAll<HTMLElement>('.terminal-grid-cell') ?? [])
      return ids.length === 2 && cells.length === 2 && cells.every(cell => ids.includes(cell.dataset.terminalId ?? ''))
    }, READY_TIMEOUT_MS, 40)
    if (!twoTasks) throw new Error('Mixed-target integrity requires exactly two current-tab layout-visible Tasks')
    const allQueueActionId = await prepareAllQueueAction()
    const originatingTabId = window.__onwardAppDebug?.getActiveTabId()
    if (!originatingTabId) throw new Error('The active Notebook tab could not be identified')
    targetId = sender()!.getTerminalCards()[0].id
    const secondaryTargetId = sender()!.getTerminalCards()[1].id
    sender()!.deselectAllTerminals()
    sender()!.selectTerminal(targetId)
    const selected = await waitFor('prompt-integrity:selection', () => {
      const ids = sender()?.getSelectedTerminalIds() ?? []
      return ids.length === 1 && ids[0] === targetId
    }, READY_TIMEOUT_MS, 30)
    if (!selected) throw new Error('Unable to select the real target terminal')

    primaryReceiver = await startReceiver(targetId, 'receiver', true)
    record('PI-00b-raw-receiver-ready', true)
    const api = window.electronAPI.promptInput
    const send = (payload: PromptInputPayload) => api.send(targetId, payload)

    for (let trial = 0; trial < TRIALS; trial++) {
      if (cancelled()) throw new Error('Integrity trials canceled')
      const label = (caseId: string) => `trial-${trial}-${caseId}`
      await changeMode(label('start'), 'on')
      observe(0, await runButton(label('pi01'), 'send', corpus.mixed, pasteFrame(corpus.mixed), true))
      observe(1, await runButton(label('pi02'), 'sendAndExecute', corpus.mixed, pasteFrame(corpus.mixed) + '\r', true))
      observe(2, await runButton(label('pi03'), 'send', corpus.large, pasteFrame(corpus.large), true))
      observe(5, await runButton(label('pi06'), 'queue', corpus.single, corpus.single + '\t', true))
      observe(6, await runButton(label('pi07'), 'execute', corpus.mixed, '\r', true, true))

      const keyResults: PromptInputResult[] = []
      for (const [terminalKey] of KEY_BYTES) {
        keyResults.push(await send({ includePrompt: false, content: corpus.mixed, terminalKey }))
      }
      const keyCapture = await checkpoint(label('pi08'), KEY_BYTES.map(([, bytes]) => bytes).join(''))
      observe(7, { ok: keyCapture.ok && keyResults.every(result => accepted(result, false)), detail: { ...keyCapture.detail, keys: keyResults.length, rejected: keyResults.filter(result => !accepted(result, false)) } })

      const invalidTexts = ['', ' \t\r\n ', 'before\x00after', 'before\x03after', 'before\x08after',
        'before\x0bafter', 'before\x0cafter', 'before\x0eafter', 'before\x1fafter', 'before\x7fafter',
        'before\x80after', 'before\x9b201~after', 'before\x9fafter',
        'before\x1b[201~after\nunsafe', 'before\x1b[200~after']
      const invalidResults: PromptInputResult[] = []
      for (const content of invalidTexts) {
        invalidResults.push(await send({ includePrompt: true, content, terminalKey: 'Enter' }))
      }
      invalidResults.push(await send({ includePrompt: true, content: corpus.single, terminalKey: 'NotATerminalKey' }))
      const invalidCapture = await checkpoint(label('pi09'), '')
      observe(8, { ok: invalidCapture.ok && invalidResults.every(result => rejected(result, 'invalid-input')), detail: { ...invalidCapture.detail, results: invalidResults } })

      const unavailable = await api.send(`terminal-pi-missing-${trial}`, { includePrompt: true, content: corpus.single, terminalKey: 'Enter' })
      const recovery = await send({ includePrompt: true, content: `recovery-${trial}`, terminalKey: 'None' })
      const recoveryCapture = await checkpoint(label('pi10'), `recovery-${trial}`)
      observe(9, { ok: recoveryCapture.ok && rejected(unavailable, 'unavailable') && accepted(recovery, true), detail: { ...recoveryCapture.detail, unavailable, recovery } })

      // Enqueue competing producers without awaiting. A short interactive write
      // must wait for the large transaction's suffix, even during ConPTY chunks.
      const transaction = send({ includePrompt: true, content: corpus.large, terminalKey: 'Tab' })
      const interactive = window.electronAPI.terminal.write(targetId, `typed-${trial}`)
      const following = send({ includePrompt: false, content: '', terminalKey: 'Control+A' })
      const [transactionResult, interactiveResult, followingResult] = await Promise.all([transaction, interactive, following])
      const atomicCapture = await checkpoint(label('pi11'), pasteFrame(corpus.large) + `\ttyped-${trial}\x01`)
      observe(10, { ok: atomicCapture.ok && accepted(transactionResult, true) && interactiveResult && accepted(followingResult, false), detail: { ...atomicCapture.detail, transactionResult, interactiveResult, followingResult } })

      const burstPayloads: PromptInputPayload[] = Array.from({ length: 12 }, (_, index) => ({
        includePrompt: true, content: `burst-${trial}-${index}`, terminalKey: ['None', 'Tab', 'Enter'][index % 3]
      }))
      const burst = await Promise.all(burstPayloads.map(payload => send(payload)))
      const burstExpected = burstPayloads.map((payload, index) => payload.content + ['', '\t', '\r'][index % 3]).join('')
      const burstCapture = await checkpoint(label('pi12'), burstExpected)
      observe(11, { ok: burstCapture.ok && burst.every(result => accepted(result, true)), detail: { ...burstCapture.detail, transactions: burst.length, failed: burst.filter(result => !accepted(result, true)) } })

      await changeMode(label('pi13-prime-off'), 'off')
      await changeMode(label('pi13-off-on'), 'off-on')
      const orderedOn = await send({ includePrompt: true, content: corpus.mixed, terminalKey: 'None' })
      const orderedOnCapture = await checkpoint(label('pi13-on'), pasteFrame(corpus.mixed), 'on-off')
      const orderedOff = await send({ includePrompt: true, content: corpus.mixed, terminalKey: 'Enter' })
      const orderedOffCapture = await checkpoint(label('pi13-off'), '')
      observe(12, { ok: orderedOnCapture.ok && orderedOffCapture.ok && accepted(orderedOn, true) && rejected(orderedOff, 'unsafe-multiline-send'), detail: { on: orderedOn, off: orderedOff, onCapture: orderedOnCapture.detail, offCapture: orderedOffCapture.detail } })

      // The first fragment must cross main -> renderer before the second is
      // emitted. Timers cannot guarantee separate native PTY output chunks.
      await changeMode(label('pi14-split-prefix'), 'split-on-prefix')
      await changeMode(label('pi14-split-suffix'), 'split-on-suffix')
      const splitResult = await send({ includePrompt: true, content: corpus.mixed, terminalKey: 'Tab' })
      const splitCapture = await checkpoint(label('pi14'), pasteFrame(corpus.mixed) + '\t', 'off')
      observe(13, { ok: splitCapture.ok && accepted(splitResult, true), detail: { ...splitCapture.detail, result: splitResult } })

      observe(3, await runButton(label('pi04'), 'send', corpus.mixed, '', false))
      observe(4, await runButton(label('pi05'), 'sendAndExecute', corpus.mixed, '', false))
      const guardResults: PromptInputResult[] = []
      for (const separator of ['\n', '\r\n', '\r']) {
        guardResults.push(await send({ includePrompt: true, content: `first${separator}last`, terminalKey: 'Tab' }))
      }
      const keyOnlyOff = await send({ includePrompt: false, content: corpus.mixed, terminalKey: 'Tab' })
      const guardCapture = await checkpoint(label('pi15'), '\t')
      observe(14, { ok: guardCapture.ok && guardResults.every(result => rejected(result, 'unsafe-multiline-send')) && accepted(keyOnlyOff, false), detail: { ...guardCapture.detail, results: guardResults, keyOnlyOff } })
    }

    await changeMode('mixed-targets-start', 'on')
    const secondaryReceiver = await startReceiver(secondaryTargetId, 'mixed-b', false)
    const mixedHistoryIds = new Set<string>()
    for (let trial = 0; trial < TRIALS; trial++) {
      if (cancelled()) throw new Error('Mixed-target integrity trials canceled')
      const label = `mixed-trial-${trial}`
      await changeMode(`${label}-safe`, 'on')
      await changeMode(`${label}-unsafe`, 'off', secondaryReceiver)
      const content = `Mixed-target dispatch ${trial + 1}\n${corpus.mixed}`
      const title = `Mixed-target title ${trial + 1}`
      notebook()!.setEditorContent(content)
      notebook()!.setEditorTitle(title)
      const prepared = await waitFor(`${label}:live-draft`, () => {
        const snapshot = notebook()?.getLiveDraftSnapshot()
        return snapshot?.content === content && snapshot.title === title && !snapshot.composing
          && notebookElement()?.querySelector<HTMLElement>('.prompt-editor-content')?.innerText === content
          && notebookElement()?.querySelector<HTMLInputElement>('.prompt-editor-title')?.value === title
      }, READY_TIMEOUT_MS, 30)
      if (!prepared) throw new Error('The mixed-target live draft and title were not prepared')
      const sentSnapshot = { ...notebook()!.getLiveDraftSnapshot()! }
      const beforeHistory = notebook()!.getPrompts()
      const priorHistory = new Map(beforeHistory.map(entry => [entry.id, JSON.stringify(entry)]))
      const selectedBefore = sender()!.getSelectedTerminalIds()

      // This is the actual Notebook dispatcher. Only A is manually selected;
      // the configured all-Tasks action must still include B and report its failure.
      const completed = await sender()!.clickAction(allQueueActionId)
      const historyReady = await waitFor(`${label}:history-committed`, () => sender()?.isSubmitting() === false
        && (notebook()?.getPrompts().some(entry => !priorHistory.has(entry.id)) ?? false), READY_TIMEOUT_MS, 30)
      const partialNotice = await waitFor(`${label}:partial-feedback`, () => {
        const notice = notebookElement()?.querySelector('.prompt-sender-notice')
        return notice?.getAttribute('role') === 'alert' && Boolean(notice.textContent?.trim())
      }, READY_TIMEOUT_MS, 30)
      const afterHistory = notebook()!.getPrompts()
      const additions = afterHistory.filter(entry => !priorHistory.has(entry.id))
      const history = additions.length === 1 ? additions[0] : undefined
      const outcomes = history?.sendHistory ?? []
      const byTarget = new Map(outcomes.map(outcome => [outcome.taskId, outcome]))
      const successful = byTarget.get(targetId)?.inputResult
      const unsafe = byTarget.get(secondaryTargetId)?.inputResult
      const allOutcomes = outcomes.length === 2 && history?.sendHistoryCount === 2 && byTarget.size === 2
        && successful !== undefined && accepted(successful, true)
        && unsafe !== undefined && rejected(unsafe, 'unsafe-multiline-send')
        && outcomes.every(outcome => outcome.inputActionId === allQueueActionId && outcome.inputTerminalKey === 'Tab'
          && Number.isFinite(outcome.sentAt) && outcome.sentAt > 0)
        && new Set(outcomes.map(outcome => outcome.sentAt)).size === 1
      const previousHistoryUntouched = beforeHistory.every(entry => {
        const current = afterHistory.find(candidate => candidate.id === entry.id)
        return current !== undefined && JSON.stringify(current) === priorHistory.get(entry.id)
      })
      const recordedOnce = historyReady && additions.length === 1 && afterHistory.length === beforeHistory.length + 1
        && history?.content === sentSnapshot.content && history.title === sentSnapshot.title
        && !mixedHistoryIds.has(history.id) && previousHistoryUntouched
      if (history) mixedHistoryIds.add(history.id)
      const draftRetained = JSON.stringify(notebook()!.getLiveDraftSnapshot()) === JSON.stringify(sentSnapshot)
        && notebook()!.getEditorContent() === content
        && notebookElement()?.querySelector<HTMLElement>('.prompt-editor-content')?.innerText === content
        && notebookElement()?.querySelector<HTMLInputElement>('.prompt-editor-title')?.value === title
      const visibleIds = sender()!.getTerminalCards().map(card => card.id)
      const targetingCorrect = window.__onwardAppDebug?.getActiveTabId() === originatingTabId
        && visibleIds.length === 2 && visibleIds.includes(targetId) && visibleIds.includes(secondaryTargetId)
        && selectedBefore.length === 1 && selectedBefore[0] === targetId
        && JSON.stringify(sender()!.getSelectedTerminalIds()) === JSON.stringify(selectedBefore)
      const [aCapture, bCapture] = await Promise.all([
        checkpoint(`${label}-dispatch`, pasteFrame(content) + '\t'),
        checkpoint(`${label}-dispatch`, '', 'keep', secondaryReceiver)
      ])
      observe(15, {
        ok: completed === false && aCapture.ok && bCapture.ok && partialNotice && draftRetained
          && targetingCorrect && recordedOnce && allOutcomes && mixedHistoryIds.size === trial + 1,
        detail: {
          completed, partialNotice, draftRetained, targetingCorrect, recordedOnce, allOutcomes,
          addedRecords: additions.length, outcomes, mixedRecords: mixedHistoryIds.size,
          a: aCapture.detail, b: bCapture.detail
        }
      })

      // Recover B's capability without any resend request. Then submit an
      // unrelated key-only action to selected A and cross a renderer paint turn.
      // Both post-completion PTY fences must exclude the retained Prompt text;
      // neither capability recovery nor the next invocation may replay it.
      const committedHistory = JSON.stringify(notebook()!.getPrompts())
      await changeMode(`${label}-recover-unsafe-target`, 'on', secondaryReceiver)
      const keyOnlyCompleted = await sender()!.clickAction('execute')
      const idle = await waitFor(`${label}:follow-up-idle`, () => sender()?.isSubmitting() === false, READY_TIMEOUT_MS, 30)
      await paintTurn()
      const [aAfter, bAfter] = await Promise.all([
        checkpoint(`${label}-after-recovery`, '\r'),
        checkpoint(`${label}-after-recovery`, '', 'keep', secondaryReceiver)
      ])
      const historyUnchanged = JSON.stringify(notebook()!.getPrompts()) === committedHistory
      const retainedAfterFollowUp = JSON.stringify(notebook()!.getLiveDraftSnapshot()) === JSON.stringify(sentSnapshot)
        && notebookElement()?.querySelector<HTMLElement>('.prompt-editor-content')?.innerText === content
        && notebookElement()?.querySelector<HTMLInputElement>('.prompt-editor-title')?.value === title
      observe(16, {
        ok: keyOnlyCompleted && idle && aAfter.ok && bAfter.ok && historyUnchanged && retainedAfterFollowUp
          && mixedHistoryIds.size === trial + 1,
        detail: { keyOnlyCompleted, idle, historyUnchanged, retainedAfterFollowUp, a: aAfter.detail, b: bAfter.detail }
      })
    }

    const finalCaptures = await Promise.all(receivers.map(async receiver => {
      const stopped = await window.electronAPI.terminal.write(receiver.terminalId, STOP_MARKER)
      const capture = await readJson<CaptureResult>(`captures/${receiver.name}.json`)
      receiver.started = false
      return { name: receiver.name, ok: stopped && capture.stopReason === 'marker' && capture.rawMode
        && !capture.timeout && capture.totalBytes === 0 && capture.hex === '', totalBytes: capture.totalBytes }
    }))
    record('PI-98-receiver-ended-with-no-unchecked-bytes', finalCaptures.every(capture => capture.ok), { receivers: finalCaptures })
  } catch (error) {
    record('PI-97-integrity-harness-completed', false, { error: String(error).slice(0, 512) })
  } finally {
    await Promise.all(receivers.filter(receiver => receiver.started).map(receiver =>
      window.electronAPI.terminal.write(receiver.terminalId, STOP_MARKER).catch(() => {})))
    notebook()?.setEditorContent('')
    notebook()?.setEditorTitle?.('')
    // The runner owns the isolated root and removes it even after a crash or
    // signal. No __autotest_* entry is ever created in the repository root.
    if (fixtureVerified) await window.electronAPI.project.deletePath(rootPath, 'captures').catch(() => {})
  }

  for (const name of CASES) {
    const trials = observations.get(name)!
    record(name, trials.length === TRIALS && trials.every(trial => trial.ok), {
      expectedTrials: TRIALS, completedTrials: trials.length,
      failedTrials: trials.flatMap((trial, index) => trial.ok ? [] : [{ trial: index + 1, ...trial.detail }])
    })
  }
  record('PI-99-exact-input-contract-complete', !cancelled() && results.every(result => result.ok), {
    cases: CASES.length, trialsPerCase: TRIALS, checkpoints: checkpointCount
  })
  log('prompt-integrity:done', { passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length })
  return results
}
