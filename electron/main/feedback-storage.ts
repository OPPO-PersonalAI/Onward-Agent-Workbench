/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { net, app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  FEEDBACK_ACTIVE_SYNC_MIN_INTERVAL_MS,
  FEEDBACK_BUG_TEMPLATE,
  FEEDBACK_FEATURE_TEMPLATE,
  FEEDBACK_MAX_URL_LENGTH,
  FEEDBACK_PENDING_SYNC_MIN_INTERVAL_MS,
  FEEDBACK_REPO_NAME,
  FEEDBACK_REPO_OWNER,
  type FeedbackAppContext,
  type FeedbackCreateSubmissionResult,
  type FeedbackDebugRemoteIssue,
  type FeedbackRecord,
  type FeedbackState,
  type FeedbackSubmissionInput
} from '../../src/types/feedback'
import {
  buildFeedbackIssueUrl,
  issueBodyContainsFeedbackId,
  normalizeFeedbackDescription,
  normalizeFeedbackTitle,
  resolveFeedbackTemplate
} from '../../src/utils/feedback-github'
import { resolveFeedbackSyncStatus } from '../../src/utils/feedback-status'

interface GitHubIssueLabel {
  name?: string
}

interface GitHubIssue {
  number: number
  html_url: string
  state: 'open' | 'closed'
  state_reason?: string | null
  labels?: GitHubIssueLabel[]
  body?: string | null
  pull_request?: unknown
}

const CURRENT_VERSION = 1
const RECENT_PENDING_SCAN_LIMIT = 100
const GITHUB_API_BASE_URL = `https://api.github.com/repos/${FEEDBACK_REPO_OWNER}/${FEEDBACK_REPO_NAME}`
const GITHUB_COMMON_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Onward-Feedback',
  'X-GitHub-Api-Version': '2022-11-28'
}

function createDefaultState(): FeedbackState {
  return {
    version: CURRENT_VERSION,
    installationId: randomUUID(),
    preferences: {
      publicConsentAccepted: false
    },
    records: [],
    updatedAt: Date.now()
  }
}

function isValidRating(value: unknown): value is FeedbackSubmissionInput['rating'] {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

function isValidType(value: unknown): value is FeedbackSubmissionInput['type'] {
  return value === 'bug' || value === 'feature'
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function normalizeFeedbackRecord(record: unknown): FeedbackRecord | null {
  if (!record || typeof record !== 'object') {
    return null
  }

  const raw = record as Record<string, unknown>
  if (!isValidRating(raw.rating) || !isValidType(raw.type)) {
    return null
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const feedbackId = typeof raw.feedbackId === 'string' ? raw.feedbackId.trim() : ''
  const title = normalizeFeedbackTitle(typeof raw.title === 'string' ? raw.title : '')
  const description = normalizeFeedbackDescription(typeof raw.description === 'string' ? raw.description : '')

  if (!id || !feedbackId || !title) {
    return null
  }

  const locale = raw.locale === 'zh-CN' ? 'zh-CN' : 'en'
  const syncStatus = typeof raw.syncStatus === 'string' ? raw.syncStatus : 'pending_submission'
  const githubTemplate = raw.githubTemplate === FEEDBACK_BUG_TEMPLATE || raw.githubTemplate === FEEDBACK_FEATURE_TEMPLATE
    ? raw.githubTemplate
    : resolveFeedbackTemplate(raw.type)

  return {
    id,
    feedbackId,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    browserOpenedAt: typeof raw.browserOpenedAt === 'number' ? raw.browserOpenedAt : null,
    locale,
    rating: raw.rating,
    type: raw.type,
    title,
    description,
    publicConsentAccepted: raw.publicConsentAccepted === true,
    githubTemplate,
    prefilledUrl: typeof raw.prefilledUrl === 'string' ? raw.prefilledUrl : '',
    issueNumber: typeof raw.issueNumber === 'number' ? raw.issueNumber : null,
    issueUrl: typeof raw.issueUrl === 'string' ? raw.issueUrl : null,
    issueState: raw.issueState === 'open' || raw.issueState === 'closed' ? raw.issueState : null,
    issueStateReason: typeof raw.issueStateReason === 'string' ? raw.issueStateReason : null,
    issueLabels: normalizeStringArray(raw.issueLabels),
    syncStatus: syncStatus as FeedbackRecord['syncStatus'],
    lastCheckedAt: typeof raw.lastCheckedAt === 'number' ? raw.lastCheckedAt : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null
  }
}

class FeedbackStorage {
  private storagePath: string
  private state: FeedbackState
  private mockIssues: GitHubIssue[] | null

  constructor() {
    const userDataPath = app.getPath('userData')
    this.storagePath = join(userDataPath, 'feedback.json')
    this.state = this.load()
    this.mockIssues = null
  }

  get(): FeedbackState {
    return this.state
  }

  debugReset(): FeedbackState {
    this.state = createDefaultState()
    this.mockIssues = null
    this.persist()
    return this.state
  }

  debugSetMockIssues(issues: FeedbackDebugRemoteIssue[]): void {
    this.mockIssues = issues.map((issue) => this.toGitHubIssue(issue))
  }

  updatePreferences(partial: Partial<FeedbackState['preferences']>): FeedbackState {
    this.state = {
      ...this.state,
      preferences: {
        ...this.state.preferences,
        publicConsentAccepted: partial.publicConsentAccepted === true
          ? true
          : partial.publicConsentAccepted === false
            ? false
            : this.state.preferences.publicConsentAccepted
      },
      updatedAt: Date.now()
    }
    this.persist()
    return this.state
  }

  createSubmission(input: FeedbackSubmissionInput, appContext: FeedbackAppContext): FeedbackCreateSubmissionResult {
    const title = normalizeFeedbackTitle(input.title)
    const description = normalizeFeedbackDescription(input.description)

    if (!input.publicConsentAccepted) {
      return { success: false, error: 'Public consent must be accepted before continuing.' }
    }
    if (!isValidRating(input.rating)) {
      return { success: false, error: 'A rating value from 0 to 5 is required.' }
    }
    if (!isValidType(input.type)) {
      return { success: false, error: 'Feedback type is invalid.' }
    }
    if (!title) {
      return { success: false, error: 'A feedback title is required.' }
    }
    if (!description) {
      return { success: false, error: 'A feedback description is required.' }
    }

    const feedbackId = randomUUID()
    const now = appContext.createdAt
    const prefilledUrl = buildFeedbackIssueUrl(feedbackId, {
      rating: input.rating,
      type: input.type,
      title,
      description
    }, appContext)

    if (prefilledUrl.length > FEEDBACK_MAX_URL_LENGTH) {
      return {
        success: false,
        error: `The generated GitHub URL is too long (${prefilledUrl.length} characters). Please shorten the description.`
      }
    }

    const record: FeedbackRecord = {
      id: randomUUID(),
      feedbackId,
      createdAt: now,
      updatedAt: now,
      browserOpenedAt: null,
      locale: input.locale,
      rating: input.rating,
      type: input.type,
      title,
      description,
      publicConsentAccepted: true,
      githubTemplate: resolveFeedbackTemplate(input.type),
      prefilledUrl,
      issueNumber: null,
      issueUrl: null,
      issueState: null,
      issueStateReason: null,
      issueLabels: [],
      syncStatus: 'pending_submission',
      lastCheckedAt: null,
      lastError: null
    }

    this.state = {
      ...this.state,
      records: [record, ...this.state.records],
      updatedAt: now
    }
    this.persist()
    return { success: true, record }
  }

  removeRecord(recordId: string): void {
    const nextRecords = this.state.records.filter((record) => record.id !== recordId)
    if (nextRecords.length === this.state.records.length) {
      return
    }
    this.state = {
      ...this.state,
      records: nextRecords,
      updatedAt: Date.now()
    }
    this.persist()
  }

  markBrowserOpened(recordId: string): FeedbackRecord | null {
    return this.updateRecord(recordId, (record) => ({
      ...record,
      browserOpenedAt: Date.now(),
      updatedAt: Date.now()
    }))
  }

  async sync(recordId?: string, force = false): Promise<FeedbackState> {
    const now = Date.now()
    const nextRecords = [...this.state.records]
    const candidateIds = recordId ? new Set([recordId]) : null
    const pendingIndexes = nextRecords
      .map((record, index) => ({ record, index }))
      .filter(({ record }) =>
        (!candidateIds || candidateIds.has(record.id)) &&
        record.issueNumber === null &&
        this.shouldSyncPendingRecord(record, force, now)
      )

    if (pendingIndexes.length > 0) {
      try {
        const recentIssues = await this.fetchRecentIssues()
        for (const { record, index } of pendingIndexes) {
          const matchedIssue = recentIssues.find((issue) => issueBodyContainsFeedbackId(issue.body, record.feedbackId))
          nextRecords[index] = matchedIssue
            ? this.applyIssueToRecord(record, matchedIssue, now)
            : {
                ...record,
                lastCheckedAt: now,
                lastError: null,
                updatedAt: now
              }
        }
      } catch (error) {
        for (const { record, index } of pendingIndexes) {
          nextRecords[index] = {
            ...record,
            lastCheckedAt: now,
            lastError: String(error),
            updatedAt: now
          }
        }
      }
    }

    const trackedIndexes = nextRecords
      .map((record, index) => ({ record, index }))
      .filter(({ record }) =>
        (!candidateIds || candidateIds.has(record.id)) &&
        record.issueNumber !== null &&
        this.shouldSyncTrackedRecord(record, force, now)
      )

    for (const { record, index } of trackedIndexes) {
      try {
        const issue = await this.fetchIssue(record.issueNumber as number)
        nextRecords[index] = issue
          ? this.applyIssueToRecord(record, issue, now)
          : {
              ...record,
              syncStatus: 'unavailable_on_github',
              lastCheckedAt: now,
              lastError: 'Issue not found on GitHub.',
              updatedAt: now
            }
      } catch (error) {
        nextRecords[index] = {
          ...record,
          lastCheckedAt: now,
          lastError: String(error),
          updatedAt: now
        }
      }
    }

    this.state = {
      ...this.state,
      records: nextRecords,
      updatedAt: now
    }
    this.persist()
    return this.state
  }

  getRecord(recordId: string): FeedbackRecord | null {
    return this.state.records.find((record) => record.id === recordId) ?? null
  }

  private load(): FeedbackState {
    try {
      if (!existsSync(this.storagePath)) {
        return createDefaultState()
      }

      const raw = readFileSync(this.storagePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<FeedbackState>
      const records = Array.isArray(parsed.records)
        ? parsed.records
            .map((record) => normalizeFeedbackRecord(record))
            .filter((record): record is FeedbackRecord => Boolean(record))
        : []

      return {
        version: CURRENT_VERSION,
        installationId: typeof parsed.installationId === 'string' && parsed.installationId.trim()
          ? parsed.installationId
          : randomUUID(),
        preferences: {
          publicConsentAccepted: parsed.preferences && typeof parsed.preferences === 'object'
            ? (parsed.preferences as { publicConsentAccepted?: unknown }).publicConsentAccepted === true
            : false
        },
        records,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
      }
    } catch (error) {
      console.error('Failed to load feedback storage:', error)
      return createDefaultState()
    }
  }

  private persist(): void {
    try {
      const userDataPath = app.getPath('userData')
      if (!existsSync(userDataPath)) {
        mkdirSync(userDataPath, { recursive: true })
      }
      writeFileSync(this.storagePath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (error) {
      console.error('Failed to persist feedback storage:', error)
    }
  }

  private updateRecord(recordId: string, updater: (record: FeedbackRecord) => FeedbackRecord): FeedbackRecord | null {
    const index = this.state.records.findIndex((record) => record.id === recordId)
    if (index < 0) {
      return null
    }
    const record = updater(this.state.records[index])
    const nextRecords = [...this.state.records]
    nextRecords[index] = record
    this.state = {
      ...this.state,
      records: nextRecords,
      updatedAt: Date.now()
    }
    this.persist()
    return record
  }

  private shouldSyncPendingRecord(record: FeedbackRecord, force: boolean, now: number): boolean {
    if (force) {
      return true
    }
    if (record.syncStatus !== 'pending_submission') {
      return false
    }
    if (record.lastCheckedAt === null) {
      return true
    }
    return now - record.lastCheckedAt >= FEEDBACK_PENDING_SYNC_MIN_INTERVAL_MS
  }

  private shouldSyncTrackedRecord(record: FeedbackRecord, force: boolean, now: number): boolean {
    if (force) {
      return true
    }
    if (
      record.syncStatus === 'completed' ||
      record.syncStatus === 'not_planned' ||
      record.syncStatus === 'duplicate' ||
      record.syncStatus === 'unavailable_on_github'
    ) {
      return false
    }
    if (record.lastCheckedAt === null) {
      return true
    }
    return now - record.lastCheckedAt >= FEEDBACK_ACTIVE_SYNC_MIN_INTERVAL_MS
  }

  private async fetchRecentIssues(): Promise<GitHubIssue[]> {
    if (this.mockIssues) {
      return this.mockIssues.filter((issue) => !issue.pull_request)
    }

    const url = new URL(`${GITHUB_API_BASE_URL}/issues`)
    url.searchParams.set('state', 'all')
    url.searchParams.set('sort', 'created')
    url.searchParams.set('direction', 'desc')
    url.searchParams.set('per_page', String(RECENT_PENDING_SCAN_LIMIT))

    const response = await net.fetch(url.toString(), { headers: GITHUB_COMMON_HEADERS })
    if (!response.ok) {
      throw new Error(`GitHub recent issues request failed: ${response.status}`)
    }

    const payload = await response.json()
    if (!Array.isArray(payload)) {
      throw new Error('GitHub recent issues response is invalid.')
    }

    return payload.filter((issue): issue is GitHubIssue => Boolean(issue && typeof issue === 'object' && !('pull_request' in (issue as Record<string, unknown>))))
  }

  private async fetchIssue(issueNumber: number): Promise<GitHubIssue | null> {
    if (this.mockIssues) {
      return this.mockIssues.find((issue) => issue.number === issueNumber && !issue.pull_request) ?? null
    }

    const response = await net.fetch(`${GITHUB_API_BASE_URL}/issues/${issueNumber}`, {
      headers: GITHUB_COMMON_HEADERS
    })

    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`GitHub issue request failed: ${response.status}`)
    }

    return await response.json() as GitHubIssue
  }

  private applyIssueToRecord(record: FeedbackRecord, issue: GitHubIssue, now: number): FeedbackRecord {
    const labels = Array.isArray(issue.labels)
      ? issue.labels
          .map((label) => (typeof label?.name === 'string' ? label.name.trim() : ''))
          .filter((label): label is string => label.length > 0)
      : []

    return {
      ...record,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      issueState: issue.state,
      issueStateReason: typeof issue.state_reason === 'string' ? issue.state_reason : null,
      issueLabels: labels,
      syncStatus: resolveFeedbackSyncStatus(labels, issue.state, typeof issue.state_reason === 'string' ? issue.state_reason : null),
      lastCheckedAt: now,
      lastError: null,
      updatedAt: now
    }
  }

  private toGitHubIssue(issue: FeedbackDebugRemoteIssue): GitHubIssue {
    return {
      number: issue.number,
      html_url: issue.url || `https://github.com/${FEEDBACK_REPO_OWNER}/${FEEDBACK_REPO_NAME}/issues/${issue.number}`,
      state: issue.state,
      state_reason: typeof issue.stateReason === 'string' ? issue.stateReason : null,
      labels: Array.isArray(issue.labels) ? issue.labels.map((label) => ({ name: label })) : [],
      body: typeof issue.body === 'string' ? issue.body : null
    }
  }
}

let instance: FeedbackStorage | null = null

export function getFeedbackStorage(): FeedbackStorage {
  if (!instance) {
    instance = new FeedbackStorage()
  }
  return instance
}
