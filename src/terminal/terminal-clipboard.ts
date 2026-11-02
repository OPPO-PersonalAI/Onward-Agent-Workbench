/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export type TerminalClipboard = { kind: 'text'; text: string } | { kind: 'image' | 'empty' | 'unavailable' }

/** Native formats are metadata only; no bitmap allocation or encoding is needed. */
export function hasClipboardImage(formats: readonly string[]): boolean {
  return formats.some(format => /^(image\/(png|jpeg|jpg|bmp|tiff|webp)|png|bitmap|dib|cf_dib|cf_dibv5|public\.(png|tiff|jpeg)|deviceindependentbitmap)$/i.test(format))
}

export function terminalClipboardPayload(formats: readonly string[], readText: () => string): TerminalClipboard {
  if (hasClipboardImage(formats)) return { kind: 'image' }
  const text = readText()
  return text ? { kind: 'text', text } : { kind: 'empty' }
}
