/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react'

/**
 * React hook providing telemetry tracking methods.
 *
 * All calls are fire-and-forget; they are silently dropped
 * when telemetry is not enabled (the main process handles this).
 */
export function useTelemetry() {
  const track = useCallback(
    (name: string, properties?: Record<string, string | number | boolean | null>) => {
      window.electronAPI.telemetry.track(name, properties)
    },
    []
  )

  return { track }
}
