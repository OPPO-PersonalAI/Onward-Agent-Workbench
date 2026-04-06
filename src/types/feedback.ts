/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AppLocale } from '../i18n/core'

export const FEEDBACK_REPO_OWNER = 'OPPO-PersonalAI'
export const FEEDBACK_REPO_NAME = 'Onward'
export const FEEDBACK_BUG_TEMPLATE = 'feedback-bug.md'
export const FEEDBACK_FEATURE_TEMPLATE = 'feedback-feature.md'
export const FEEDBACK_LABEL_ACCEPTED = 'feedback:accepted'
export const FEEDBACK_LABEL_IN_PROGRESS = 'feedback:in-progress'
export const FEEDBACK_PENDING_SYNC_MIN_INTERVAL_MS = 30_000
export const FEEDBACK_ACTIVE_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000
export const FEEDBACK_MAX_TITLE_LENGTH = 120
export const FEEDBACK_MAX_DESCRIPTION_LENGTH = 1_200
export const FEEDBACK_MAX_URL_LENGTH = 7_500

export type FeedbackType = 'bug' | 'feature'
export type FeedbackRating = 0 | 1 | 2 | 3 | 4 | 5

export type FeedbackSyncStatus =
  | 'pending_submission'
  | 'submitted'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'not_planned'
  | 'duplicate'
  | 'unavailable_on_github'

export interface FeedbackSubmissionInput {
  rating: FeedbackRating
  type: FeedbackType
  title: string
  description: string
  publicConsentAccepted: boolean
  locale: AppLocale
}

export interface FeedbackAppContext {
  locale: AppLocale
  platform: 'darwin' | 'win32' | 'linux'
  productName: string
  version: string
  buildChannel: 'dev' | 'prod'
  releaseChannel: 'daily' | 'stable' | 'unknown'
  releaseOs: 'macos' | 'windows' | 'linux' | 'unknown'
  createdAt: number
}

export interface FeedbackRecord {
  id: string
  feedbackId: string
  createdAt: number
  updatedAt: number
  browserOpenedAt: number | null
  locale: AppLocale
  rating: FeedbackRating
  type: FeedbackType
  title: string
  description: string
  publicConsentAccepted: boolean
  githubTemplate: string
  prefilledUrl: string
  issueNumber: number | null
  issueUrl: string | null
  issueState: 'open' | 'closed' | null
  issueStateReason: string | null
  issueLabels: string[]
  syncStatus: FeedbackSyncStatus
  lastCheckedAt: number | null
  lastError: string | null
}

export interface FeedbackPreferences {
  publicConsentAccepted: boolean
}

export interface FeedbackState {
  version: number
  installationId: string
  preferences: FeedbackPreferences
  records: FeedbackRecord[]
  updatedAt: number
}

export interface FeedbackActionResult {
  success: boolean
  error?: string
}

export interface FeedbackCreateSubmissionResult extends FeedbackActionResult {
  record?: FeedbackRecord
}

export interface FeedbackDebugRemoteIssue {
  number: number
  url?: string
  state: 'open' | 'closed'
  stateReason?: string | null
  labels?: string[]
  body?: string | null
}
