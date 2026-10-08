/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GlobalTerminalStyle, TerminalStyleConfig } from '../types/settings'

/** Only fonts have Task scope. Legacy color fields never cross this boundary. */
export function resolveTaskFonts(settings: {
  terminalStyles: Record<string, TerminalStyleConfig>
  globalTerminalStyle: GlobalTerminalStyle
}, taskId: string): TerminalStyleConfig {
  const font = settings.terminalStyles[taskId] ?? settings.globalTerminalStyle
  return {
    terminalId: taskId,
    fontFamily: font?.fontFamily ?? null,
    fontSize: font?.fontSize ?? null,
    gitDiffFontSize: font?.gitDiffFontSize ?? null
  }
}

export function patchTaskFonts(terminalId: string, previous: GlobalTerminalStyle | null | undefined, patch: Partial<GlobalTerminalStyle>): TerminalStyleConfig {
  return {
    terminalId,
    fontFamily: 'fontFamily' in patch ? (patch.fontFamily ?? null) : (previous?.fontFamily ?? null),
    fontSize: 'fontSize' in patch ? (patch.fontSize ?? null) : (previous?.fontSize ?? null),
    gitDiffFontSize: 'gitDiffFontSize' in patch ? (patch.gitDiffFontSize ?? null) : (previous?.gitDiffFontSize ?? null)
  }
}
