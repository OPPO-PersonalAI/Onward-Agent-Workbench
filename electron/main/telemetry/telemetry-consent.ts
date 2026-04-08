/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto'
import { getSettingsStorage } from '../settings-storage'

/**
 * Read the current telemetry consent state from settings.
 * Returns null if the user has not been asked yet.
 */
export function getTelemetryConsent(): boolean | null {
  return getSettingsStorage().getTelemetryConsent()
}

/**
 * Read the stored anonymous instance ID.
 * Returns null if telemetry is not enabled.
 */
export function getTelemetryInstanceId(): string | null {
  return getSettingsStorage().getTelemetryInstanceId()
}

/**
 * Set consent and manage instance ID accordingly.
 * - On opt-in: generates a fresh random UUID as instance ID.
 * - On opt-out: clears the instance ID.
 * Returns the new instance ID (or null on opt-out).
 */
export function setTelemetryConsent(consent: boolean): string | null {
  const storage = getSettingsStorage()
  const instanceId = consent ? randomUUID() : null
  storage.setTelemetryConsent(consent, instanceId)
  return instanceId
}
