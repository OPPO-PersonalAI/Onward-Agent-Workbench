/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type TerminalShellKind = 'posix' | 'powershell' | 'cmd' | 'unknown'

function quotePosixPath(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

function quotePowerShellLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function quoteCmdPath(value: string): string {
  return '"' + value.replace(/([%^&|<>!])/g, '^$1').replace(/"/g, '""') + '"'
}

export function buildChangeDirectoryCommand(
  platform: string,
  directory: string,
  shellKind?: TerminalShellKind
): string {
  if (platform === 'win32') {
    if (shellKind === 'cmd') {
      return `cd /d ${quoteCmdPath(directory)}\r`
    }
    return `Set-Location -LiteralPath ${quotePowerShellLiteral(directory)}\r`
  }
  return `cd ${quotePosixPath(directory)}\r`
}
