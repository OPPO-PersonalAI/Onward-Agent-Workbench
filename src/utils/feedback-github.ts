/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FEEDBACK_BUG_TEMPLATE,
  FEEDBACK_FEATURE_TEMPLATE,
  FEEDBACK_MAX_DESCRIPTION_LENGTH,
  FEEDBACK_MAX_TITLE_LENGTH,
  FEEDBACK_REPO_NAME,
  FEEDBACK_REPO_OWNER,
  type FeedbackAppContext,
  type FeedbackSubmissionInput,
  type FeedbackType
} from '../types/feedback'

export const FEEDBACK_ID_MARKER_PREFIX = 'Feedback ID: '
const FEEDBACK_HIDDEN_MARKER_PREFIX = 'onward-feedback-id:'

function clampWhitespace(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

export function normalizeFeedbackTitle(value: string): string {
  return clampWhitespace(value).slice(0, FEEDBACK_MAX_TITLE_LENGTH)
}

export function normalizeFeedbackDescription(value: string): string {
  return clampWhitespace(value).slice(0, FEEDBACK_MAX_DESCRIPTION_LENGTH)
}

export function resolveFeedbackTemplate(type: FeedbackType): string {
  return type === 'bug' ? FEEDBACK_BUG_TEMPLATE : FEEDBACK_FEATURE_TEMPLATE
}

export function formatFeedbackTypeLabel(type: FeedbackType): string {
  return type === 'bug' ? 'Bug Report' : 'Feature Request'
}

export function buildFeedbackIssueBody(
  feedbackId: string,
  input: Pick<FeedbackSubmissionInput, 'rating' | 'type' | 'description'>,
  appContext: FeedbackAppContext
): string {
  const description = normalizeFeedbackDescription(input.description)
  const ratingLine = input.rating === 0
    ? '- Rating: 0/5 (not provided)'
    : `- Rating: ${input.rating}/5`
  const lines = [
    `<!-- ${FEEDBACK_HIDDEN_MARKER_PREFIX} ${feedbackId} -->`,
    '',
    '## Feedback Summary',
    `- ${FEEDBACK_ID_MARKER_PREFIX}${feedbackId}`,
    `- Type: ${formatFeedbackTypeLabel(input.type)}`,
    ratingLine,
    '',
    '## Description',
    description || '_No additional details provided._',
    '',
    '## Screenshots',
    'Please attach screenshots directly in GitHub before submitting the issue if needed.',
    '',
    '## Environment',
    `- App: ${appContext.productName}`,
    `- Version: ${appContext.version}`,
    `- Build channel: ${appContext.buildChannel}`,
    `- Release channel: ${appContext.releaseChannel}`,
    `- Release OS: ${appContext.releaseOs}`,
    `- Platform: ${appContext.platform}`,
    `- Locale: ${appContext.locale}`,
    `- Created at: ${new Date(appContext.createdAt).toISOString()}`
  ]

  return lines.join('\n')
}

export function buildFeedbackIssueUrl(
  feedbackId: string,
  input: Pick<FeedbackSubmissionInput, 'rating' | 'type' | 'title' | 'description'>,
  appContext: FeedbackAppContext
): string {
  const template = resolveFeedbackTemplate(input.type)
  const title = normalizeFeedbackTitle(input.title)
  const body = buildFeedbackIssueBody(feedbackId, input, appContext)
  const url = new URL(`https://github.com/${FEEDBACK_REPO_OWNER}/${FEEDBACK_REPO_NAME}/issues/new`)
  url.searchParams.set('template', template)
  url.searchParams.set('title', title)
  url.searchParams.set('body', body)
  return url.toString()
}

export function buildFeedbackIssueUrlLength(
  feedbackId: string,
  input: Pick<FeedbackSubmissionInput, 'rating' | 'type' | 'title' | 'description'>,
  appContext: FeedbackAppContext
): number {
  return buildFeedbackIssueUrl(feedbackId, input, appContext).length
}

export function issueBodyContainsFeedbackId(body: string | null | undefined, feedbackId: string): boolean {
  if (typeof body !== 'string' || !body.trim()) {
    return false
  }

  return (
    body.includes(`${FEEDBACK_ID_MARKER_PREFIX}${feedbackId}`) ||
    body.includes(`${FEEDBACK_HIDDEN_MARKER_PREFIX} ${feedbackId}`) ||
    body.includes(`${FEEDBACK_HIDDEN_MARKER_PREFIX}${feedbackId}`)
  )
}
