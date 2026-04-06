/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutotestContext, TestResult } from './types'
import { buildFeedbackIssueBody, buildFeedbackIssueUrl, issueBodyContainsFeedbackId } from '../utils/feedback-github'
import { resolveFeedbackSyncStatus } from '../utils/feedback-status'

export async function testFeedback(ctx: AutotestContext): Promise<TestResult[]> {
  const { assert } = ctx
  const results: TestResult[] = []
  const _assert = (name: string, ok: boolean, detail?: Record<string, unknown>) => {
    assert(name, ok, detail)
    results.push({ name, ok, detail })
  }

  const feedbackId = 'fb-test-123'
  const appContext = {
    locale: 'en' as const,
    platform: 'darwin' as const,
    productName: 'Onward 2',
    version: '2.0.1',
    buildChannel: 'dev' as const,
    releaseChannel: 'unknown' as const,
    releaseOs: 'unknown' as const,
    createdAt: Date.parse('2026-04-06T12:34:56.000Z')
  }

  const bugUrl = buildFeedbackIssueUrl(feedbackId, {
    rating: 4,
    type: 'bug',
    title: 'Terminal title flickers',
    description: 'The terminal title flickers after switching tabs.'
  }, appContext)
  const bugUrlParsed = new URL(bugUrl)
  const bugBody = bugUrlParsed.searchParams.get('body') || ''

  _assert('FB-01-template-bug', bugUrlParsed.searchParams.get('template') === 'feedback-bug.md', {
    template: bugUrlParsed.searchParams.get('template')
  })
  _assert('FB-02-title-prefill', bugUrlParsed.searchParams.get('title') === 'Terminal title flickers', {
    title: bugUrlParsed.searchParams.get('title')
  })
  _assert('FB-03-body-has-feedback-id', issueBodyContainsFeedbackId(bugBody, feedbackId), {
    bugBody
  })
  _assert('FB-04-body-has-environment', bugBody.includes('Version: 2.0.1') && bugBody.includes('Platform: darwin'), {
    bugBody
  })

  const featureBody = buildFeedbackIssueBody('fb-feature-456', {
    rating: 5,
    type: 'feature',
    description: 'Please add a compact layout toggle.'
  }, appContext)
  _assert('FB-05-feature-body-type-label', featureBody.includes('Type: Feature Request'), {
    featureBody
  })
  const unratedBody = buildFeedbackIssueBody('fb-unrated-789', {
    rating: 0,
    type: 'bug',
    description: 'The feedback keeps the rating optional.'
  }, appContext)
  _assert('FB-06-body-supports-unrated-feedback', unratedBody.includes('Rating: 0/5 (not provided)'), {
    unratedBody
  })

  _assert('FB-07-status-submitted', resolveFeedbackSyncStatus([], 'open', null) === 'submitted')
  _assert('FB-08-status-accepted', resolveFeedbackSyncStatus(['feedback:accepted'], 'open', null) === 'accepted')
  _assert('FB-09-status-in-progress', resolveFeedbackSyncStatus(['feedback:in-progress'], 'open', null) === 'in_progress')
  _assert('FB-10-status-completed', resolveFeedbackSyncStatus([], 'closed', 'completed') === 'completed')
  _assert('FB-11-status-not-planned', resolveFeedbackSyncStatus([], 'closed', 'not_planned') === 'not_planned')
  _assert('FB-12-status-duplicate', resolveFeedbackSyncStatus([], 'closed', 'duplicate') === 'duplicate')

  return results
}
