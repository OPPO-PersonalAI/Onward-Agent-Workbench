/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

/** The left-anchored Settings panel grows when its right edge moves right. */
export function resizedSettingsWidth(startWidth: number, deltaX: number): number {
  return Math.max(300, Math.min(600, startWidth + deltaX))
}
