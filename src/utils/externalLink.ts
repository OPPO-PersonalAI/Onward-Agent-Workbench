/*
 * SPDX-FileCopyrightText: 2026 OPPO
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ExternalLinkOpenResult {
  success: boolean
  canceled?: boolean
  blocked?: boolean
  error?: string
}

const HTTP_URL_RE = /^https?:\/\//i

function normalizeHttpUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!HTTP_URL_RE.test(trimmed)) {
    return null
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

export async function requestOpenExternalHttpLink(rawUrl: string): Promise<ExternalLinkOpenResult> {
  const normalized = normalizeHttpUrl(rawUrl)
  if (!normalized) {
    return {
      success: false,
      blocked: true,
      error: 'Only http/https links are allowed'
    }
  }

  try {
    return await window.electronAPI.shell.openExternal(normalized)
  } catch (error) {
    return {
      success: false,
      error: String(error)
    }
  }
}
