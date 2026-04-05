/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export function buildChangeDirectoryCommand(platform: string, directory: string): string {
  if (platform === 'win32') {
    return `cd /d "${directory}"\r`
  }
  return `cd "${directory}"\r`
}
