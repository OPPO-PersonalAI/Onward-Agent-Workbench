/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import type { FeedbackDebugRemoteIssue } from '../types/feedback'

function queryElement<T extends Element>(selector: string): T | null {
  return document.querySelector(selector) as T | null
}

function queryElements<T extends Element>(selector: string): T[] {
  return Array.from(document.querySelectorAll(selector)) as T[]
}

function clickElement(element: HTMLElement | null): boolean {
  if (!element) {
    return false
  }
  element.click()
  return true
}

function setTextInputValue(element: HTMLInputElement | HTMLTextAreaElement | null, value: string): boolean {
  if (!element) {
    return false
  }
  element.focus()
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) {
    return false
  }
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function setSelectValue(element: HTMLSelectElement | null, value: string): boolean {
  if (!element) {
    return false
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (!setter) {
    return false
  }
  setter.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

function queryHistoryItem(): HTMLDivElement | null {
  return queryElement<HTMLDivElement>('[data-testid="feedback-history-item"]')
}

function getHistoryStatus(): string | null {
  return queryHistoryItem()?.dataset.feedbackStatus ?? null
}

function getHistoryTitle(): string | null {
  return queryElement<HTMLElement>('[data-testid="feedback-history-title"]')?.textContent?.trim() ?? null
}

export async function testFeedbackUi(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, log, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const sidebarButtonSelector = '[data-testid="sidebar-feedback-button"]'
  const modalSelector = '[data-testid="feedback-modal"]'
  const submitButtonSelector = '[data-testid="feedback-submit-button"]'
  const historyRefreshSelector = '[data-testid="feedback-history-refresh"]'
  const formErrorSelector = '[data-testid="feedback-form-error"]'
  const submitNoticeSelector = '[data-testid="feedback-history-notice"], [data-testid="feedback-submit-notice"]'

  const openFeedbackModal = async () => {
    const button = queryElement<HTMLButtonElement>(sidebarButtonSelector)
    if (!button) {
      return { opened: false, elapsedMs: null as number | null }
    }
    const startedAt = performance.now()
    clickElement(button)
    const opened = await waitFor(
      'feedback-ui-open-modal',
      () => queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen === 'true',
      4000,
      40
    )
    return {
      opened,
      elapsedMs: opened ? Math.round(performance.now() - startedAt) : null
    }
  }

  const waitForRefreshAvailable = async () => {
    return await waitFor(
      'feedback-ui-refresh-available',
      () => queryElement<HTMLButtonElement>(historyRefreshSelector)?.disabled === false,
      4000,
      40
    )
  }

  log('feedback-ui:start')

  await window.electronAPI.debug.feedbackReset()
  await window.electronAPI.debug.feedbackSetMockIssues([])
  await sleep(60)

  try {
    const preRendered = queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen === 'false'
    record('FBU-00-feedback-modal-pre-rendered', preRendered, {
      feedbackOpen: queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen ?? null
    })
    if (cancelled()) {
      return results
    }

    const { opened, elapsedMs } = await openFeedbackModal()
    record('FBU-01-open-feedback-modal', opened, {
      sidebarButtonFound: Boolean(queryElement(sidebarButtonSelector)),
      openElapsedMs: elapsedMs
    })
    if (!opened || cancelled()) {
      return results
    }

    const blankSubmitClicked = clickElement(queryElement<HTMLButtonElement>(submitButtonSelector))
    const validationShown = await waitFor(
      'feedback-ui-validation',
      () => Boolean(queryElement(formErrorSelector)?.textContent?.trim()),
      1200,
      40
    )
    record('FBU-02-submit-validation', blankSubmitClicked && validationShown, {
      errorText: queryElement(formErrorSelector)?.textContent?.trim() ?? null
    })
    if (cancelled()) {
      return results
    }

    const typeSet = setSelectValue(queryElement<HTMLSelectElement>('[data-testid="feedback-type-select"]'), 'feature')
    const titleSet = setTextInputValue(
      queryElement<HTMLInputElement>('[data-testid="feedback-title-input"]'),
      'Feedback modal UI automation'
    )
    const descriptionSet = setTextInputValue(
      queryElement<HTMLTextAreaElement>('[data-testid="feedback-description-input"]'),
      'This autotest validates the in-app feedback flow, browser handoff, and GitHub status refresh.'
    )
    const consentSet = clickElement(queryElement<HTMLInputElement>('[data-testid="feedback-public-consent"]'))
    await sleep(120)

    record('FBU-03-fill-feedback-form', typeSet && titleSet && descriptionSet && consentSet, {
      typeSet,
      titleSet,
      descriptionSet,
      consentSet
    })
    if (cancelled()) {
      return results
    }

    const submitted = clickElement(queryElement<HTMLButtonElement>(submitButtonSelector))
    const historyVisible = await waitFor(
      'feedback-ui-history-visible',
      () => getHistoryStatus() === 'pending_submission' && Boolean(queryElement(submitNoticeSelector)),
      4000,
      40
    )
    const openedUrl = await window.electronAPI.debug.feedbackGetLastOpenedUrl()
    const issueUrl = openedUrl ? new URL(openedUrl) : null
    const issueBody = issueUrl?.searchParams.get('body') || ''
    const feedbackIdMatch = issueBody.match(/Feedback ID:\s*([^\n]+)/)
    const feedbackId = feedbackIdMatch?.[1]?.trim() || null

    record('FBU-04-submit-opens-browser-draft', submitted &&
      historyVisible &&
      issueUrl?.searchParams.get('template') === 'feedback-feature.md' &&
      issueUrl?.searchParams.get('title') === 'Feedback modal UI automation' &&
      issueBody.includes('Type: Feature Request') &&
      issueBody.includes('Rating: 0/5 (not provided)') &&
      issueBody.includes('Locale: en') &&
      Boolean(feedbackId), {
      openedUrl,
      historyStatus: getHistoryStatus(),
      historyTitle: getHistoryTitle(),
      feedbackId
    })
    if (!feedbackId || cancelled()) {
      return results
    }

    const remoteIssueBase: FeedbackDebugRemoteIssue = {
      number: 321,
      url: 'https://github.com/OPPO-PersonalAI/Onward/issues/321',
      state: 'open',
      labels: [],
      body: issueBody
    }

    await window.electronAPI.debug.feedbackSetMockIssues([remoteIssueBase])
    await sleep(40)
    const refreshAvailable = await waitForRefreshAvailable()
    const refreshClicked = clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const submittedResolved = await waitFor(
      'feedback-ui-submitted-status',
      () => getHistoryStatus() === 'submitted',
      3000,
      40
    )
    record('FBU-05-history-resolves-to-submitted', refreshAvailable && refreshClicked && submittedResolved, {
      historyStatus: getHistoryStatus(),
      issueUrlVisible: Boolean(queryElement('[data-testid="feedback-open-issue"]'))
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([{
      ...remoteIssueBase,
      labels: ['feedback:accepted']
    }])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const acceptedResolved = await waitFor(
      'feedback-ui-accepted-status',
      () => getHistoryStatus() === 'accepted',
      3000,
      40
    )
    record('FBU-06-history-resolves-to-accepted', acceptedResolved, {
      historyStatus: getHistoryStatus()
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([{
      ...remoteIssueBase,
      labels: ['feedback:in-progress']
    }])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const inProgressResolved = await waitFor(
      'feedback-ui-in-progress-status',
      () => getHistoryStatus() === 'in_progress',
      3000,
      40
    )
    record('FBU-07-history-resolves-to-in-progress', inProgressResolved, {
      historyStatus: getHistoryStatus()
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([{
      ...remoteIssueBase,
      state: 'closed',
      stateReason: 'completed',
      labels: []
    }])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const completedResolved = await waitFor(
      'feedback-ui-completed-status',
      () => getHistoryStatus() === 'completed',
      3000,
      40
    )
    record('FBU-08-history-resolves-to-completed', completedResolved, {
      historyStatus: getHistoryStatus()
    })
    if (cancelled()) {
      return results
    }

    await window.electronAPI.debug.feedbackSetMockIssues([])
    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const unavailableResolved = await waitFor(
      'feedback-ui-unavailable-status',
      () => getHistoryStatus() === 'unavailable_on_github',
      3000,
      40
    )
    record('FBU-09-deleted-issue-becomes-unavailable', unavailableResolved, {
      historyStatus: getHistoryStatus(),
      historyError: queryElement('[data-testid="feedback-history-error"]')?.textContent?.trim() ?? null
    })

    const extraSubmissionCount = 8
    for (let index = 0; index < extraSubmissionCount; index += 1) {
      await window.electronAPI.feedback.createSubmission({
        rating: 0,
        type: 'bug',
        title: `Scroll record ${index + 1}`,
        description: `Feedback history scroll coverage record ${index + 1}.`,
        publicConsentAccepted: true,
        locale: 'en'
      })
    }

    await waitForRefreshAvailable()
    clickElement(queryElement<HTMLButtonElement>(historyRefreshSelector))
    const scrollReady = await waitFor(
      'feedback-ui-history-scroll-ready',
      () => queryElements('[data-testid="feedback-history-item"]').length >= extraSubmissionCount + 1,
      4000,
      40
    )
    const historyList = queryElement<HTMLDivElement>('[data-testid="feedback-history-list"]')
    if (historyList) {
      historyList.scrollTop = 180
      historyList.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    const listIsScrollable = Boolean(historyList) &&
      historyList.scrollHeight > historyList.clientHeight &&
      historyList.scrollTop > 0 &&
      window.getComputedStyle(historyList).overflowY === 'auto'

    record('FBU-10-history-list-scrolls', scrollReady && listIsScrollable, {
      itemCount: queryElements('[data-testid="feedback-history-item"]').length,
      clientHeight: historyList?.clientHeight ?? null,
      scrollHeight: historyList?.scrollHeight ?? null,
      scrollTop: historyList?.scrollTop ?? null,
      overflowY: historyList ? window.getComputedStyle(historyList).overflowY : null
    })

    const removeButtons = queryElements<HTMLButtonElement>('[data-testid="feedback-remove-record"]')
    const countBeforeRemove = queryElements('[data-testid="feedback-history-item"]').length
    const removeClicked = clickElement(removeButtons[0] ?? null)
    const removeResolved = await waitFor(
      'feedback-ui-remove-local-record',
      () => queryElements('[data-testid="feedback-history-item"]').length === Math.max(0, countBeforeRemove - 1),
      3000,
      40
    )
    const stateAfterRemove = await window.electronAPI.feedback.load()
    record('FBU-11-remove-local-record', removeClicked && removeResolved, {
      countBeforeRemove,
      countAfterRemove: queryElements('[data-testid="feedback-history-item"]').length,
      storedCountAfterRemove: stateAfterRemove.records.length
    })
  } finally {
    const sidebarButton = queryElement<HTMLButtonElement>(sidebarButtonSelector)
    if (sidebarButton && queryElement<HTMLElement>(modalSelector)?.dataset.feedbackOpen === 'true') {
      clickElement(sidebarButton)
      await sleep(120)
    }
    await window.electronAPI.debug.feedbackReset()
  }

  return results
}
