/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

function parseTaskNumber(title: string): number | null {
  const match = title.match(/\bTask\s+(\d+)\b/i)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) && value > 0 ? value : null
}

export async function testPromptList(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  log('phase1.05:start', { suite: 'PromptList' })

  const notebookApi = () => window.__onwardPromptNotebookDebug
  const senderApi = () => window.__onwardPromptSenderDebug

  const apisReady = await waitFor('prompt-list-apis', () => {
    return Boolean(notebookApi() && senderApi())
  }, 8000, 120)
  if (!apisReady) {
    record('PL-00-api-available', false, { reason: 'Prompt list debug API not mounted' })
    return results
  }

  const cards = senderApi()!.getTerminalCards()
  record('PL-01-terminal-cards-available', cards.length > 0, {
    count: cards.length,
    titles: cards.map(card => card.title)
  })
  if (cards.length === 0 || cancelled()) return results

  const colorState = notebookApi()!.getColorFilterState?.()
  const taskState = notebookApi()!.getTaskFilterState?.()
  record('PL-02-filter-state-readable', Boolean(colorState && taskState && notebookApi()!.isFilterEnabled), {
    colorState,
    taskState,
    filterEnabled: notebookApi()!.isFilterEnabled?.()
  })

  const filterStartsDisabled = notebookApi()!.isFilterEnabled?.() === false
  record('PL-03-filter-default-disabled', filterStartsDisabled, {
    filterEnabled: notebookApi()!.isFilterEnabled?.(),
    colorState,
    taskState
  })

  const targetsStartsDisabled = notebookApi()!.isTargetsEnabled?.() === false
  record('PL-04-targets-default-disabled', targetsStartsDisabled, {
    targetsEnabled: notebookApi()!.isTargetsEnabled?.()
  })

  const promptContent = `PL-${Date.now()} prompt history marker`
  const beforeIds = new Set(notebookApi()!.getPrompts().map(prompt => prompt.id))
  senderApi()!.deselectAllTerminals()
  await sleep(100)
  senderApi()!.selectTerminal(cards[0].id)
  await sleep(120)
  notebookApi()!.setEditorContent(promptContent)
  const editorReady = await waitFor('pl-editor-content', () => {
    return notebookApi()!.getEditorContent() === promptContent
  }, 3000, 80)
  const clickedSend = await senderApi()!.clickAction('send')
  const idleAfterSend = await waitFor('pl-send-idle', () => {
    return !senderApi()!.isSubmitting()
  }, 5000, 80)
  const newPromptReady = await waitFor('pl-new-prompt', () => {
    return notebookApi()!.getPrompts().some(prompt => !beforeIds.has(prompt.id) && prompt.taskNumbers.length > 0)
  }, 5000, 80)

  const createdPrompt = notebookApi()!.getPrompts().find(prompt => !beforeIds.has(prompt.id)) ?? null
  const expectedFirstTaskNumber = parseTaskNumber(cards[0].title)
  const hiddenTaskHistoryElement = createdPrompt
    ? document.querySelector(`[data-prompt-id="${createdPrompt.id}"] .prompt-item-task-history`)
    : null
  record('PL-05-send-history-task-badge-data', Boolean(
    editorReady &&
    clickedSend &&
    idleAfterSend &&
    newPromptReady &&
    createdPrompt &&
    createdPrompt.taskNumbers.length >= 1 &&
    hiddenTaskHistoryElement === null &&
    (expectedFirstTaskNumber === null || createdPrompt.taskNumbers.includes(expectedFirstTaskNumber))
  ), {
    editorReady,
    clickedSend,
    idleAfterSend,
    newPromptReady,
    createdPrompt,
    hiddenTaskHistoryVisible: hiddenTaskHistoryElement !== null,
    expectedFirstTaskNumber
  })

  if (!createdPrompt || cancelled()) {
    return results
  }

  const targetsOpened = notebookApi()!.setTargetsEnabled?.(true) ?? false
  await sleep(120)
  const visibleTaskHistoryElement = document.querySelector(`[data-prompt-id="${createdPrompt.id}"] .prompt-item-task-history`) as HTMLElement | null
  record('PL-06-targets-toggle-shows-history', Boolean(
    targetsOpened &&
    visibleTaskHistoryElement &&
    visibleTaskHistoryElement.dataset.taskHistory &&
    createdPrompt.taskNumbers.every((taskNum) => visibleTaskHistoryElement.dataset.taskHistory?.includes(String(taskNum)))
  ), {
    targetsOpened,
    targetsEnabled: notebookApi()!.isTargetsEnabled?.(),
    taskHistory: visibleTaskHistoryElement?.dataset.taskHistory ?? null,
    taskNumbers: createdPrompt.taskNumbers
  })

  const filterOpened = notebookApi()!.setFilterEnabled?.(true) ?? false
  await sleep(120)
  const painted = notebookApi()!.setPromptColor?.(createdPrompt.id, 'red') ?? false
  await sleep(120)
  const colorApplied = notebookApi()!.getPrompts().find(prompt => prompt.id === createdPrompt.id)?.color === 'red'
  const colorFilterEnabled = notebookApi()!.setColorFilter?.('red') ?? false
  await sleep(120)
  const colorVisibleIds = notebookApi()!.getVisiblePromptItems?.().map(prompt => prompt.id) ?? []
  record('PL-07-color-filter', filterOpened && painted && colorApplied && colorFilterEnabled && colorVisibleIds.includes(createdPrompt.id), {
    filterOpened,
    painted,
    colorApplied,
    colorVisibleIds,
    colorState: notebookApi()!.getColorFilterState?.()
  })

  const taskNumber = createdPrompt.taskNumbers[0] ?? null
  const taskFilterEnabled = taskNumber !== null && (notebookApi()!.setTaskFilter?.(taskNumber) ?? false)
  await sleep(120)
  const taskVisibleItems = notebookApi()!.getVisiblePromptItems?.() ?? []
  record('PL-08-task-filter', Boolean(
    taskNumber !== null &&
    taskFilterEnabled &&
    taskVisibleItems.some(prompt => prompt.id === createdPrompt.id && prompt.taskNumbers.includes(taskNumber))
  ), {
    taskNumber,
    taskFilterEnabled,
    taskVisibleItems,
    taskState: notebookApi()!.getTaskFilterState?.()
  })

  const copied = await (notebookApi()!.copyPrompt?.(createdPrompt.id) ?? Promise.resolve(false))
  const clipboardText = await (
    window.electronAPI?.clipboard?.readText?.() ??
    navigator.clipboard.readText()
  ).catch(() => null)
  record('PL-09-copy-prompt-content', copied && clipboardText === promptContent, {
    copied,
    clipboardText,
    promptContent
  })

  const filterDisabled = notebookApi()!.setFilterEnabled?.(false) ?? false
  await sleep(120)
  const filterResetState = {
    filterEnabled: notebookApi()!.isFilterEnabled?.(),
    colorState: notebookApi()!.getColorFilterState?.(),
    taskState: notebookApi()!.getTaskFilterState?.(),
    visiblePromptIds: notebookApi()!.getVisiblePromptItems?.().map(prompt => prompt.id) ?? []
  }
  record('PL-10-filter-disable-resets-state', Boolean(
    filterDisabled &&
    filterResetState.filterEnabled === false &&
    filterResetState.colorState?.activeColor === null &&
    filterResetState.taskState?.activeTaskNumber === null &&
    filterResetState.visiblePromptIds.includes(createdPrompt.id)
  ), filterResetState)

  if (!cancelled()) {
    const promptElement = document.querySelector(`[data-prompt-id="${createdPrompt.id}"]`) as HTMLElement | null
    promptElement?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    const saveAsNewLabelReady = await waitFor('pl-save-as-new-label', () => {
      const labels = Array.from(document.querySelectorAll(
        '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
      )).map((button) => button.textContent?.trim() ?? '')
      return (
        (labels.includes('Add') || labels.includes('\u6dfb\u52a0')) &&
        !labels.includes('Save as new item') &&
        !labels.includes('\u4fdd\u5b58\u4e3a\u65b0\u6761\u76ee')
      )
    }, 3000, 80)
    const editButtonLabels = Array.from(document.querySelectorAll(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
    )).map((button) => button.textContent?.trim() ?? '')
    record('PL-11-save-as-new-button-label', Boolean(promptElement && saveAsNewLabelReady), {
      buttonLabels: editButtonLabels
    })
    const activeEditorContent = document.querySelector<HTMLElement>(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-content'
    )
    let escPreservedTrials = 0
    for (let trial = 0; trial < 5; trial += 1) {
      activeEditorContent?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
      await sleep(40)
      const stillEditing = document.querySelector(
        '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"]'
      ) !== null
      const liveText = activeEditorContent?.innerText ?? notebookApi()!.getEditorContent()
      if (stillEditing && liveText === promptContent) {
        escPreservedTrials += 1
      }
    }
    record('PL-11b-escape-does-not-cancel-edit', escPreservedTrials === 5, {
      trials: 5,
      preserved: escPreservedTrials
    })
    const isMac = window.electronAPI.platform === 'darwin'
    activeEditorContent?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: !isMac,
        metaKey: isMac,
        bubbles: true,
        cancelable: true
      })
    )
    const savedViaShortcut = await waitFor('pl-11c-ctrl-s-save', () => {
      return document.querySelector(
        '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"]'
      ) === null
    }, 3000, 60)
    record('PL-11c-ctrl-s-saves-edited-prompt', savedViaShortcut, {
      savedViaShortcut
    })
    if (!savedViaShortcut) {
      const cancelBtnFallback = Array.from(document.querySelectorAll(
        '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
      )).find((button) => {
        const label = button.textContent?.trim()
        return label === 'Cancel' || label === '\u53d6\u6d88'
      }) as HTMLButtonElement | undefined
      cancelBtnFallback?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      await sleep(120)
    }

    const selectPrompt = notebookApi()!.selectPrompt
    if (cards.length > 1 && selectPrompt) {
      senderApi()!.deselectAllTerminals()
      await sleep(100)
      senderApi()!.selectTerminal(cards[1].id)
      await sleep(100)
      selectPrompt(createdPrompt.id)
      await sleep(120)
      const clickedSecondSend = await senderApi()!.clickAction('send')
      const secondIdle = await waitFor('pl-second-send-idle', () => {
        return !senderApi()!.isSubmitting()
      }, 5000, 80)
      const multiTaskReady = await waitFor('pl-multi-task-history', () => {
        const prompt = notebookApi()!.getPrompts().find(item => item.id === createdPrompt.id)
        return Boolean(prompt && prompt.taskNumbers.length >= 2)
      }, 5000, 80)
      const updatedPrompt = notebookApi()!.getPrompts().find(prompt => prompt.id === createdPrompt.id) ?? null
      record('PL-12-multi-task-history', Boolean(clickedSecondSend && secondIdle && multiTaskReady), {
        clickedSecondSend,
        secondIdle,
        multiTaskReady,
        updatedPrompt,
        secondTaskTitle: cards[1].title
      })
    } else {
      record('PL-12-multi-task-history', true, {
        reason: 'single terminal layout or prompt selection debug API unavailable'
      })
    }
  }

  // ---- PL-13/14/15: draft auto-preservation on history double-click ----
  // Contract (2026-07-13): double-clicking a history prompt while the editor
  // holds content must FIRST auto-save that content into history, THEN load
  // the double-clicked prompt — unless the editor still holds the untouched
  // original of the entry being edited (no duplicate spam), or is empty.
  if (!cancelled()) {
    const dispatchRowDoubleClick = (promptId: string): boolean => {
      const row = document.querySelector<HTMLElement>(
        `.prompt-list-item[data-prompt-id="${CSS.escape(promptId)}"]`
      )
      if (!row) return false
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return true
    }
    const promptByContent = (content: string) =>
      notebookApi()!.getPrompts().find(prompt => prompt.content === content) ?? null

    // Seed a target history entry T to double-click on.
    const targetContent = `PL13-target ${Date.now()}`
    notebookApi()!.setEditorContent(targetContent)
    await waitFor('pl13-target-typed', () => notebookApi()!.getEditorContent() === targetContent, 4000, 80)
    notebookApi()!.submitEditor()
    const targetSeeded = await waitFor('pl13-target-seeded', () => Boolean(promptByContent(targetContent)), 4000, 80)
    const targetPrompt = promptByContent(targetContent)

    // PL-13: fresh draft in the editor → double-click T → draft saved as a
    // new entry AND T loaded into the editor, with the save toast visible.
    const draftContent = `PL13-draft ${Date.now()}`
    notebookApi()!.setEditorContent(draftContent)
    const draftTyped = await waitFor('pl13-draft-typed', () => notebookApi()!.getEditorContent() === draftContent, 4000, 80)
    const dblClicked = Boolean(targetSeeded && targetPrompt && dispatchRowDoubleClick(targetPrompt.id))
    const draftSaved = await waitFor('pl13-draft-saved', () => Boolean(promptByContent(draftContent)), 4000, 80)
    const targetLoaded = await waitFor('pl13-target-loaded', () => notebookApi()!.getEditorContent() === targetContent, 4000, 80)
    const toastSeen = await waitFor('pl13-toast', () => {
      const toast = document.querySelector<HTMLElement>('.prompt-editor-draft-toast')
      return Boolean(toast && toast.textContent && toast.textContent.length > 0)
    }, 2500, 80)
    record('PL-13-double-click-preserves-editor-draft', targetSeeded && draftTyped && dblClicked && draftSaved && targetLoaded && toastSeen, {
      targetSeeded, draftTyped, dblClicked, draftSaved, targetLoaded, toastSeen
    })

    // PL-14: editor now holds T untouched (loaded by PL-13's double-click).
    // Double-click the preserved draft entry D → NO new history entry.
    const draftPrompt = promptByContent(draftContent)
    const countBeforeUntouched = notebookApi()!.getPrompts().length
    const dblClickedDraft = Boolean(draftPrompt && dispatchRowDoubleClick(draftPrompt.id))
    const draftLoaded = await waitFor('pl14-draft-loaded', () => notebookApi()!.getEditorContent() === draftContent, 4000, 80)
    await sleep(300)
    const countAfterUntouched = notebookApi()!.getPrompts().length
    record('PL-14-untouched-source-not-duplicated', dblClickedDraft && draftLoaded && countAfterUntouched === countBeforeUntouched, {
      dblClickedDraft, draftLoaded, countBeforeUntouched, countAfterUntouched
    })

    // PL-15: empty editor → double-click T → no new entry, T loads.
    notebookApi()!.setEditorContent('')
    await waitFor('pl15-cleared', () => notebookApi()!.getEditorContent() === '', 4000, 80)
    const countBeforeEmpty = notebookApi()!.getPrompts().length
    const dblClickedEmpty = Boolean(targetPrompt && dispatchRowDoubleClick(targetPrompt!.id))
    const targetReloaded = await waitFor('pl15-target-loaded', () => notebookApi()!.getEditorContent() === targetContent, 4000, 80)
    await sleep(300)
    const countAfterEmpty = notebookApi()!.getPrompts().length
    record('PL-15-empty-editor-adds-nothing', dblClickedEmpty && targetReloaded && countAfterEmpty === countBeforeEmpty, {
      dblClickedEmpty, targetReloaded, countBeforeEmpty, countAfterEmpty
    })

    // Exit edit mode before testing fresh editor drop & image paste
    const cancelBtnAfter15 = Array.from(document.querySelectorAll(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor[data-prompt-editing="true"] .prompt-editor-btn'
    )).find((button) => {
      const label = button.textContent?.trim()
      return label === 'Cancel' || label === '\u53d6\u6d88'
    }) as HTMLButtonElement | undefined
    cancelBtnAfter15?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    await sleep(120)
  }

  // ---- PL-16..20: Prompt Editor file/folder drop & top image grid ----
  if (!cancelled()) {
    notebookApi()!.setEditorContent('Check files: ')
    await waitFor('pl16-seed', () => notebookApi()!.getEditorContent() === 'Check files: ', 3000, 60)
    const sampleDropPaths = window.electronAPI.platform === 'win32'
      ? ['C:\\repo\\src\\index.ts', 'C:\\repo\\my folder\\README.md']
      : ['/repo/src/index.ts', '/repo/my folder/README.md']
    const dropResult = notebookApi()!.dropFilesIntoEditor?.(sampleDropPaths) ?? null
    const droppedContentReady = await waitFor('pl16-dropped-content', () => {
      const text = notebookApi()!.getEditorContent()
      return text.includes('index.ts') && text.includes('README.md')
    }, 3000, 60)
    record('PL-16-editor-file-drop', Boolean(
      dropResult &&
      dropResult.rawPaths.length === 2 &&
      dropResult.formattedText.length > 0 &&
      droppedContentReady
    ), {
      dropResult,
      editorContent: notebookApi()!.getEditorContent()
    })

    // Clear editor and paste 3 images of different aspect ratios
    notebookApi()!.setEditorContent('')
    await waitFor('pl17-clear', () => notebookApi()!.getEditorContent() === '', 3000, 60)
    await notebookApi()!.pasteClipboardIntoEditor?.({ autotestImage: { width: 800, height: 600 } })
    await notebookApi()!.pasteClipboardIntoEditor?.({ autotestImage: { width: 400, height: 900 } })
    await notebookApi()!.pasteClipboardIntoEditor?.({ autotestImage: { width: 1200, height: 500 } })

    const threeImagesMounted = await waitFor('pl17-three-images', () => {
      const domCards = document.querySelectorAll(
        '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor .prompt-editor-images-strip .prompt-editor-image-card'
      )
      return domCards.length === 3 && (notebookApi()!.getEditorImages?.().length ?? 0) === 3
    }, 4000, 80)

    const editorImages17 = notebookApi()!.getEditorImages?.() ?? []
    const stripEl = document.querySelector<HTMLElement>(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor .prompt-editor-images-strip'
    )
    const inputsEl = document.querySelector<HTMLElement>(
      '.prompt-notebook:not(.prompt-notebook-hidden) .prompt-editor .prompt-editor-inputs'
    )
    const stripIsAboveInputs = Boolean(
      stripEl &&
      inputsEl &&
      stripEl.getBoundingClientRect().top <= inputsEl.getBoundingClientRect().top
    )
    record('PL-17-editor-paste-images-top-grid', Boolean(
      threeImagesMounted &&
      stripIsAboveInputs &&
      editorImages17[0]?.index === 1 &&
      editorImages17[0]?.path.endsWith('item-1.png') &&
      editorImages17[1]?.index === 2 &&
      editorImages17[1]?.path.endsWith('item-2.png') &&
      editorImages17[2]?.index === 3 &&
      editorImages17[2]?.path.endsWith('item-3.png')
    ), {
      threeImagesMounted,
      stripIsAboveInputs,
      images: editorImages17
    })

    // PL-18: Typing @ pops up .prompt-editor-mention-menu with candidates (@1..@3),
    // selecting @1 inserts @1, badge insert inserts @2, and Lightbox preview opens/closes.
    notebookApi()!.setEditorContent('看以下 @')
    const mentionPopupReady = await waitFor('pl18-mention-popup', () => {
      const cands = notebookApi()!.getEditorMentionCandidates?.() ?? []
      const menuDom = document.querySelector('.prompt-editor-mention-menu')
      return cands.length === 3 && menuDom !== null
    }, 3000, 60)
    const inserted1 = notebookApi()!.selectEditorMentionCandidate?.(1) ?? false
    await waitFor('pl18-token-1', () => notebookApi()!.getEditorContent().includes('@1'), 3000, 60)
    const mentionPopupClosed = document.querySelector('.prompt-editor-mention-menu') === null
    notebookApi()!.setEditorContent(`${notebookApi()!.getEditorContent()}对比 `)
    await waitFor('pl18-with', () => notebookApi()!.getEditorContent().includes('@1 对比 '), 3000, 60)
    const inserted2 = notebookApi()!.insertEditorImageToken?.(2) ?? false
    const tokensReady = await waitFor('pl18-tokens', () => {
      const text = notebookApi()!.getEditorContent()
      return text.includes('@1') && text.includes('@2')
    }, 3000, 60)

    const previewOpened = notebookApi()!.openEditorImagePreview?.(2) ?? false
    const lightboxVisible = await waitFor('pl18-lightbox-open', () => {
      return document.querySelector('.prompt-image-lightbox-overlay') !== null &&
        notebookApi()!.getEditorImagePreviewIndex?.() === 2
    }, 3000, 60)
    notebookApi()!.closeEditorImagePreview?.()
    const lightboxClosed = await waitFor('pl18-lightbox-close', () => {
      return document.querySelector('.prompt-image-lightbox-overlay') === null &&
        notebookApi()!.getEditorImagePreviewIndex?.() === null
    }, 3000, 60)
    record('PL-18-editor-insert-image-token-and-lightbox', Boolean(
      mentionPopupReady &&
      inserted1 &&
      mentionPopupClosed &&
      inserted2 &&
      tokensReady &&
      previewOpened &&
      lightboxVisible &&
      lightboxClosed
    ), {
      mentionPopupReady,
      inserted1,
      mentionPopupClosed,
      inserted2,
      editorContent: notebookApi()!.getEditorContent(),
      previewOpened,
      lightboxVisible,
      lightboxClosed
    })

    // PL-19: Remove item #1 -> remaining items renumber to #1 (400x900) and #2 (1200x500),
    // and @2 in text renumbers to @1.
    const removed1 = await (notebookApi()!.removeEditorImage?.(1) ?? Promise.resolve(false))
    const renumberedReady = await waitFor('pl19-renumbered', () => {
      const imgs = notebookApi()!.getEditorImages?.() ?? []
      const text = notebookApi()!.getEditorContent()
      return (
        imgs.length === 2 &&
        imgs[0]?.index === 1 &&
        imgs[0]?.width === 400 &&
        imgs[0]?.path.endsWith('item-1.png') &&
        imgs[1]?.index === 2 &&
        imgs[1]?.width === 1200 &&
        imgs[1]?.path.endsWith('item-2.png') &&
        text.includes('@1') &&
        !text.includes('@2')
      )
    }, 4000, 80)
    record('PL-19-editor-remove-image-renumbers-files-and-tokens', Boolean(removed1 && renumberedReady), {
      removed1,
      renumberedReady,
      images: notebookApi()!.getEditorImages?.(),
      editorContent: notebookApi()!.getEditorContent()
    })

    // PL-20: Send prompt with images -> history records images, badge shows in PromptList, and editor clears images
    const beforeImageSendIds = new Set(notebookApi()!.getPrompts().map(p => p.id))
    senderApi()!.deselectAllTerminals()
    await sleep(80)
    senderApi()!.selectTerminal(cards[0].id)
    await sleep(80)
    const clickedImageSend = await senderApi()!.clickAction('send')
    const imageSendIdle = await waitFor('pl20-send-idle', () => !senderApi()!.isSubmitting(), 5000, 80)
    const imagePromptRecorded = await waitFor('pl20-prompt-recorded', () => {
      return notebookApi()!.getPrompts().some(p => !beforeImageSendIds.has(p.id) && (p.images?.length ?? 0) === 2)
    }, 5000, 80)
    const recordedImagePrompt = notebookApi()!.getPrompts().find(p => !beforeImageSendIds.has(p.id)) ?? null
    const hasBadgeDom = await waitFor('pl20-badge-dom', () => {
      if (!recordedImagePrompt) return false
      return document.querySelector(`[data-prompt-id="${CSS.escape(recordedImagePrompt.id)}"] .prompt-item-image-badge`) !== null
    }, 3000, 60)
    const editorClearedImages = (notebookApi()!.getEditorImages?.().length ?? 0) === 0
    record('PL-20-send-prompt-with-images-and-history-badge', Boolean(
      clickedImageSend &&
      imageSendIdle &&
      imagePromptRecorded &&
      recordedImagePrompt &&
      (recordedImagePrompt.images?.length ?? 0) === 2 &&
      hasBadgeDom &&
      editorClearedImages
    ), {
      clickedImageSend,
      imageSendIdle,
      imagePromptRecorded,
      recordedImagePrompt,
      hasBadgeDom,
      editorClearedImages
    })

    // PL-21: Ctrl+V pasting a non-image file (e.g. markdown) + a folder:
    // the file enters the top #1 strip as item-1.md and previews in Lightbox,
    // while the folder path is inserted into the editor text.
    const cwd = window.electronAPI.debug?.autotestCwd
    if (cwd) {
      const sep = window.electronAPI.platform === 'win32' ? '\\' : '/'
      const mdFixturePath = `${cwd}${sep}test${sep}autotest${sep}fixtures${sep}markdown-code-wrap.md`
      const folderFixturePath = `${cwd}${sep}test${sep}autotest${sep}fixtures`
      notebookApi()!.setEditorContent('')
      await waitFor('pl21-clear', () => notebookApi()!.getEditorContent() === '', 3000, 60)
      await notebookApi()!.pasteClipboardIntoEditor?.({
        filePaths: [mdFixturePath, folderFixturePath]
      })
      const pastedMixedReady = await waitFor('pl21-mixed-ready', () => {
        const imgs = notebookApi()!.getEditorImages?.() ?? []
        const text = notebookApi()!.getEditorContent()
        return imgs.length === 1 && imgs[0]?.path.endsWith('item-1.md') && text.includes('fixtures')
      }, 4000, 80)
      const openedMdPreview = notebookApi()!.openEditorImagePreview?.(1) ?? false
      const mdCodePreviewReady = await waitFor('pl21-md-preview', () => {
        const codeEl = document.querySelector('.prompt-image-lightbox-body[data-preview-kind="markdown"] .prompt-image-lightbox-code')
        return Boolean(codeEl && (codeEl.textContent?.trim().length ?? 0) > 0)
      }, 4000, 80)
      notebookApi()!.closeEditorImagePreview?.()
      await notebookApi()!.removeEditorImage?.(1)
      notebookApi()!.setEditorContent('')
      record('PL-21-editor-paste-files-and-folders', Boolean(
        pastedMixedReady &&
        openedMdPreview &&
        mdCodePreviewReady
      ), {
        pastedMixedReady,
        openedMdPreview,
        mdCodePreviewReady
      })
    }
  }

  notebookApi()!.setTargetsEnabled?.(false)
  notebookApi()!.setFilterEnabled?.(false)
  notebookApi()!.setColorFilter?.(null)
  notebookApi()!.setTaskFilter?.(null)
  notebookApi()!.setEditorContent('')
  await sleep(120)

  log('phase1.05:done', {
    total: results.length,
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length
  })

  return results
}
