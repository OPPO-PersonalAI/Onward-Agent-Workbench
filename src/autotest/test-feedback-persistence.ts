/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'

function queryElement<T extends Element>(selector: string): T | null {
  return document.querySelector(selector) as T | null
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

async function openFeedbackModal(ctx: AutotestContext): Promise<boolean> {
  const { waitFor } = ctx
  const sidebarButton = queryElement<HTMLButtonElement>('[data-testid="sidebar-feedback-button"]')
  if (!sidebarButton) {
    return false
  }
  sidebarButton.click()
  return await waitFor(
    'feedback-persistence-open-modal',
    () => queryElement<HTMLElement>('[data-testid="feedback-modal"]')?.dataset.feedbackOpen === 'true',
    4000,
    40
  )
}

export async function testFeedbackPersistenceSeed(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, cancelled, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  await window.electronAPI.debug.feedbackReset()
  await window.electronAPI.debug.feedbackSetMockIssues([])
  await sleep(60)

  const opened = await openFeedbackModal(ctx)
  record('FBP-SEED-01-open-feedback-modal', opened, {
    sidebarButtonFound: Boolean(queryElement('[data-testid="sidebar-feedback-button"]'))
  })
  if (!opened || cancelled()) {
    return results
  }

  const consentClicked = clickElement(queryElement<HTMLInputElement>('[data-testid="feedback-public-consent"]'))
  const titleSet = setTextInputValue(
    queryElement<HTMLInputElement>('[data-testid="feedback-title-input"]'),
    'Feedback persistence seed record'
  )
  const descriptionSet = setTextInputValue(
    queryElement<HTMLTextAreaElement>('[data-testid="feedback-description-input"]'),
    'This record verifies that feedback history and consent survive a relaunch.'
  )
  await sleep(120)

  record('FBP-SEED-02-persist-consent-preference', consentClicked && titleSet && descriptionSet, {
    consentChecked: queryElement<HTMLInputElement>('[data-testid="feedback-public-consent"]')?.checked ?? false,
    titleLength: queryElement<HTMLInputElement>('[data-testid="feedback-title-input"]')?.value.length ?? 0,
    descriptionLength: queryElement<HTMLTextAreaElement>('[data-testid="feedback-description-input"]')?.value.length ?? 0
  })
  if (cancelled()) {
    return results
  }

  const submitted = clickElement(queryElement<HTMLButtonElement>('[data-testid="feedback-submit-button"]'))
  const historyVisible = await waitFor(
    'feedback-persistence-seed-history',
    () => queryElement('[data-testid="feedback-history-item"]')?.getAttribute('data-feedback-status') === 'pending_submission',
    4000,
    40
  )
  const savedState = await window.electronAPI.feedback.load()

  record('FBP-SEED-03-create-pending-history-record', submitted && historyVisible && savedState.preferences.publicConsentAccepted, {
    storedConsent: savedState.preferences.publicConsentAccepted,
    storedRecordCount: savedState.records.length,
    storedStatus: savedState.records[0]?.syncStatus ?? null,
    storedTitle: savedState.records[0]?.title ?? null
  })

  return results
}

export async function testFeedbackPersistenceVerify(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert, sleep, waitFor } = ctx
  const results: TestResult[] = []
  const record = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  try {
    const opened = await openFeedbackModal(ctx)
    record('FBP-VERIFY-01-open-feedback-modal', opened, {
      sidebarButtonFound: Boolean(queryElement('[data-testid="sidebar-feedback-button"]'))
    })
    if (!opened) {
      return results
    }

    const consentRestored = await waitFor(
      'feedback-persistence-verify-consent',
      () => queryElement<HTMLInputElement>('[data-testid="feedback-public-consent"]')?.checked === true,
      3000,
      40
    )
    record('FBP-VERIFY-02-consent-restored-after-relaunch', consentRestored, {
      consentChecked: queryElement<HTMLInputElement>('[data-testid="feedback-public-consent"]')?.checked ?? false
    })

    clickElement(queryElement<HTMLButtonElement>('[data-testid="feedback-tab-history"]'))
    const historyRestored = await waitFor(
      'feedback-persistence-verify-history',
      () => {
        const item = queryElement<HTMLElement>('[data-testid="feedback-history-item"]')
        const title = queryElement<HTMLElement>('[data-testid="feedback-history-title"]')?.textContent?.trim()
        return Boolean(item) &&
          item.getAttribute('data-feedback-status') === 'pending_submission' &&
          title === 'Feedback persistence seed record'
      },
      3000,
      40
    )
    const restoredState = await window.electronAPI.feedback.load()

    record('FBP-VERIFY-03-history-record-restored-after-relaunch', historyRestored, {
      storedConsent: restoredState.preferences.publicConsentAccepted,
      storedRecordCount: restoredState.records.length,
      storedTitle: restoredState.records[0]?.title ?? null
    })

    const removeClicked = clickElement(queryElement<HTMLButtonElement>('[data-testid="feedback-remove-record"]'))
    const removalResolved = await waitFor(
      'feedback-persistence-verify-removal',
      () => !queryElement('[data-testid="feedback-history-item"]'),
      3000,
      40
    )
    await sleep(80)
    const finalState = await window.electronAPI.feedback.load()
    record('FBP-VERIFY-04-history-record-removable', removeClicked && removalResolved && finalState.records.length === 0, {
      remainingRecords: finalState.records.length
    })
  } finally {
    await window.electronAPI.debug.feedbackReset()
  }

  return results
}
