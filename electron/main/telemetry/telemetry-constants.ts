/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Azure Application Insights connection string.
 * This is NOT a secret — it identifies the telemetry resource endpoint only.
 * Replace with your own Application Insights connection string.
 */
export const TELEMETRY_CONNECTION_STRING =
  process.env.ONWARD_TELEMETRY_CONNECTION_STRING ||
  'InstrumentationKey=eb3ba3c1-253c-4a08-b825-16c9af05fbe1;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=696f3684-0511-4ee5-a0b0-32fe69d04cbf'

/**
 * Whether telemetry is fully disabled at build time.
 * Set ONWARD_TELEMETRY_DISABLED=1 to completely disable telemetry in a build.
 */
export const TELEMETRY_BUILD_DISABLED = process.env.ONWARD_TELEMETRY_DISABLED === '1'

/**
 * Debug: reset telemetry consent to simulate a first-time install.
 * Set ONWARD_TELEMETRY_RESET_CONSENT=1 to force the consent dialog on next launch.
 */
export const TELEMETRY_RESET_CONSENT = process.env.ONWARD_TELEMETRY_RESET_CONSENT === '1'

/**
 * Debug: use a fast heartbeat interval (5 seconds) for telemetry testing.
 * Set ONWARD_TELEMETRY_FAST_HEARTBEAT=1 to accelerate heartbeat for testing.
 */
export const TELEMETRY_FAST_HEARTBEAT = process.env.ONWARD_TELEMETRY_FAST_HEARTBEAT === '1'

/**
 * Debug: force daily upload on the next heartbeat cycle (skip 24h wait).
 * Set ONWARD_TELEMETRY_FORCE_UPLOAD=1 to trigger upload immediately.
 */
export const TELEMETRY_FORCE_UPLOAD = process.env.ONWARD_TELEMETRY_FORCE_UPLOAD === '1'

/** Flush interval: how often buffered events are sent to the backend (ms) */
export const TELEMETRY_FLUSH_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

/** Session heartbeat interval (ms) */
export const TELEMETRY_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/** Maximum characters for string property values */
export const TELEMETRY_MAX_PROPERTY_LENGTH = 1024

/** Maximum characters for stack traces */
export const TELEMETRY_MAX_STACK_LENGTH = 4096
