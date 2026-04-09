/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto'
import { app } from 'electron'
import { join } from 'path'
import { appendFile, writeFile } from 'fs/promises'
import { getAppInfo } from '../app-info'
import { getTelemetryConsent, getTelemetryInstanceId } from './telemetry-consent'
import { getDailyAggregator } from './telemetry-aggregator'
import {
  TELEMETRY_BUILD_DISABLED,
  TELEMETRY_CONNECTION_STRING,
  TELEMETRY_MAX_PROPERTY_LENGTH
} from './telemetry-constants'

type TelemetryClient = import('applicationinsights').TelemetryClient

/**
 * Core telemetry service — singleton orchestrator.
 *
 * Events are routed to:
 * 1. Local JSONL file (for debugging/inspection)
 * 2. Daily aggregator (accumulated throughout the day)
 *
 * Azure Application Insights receives a single aggregated summary
 * once per day (triggered by heartbeat check or app quit).
 */
class TelemetryService {
  private client: TelemetryClient | null = null
  private sessionId: string = randomUUID()
  private instanceId: string | null = null
  private initialized = false
  private localLogPath: string | null = null
  private commonProperties: Record<string, string> = {}
  private writeQueue: Promise<void> = Promise.resolve()

  initialize(): void {
    if (this.initialized) return
    this.initialized = true

    if (TELEMETRY_BUILD_DISABLED) return

    const consent = getTelemetryConsent()
    this.instanceId = getTelemetryInstanceId()
    if (!consent || !this.instanceId) return

    this.setupLocalLog()
    this.buildCommonProperties(this.instanceId)
    this.startAzureSdk(this.instanceId)
  }

  onConsentChanged(consent: boolean, instanceId: string | null): void {
    if (consent && instanceId) {
      this.sessionId = randomUUID()
      this.instanceId = instanceId
      this.setupLocalLog()
      this.buildCommonProperties(instanceId)
      this.startAzureSdk(instanceId)
      // Record session/start so the aggregator counts this session
      this.track('session/start')
    } else {
      this.instanceId = null
      this.commonProperties = {}
      this.stopAzureSdk()
    }
  }

  /**
   * Track a named event. Routes to local log + daily aggregator.
   * Does NOT send to Azure directly.
   */
  track(name: string, properties?: Record<string, string | number | boolean | null>): void {
    if (!this.instanceId) return
    const sanitized = properties ? this.sanitizeProperties(properties) : undefined

    // Write to local JSONL for debugging
    this.writeLocal(name, sanitized)

    // Route to daily aggregator
    this.routeToAggregator(name, sanitized)
  }

  /**
   * Track an event and send it to Azure immediately (bypasses daily aggregation).
   * Use sparingly for critical diagnostics like update failures.
   */
  trackImmediate(name: string, properties?: Record<string, string | number | boolean | null>): void {
    if (!this.instanceId) return
    const sanitized = properties ? this.sanitizeProperties(properties) : undefined

    this.writeLocal(name, sanitized)

    if (this.client) {
      this.client.trackEvent({
        name,
        properties: { ...this.commonProperties, ...(sanitized ?? {}) }
      })
      try {
        this.client.flush()
      } catch {}
    }
  }

  /**
   * Try to upload daily summary if the day has rolled over.
   * Called from heartbeat timer.
   */
  tryDailyUpload(): void {
    if (!this.client) return // Don't consume data if Azure SDK is not active
    const aggregator = getDailyAggregator()
    const payload = aggregator.getUploadPayloadIfDue()
    if (payload) {
      this.uploadSummary(payload)
      aggregator.markUploaded()
    }
  }

  /**
   * Flush: upload current aggregated data on app quit (even if day hasn't ended).
   */
  async shutdown(): Promise<void> {
    if (!this.instanceId) return

    const aggregator = getDailyAggregator()
    const summary = aggregator.getCurrentSummary()
    if (summary && this.client) {
      this.uploadSummary(summary)
    }

    // Wait for local writes
    await this.writeQueue

    // Flush Azure SDK
    if (this.client) {
      try {
        await new Promise<void>((resolve) => {
          this.client!.flush({ callback: () => resolve() })
        })
      } catch {}
      this.stopAzureSdk()
    }
  }

  get isActive(): boolean { return this.instanceId !== null }
  get logFilePath(): string | null { return this.localLogPath }

  // --- Aggregator routing ---

  private routeToAggregator(name: string, properties?: Record<string, string>): void {
    const agg = getDailyAggregator()

    switch (name) {
      case 'session/start':
        agg.recordSessionStart()
        break
      case 'session/end':
        agg.recordSessionEnd(Number(properties?.durationMs) || 0)
        break
      case 'session/heartbeat':
        agg.recordHeartbeat(
          Number(properties?.tabCount) || 0,
          Number(properties?.terminalCount) || 0,
          Number(properties?.layoutMode) || 1
        )
        break
      case 'prompt/use':
        agg.recordPrompt(properties?.action ?? '')
        break
      case 'dropdown/workspace':
      case 'dropdown/development':
      case 'dropdown/tools':
        agg.recordDropdown(name, properties?.action ?? '')
        break
      case 'error/rendererCrash':
        agg.recordRendererCrash()
        break
    }
  }

  // --- Upload to Azure ---

  private uploadSummary(summary: Record<string, string | number>): void {
    console.log('[Telemetry] Uploading daily summary:', JSON.stringify(summary))
    if (this.client) {
      this.client.trackEvent({
        name: 'daily/summary',
        properties: Object.fromEntries(
          Object.entries(summary).map(([k, v]) => [k, String(v)])
        )
      })
      console.log('[Telemetry] Daily summary sent to Azure Application Insights')
    } else {
      console.log('[Telemetry] Azure SDK not active, summary logged locally only')
    }
    // Clear local JSONL after successful upload — data is now in the aggregated summary
    this.clearLocalLog()
  }

  private clearLocalLog(): void {
    if (!this.localLogPath) return
    this.writeQueue = this.writeQueue
      .then(() => writeFile(this.localLogPath!, '', 'utf-8'))
      .catch(() => {})
  }

  // --- Local JSONL logging ---

  private setupLocalLog(): void {
    try {
      this.localLogPath = join(app.getPath('userData'), 'telemetry-events.jsonl')
    } catch {
      this.localLogPath = null
    }
  }

  private writeLocal(name: string, properties?: Record<string, string>): void {
    if (!this.localLogPath || !this.instanceId) return
    const entry = {
      timestamp: new Date().toISOString(),
      name,
      properties: properties || undefined,
      common: this.commonProperties
    }
    const line = JSON.stringify(entry) + '\n'
    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.localLogPath!, line, 'utf-8'))
      .catch(() => {})
  }

  private buildCommonProperties(instanceId: string): void {
    const appInfo = getAppInfo()
    this.commonProperties = {
      instanceId,
      sessionId: this.sessionId,
      appVersion: appInfo.version,
      buildChannel: appInfo.buildChannel,
      releaseChannel: appInfo.releaseChannel,
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron ?? 'unknown'
    }
  }

  // --- Azure Application Insights SDK ---

  private startAzureSdk(instanceId: string): void {
    this.stopAzureSdk()
    if (TELEMETRY_CONNECTION_STRING.includes('00000000-0000-0000-0000-000000000000')) return

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const appInsights = require('applicationinsights') as typeof import('applicationinsights')
      appInsights.setup(TELEMETRY_CONNECTION_STRING)
        .setAutoCollectExceptions(false)
        .setAutoCollectPerformance(false)
        .setAutoCollectConsole(false)
        .setAutoCollectRequests(false)
        .setAutoCollectDependencies(false)
        .setAutoCollectPreAggregatedMetrics(false)
        .start()

      this.client = appInsights.defaultClient
      this.client.commonProperties = { ...this.commonProperties }
      this.client.context.tags[this.client.context.keys.userId] = instanceId
      this.client.context.tags[this.client.context.keys.sessionId] = this.sessionId
      this.client.context.tags[this.client.context.keys.applicationVersion] = this.commonProperties.appVersion
    } catch (error) {
      console.error('[Telemetry] Failed to initialize Application Insights:', error)
      this.client = null
    }
  }

  private stopAzureSdk(): void {
    if (!this.client) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const appInsights = require('applicationinsights') as typeof import('applicationinsights')
      appInsights.dispose()
    } catch {}
    this.client = null
  }

  private sanitizeProperties(
    props: Record<string, string | number | boolean | null>
  ): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined) continue
      const str = String(value)
      result[key] = str.length > TELEMETRY_MAX_PROPERTY_LENGTH
        ? str.slice(0, TELEMETRY_MAX_PROPERTY_LENGTH)
        : str
    }
    return result
  }
}

// Singleton
let instance: TelemetryService | null = null

export function getTelemetryService(): TelemetryService {
  if (!instance) {
    instance = new TelemetryService()
  }
  return instance
}
