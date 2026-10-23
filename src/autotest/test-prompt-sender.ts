/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/** Sender UI contracts. Trusted shortcuts and raw-byte transport have paired suites. */
import type { AutotestContext, PromptNotebookDebugApi, TestResult } from './types'
import { translate, type AppLocale, type TranslationKey } from '../i18n/core'
import type { PromptInputResult, PromptInputSettings } from '../utils/prompt-input'
import appearanceAcceptance from '../../test/autotest/fixtures/prompt-input-settings/acceptance.json'

const CORRECTNESS_TRIALS = 5
const PRESET_IDS = ['sendAndExecute', 'execute', 'send', 'sendAllAndExecute', 'queue'] as const
type PromptHistoryEntry = ReturnType<PromptNotebookDebugApi['getPrompts']>[number] & {
  sendHistory?: Array<{ taskId: string; inputActionId?: string; inputTerminalKey?: string; inputResult?: PromptInputResult }>
}

function runtimeSettings(): { language: AppLocale; promptInput: PromptInputSettings } | null | undefined {
  return (window as unknown as {
    __onwardThemeDebug?: { getState: () => { settings: { language: AppLocale; promptInput: PromptInputSettings } | null } }
  }).__onwardThemeDebug?.getState().settings
}

/** Compare saved values, independently of object-property insertion order. */
function settingsSignature(config: PromptInputSettings | undefined): string {
  return JSON.stringify(config && [config.leader, config.timeoutMs, config.actions.map(action => [
    action.id, action.preset ?? null, action.name, action.visible, action.includePrompt,
    action.terminalKey, action.target, action.shortcut, action.color ?? null, action.emoji ?? null
  ])])
}

function activeNotebookElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.prompt-notebook:not(.prompt-notebook-hidden)')
}

function actionButton(id: string): HTMLButtonElement | undefined {
  return Array.from(activeNotebookElement()?.querySelectorAll<HTMLButtonElement>('.prompt-sender-btn') ?? [])
    .find(button => button.dataset.actionId === id)
}

function actionLabels(): Array<{ id: string; label: string; title: string; disabled: boolean }> {
  return Array.from(activeNotebookElement()?.querySelectorAll<HTMLButtonElement>('.prompt-sender-btn') ?? [])
    .map(button => ({ id: button.dataset.actionId ?? '', label: button.getAttribute('aria-label') ?? '',
      title: button.title, disabled: button.disabled }))
}

function editorValue(): string | null {
  return activeNotebookElement()?.querySelector<HTMLElement>('.prompt-editor-content')?.innerText ?? null
}

function inputSettingsSnapshot(): PromptInputSettings | undefined {
  return runtimeSettings()?.promptInput
}

function currentLocale(): AppLocale {
  return runtimeSettings()?.language === 'zh-CN' ? 'zh-CN' : 'en'
}

function translated(key: string, locale = currentLocale()): string {
  return translate(locale, key as TranslationKey)
}

function clickSidebarTitle(key: string): boolean {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.sidebar .sidebar-btn'))
    .find(candidate => candidate.title === translated(key))
  button?.click()
  return Boolean(button)
}

/** Use native setters so React observes the user's field change. */
function changeField(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

async function paintTurn(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/** The Task grid of the currently visible Tab. */
function visibleTaskGridElement(): HTMLElement | null {
  const wrappers = Array.from(document.querySelectorAll<HTMLElement>('.terminal-grid-wrapper'))
  const visible = wrappers.find(w => !w.classList.contains('terminal-grid-hidden')) ?? null
  return visible?.querySelector<HTMLElement>('.terminal-grid') ?? null
}

/** The Task selector inside the Prompt panel. */
function senderGridElement(): HTMLElement | null {
  return activeNotebookElement()?.querySelector<HTMLElement>('.prompt-sender-terminals') ?? null
}

/**
 * Track counts as the engine actually resolved them. `grid-template-*`
 * computes to used pixel sizes ("70px 70px 70px 70px"), so counting the
 * entries reads the real rendered shape rather than the authored shorthand.
 */
function readGridTracks(element: HTMLElement): { columns: number; rows: number } {
  const style = window.getComputedStyle(element)
  const count = (value: string) => value.trim().split(/\s+/).filter(part => part && part !== 'none').length
  return {
    columns: count(style.gridTemplateColumns),
    rows: count(style.gridTemplateRows)
  }
}

/** 1-based grid rectangle an element occupies, read back from computed style. */
function readGridArea(element: HTMLElement): { colStart: number; colSpan: number; rowStart: number; rowSpan: number } {
  const style = window.getComputedStyle(element)
  const parse = (start: string, end: string) => {
    const startLine = Number.parseInt(start, 10)
    const spanMatch = /span\s+(\d+)/.exec(end)
    return {
      start: Number.isFinite(startLine) ? startLine : Number.NaN,
      span: spanMatch ? Number(spanMatch[1]) : 1
    }
  }
  const col = parse(style.gridColumnStart, style.gridColumnEnd)
  const row = parse(style.gridRowStart, style.gridRowEnd)
  return { colStart: col.start, colSpan: col.span, rowStart: row.start, rowSpan: row.span }
}

export async function testPromptSender(ctx: AutotestContext): Promise<TestResult[]> {
  const { log, sleep, waitFor, assert, cancelled } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase1:start', { suite: 'PromptSender' })

  const getApi = () => window.__onwardPromptSenderDebug
  const getPromptNotebookApi = () => window.__onwardPromptNotebookDebug
  const promptHistory = () => (getPromptNotebookApi()?.getPrompts() ?? []) as PromptHistoryEntry[]
  const repeat = async (name: string, trial: (index: number) => Promise<Record<string, unknown> & { ok: boolean }>) => {
    const trials: Array<Record<string, unknown> & { ok: boolean }> = []
    for (let index = 0; index < CORRECTNESS_TRIALS && !cancelled(); index++) {
      try {
        trials.push(await trial(index))
      } catch (error) {
        trials.push({ ok: false, index, error: String(error).slice(0, 512) })
      }
    }
    _assert(name, trials.length === CORRECTNESS_TRIALS && trials.every(result => result.ok), { trials })
  }
  const rootPath = window.electronAPI.debug.autotestCwd
  const marker = rootPath ? await window.electronAPI.project.readFile(rootPath, '.prompt-sender-root') : null
  const isolated = marker?.success === true && marker.content === 'prompt-sender-v2\n'
  _assert('PS-00-isolated-fixture', isolated)
  if (!isolated || !rootPath) return results
  if (!activeNotebookElement()) clickSidebarTitle('sidebar.promptNotebook')
  const panelReady = await waitFor('ps-prompt-panel-visible', () => Boolean(activeNotebookElement()), 8000)
  _assert('PS-00-panel-visible', panelReady)
  const apiReady = await waitFor('prompt-sender-api', () => Boolean(getApi() && getPromptNotebookApi() && inputSettingsSnapshot()), 8000)
  if (!apiReady || !panelReady) {
    _assert('PS-00-api-available', false, { reason: 'Visible sender not ready' })
    return results
  }

  const setDraft = async (content: string) => {
    getPromptNotebookApi()?.setEditorContent(content)
    return await waitFor('ps-draft-prepared', () => editorValue() === content, 3000, 40)
  }
  const clearSelection = async () => {
    getApi()!.deselectAllTerminals()
    return await waitFor('ps-selection-cleared', () => getApi()!.getSelectedCount() === 0, 3000, 40)
  }
  const clickAction = async (id: string) => {
    const button = actionButton(id)
    if (!button || button.disabled) return false
    // Observe a new busy/error commit so a stale model result cannot certify
    // a disconnected click handler. Text-bearing cases also require new history
    // or a child-process file side effect, independently of this UI witness.
    let changed = false
    const observer = new MutationObserver(records => {
      changed ||= records.some(record => (record.target instanceof Element && (
        record.target.matches('.prompt-sender-btn, .prompt-sender-notice')
        || Boolean(record.target.closest('.prompt-sender-notice'))
      )) || Array.from(record.addedNodes).concat(Array.from(record.removedNodes))
        .some(node => node instanceof Element && node.matches('.prompt-sender-notice')))
    })
    observer.observe(activeNotebookElement()!, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      button.click()
      await paintTurn()
      return await waitFor(`ps-${id}-settled`, () => changed && Boolean(getApi() && !getApi()!.isSubmitting()
        && getApi()!.getNotice()), 5000, 40)
    } finally {
      observer.disconnect()
    }
  }
  const waitForAsync = async (label: string, predicate: () => Promise<boolean>, timeoutMs = 5000) => {
    const deadline = performance.now() + timeoutMs
    while (!cancelled() && performance.now() < deadline) {
      if (await predicate()) return true
      await sleep(40)
    }
    log('timeout', { label, timeoutMs })
    return false
  }

  // PS-01: Terminal card rendering
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    _assert('PS-01-terminal-cards', cards.length > 0, {
      count: cards.length,
      sample: cards.slice(0, 3).map(c => ({ id: c.id, title: c.title }))
    })
  }

  // PS-02: the Task selector is the same shape as the Task grid.
  // Read BOTH sides from real computed CSS rather than from the expected
  // mapping: a table that agrees with itself proves nothing, and the failure
  // mode we care about ("the grid moved to 4x2 and the selector stayed 2xN")
  // only shows up when the two are compared directly.
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const senderGrid = senderGridElement()
    const taskGrid = visibleTaskGridElement()
    const senderTracks = senderGrid ? readGridTracks(senderGrid) : null
    const taskTracks = taskGrid ? readGridTracks(taskGrid) : null
    const gridAutoFlow = senderGrid ? window.getComputedStyle(senderGrid).gridAutoFlow : null
    const isRowFlow = typeof gridAutoFlow === 'string' && gridAutoFlow.startsWith('row')
    const mirrored = senderTracks !== null
      && taskTracks !== null
      && senderTracks.columns === taskTracks.columns
      && senderTracks.rows === taskTracks.rows
    const apiAgrees = senderTracks !== null
      && layout.columns === senderTracks.columns
      && layout.rows === senderTracks.rows
    _assert('PS-02-grid-layout-mirrors-task-grid', mirrored && apiAgrees && isRowFlow, {
      dataLayout: taskGrid?.getAttribute('data-layout') ?? null,
      layoutKind: layout.layoutKind,
      senderTracks,
      taskTracks,
      apiColumns: layout.columns,
      apiRows: layout.rows,
      totalCards: layout.totalCards,
      gridAutoFlow
    })
  }

  // Drive the same card clicks a user makes, including their delayed toggle.
  if (!cancelled()) {
    await repeat('PS-03-select-terminal', async () => {
      await clearSelection()
      const card = senderGridElement()?.querySelector<HTMLElement>('.prompt-sender-terminal')
      card?.click()
      const selected = await waitFor('ps-card-click-selected', () => card?.getAttribute('aria-pressed') === 'true', 3000, 40)
      return { ok: selected && getApi()!.getSelectedTerminalIds().includes(card?.dataset.terminalId ?? ''),
        selectedIds: getApi()!.getSelectedTerminalIds() }
    })
  }

  // PS-04: Click to uncheck
  if (!cancelled()) {
    await repeat('PS-04-deselect-terminal', async () => {
      const card = senderGridElement()?.querySelector<HTMLElement>('.prompt-sender-terminal')
      getApi()!.selectTerminal(card?.dataset.terminalId ?? '')
      await waitFor('ps-card-selected-before-clear', () => card?.getAttribute('aria-pressed') === 'true', 3000, 40)
      card?.click()
      const cleared = await waitFor('ps-card-click-cleared', () => card?.getAttribute('aria-pressed') === 'false', 3000, 40)
      return { ok: cleared && getApi()!.getSelectedCount() === 0 }
    })
  }

  // PS-05: Selection summary tracks the selected count
  if (!cancelled()) {
    await repeat('PS-05-selection-summary', async () => {
      const api = getApi()!
      const cards = api.getTerminalCards()
      if (!cards.length) return { ok: false, reason: 'No visible Tasks' }
      await clearSelection()
      const expectedCount = Math.min(cards.length, 2)
      const expectedActiveIds = cards.slice(0, expectedCount).map(card => card.id)
      expectedActiveIds.forEach(id => api.selectTerminal(id))
      const rendered = await waitFor('ps-selection-summary-rendered', () => activeNotebookElement()
        ?.querySelectorAll('.prompt-sender-selection-cell.is-active').length === expectedCount, 3000, 40)
      const cells = Array.from(activeNotebookElement()?.querySelectorAll<HTMLElement>('.prompt-sender-selection-cell') ?? [])
      const indicatorCellIds = cells.map(cell => cell.dataset.terminalId ?? '')
      const activeIndicatorIds = cells.filter(cell => cell.classList.contains('is-active')).map(cell => cell.dataset.terminalId ?? '')
      return { ok: rendered && api.getSelectedCount() === expectedCount
        && api.getSelectedTerminalIds().join('|') === expectedActiveIds.join('|')
        && indicatorCellIds.join('|') === cards.map(card => card.id).join('|')
        && activeIndicatorIds.join('|') === expectedActiveIds.join('|'),
        indicatorCellIds, activeIndicatorIds, expectedActiveIds }
    })
    await clearSelection()
  }

  // Preset expectations are independent of the production default factory.
  if (!cancelled()) {
    const expected = [
      ['sendAndExecute', true, 'Enter', 'default'], ['execute', false, 'Enter', 'default'],
      ['send', true, 'None', 'default'], ['sendAllAndExecute', true, 'Enter', 'all'],
      ['queue', true, 'Tab', 'default']
    ]
    const config = inputSettingsSnapshot()
    const buttons = actionLabels()
    const labelsMatch = buttons.length === PRESET_IDS.length && buttons.every((button, index) => {
      const key = `promptInput.action.${PRESET_IDS[index]}`
      return button.id === PRESET_IDS[index] && button.label === translated(key) && button.label !== key
    })
    const presetValues = config?.actions.map(action => [action.id, action.includePrompt, action.terminalKey, action.target])
    _assert('PS-06-action-buttons', labelsMatch && config?.leader === null && config.timeoutMs === 1500
      && JSON.stringify(presetValues) === JSON.stringify(expected), { buttons, presetValues, leader: config?.leader })
  }

  // No manual selection is required when the current Tab has an active Task.
  if (!cancelled()) {
    await repeat('PS-07-active-target-without-manual-selection', async index => {
      await clearSelection()
      const prepared = await setDraft(`# PS-enable-${index}`)
      const enabled = await waitFor('ps-default-target-enabled', () => actionLabels().length === 5
        && actionLabels().every(button => !button.disabled), 3000, 40)
      return { ok: prepared && enabled && getApi()!.getSelectedCount() === 0, buttons: actionLabels() }
    })
  }

  // PS-08: Quickly select/cancel 20 times
  if (!cancelled()) {
    await repeat('PS-08-rapid-toggle', async () => {
      await clearSelection()
      const card = senderGridElement()?.querySelector<HTMLElement>('.prompt-sender-terminal')
      let matched = 0
      for (let index = 0; index < 20 && !cancelled(); index++) {
        card?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
        const expected = index % 2 === 0
        if (await waitFor('ps-toggle-rendered', () => card?.getAttribute('aria-pressed') === String(expected), 3000, 40)) matched++
      }
      return { ok: Boolean(card) && matched === 20 && getApi()!.getSelectedCount() === 0, matched }
    })
  }

  // PS-09: Multi-terminal layout detection (depends on the current number of terminals)
  if (!cancelled()) {
    const api = getApi()!
    const cards = api.getTerminalCards()
    const layout = api.getGridLayout()
    _assert('PS-09-layout-consistency', layout.totalCards === cards.length, {
      totalCards: layout.totalCards,
      actualCards: cards.length,
      columns: layout.columns,
      rows: layout.rows
    })
  }

  // A file written by a real child proves execution; echoed command text does not.
  if (!cancelled()) {
    await repeat('PS-10-send-and-execute-single-line', async index => {
      const output = `ps-executed-${Date.now()}-${index}.txt`
      await clearSelection()
      const command = `node "./prompt-shell-ready.cjs" "${output}"`
      const prepared = await setDraft(command)
      const absentBefore = !(await window.electronAPI.project.readFile(rootPath, output)).success
      const clicked = await clickAction('sendAndExecute')
      try {
        const executed = await waitForAsync('ps-execution-created-file', async () => {
          const result = await window.electronAPI.project.readFile(rootPath, output)
          return result.success && result.content === 'ready'
        }, window.electronAPI.platform === 'win32' ? 8000 : 5000)
        const cleared = await waitFor('ps-success-cleared-draft', () => editorValue() === '', 3000, 40)
        const matchingHistory = getPromptNotebookApi()?.getPrompts().filter(prompt => prompt.content === command) ?? []
        return { ok: prepared && absentBefore && clicked && executed && cleared && matchingHistory.length === 1,
          executed, cleared, historyEntries: matchingHistory.length }
      } finally {
        await window.electronAPI.project.deletePath(rootPath, output)
      }
    })
  }

  const getLayoutNotebook = () => {
    return activeNotebookElement()
  }

  // PS-31: Terminals grid no longer has the legacy 140px hard cap
  if (!cancelled()) {
    const notebook = getLayoutNotebook()
    const grid = notebook?.querySelector('.prompt-sender-terminals') as HTMLElement | null
    if (grid) {
      const style = window.getComputedStyle(grid)
      const maxHeight = style.maxHeight
      const overflowY = style.overflowY
      const isUncapped = maxHeight === 'none' || maxHeight === '' || !maxHeight.endsWith('140px')
      _assert('PS-31-terminals-no-hard-cap', isUncapped && overflowY === 'auto', {
        maxHeight,
        overflowY
      })
    } else {
      _assert('PS-31-terminals-no-hard-cap', false, { reason: 'grid element not found' })
    }
  }

  // PS-32: Sender container enforces the 50% ceiling of the notebook
  if (!cancelled()) {
    const notebook = getLayoutNotebook()
    const sender = notebook?.querySelector('.prompt-sender') as HTMLElement | null
    if (sender && notebook) {
      const senderHeight = sender.getBoundingClientRect().height
      const notebookHeight = notebook.getBoundingClientRect().height
      const ceiling = notebookHeight * 0.5
      // 2px tolerance for sub-pixel rounding
      const withinCeiling = senderHeight <= ceiling + 2
      const senderMaxHeight = window.getComputedStyle(sender).maxHeight
      // Electron/Chromium may return the literal '50%' or a resolved px value.
      // Accept either: string ending with '%' and equals '50%', OR a px value
      // that is approximately half of the notebook height.
      const maxHeightRule = senderMaxHeight === '50%'
      const maxHeightPx = parseFloat(senderMaxHeight)
      const maxHeightPxHalf = senderMaxHeight.endsWith('px')
        && Number.isFinite(maxHeightPx)
        && Math.abs(maxHeightPx - ceiling) <= 2
      const maxHeightOk = maxHeightRule || maxHeightPxHalf
      _assert('PS-32-sender-respects-50-percent-cap', withinCeiling && maxHeightOk, {
        senderHeight,
        notebookHeight,
        ceiling,
        senderMaxHeight,
        maxHeightPx
      })
    } else {
      _assert('PS-32-sender-respects-50-percent-cap', false, { reason: 'sender or notebook not found' })
    }
  }

  // PS-33: Editor is compressible (flex-shrink: 1) with a 180px floor
  if (!cancelled()) {
    const notebook = getLayoutNotebook()
    const editor = notebook?.querySelector('.prompt-editor') as HTMLElement | null
    if (editor) {
      const style = window.getComputedStyle(editor)
      const minHeight = style.minHeight
      const flexShrink = style.flexShrink
      const minHeightPx = parseFloat(minHeight)
      const minHeightOk = Number.isFinite(minHeightPx) && Math.abs(minHeightPx - 180) <= 1
      const shrinkOk = flexShrink === '1'
      _assert('PS-33-editor-compressible-with-floor', minHeightOk && shrinkOk, {
        minHeight,
        flexShrink
      })
    } else {
      _assert('PS-33-editor-compressible-with-floor', false, { reason: 'editor element not found' })
    }
  }

  // PS-34: every card sits on the rectangle its Task occupies in the grid,
  // in the same DOM order as the Task array. This is the assertion that keeps
  // drag-to-rearrange honest: reordering rewrites the Task array, and BOTH
  // grids re-derive placement from it, so card N and grid cell N must always
  // name the same terminal.
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const senderGrid = senderGridElement()
    const cards = senderGrid
      ? Array.from(senderGrid.querySelectorAll<HTMLElement>('.prompt-sender-terminal'))
      : []
    const cardIds = cards.map(card => card.dataset.terminalId ?? '')
    const slotIds = layout.slots.map(slot => slot.terminalId)
    const gridCellIds = Array.from(
      visibleTaskGridElement()?.querySelectorAll<HTMLElement>('.terminal-grid-cell') ?? []
    ).map(cell => cell.dataset.terminalId ?? '')
    const areas = cards.map(readGridArea)
    const areasMatch = areas.every((area, index) => {
      const slot = layout.slots[index]
      return slot
        && area.colStart === slot.colStart
        && area.colSpan === slot.colSpan
        && area.rowStart === slot.rowStart
        && area.rowSpan === slot.rowSpan
    })
    // The grid can hold MORE cells than the selector shows only if the two
    // disagree about the effective Task count, so compare the shared prefix
    // and require the selector to cover every visible grid cell.
    const orderMatchesGrid = cardIds.length === gridCellIds.length
      && cardIds.every((id, index) => id === gridCellIds[index])
    _assert(
      'PS-34-cards-mirror-grid-slots',
      cards.length > 0 && areasMatch && orderMatchesGrid && cardIds.join('|') === slotIds.join('|'),
      { cardIds, slotIds, gridCellIds, areas, slots: layout.slots }
    )
  }

  // PS-35: the selection swatch beside the action buttons uses the same
  // scale model — same tracks, same rectangles — so it reads as a miniature
  // of the layout rather than a second, contradictory one.
  if (!cancelled()) {
    const api = getApi()!
    const layout = api.getGridLayout()
    const notebook = getLayoutNotebook()
    const indicator = notebook?.querySelector<HTMLElement>('.prompt-sender-selection-indicator') ?? null
    const cells = indicator
      ? Array.from(indicator.querySelectorAll<HTMLElement>('.prompt-sender-selection-cell'))
      : []
    const tracks = indicator ? readGridTracks(indicator) : null
    const areasMatch = cells.every((cell, index) => {
      const slot = layout.slots[index]
      const area = readGridArea(cell)
      return slot
        && area.colStart === slot.colStart
        && area.colSpan === slot.colSpan
        && area.rowStart === slot.rowStart
        && area.rowSpan === slot.rowSpan
    })
    _assert(
      'PS-35-selection-indicator-mirrors-layout',
      tracks !== null
        && tracks.columns === layout.columns
        && tracks.rows === layout.rows
        && cells.length === layout.slots.length
        && areasMatch,
      { tracks, apiColumns: layout.columns, apiRows: layout.rows, cells: cells.length }
    )
  }

  // PS-36: a slot too narrow for a name shows the Task's position number
  // instead. Both branches are asserted from a real layout pass — the grid is
  // temporarily forced narrow and then wide, because the panel width alone
  // cannot reach both sides of the threshold in one run. The override is
  // reverted before the assertion returns.
  if (!cancelled()) {
    const senderGrid = senderGridElement()
    const firstCard = senderGrid?.querySelector<HTMLElement>('.prompt-sender-terminal') ?? null
    const name = firstCard?.querySelector<HTMLElement>('.prompt-sender-terminal-name') ?? null
    const index = firstCard?.querySelector<HTMLElement>('.prompt-sender-terminal-index') ?? null
    if (senderGrid && firstCard && name && index) {
      const originalWidth = senderGrid.style.width
      const restored: boolean[] = []
      const measure = async (width: string) => {
        senderGrid.style.width = width
        // Two frames: one for the style change to land, one for the container
        // query to re-evaluate against the new layout.
        await paintTurn()
        return {
          cardWidth: Math.round(firstCard.getBoundingClientRect().width),
          nameShown: window.getComputedStyle(name).display !== 'none',
          indexShown: window.getComputedStyle(index).display !== 'none'
        }
      }
      // 40px is under the 44px content-box threshold even for a ONE-column
      // layout (6px padding + 1px border each side), so the narrow branch is
      // reachable whatever layout the suite inherited; 640px clears it for
      // every layout up to 4 columns.
      await repeat('PS-36-narrow-slot-shows-position-number', async () => {
        try {
          const narrow = await measure('40px')
          const wide = await measure('640px')
          return { ok: !narrow.nameShown && narrow.indexShown && wide.nameShown && !wide.indexShown, narrow, wide }
        } finally {
          senderGrid.style.width = originalWidth
          await paintTurn()
          restored.push(senderGrid.style.width === originalWidth)
        }
      })
      // The override must leave nothing behind: a stuck inline width would
      // silently break every later suite that reads this panel.
      _assert('PS-36b-width-override-reverted', restored.length === CORRECTNESS_TRIALS && restored.every(Boolean), {
        inlineWidth: senderGrid.style.width,
        originalWidth,
        restored,
        widthAfterRestore: Math.round(firstCard.getBoundingClientRect().width)
      })
    } else {
      _assert('PS-36-narrow-slot-shows-position-number', false, { reason: 'card or labels not found' })
    }
  }

  const openSettings = async (page: 'general' | 'shortcuts' = 'shortcuts') => {
    if (!window.__onwardSettingsDebug?.isOpen()) {
      document.querySelector<HTMLButtonElement>('[data-testid="sidebar-settings-button"]')?.click()
      if (!await waitFor('ps-settings-open', () => Boolean(window.__onwardSettingsDebug?.isOpen()), 4000, 40)) return false
    }
    const compact = document.querySelector<HTMLSelectElement>('[data-testid="settings-page-select"]')
    if (compact?.getClientRects().length) changeField(compact, page)
    else document.querySelector<HTMLButtonElement>(`[data-testid="settings-tab-${page}"]`)?.click()
    const ready = await waitFor('ps-settings-page', () => document.querySelector('.settings-content')?.getAttribute('data-settings-page') === page, 3000, 40)
    if (ready && page === 'shortcuts') {
      const toggle = document.querySelector<HTMLButtonElement>('[data-testid="prompt-input-expand"]')
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click()
      await paintTurn()
    }
    return ready
  }
  const closeSettings = async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="sidebar-settings-button"]')?.click()
    const closed = await waitFor('ps-settings-closed', () => !window.__onwardSettingsDebug, 4000, 40)
    if (!activeNotebookElement()) clickSidebarTitle('sidebar.promptNotebook')
    return closed && await waitFor('ps-prompt-visible-again', () => Boolean(activeNotebookElement()), 3000, 40)
  }
  const settingsRow = (id: string) => document.querySelector<HTMLElement>(`.prompt-input-action[data-prompt-action-id="${id}"]`)
  const rowIds = () => Array.from(document.querySelectorAll<HTMLOptionElement>('[data-testid="prompt-input-action-select"] option')).map(option => option.value)
  const selectSettingsAction = async (id: string) => {
    const select = document.querySelector<HTMLSelectElement>('[data-testid="prompt-input-action-select"]')
    if (select) changeField(select, id)
    await paintTurn()
    return Boolean(settingsRow(id))
  }
  const moveSettingsAction = async (id: string, direction: 'ArrowLeft' | 'ArrowRight') => {
    if (!await selectSettingsAction(id)) return false
    document.querySelector('[data-testid="prompt-input-action-select"]')?.dispatchEvent(new KeyboardEvent('keydown', {
      key: direction, code: direction, altKey: true, bubbles: true, cancelable: true
    }))
    await paintTurn()
    return true
  }
  const editAction = async (id: string, field: 'name' | 'visible' | 'include-prompt' | 'terminal-key' | 'target' | 'color', value: string | boolean) => {
    await selectSettingsAction(id)
    if (field === 'color') {
      settingsClick(`prompt-input-action-${id}-appearance`, settingsRow(id))
      await paintTurn()
    }
    const input = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-testid="prompt-input-action-${id}-${field}"]`)
    if (!input) return false
    if (typeof value === 'boolean') {
      if (!(input instanceof HTMLInputElement)) return false
      if (input.checked !== value) input.click()
    } else changeField(input, value)
    await paintTurn()
    const changed = typeof value === 'boolean' ? (input as HTMLInputElement).checked === value : input.value === value
    if (field === 'color') { settingsClick('prompt-emoji-close'); await paintTurn() }
    return changed
  }
  const settingsClick = (testId: string, root: ParentNode | null = document) => {
    const button = root?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
    if (!button || button.disabled) return false
    button.click()
    return true
  }
  const waitForSettingsSaveReady = () => waitFor('ps-settings-dirty-before-save', () => {
    const status = document.querySelector('[data-testid="prompt-input-status"][data-state="dirty"]')
    const button = document.querySelector<HTMLButtonElement>('[data-testid="prompt-input-save"]')
    return Boolean(status && button && !button.disabled)
  }, 3000, 40)
  const saveInputSettings = async (expected: (settings: PromptInputSettings) => boolean) => {
    // Require a fresh dirty -> saved transition; prior success copy is not an ACK.
    const clicked = await waitForSettingsSaveReady() && settingsClick('prompt-input-save')
    const acknowledged = clicked && await waitFor('ps-settings-save-ack', () => {
      const status = document.querySelector('[data-testid="prompt-input-status"][data-state="saved"][role="status"]')?.textContent?.trim()
      return status === translated('promptInput.settings.saved')
        && status !== 'promptInput.settings.saved' && Boolean(inputSettingsSnapshot() && expected(inputSettingsSnapshot()!))
    }, 5000, 40)
    // The rendered success alone is insufficient: read back the real main-process store.
    const durable = acknowledged && await waitForAsync('ps-settings-durable-ack', async () => {
      const settings = await window.electronAPI.settings.load()
      return expected(settings.promptInput)
    })
    return Boolean(clicked && acknowledged && durable)
  }
  const recordBinding = async (element: HTMLElement | null | undefined, key: string, code: string, modifiers: KeyboardEventInit = {}) => {
    if (!element) return false
    element.click()
    if (!await waitFor('ps-shortcut-recorder-open', () => element.dataset.recording === 'ready', 3000, 40)) return false
    // This configures the recorder UI, not the production shortcut dispatcher.
    // Trusted physical shortcut delivery is owned by the main-process CDP suite.
    element.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...modifiers }))
    return await waitFor('ps-shortcut-recorder-closed', () => element.dataset.recording === 'idle', 3000, 40)
  }
  const historySnapshot = () => JSON.stringify(getPromptNotebookApi()?.getPrompts() ?? [])

  await repeat('PS-37-key-only-keeps-draft-and-history', async index => {
    const cases: Array<Record<string, unknown> & { ok: boolean }> = []
    for (const content of ['', '  \n\t ', `Unsent draft ${index} \u4e2d\u6587`]) {
      const prepared = await setDraft(content)
      const title = activeNotebookElement()?.querySelector<HTMLInputElement>('.prompt-editor-title')
      if (title) changeField(title, `Unsent title ${index}`)
      await paintTurn()
      const before = historySnapshot()
      const completed = await clickAction('execute')
      cases.push({ ok: prepared && completed && editorValue() === content && title?.value === `Unsent title ${index}`
        && historySnapshot() === before && !activeNotebookElement()?.querySelector('.prompt-sender-notice'),
        completed, draftLength: content.length, draftPreserved: editorValue() === content, historyPreserved: historySnapshot() === before })
    }
    return { ok: cases.length === 3 && cases.every(result => result.ok), cases }
  })
  const selectEmoji = async (id: string, sample: typeof appearanceAcceptance.emojiSamples[number]) => {
    await selectSettingsAction(id)
    settingsClick(`prompt-input-action-${id}-appearance`, settingsRow(id))
    await paintTurn()
    const search = document.querySelector<HTMLInputElement>('[data-testid="prompt-emoji-search"]')
    if (!search) return false
    changeField(search, sample.query)
    const ready = await waitFor('ps-emoji-search-ready', () => {
      const option = document.querySelector<HTMLButtonElement>(`[data-testid="prompt-emoji-option-${sample.key}"]`)
      return Boolean(option && !option.disabled && option.querySelector('img')?.naturalWidth)
    }, 5000, 40)
    if (ready) settingsClick(`prompt-emoji-option-${sample.key}`)
    await paintTurn()
    return ready && settingsRow(id)?.querySelector('.prompt-input-appearance [data-emoji]')?.getAttribute('data-emoji') === sample.emoji
  }

  await repeat('PS-38-empty-draft-never-falls-back-to-history', async () => {
    const prior = getPromptNotebookApi()?.getPrompts()[0]
    if (!prior || !getPromptNotebookApi()?.selectPrompt?.(prior.id)) return { ok: false, reason: 'History setup missing' }
    const cases: Array<Record<string, unknown> & { ok: boolean }> = []
    for (const content of ['', '  \n\t ']) {
      const prepared = await setDraft(content)
      const before = historySnapshot()
      let rejected = 0
      for (const id of ['sendAndExecute', 'send', 'sendAllAndExecute', 'queue']) {
      // A fresh successful action removes the previous error, making the next rejection observable even
        // though all four empty-draft errors intentionally have identical copy.
        const resetNotice = await clickAction('execute')
        const completed = await clickAction(id)
        const notice = activeNotebookElement()?.querySelector('.prompt-sender-notice')
        if (resetNotice && completed && notice?.getAttribute('role') === 'alert'
          && notice.textContent === translated('promptInput.runtime.empty')) rejected++
      }
      cases.push({ ok: prepared && rejected === 4 && editorValue() === content && historySnapshot() === before,
        draftLength: content.length, rejected, historyPreserved: historySnapshot() === before })
    }
    return { ok: cases.length === 2 && cases.every(result => result.ok), cases }
  })

  // Use two real Tasks so default, manual and all cannot accidentally agree.
  clickSidebarTitle('sidebar.layout.double')
  const twoTasks = await waitFor('ps-two-tasks-visible', () => getApi()?.getTerminalCards().length === 2
    && visibleTaskGridElement()?.querySelectorAll('.terminal-grid-cell').length === 2, 10000, 80)
  _assert('PS-39a-two-task-setup', twoTasks)
  await repeat('PS-39-target-priority-and-retained-selection', async index => {
    const cards = getApi()?.getTerminalCards() ?? []
    if (!twoTasks || cards.length !== 2) return { ok: false, reason: 'Two distinct visible Tasks are required' }
    window.__onwardAppDebug?.triggerShortcutAction({ type: 'focusTerminal', index: 2 })
    const active = await waitFor('ps-second-task-active', () => visibleTaskGridElement()
      ?.querySelector<HTMLElement>('.terminal-grid-cell.active')?.dataset.terminalId === cards[1].id, 3000, 40)
    const historyCases: Array<Record<string, unknown> & { ok: boolean }> = []
    for (const scenario of [
      { name: 'default', action: 'send', selection: [], expected: [2] },
      { name: 'manual', action: 'send', selection: [cards[0].id], expected: [1] },
      { name: 'all', action: 'sendAllAndExecute', selection: [cards[0].id], expected: [1, 2] }
    ]) {
      await clearSelection()
      scenario.selection.forEach(id => getApi()!.selectTerminal(id))
      await waitFor('ps-target-selection-prepared', () => getApi()!.getSelectedTerminalIds().join('|') === scenario.selection.join('|'), 3000, 40)
      const shell = await window.electronAPI.terminal.getInputCapabilities(cards[0].id)
      const content = `${shell.shellKind === 'cmd' ? 'REM' : '#'} PS-${scenario.name}-${index}-${Date.now()}`
      await setDraft(content)
      const completed = await clickAction(scenario.action)
      const recorded = await waitFor('ps-target-history-visible', () => getPromptNotebookApi()?.getPrompts()
        .some(prompt => prompt.content === content) ?? false, 3000, 40)
      const matches = promptHistory().filter(prompt => prompt.content === content)
      const records = matches[0]?.sendHistory ?? []
      const expectedIds = scenario.expected.map(number => cards[number - 1].id)
      historyCases.push({ ok: completed && recorded && matches.length === 1
        && matches[0].taskNumbers.join('|') === scenario.expected.join('|')
        && matches[0].sendHistoryCount === scenario.expected.length
        && records.map(record => record.taskId).sort().join('|') === [...expectedIds].sort().join('|')
        && records.every(record => record.inputActionId === scenario.action && record.inputResult?.ok)
        && getApi()!.getSelectedTerminalIds().join('|') === scenario.selection.join('|') && editorValue() === '',
        scenario: scenario.name, taskNumbers: matches[0]?.taskNumbers, count: matches.length,
        selectedIds: getApi()!.getSelectedTerminalIds() })
    }
    return { ok: active && historyCases.every(result => result.ok), active, historyCases }
  })

  let customId = ''
  let customName = ''
  await repeat('PS-40-custom-action-explicit-save-roundtrip', async index => {
    if (!await openSettings()) return { ok: false, reason: 'Settings did not open' }
    const baseline = settingsSignature(inputSettingsSnapshot())
    if (!customId) {
      const beforeIds = new Set(rowIds())
      settingsClick('prompt-input-add')
      await waitFor('ps-custom-action-added', () => rowIds().some(id => !beforeIds.has(id)), 3000, 40)
      customId = rowIds().find(id => !beforeIds.has(id)) ?? ''
    }
    customName = `Review \u4e2d\u6587 ${index} ${'long custom action '.repeat(3)}`.trimEnd()
    const includePrompt = index % 2 === 1
    const terminalKey = ['Tab', 'None', 'Shift+Tab', 'Enter', 'Control+C'][index]
    const target = index % 2 === 0 ? 'all' : 'default'
    const color = ['#3070a0', '#bc6a85', '#5ea76b', '#9e80cd', '#d79745'][index]
    const emoji = appearanceAcceptance.emojiSamples[index]
    const fields = await editAction(customId, 'name', customName)
      && await editAction(customId, 'terminal-key', terminalKey)
      && await editAction(customId, 'include-prompt', includePrompt)
      && await editAction(customId, 'target', target)
      && await editAction(customId, 'color', color)
      && await selectEmoji(customId, emoji)
    let recorded = true
    if (index === 0) {
      recorded = await recordBinding(document.querySelector<HTMLElement>('[data-testid="prompt-input-leader"]'), 'L', 'KeyL', {
        ctrlKey: true, altKey: true, shiftKey: true
      }) && await recordBinding(settingsRow(customId)?.querySelector<HTMLElement>(`[data-testid="prompt-input-action-${customId}-shortcut"]`), 'j', 'KeyJ', { ctrlKey: true })
    }
    const unchangedBeforeSave = settingsSignature(inputSettingsSnapshot()) === baseline
      && settingsSignature((await window.electronAPI.settings.load()).promptInput) === baseline
    const saved = await saveInputSettings(config => {
      const action = config.actions.find(candidate => candidate.id === customId)
      return config.leader === 'Control+Alt+Shift+L' && config.actions.length === 6
        && action?.name === customName && action.includePrompt === includePrompt
        && action.terminalKey === terminalKey && action.target === target && action.shortcut === 'Control+J' && action.color === color && action.emoji === emoji.emoji
    })
    const closed = await closeSettings()
    const shown = await waitFor('ps-custom-toolbar-label', () => actionLabels().some(button => button.id === customId && button.label === customName)
      && actionButton(customId)?.style.getPropertyValue('--prompt-action-color') === color
      && actionButton(customId)?.querySelector('[data-emoji]')?.getAttribute('data-emoji') === emoji.emoji
      && Boolean(actionButton(customId)?.querySelector('img')?.naturalWidth), 3000, 40)
    await clearSelection()
    const cards = getApi()?.getTerminalCards() ?? []
    const activeId = visibleTaskGridElement()?.querySelector<HTMLElement>('.terminal-grid-cell.active')?.dataset.terminalId
    const shell = activeId ? await window.electronAPI.terminal.getInputCapabilities(activeId) : null
    const content = includePrompt
      ? `${shell?.shellKind === 'cmd' ? 'REM' : '#'} PS-custom-${index}-${Date.now()}`
      : `Unsent custom-action draft ${index} \u4e2d\u6587`
    const prepared = await setDraft(content)
    const historyBefore = historySnapshot()
    const clicked = await clickAction(customId)
    const expectedIds = target === 'all' ? cards.map(card => card.id) : [activeId ?? '']
    const entries = promptHistory().filter(prompt => prompt.content === content)
    const records = entries[0]?.sendHistory ?? []
    const delivered = Boolean(getApi()?.getNotice()) && !activeNotebookElement()?.querySelector('.prompt-sender-notice')
    const semantics = includePrompt
      ? editorValue() === '' && entries.length === 1 && records.length === expectedIds.length
        && records.map(record => record.taskId).sort().join('|') === expectedIds.sort().join('|')
        && records.every(record => record.inputActionId === customId && record.inputTerminalKey === terminalKey
          && record.inputResult?.ok && record.inputResult.contentDelivered)
      : editorValue() === content && historyBefore === historySnapshot()
    return { ok: fields && recorded && unchangedBeforeSave && saved && closed && shown && prepared && clicked && delivered && semantics,
      fields, recorded, unchangedBeforeSave, saved, shown, customId, includePrompt, terminalKey, target, clicked, semantics }
  })

  await repeat('PS-41-hide-show-reorder-keeps-action-identity', async () => {
    if (!customId || !await openSettings()) return { ok: false, reason: 'Custom action setup missing' }
    const before = rowIds()
    const position = before.indexOf(customId)
    const expectedOrder = [...before]
    ;[expectedOrder[position - 1], expectedOrder[position]] = [expectedOrder[position], expectedOrder[position - 1]]
    const hidden = await editAction('queue', 'visible', false)
    const moved = position > 0 && await moveSettingsAction(customId, 'ArrowLeft')
    await paintTurn()
    const orderChanged = rowIds().join('|') === expectedOrder.join('|')
    const saved = await saveInputSettings(config => config.actions.map(action => action.id).join('|') === expectedOrder.join('|')
      && config.actions.find(action => action.id === 'queue')?.visible === false
      && config.actions.find(action => action.id === 'queue')?.shortcut === 'Q')
    await closeSettings()
    const hiddenButtons = actionLabels()
    const reflected = hiddenButtons.map(button => button.id).join('|') === expectedOrder.filter(id => id !== 'queue').join('|')
      && actionButton(customId)?.getAttribute('aria-label') === customName
    await openSettings()
    const shown = await editAction('queue', 'visible', true)
    const restored = await moveSettingsAction(customId, 'ArrowRight')
    await paintTurn()
    const resaved = await saveInputSettings(config => config.actions.map(action => action.id).join('|') === before.join('|')
      && config.actions.find(action => action.id === 'queue')?.visible === true)
    await closeSettings()
    return { ok: hidden && moved && orderChanged && saved && reflected && shown && restored && resaved
      && actionLabels().map(button => button.id).join('|') === before.join('|'),
      orderChanged, reflected, hiddenIds: hiddenButtons.map(button => button.id), saved, resaved }
  })

  await repeat('PS-42-invalid-config-cannot-replace-saved-actions', async () => {
    if (!customId || !await openSettings()) return { ok: false, reason: 'Custom action setup missing' }
    const before = settingsSignature(inputSettingsSnapshot())
    const cases: Array<{ field: string; ok: boolean; prepared: boolean; clicked: boolean; rejected: boolean }> = []
    for (const invalid of ['timeout-low', 'timeout-high', 'empty-name', 'no-input']) {
      let prepared = false
      if (invalid.startsWith('timeout')) {
        const field = document.querySelector<HTMLInputElement>('[data-testid="prompt-input-timeout"]')
        const value = invalid === 'timeout-low' ? '499' : '10001'
        if (field) {
          changeField(field, value)
          prepared = field.value === value
        }
      } else if (invalid === 'empty-name') prepared = await editAction(customId, 'name', '   ')
      else {
        prepared = await editAction(customId, 'terminal-key', 'None')
          && await editAction(customId, 'include-prompt', false)
      }
      await paintTurn()
      const clicked = prepared && await waitForSettingsSaveReady() && settingsClick('prompt-input-save')
      const errorKey = invalid.startsWith('timeout') ? 'promptInput.settings.invalidTimeout' : 'promptInput.settings.invalidAction'
      const rejected = clicked && await waitFor('ps-invalid-config-alert', () => {
        const status = document.querySelector('[data-testid="prompt-input-status"][data-state="error"][role="alert"]')
        return status?.textContent?.trim() === translated(errorKey) && translated(errorKey) !== errorKey
      }, 3000, 40)
      const persisted = settingsSignature((await window.electronAPI.settings.load()).promptInput)
      cases.push({ field: invalid, ok: rejected && persisted === before && settingsSignature(inputSettingsSnapshot()) === before,
        prepared, clicked, rejected })
      settingsClick('prompt-input-cancel')
      await paintTurn()
    }
    await closeSettings()
    return { ok: cases.length === 4 && cases.every(result => result.ok), cases }
  })

  await repeat('PS-43-duplicate-delete-arbitrary-actions', async () => {
    if (!customId || !await openSettings()) return { ok: false, reason: 'Custom action setup missing' }
    const before = rowIds()
    await selectSettingsAction(customId)
    settingsClick(`prompt-input-action-${customId}-duplicate`, settingsRow(customId))
    const added = await waitFor('ps-duplicate-created', () => rowIds().length === before.length + 1, 3000, 40)
    const duplicateId = rowIds().find(id => !before.includes(id)) ?? ''
    const saved = await saveInputSettings(config => config.actions.length === 7
      && config.actions.some(action => action.id === duplicateId && action.shortcut === null && action.name.length > 0
        && action.emoji === config.actions.find(item => item.id === customId)?.emoji
        && action.color === config.actions.find(item => item.id === customId)?.color))
    await closeSettings()
    const rendered = actionLabels().length === 7 && Boolean(actionButton(customId)) && Boolean(actionButton(duplicateId))
    await openSettings()
    await selectSettingsAction(duplicateId)
    const deleted = settingsClick(`prompt-input-action-${duplicateId}-delete`, settingsRow(duplicateId))
    await paintTurn()
    const resaved = await saveInputSettings(config => config.actions.map(action => action.id).join('|') === before.join('|'))
    await closeSettings()
    return { ok: added && duplicateId !== customId && saved && rendered && deleted && resaved && actionLabels().length === 6,
      saved, rendered, deleted, resaved }
  })

  await repeat('PS-44-bilingual-controls-and-narrow-layout', async () => {
    const measurements: Array<Record<string, unknown> & { ok: boolean }> = []
    for (const locale of ['en', 'zh-CN'] as const) {
      await openSettings('general')
      const select = document.querySelector<HTMLSelectElement>('[data-testid="settings-language-select"]')
      if (select) changeField(select, locale)
      const localized = await waitFor('ps-language-applied', () => currentLocale() === locale, 3000, 40)
      await openSettings()
      for (const width of [300, 600]) {
        window.__onwardSettingsDebug?.setPanelWidth?.(width)
        await paintTurn()
        const root = document.querySelector<HTMLElement>('[data-testid="prompt-input-settings"]')
        const bounds = root?.getBoundingClientRect()
        const controls = Array.from(root?.querySelectorAll<HTMLElement>('input, select, button, .shortcut-input') ?? [])
        const overflow = controls.filter(control => {
          const rect = control.getBoundingClientRect()
          return !bounds || rect.width <= 0 || rect.height <= 0 || rect.left < bounds.left - 2 || rect.right > bounds.right + 2
        }).map(control => control.dataset.testid ?? control.tagName)
        const title = root?.querySelector('h3')?.textContent
        const expectedTitle = translated('promptInput.settings.title', locale)
        measurements.push({ ok: localized && Boolean(bounds && bounds.width > 0) && controls.length > 20 && overflow.length === 0
          && title?.endsWith(expectedTitle) === true && expectedTitle !== 'promptInput.settings.title'
          && !root?.textContent?.includes('promptInput.'), locale, width, overflow, title })
      }
      await closeSettings()
      const labels = actionLabels()
      const notebookBounds = activeNotebookElement()?.getBoundingClientRect()
      const toolbarFits = labels.every(label => {
        const button = actionButton(label.id)
        const rect = button?.getBoundingClientRect()
        return Boolean(rect && notebookBounds && rect.width > 0 && rect.height > 0
          && rect.left >= notebookBounds.left - 2 && rect.right <= notebookBounds.right + 2
          && button?.title.startsWith(label.label) && !button.title.includes('promptInput.'))
      })
      measurements.push({ ok: labels.length === 6 && PRESET_IDS.every(id => {
        const key = `promptInput.action.${id}`
        const expected = translated(key, locale)
        return labels.find(button => button.id === id)?.label === expected && expected !== key
          && (locale === 'en' || expected !== translated(key, 'en'))
      }) && labels.find(button => button.id === customId)?.label === customName && toolbarFits,
        locale, labels, toolbarFits })
    }
    return { ok: measurements.length === 6 && measurements.every(result => result.ok), measurements }
  })

  await repeat('PS-45-emoji-blocks-single-row-no-status', async () => {
    const buttons = Array.from(activeNotebookElement()?.querySelectorAll<HTMLButtonElement>('.prompt-sender-btn') ?? [])
    const rects = buttons.map(button => button.getBoundingClientRect())
    const gaps = rects.slice(1).map((rect, index) => rect.left - rects[index].right)
    const widths = rects.map(rect => rect.width)
    const rows = new Set(rects.map(rect => rect.top))
    return { ok: buttons.length === 6 && rows.size === 1 && rects.every(rect => rect.height === 24)
      && Math.max(...widths) - Math.min(...widths) < 1 && Math.max(...gaps) - Math.min(...gaps) < 1
      && buttons.every(button => button.textContent === '' && button.title.startsWith(button.getAttribute('aria-label') ?? '')
        && Boolean(button.querySelector('img')?.naturalWidth) && button.querySelector('img')?.getBoundingClientRect().height === 18)
      && !document.querySelector('.prompt-input-status, .prompt-input-target')
      && !activeNotebookElement()?.querySelector('.prompt-sender-notice[role="status"]'), rows: rows.size, widths, gaps }
  })

  // Restore the language/width for adjacent suites that may share this session.
  await openSettings('general')
  const language = document.querySelector<HTMLSelectElement>('[data-testid="settings-language-select"]')
  if (language) changeField(language, 'en')
  window.__onwardSettingsDebug?.setPanelWidth?.(400)
  await waitFor('ps-language-restored', () => currentLocale() === 'en', 3000, 40)
  await closeSettings()
  await clearSelection()
  await setDraft('')
  const required = ['PS-06-action-buttons', 'PS-10-send-and-execute-single-line',
    'PS-37-key-only-keeps-draft-and-history', 'PS-38-empty-draft-never-falls-back-to-history',
    'PS-39-target-priority-and-retained-selection', 'PS-40-custom-action-explicit-save-roundtrip',
    'PS-41-hide-show-reorder-keeps-action-identity', 'PS-42-invalid-config-cannot-replace-saved-actions',
    'PS-43-duplicate-delete-arbitrary-actions', 'PS-44-bilingual-controls-and-narrow-layout', 'PS-45-emoji-blocks-single-row-no-status']
  _assert('PS-99-contract-completed', !cancelled() && required.every(name => results.some(result => result.name === name && result.ok))
    && results.every(result => result.ok), { requiredCases: required.length, completed: results.length })

  log('phase1:done', {
    total: results.length,
    passed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length
  })

  return results
}
