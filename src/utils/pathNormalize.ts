/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export function normalizeProjectCwd(path: string): string {
  return path.replace(/\\/g, '/')
}
